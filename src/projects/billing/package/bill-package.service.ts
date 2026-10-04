import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BillDirection,
  BillPackageStatus,
  ClaimProposalSource,
  ClientBillStatus,
  Prisma,
  RaBillStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { CompaniesService } from '../../../settings/companies/companies.service';
import { DwrPeriodFiguresService } from '../../dwr/dwr-period-figures.service';
import { lineTotals, money } from '../bill-totals';
import { PACKAGE_ERRORS } from './package-error-codes';

/**
 * One line of the schedule a bill's direction measures (023 FR-003).
 *
 * **The two directions measure different schedules**, which is the finding research §1 turns on: a
 * bill to the client measures the project's own BOQ lines at the client's rates, and a bill to a
 * subcontractor measures that subcontractor's award lines at the awarded rates. Those are different
 * numbers for the same work — revenue and cost — so this type is what both are flattened into, and
 * `resolveSchedule` is the only place that decides which.
 */
export interface ScheduleLine {
  /** `BOQTaskItem.id` or `WorkOrderBOQItem.id`, according to the direction. */
  id: string;
  boqNo: string;
  description: string;
  unit: string;
  /** Scope for a client bill, awarded quantity for a subcontractor's. */
  scopeQty: Prisma.Decimal;
  rate: Prisma.Decimal;
  /**
   * The BOQ line measurement is attributed to, where there is one.
   *
   * Always set for a client bill. **Null is possible for an award line** and is not an error:
   * `WorkOrderBOQItem.boqTaskItemId` is nullable by design, because a subcontract can cover work the
   * client's BOQ itemises differently and forcing a match would make somebody invent one. Feature
   * 022 attributes measurement to BOQ lines, so a null here means there is no measurement to read —
   * which FR-003a requires be distinguishable from a measurement of zero.
   */
  boqTaskItemId: string | null;
  /** The rate is still 0: "nobody has priced this", not "this is free" (FR-009). */
  unpriced: boolean;
}

/** One proposed line, before anything is written. */
interface Proposal {
  line: ScheduleLine;
  proposedQty: Prisma.Decimal | null;
  proposalSource: ClaimProposalSource;
}

/** The rates a package is computed at, frozen onto it at composition (FR-023, research §4). */
export interface FrozenRates {
  retentionFraction: string;
  cgstFraction: string;
  sgstFraction: string;
  igstFraction: string;
  tdsFraction: string;
}

export interface ComposeBillPackageInput {
  projectId: string;
  direction: BillDirection;
  periodFrom: string;
  periodTo: string;
  workOrderId?: string | null;
  externalBillNo?: string | null;
  externalWorkOrderNo?: string | null;
}

export interface SetClaimInput {
  claimedQty: string;
  reason?: string | null;
}

export interface BillPackageClaimView {
  id: string;
  scheduleLineId: string;
  boqNo: string;
  description: string;
  unit: string;
  /** Null when there was no measurement to read (FR-003a). Not the same fact as `"0.000"`. */
  proposedQty: string | null;
  proposalSource: ClaimProposalSource;
  claimedQty: string;
  /** Null exactly when `proposedQty` is: there is no variance from a figure never proposed. */
  varianceQty: string | null;
  reason: string | null;
  overClaimed: boolean;
  rate: string;
  amount: string;
  /** Scope less everything measured including this bill. **Negative when over** (FR-012b). */
  remainingQty: string;
  exceedsScope: boolean;
  unpriced: boolean;
}

export interface BillPackageView {
  id: string;
  projectId: string;
  direction: BillDirection;
  /** "RA-12" — one rendering, everywhere (FR-024a's sibling problem). */
  label: string;
  sequenceNo: number;
  periodFrom: string;
  periodTo: string;
  status: BillPackageStatus;
  rates: FrozenRates;
  claims: BillPackageClaimView[];
  /** Lines whose rate is 0 and whose claim is non-zero. Refused at **issue**, not here (FR-009). */
  unpricedClaimedCount: number;
}

/** The only rendering of a package's number (`RA-12`), so two documents cannot disagree. */
export function packageLabel(sequenceNo: number): string {
  return `RA-${String(sequenceNo).padStart(2, '0')}`;
}

const dec = (value: Prisma.Decimal | string | number): Prisma.Decimal =>
  new Prisma.Decimal(value);

/**
 * Composing a running-account bill package (023 US1, FR-001 to FR-012b).
 *
 * ## Why this does not go through `ClientBillsService.compose`
 *
 * plan.md's Phase B said to create the underlying bill "through 018's existing service", and reading
 * that service shows it cannot be used here — for two reasons, both of which would be defects rather
 * than inconveniences.
 *
 * 1. **It refuses an unpriced line at composition.** That is right for 018, where the caller chooses
 *    which lines to measure, so an unpriced one in the list is a mistake to correct before going
 *    further. It is wrong here: FR-003 proposes *every* line of the schedule, and FR-009 defers the
 *    refusal to **issue**. Delegating would make a single unpriced line refuse the whole package, so
 *    a 312-line tender with one unpriced row could not be billed at all.
 * 2. **It opens its own transaction.** Composition writes a bill, its lines, a package and a claim
 *    per line, and FR-013's all-or-nothing has to hold across all four. Two transactions cannot give
 *    that — which is the same wall 022 hit with `BoqService.updateDoneQty` and solved the same way,
 *    by writing the operation that needs one transaction inside one.
 *
 * So the bill row is created here. Its figures still come from `bill-totals.ts`, which stays the
 * single definition of what gross and net mean.
 *
 * ## Bounded statements
 *
 * A 312-line tender is composed in **four statements, not 312** — the bill, its lines, the package,
 * the claims. Research §8 and the production 500 behind it: a loop issuing one write per group was
 * 132 sequential round trips inside one interactive transaction whose budget is five seconds, which
 * is 0.17s locally and 5-7s against a hosted database, and expired mid-write as a bare 500. The
 * number of round trips scaled with the file, so the schedules most worth billing were the ones that
 * could not be.
 */
@Injectable()
export class BillPackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodFigures: DwrPeriodFiguresService,
    private readonly companies: CompaniesService,
  ) {}

  /**
   * The schedule a direction measures (FR-003).
   *
   * One function, so nothing downstream has to know which table it came from.
   */
  async resolveSchedule(
    tx: Prisma.TransactionClient,
    direction: BillDirection,
    projectId: string,
    workOrderId?: string | null,
  ): Promise<ScheduleLine[]> {
    if (direction === BillDirection.to_client) {
      const items = await tx.bOQTaskItem.findMany({
        where: { group: { projectId }, isEstimate: false },
        orderBy: [{ boqNo: 'asc' }],
        select: {
          id: true,
          boqNo: true,
          taskName: true,
          unit: true,
          scopeQty: true,
          rate: true,
        },
      });
      return items.map((item) => ({
        id: item.id,
        boqNo: item.boqNo,
        description: item.taskName,
        unit: item.unit,
        scopeQty: item.scopeQty,
        rate: item.rate,
        // A client bill measures the BOQ, so the line *is* the measured line.
        boqTaskItemId: item.id,
        unpriced: item.rate.isZero(),
      }));
    }

    if (!workOrderId) {
      throw new BadRequestException({
        statusCode: 400,
        code: PACKAGE_ERRORS.workOrderRequired,
        message:
          'A bill to a subcontractor measures that subcontractor’s award lines, so it needs the ' +
          'work order. Without one there is no schedule to propose against.',
      });
    }

    const award = await tx.workOrderBOQItem.findMany({
      where: { workOrderId, workOrder: { projectId } },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        description: true,
        unit: true,
        awardedQty: true,
        rate: true,
        boqTaskItemId: true,
        boqTaskItem: { select: { boqNo: true } },
      },
    });

    return award.map((item, index) => ({
      id: item.id,
      // An award line carries no number of its own. Its BOQ line's is used where it has one, and a
      // positional number otherwise — stated rather than left blank, because every sheet in the
      // client's package is found by its number.
      boqNo: item.boqTaskItem?.boqNo ?? `A.${index + 1}`,
      description: item.description,
      unit: item.unit,
      scopeQty: item.awardedQty,
      rate: item.rate,
      boqTaskItemId: item.boqTaskItemId,
      unpriced: item.rate.isZero(),
    }));
  }

  /**
   * The rates this package is computed at, read from the contract and from configuration (FR-018,
   * FR-019, FR-023).
   *
   * **A missing rate is a refusal, naming which** (research §4). A silent zero would produce a bill
   * with no retention and a payable five per cent too high, which is the error most likely to be
   * paid before anybody notices — and the one nobody would trace back to a null column.
   */
  private async resolveRates(
    tx: Prisma.TransactionClient,
    companyId: string,
    direction: BillDirection,
    project: { clientRetentionFraction: Prisma.Decimal | null },
    workOrder: { retentionPercent: Prisma.Decimal } | null,
  ): Promise<FrozenRates> {
    const retention =
      direction === BillDirection.to_client
        ? project.clientRetentionFraction
        : workOrder?.retentionPercent ?? null;

    if (retention === null) {
      throw new BadRequestException({
        statusCode: 400,
        code: PACKAGE_ERRORS.rateMissing,
        message:
          direction === BillDirection.to_client
            ? 'This project has no client retention term recorded, so a bill to the client cannot ' +
              'compute retention. Record it on the project first — billing at zero retention ' +
              'would make the payable five per cent too high, and nothing downstream would ' +
              'notice.'
            : 'This work order has no retention term recorded.',
        missingRate: 'retentionFraction',
      });
    }

    const tax = await this.companies.getBillingTaxRates(companyId);
    return {
      retentionFraction: retention.toFixed(6),
      ...tax,
    };
  }

  /**
   * Opens a package and proposes every line (FR-001 to FR-012b).
   *
   * Feature 022's figures are read **before** the write transaction, not inside it. Two reasons:
   * `figuresFor` opens a transaction of its own, so calling it from within one would nest; and the
   * proposal is a point-in-time fact by definition (`proposedQty` is "as at composition"), so
   * reading it a moment earlier is the semantics rather than a compromise. It is also one request
   * for the whole schedule rather than one per line.
   */
  async compose(
    ctx: RlsContext,
    companyId: string,
    input: ComposeBillPackageInput,
  ): Promise<BillPackageView> {
    if (new Date(input.periodTo) < new Date(input.periodFrom)) {
      throw new BadRequestException({
        statusCode: 400,
        code: PACKAGE_ERRORS.periodInverted,
        message: `The period ends (${input.periodTo}) before it begins (${input.periodFrom}).`,
      });
    }

    const figures = await this.periodFigures.figuresFor(ctx, input.projectId, {
      from: input.periodFrom,
      to: input.periodTo,
    });
    const approvedByItem = new Map(
      figures.lines.map((line) => [line.boqItemId, line.approvedInPeriod]),
    );

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId },
        select: {
          id: true,
          clientId: true,
          quotedPercentage: true,
          clientRetentionFraction: true,
        },
      });
      // 404 and not 403: a 403 confirms the row exists, which is itself a leak across the boundary
      // row-level security is there to hold (FR-053).
      if (!project) throw new NotFoundException('Project not found');

      const workOrder =
        input.direction === BillDirection.to_subcontractor && input.workOrderId
          ? await tx.workOrder.findFirst({
              where: { id: input.workOrderId, projectId: input.projectId },
              select: { id: true, retentionPercent: true },
            })
          : null;
      if (input.direction === BillDirection.to_subcontractor && !workOrder) {
        throw new BadRequestException({
          statusCode: 400,
          code: PACKAGE_ERRORS.workOrderRequired,
          message: 'That work order is not on this project.',
        });
      }

      const counterpartyKey =
        input.direction === BillDirection.to_client
          ? project.clientId
          : (workOrder as { id: string }).id;

      const existing = await this.findOccupyingPackage(
        tx,
        input,
        counterpartyKey,
      );
      if (existing) {
        // FR-007 where the period matches exactly: the **existing** package is returned rather than
        // a second created. FR-002 where it merely overlaps: refused, naming the one that covers it,
        // because a day's measurement claimed on two bills is claimed twice.
        if (
          existing.samePeriod &&
          existing.status !== BillPackageStatus.abandoned
        ) {
          return { id: existing.id, reused: true };
        }
        if (existing.status !== BillPackageStatus.abandoned) {
          throw new ConflictException({
            statusCode: 409,
            code: PACKAGE_ERRORS.periodOverlaps,
            message:
              `${packageLabel(existing.sequenceNo)} already covers part of ` +
              `${input.periodFrom} to ${input.periodTo} (${existing.periodFrom} to ` +
              `${existing.periodTo}). A day's measurement claimed on two bills is claimed twice.`,
            packageId: existing.id,
            packageLabel: packageLabel(existing.sequenceNo),
          });
        }
      }

      const schedule = await this.resolveSchedule(
        tx,
        input.direction,
        input.projectId,
        input.workOrderId,
      );
      if (schedule.length === 0) {
        // Distinct from "this line is not on the schedule": there is no schedule at all, and the
        // remedy is to enter one rather than to correct a line (FR-011).
        throw new BadRequestException({
          statusCode: 400,
          code: PACKAGE_ERRORS.noSchedule,
          message:
            input.direction === BillDirection.to_client
              ? 'This project has no BOQ lines to bill against. Enter the BOQ first.'
              : 'This work order has no award lines to bill against.',
        });
      }

      const proposals = this.proposeFor(schedule, approvedByItem);
      const rates = await this.resolveRates(
        tx,
        companyId,
        input.direction,
        project,
        workOrder,
      );

      const sequenceNo = await this.nextSequenceNo(
        tx,
        input.projectId,
        input.direction,
        counterpartyKey,
      );
      const quotedPercentage =
        input.direction === BillDirection.to_client
          ? project.quotedPercentage.toNumber()
          : 0;

      // Each line's amount, from the one definition of what a line's amount is. `lineTotals` also
      // reports `remainingQty` as a **negative** figure when measurement has passed scope and flags
      // `exceedsScope` — which is FR-012b already built, so this reuses it rather than restating it.
      const priced = proposals.map((proposal) => ({
        proposal,
        totals: lineTotals(
          {
            quantity: Number(proposal.proposedQty ?? 0),
            rate: proposal.line.rate.toNumber(),
            scopeQty: proposal.line.scopeQty.toNumber(),
          },
          quotedPercentage,
        ),
      }));
      const gross = money(
        priced.reduce((sum, entry) => sum + entry.totals.amount, 0),
      );

      // One statement for the bill.
      const bill =
        input.direction === BillDirection.to_client
          ? await tx.clientBill.create({
              data: {
                companyId,
                projectId: input.projectId,
                billNumber: packageLabel(sequenceNo),
                billingDate: new Date(input.periodTo),
                quotedPercentage,
                grossAmount: gross,
                retentionAmount: 0,
                netAmount: gross,
                status: ClientBillStatus.draft,
              },
              select: { id: true },
            })
          : await tx.rABill.create({
              data: {
                companyId,
                projectId: input.projectId,
                billNumber: packageLabel(sequenceNo),
                amount: gross,
                billingDate: new Date(input.periodTo),
                status: RaBillStatus.draft,
                workOrderId: input.workOrderId ?? null,
                grossAmount: gross,
                netPayable: gross,
              },
              select: { id: true },
            });

      // One statement for the lines, returning their ids so the claims can point at them without a
      // second read. `createManyAndReturn` is the shape `boq-import.service.ts` adopted after the
      // 2026-10-04 timeout, and for the same reason.
      const lines =
        input.direction === BillDirection.to_client
          ? await tx.clientBillLine.createManyAndReturn({
              data: priced.map(({ proposal, totals }) => ({
                companyId,
                clientBillId: bill.id,
                boqTaskItemId: proposal.line.id,
                quantity: proposal.proposedQty ?? 0,
                // The frozen rate (FR-010). Read once, here — revising the schedule afterwards does
                // not move an issued bill.
                rate: proposal.line.rate,
                amount: totals.amount,
                exceedsScope: totals.exceedsScope,
              })),
              select: { id: true, boqTaskItemId: true },
            })
          : await tx.rABillLine.createManyAndReturn({
              data: priced.map(({ proposal, totals }) => ({
                companyId,
                raBillId: bill.id,
                workOrderBoqItemId: proposal.line.id,
                quantity: proposal.proposedQty ?? 0,
                rate: proposal.line.rate,
                amount: totals.amount,
              })),
              select: { id: true, workOrderBoqItemId: true },
            });

      // Keyed by the schedule line each bill line measures, so the claims can point at them without
      // a second read. Built explicitly rather than by `map`, because the two directions return two
      // shapes and inferring one type across both loses the key's.
      const lineIdByScheduleId = new Map<string, string>();
      for (const line of lines) {
        const scheduleLineId =
          'boqTaskItemId' in line
            ? line.boqTaskItemId
            : line.workOrderBoqItemId;
        lineIdByScheduleId.set(scheduleLineId, line.id);
      }

      // One statement for the package.
      const pkg = await tx.billPackage.create({
        data: {
          companyId,
          projectId: input.projectId,
          direction: input.direction,
          clientBillId:
            input.direction === BillDirection.to_client ? bill.id : null,
          raBillId:
            input.direction === BillDirection.to_subcontractor ? bill.id : null,
          counterpartyKey,
          periodFrom: new Date(input.periodFrom),
          periodTo: new Date(input.periodTo),
          sequenceNo,
          retentionFraction: rates.retentionFraction,
          cgstFraction: rates.cgstFraction,
          sgstFraction: rates.sgstFraction,
          igstFraction: rates.igstFraction,
          tdsFraction: rates.tdsFraction,
          // Phase C decides which applies and records how. Until then the project's own flag is the
          // honest answer and the source says so, rather than a derivation nobody performed.
          taxBasis: 'intra_state',
          taxBasisSource: 'from_project_flag',
          externalBillNo: input.externalBillNo ?? null,
          externalWorkOrderNo: input.externalWorkOrderNo ?? null,
          missingHeaderFields: [],
          status: BillPackageStatus.draft,
        },
        select: { id: true },
      });

      // One statement for the claims.
      await tx.billPackageLineClaim.createMany({
        data: proposals.map((proposal) => ({
          companyId,
          packageId: pkg.id,
          clientBillLineId:
            input.direction === BillDirection.to_client
              ? lineIdByScheduleId.get(proposal.line.id) ?? null
              : null,
          raBillLineId:
            input.direction === BillDirection.to_subcontractor
              ? lineIdByScheduleId.get(proposal.line.id) ?? null
              : null,
          proposedQty: proposal.proposedQty,
          proposalSource: proposal.proposalSource,
          claimedQty: proposal.proposedQty ?? 0,
          // Zero rather than null where a proposal exists: the claim starts at the proposal, so the
          // variance starts at nothing. Null only where there was no proposal to vary from.
          varianceQty: proposal.proposedQty === null ? null : 0,
          reason: null,
          overClaimed: false,
        })),
      });

      return { id: pkg.id, reused: false };
    });

    return this.view(ctx, created.id);
  }

  /**
   * One proposal per schedule line (FR-003, FR-003a, FR-003b).
   *
   * **The two kinds of empty are different facts.** A line whose BOQ measurement was read and was
   * nothing is proposed `0` with `approved_measurement`. A line with nowhere to read from — an award
   * line mapped to no BOQ line — is proposed `null` with `no_measurement_source`. Collapsing the
   * second into the first would say "no work was done this month" for every unmapped line of every
   * subcontractor bill, which is the direction the company bills monthly.
   */
  private proposeFor(
    schedule: ScheduleLine[],
    approvedByItem: Map<string, string>,
  ): Proposal[] {
    // FR-003b. Two award lines sharing one BOQ line would each be proposed that line's full
    // approved measurement, claiming the same work twice on one bill — and FR-008's
    // one-line-per-item rule would not catch it, because they are two different lines.
    const seen = new Map<string, string[]>();
    for (const line of schedule) {
      if (!line.boqTaskItemId) continue;
      const against = seen.get(line.boqTaskItemId) ?? [];
      against.push(line.boqNo);
      seen.set(line.boqTaskItemId, against);
    }
    const shared = [...seen.entries()].filter(([, lines]) => lines.length > 1);
    if (shared.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: PACKAGE_ERRORS.ambiguousAwardMapping,
        message:
          'These award lines share one BOQ line, so the measurement approved against it cannot be ' +
          `attributed to either without saying how: ${shared
            .map(([, lines]) => lines.join(' and '))
            .join(
              '; ',
            )}. Proposing the full quantity to each would claim the same work twice.`,
        lines: shared.map(([boqTaskItemId, lines]) => ({
          boqTaskItemId,
          scheduleLines: lines,
        })),
      });
    }

    return schedule.map((line) => {
      if (!line.boqTaskItemId) {
        return {
          line,
          proposedQty: null,
          proposalSource: ClaimProposalSource.no_measurement_source,
        };
      }
      return {
        line,
        // Every line of the project's BOQ comes back from 022 including those with no approved
        // measurement, carrying zero (022 FR-037) — so a line absent from the map is a line the
        // period figures did not know about, which for an award line's BOQ reference is possible
        // when that BOQ line belongs to another project. Treated as nothing approved, not as no
        // source: the source exists and read zero.
        proposedQty: dec(approvedByItem.get(line.boqTaskItemId) ?? '0'),
        proposalSource: ClaimProposalSource.approved_measurement,
      };
    });
  }

  /**
   * The package occupying this period, where there is one (FR-002, FR-002a, FR-007).
   *
   * Scoped to the schedule **and the counterparty**: one project is billed to its client and to
   * several subcontractors over the same month, legitimately, so a per-project check would refuse
   * the second of those. An abandoned package does not occupy its period — that is what abandoning
   * one is for (FR-002b).
   */
  private async findOccupyingPackage(
    tx: Prisma.TransactionClient,
    input: ComposeBillPackageInput,
    counterpartyKey: string,
  ): Promise<{
    id: string;
    sequenceNo: number;
    status: BillPackageStatus;
    periodFrom: string;
    periodTo: string;
    samePeriod: boolean;
  } | null> {
    const from = new Date(input.periodFrom);
    const to = new Date(input.periodTo);
    const found = await tx.billPackage.findFirst({
      where: {
        projectId: input.projectId,
        direction: input.direction,
        counterpartyKey,
        status: { not: BillPackageStatus.abandoned },
        // Overlap, in its only correct form: this period starts before that one ends, and ends
        // after it starts. Both bounds are inclusive (FR-001).
        periodFrom: { lte: to },
        periodTo: { gte: from },
      },
      orderBy: { sequenceNo: 'asc' },
      select: {
        id: true,
        sequenceNo: true,
        status: true,
        periodFrom: true,
        periodTo: true,
      },
    });
    if (!found) return null;
    return {
      id: found.id,
      sequenceNo: found.sequenceNo,
      status: found.status,
      periodFrom: iso(found.periodFrom),
      periodTo: iso(found.periodTo),
      samePeriod:
        iso(found.periodFrom) === input.periodFrom &&
        iso(found.periodTo) === input.periodTo,
    };
  }

  /**
   * The next running number for this counterparty.
   *
   * A gap is permitted and means nothing — the same judgement 022 FR-002c made about report numbers.
   * What matters is that two packages to one counterparty never carry one number, which the unique
   * index holds rather than this query.
   */
  private async nextSequenceNo(
    tx: Prisma.TransactionClient,
    projectId: string,
    direction: BillDirection,
    counterpartyKey: string,
  ): Promise<number> {
    const last = await tx.billPackage.findFirst({
      where: { projectId, direction, counterpartyKey },
      orderBy: { sequenceNo: 'desc' },
      select: { sequenceNo: true },
    });
    return (last?.sequenceNo ?? 0) + 1;
  }

  /**
   * Sets one line's claimed quantity (FR-004, FR-004a, FR-006).
   *
   * A reduction needs a reason; an over-claim needs a reason **and** sets the flag. Returning the
   * claim to its proposal **clears** the reason (FR-004a): a reason beside a zero variance argues on
   * the measurement sheet for a deduction the bill does not make.
   */
  async setClaim(
    ctx: RlsContext,
    packageId: string,
    claimId: string,
    input: SetClaimInput,
  ): Promise<BillPackageView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const claim = await tx.billPackageLineClaim.findFirst({
        where: { id: claimId, packageId },
        select: {
          id: true,
          proposedQty: true,
          proposalSource: true,
          package: { select: { status: true } },
        },
      });
      if (!claim) throw new NotFoundException('Bill line not found');
      if (claim.package.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message:
            'This package has been issued. Revise it rather than editing a line — what a bill ' +
            'stated when it went out has to stay readable (FR-045).',
        });
      }

      const claimed = dec(input.claimedQty);
      const proposed = claim.proposedQty;
      const variance = proposed === null ? null : claimed.minus(proposed);
      const reason = input.reason?.trim() ? input.reason.trim() : null;

      // A claim against a line with no measurement source is not a variance from anything, so it
      // needs a reason of its own kind: there is nothing to reduce or exceed, only a figure somebody
      // has to stand behind.
      const needsReason =
        variance === null ? !claimed.isZero() : !variance.isZero();
      if (needsReason && !reason) {
        throw new BadRequestException({
          statusCode: 400,
          code: PACKAGE_ERRORS.claimNeedsReason,
          message:
            variance === null
              ? 'There is no approved measurement behind this line, so a claim on it needs a ' +
                'written reason.'
              : 'This claim differs from the approved measurement, so it needs a written reason. ' +
                'The reason is reproduced on the measurement sheet verbatim — it is the argument ' +
                'the document exists to settle.',
        });
      }

      await tx.billPackageLineClaim.update({
        where: { id: claim.id },
        data: {
          claimedQty: claimed,
          varianceQty: variance,
          // Cleared where the claim matches its proposal (FR-004a).
          reason: needsReason ? reason : null,
          overClaimed:
            proposed !== null && claimed.greaterThan(proposed) ? true : false,
        },
      });
      return null;
    });

    return this.view(ctx, packageId);
  }

  /**
   * Abandons a draft, releasing its period (FR-002b).
   *
   * The only way out of a mistakenly-opened draft. A package in any status occupies its period
   * (FR-002a), so without this the alternative is deleting the row that records the period was
   * billed — which FR-044a forbids for an issued bill and this makes unnecessary for a draft.
   */
  async abandon(ctx: RlsContext, packageId: string): Promise<void> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      // A conditional update whose row count is checked, rather than a read then a write: two
      // callers abandoning and issuing at once must not both succeed.
      const moved = await tx.billPackage.updateMany({
        where: { id: packageId, status: BillPackageStatus.draft },
        data: { status: BillPackageStatus.abandoned },
      });
      if (moved.count === 1) return;

      const existing = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('Bill package not found');
      throw new ConflictException({
        statusCode: 409,
        code: PACKAGE_ERRORS.packageIssued,
        message:
          'Only a draft can be abandoned. An issued bill is revised or certified, never removed — ' +
          'it is a document that was sent.',
      });
    });
  }

  /** A package and its claims, as a caller reads them. */
  async view(ctx: RlsContext, packageId: string): Promise<BillPackageView> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        include: {
          claims: {
            include: {
              clientBillLine: {
                select: {
                  id: true,
                  rate: true,
                  amount: true,
                  quantity: true,
                  exceedsScope: true,
                  boqTaskItem: {
                    select: {
                      id: true,
                      boqNo: true,
                      taskName: true,
                      unit: true,
                      scopeQty: true,
                    },
                  },
                },
              },
              raBillLine: {
                select: {
                  id: true,
                  rate: true,
                  amount: true,
                  quantity: true,
                  workOrderBoqItem: {
                    select: {
                      id: true,
                      description: true,
                      unit: true,
                      awardedQty: true,
                      boqTaskItem: { select: { boqNo: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      const claims: BillPackageClaimView[] = pkg.claims.map((claim) => {
        const client = claim.clientBillLine;
        const ra = claim.raBillLine;
        const rate = client?.rate ?? ra?.rate ?? dec(0);
        const scopeQty =
          client?.boqTaskItem.scopeQty ??
          ra?.workOrderBoqItem.awardedQty ??
          dec(0);
        const totals = lineTotals({
          quantity: Number(claim.claimedQty),
          rate: rate.toNumber(),
          scopeQty: scopeQty.toNumber(),
        });
        return {
          id: claim.id,
          scheduleLineId:
            client?.boqTaskItem.id ?? ra?.workOrderBoqItem.id ?? '',
          boqNo:
            client?.boqTaskItem.boqNo ??
            ra?.workOrderBoqItem.boqTaskItem?.boqNo ??
            '',
          description:
            client?.boqTaskItem.taskName ??
            ra?.workOrderBoqItem.description ??
            '',
          unit: client?.boqTaskItem.unit ?? ra?.workOrderBoqItem.unit ?? '',
          proposedQty:
            claim.proposedQty === null ? null : claim.proposedQty.toFixed(3),
          proposalSource: claim.proposalSource,
          claimedQty: claim.claimedQty.toFixed(3),
          varianceQty:
            claim.varianceQty === null ? null : claim.varianceQty.toFixed(3),
          reason: claim.reason,
          overClaimed: claim.overClaimed,
          rate: rate.toFixed(2),
          amount: (client?.amount ?? ra?.amount ?? dec(0)).toFixed(2),
          // Negative where measurement has passed scope (FR-012b). "0 remaining" and "12 over" are
          // different facts, and a clamp hides the second behind the first.
          remainingQty: totals.remainingQty.toFixed(3),
          exceedsScope: totals.exceedsScope,
          unpriced: rate.isZero(),
        };
      });

      return {
        id: pkg.id,
        projectId: pkg.projectId,
        direction: pkg.direction,
        label: packageLabel(pkg.sequenceNo),
        sequenceNo: pkg.sequenceNo,
        periodFrom: iso(pkg.periodFrom),
        periodTo: iso(pkg.periodTo),
        status: pkg.status,
        rates: {
          retentionFraction: pkg.retentionFraction.toFixed(6),
          cgstFraction: pkg.cgstFraction.toFixed(6),
          sgstFraction: pkg.sgstFraction.toFixed(6),
          igstFraction: pkg.igstFraction.toFixed(6),
          tdsFraction: pkg.tdsFraction.toFixed(6),
        },
        claims,
        // Counted, not refused — FR-009's refusal is at issue. Reported here so the engineer sees it
        // while there is still time to price the line.
        unpricedClaimedCount: claims.filter(
          (claim) => claim.unpriced && Number(claim.claimedQty) !== 0,
        ).length,
      };
    });
  }
}

/** A stored date as the day it is, with no timezone in the way. */
function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
