import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BillDirection,
  BillPackageStatus,
  BillTaxBasis,
  CheckListAnswer,
  ClaimProposalSource,
  ClientBillStatus,
  DwrStatus,
  Prisma,
  RaBillStatus,
  WorkOrderStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { CompaniesService } from '../../../settings/companies/companies.service';
import { DwrPeriodFiguresService } from '../../dwr/dwr-period-figures.service';
import { ProjectSourcesRegistry } from '../../portfolio/project-sources.registry';
import { lineTotals, money } from '../bill-totals';
import type { AbstractColumn } from './bill-abstract';
import { billAbstract, displayRupees } from './bill-abstract';
import { decideTaxBasis } from './bill-tax';
import {
  CHECK_LIST_FOOTER,
  CHECK_LIST_SIGNATORIES,
  checkListGaps,
  mergeCheckList,
} from './check-list';
import type { SetBillAdjustmentsDto } from './dto/bill-adjustments.dto';
import { BILLING_ERRORS } from '../billing-error-codes';
import { PACKAGE_ERRORS } from './package-error-codes';
import {
  nextClientBillNumber,
  nextRaBillNumber,
  sequenceOf,
  packageLabel,
} from '../bill-number';
import { sortByBoqNo } from '../../boq/boq-order';

/**
 * Re-exported: `packageLabel` moved to `../bill-number` when a second caller appeared, and
 * `bill-package-view.builder.ts` has imported it from here since 023.
 */
export { packageLabel };

/** One party's statutory details, however they were sourced. */
interface PartyIdentity {
  name: string | null;
  gstin: string | null;
  pan: string | null;
  state: string | null;
  address: string | null;
  code: string | null;
}

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
  /**
   * The most recent approved daily report on the project — **read only when this package proposed
   * nothing at all**, and null otherwise.
   *
   * A package whose every line proposes zero looks, from the screen, exactly like a system that
   * has stopped working: the award is approved, the lines are there, and every quantity is 0.000.
   * The fact that resolves it lives outside the package — the last day anybody approved work — and
   * no amount of looking at the claims can produce it. So it is read here and carried on the view.
   *
   * Null **together with** an all-zero proposal is the other answer, and a different one: no work
   * has ever been approved on this project.
   */
  latestApprovedWork: { workDate: string; dprNumber: string } | null;
}

/** The only rendering of a package's number (`RA-12`), so two documents cannot disagree. */

/**
 * The columns `setAdjustments` may write (025 FR-044).
 *
 * A list rather than `Object.keys(dto)`: the DTO's shape is a wire contract and this is the set of
 * columns a caller is permitted to move, and conflating the two is how a field added to the DTO for
 * display would silently become writable. `retentionAmount`, `tdsAmount` and `workDone` are absent
 * because each is computed — accepting one would let a bill state a retention its own frozen rate
 * does not produce.
 */
const ADJUSTABLE = [
  'releaseWithheld',
  'recoveryDiesel',
  'debitAgainstCivil',
  'otherRecoveries',
  'mechanicalDebit',
  'mobilizationAdvance',
  'performanceSecurity',
  'theftWithheld',
  'mobilizationAdvanceTotal',
  'performanceSecurityTotal',
] as const satisfies readonly (keyof SetBillAdjustmentsDto)[];

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
    /**
     * A subcontractor's statutory details, read through the registry rather than by injecting
     * `VendorsService` (023 FR-026).
     *
     * `PartnersModule` already imports `ProjectsModule`, so importing it back would close a cycle
     * across five modules — the wall 018's `WorkOrdersService` documents. `partners` registers
     * itself instead, exactly as `plant` registers the equipment logbook for 022.
     */
    private readonly sources: ProjectSourcesRegistry,
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
      // Text order puts 10 before 2 — see `boq-order.ts`.
      sortByBoqNo(items);
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
          cgstApplicable: true,
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
              select: {
                id: true,
                retentionPercent: true,
                partnerId: true,
                status: true,
              },
            })
          : null;
      if (input.direction === BillDirection.to_subcontractor && !workOrder) {
        throw new BadRequestException({
          statusCode: 400,
          code: PACKAGE_ERRORS.workOrderRequired,
          message: 'That work order is not on this project.',
        });
      }

      // 028 FR-009. An award is a commitment, and until 028 it became one the moment somebody
      // saved it while the first bill *under* it needed an approval — the control was the wrong way
      // round. Refusing here is what gives the approval its force: without it, `pending_approval`
      // would be a label on a screen that changed nothing.
      //
      // `draft` and `pending_approval` are both refused, and the message distinguishes them,
      // because the remedy differs — one needs sending, the other needs deciding.
      if (
        workOrder &&
        workOrder.status !== WorkOrderStatus.active &&
        workOrder.status !== WorkOrderStatus.completed
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.workOrderNotApproved,
          message:
            workOrder.status === WorkOrderStatus.draft
              ? 'This work order has not been sent for approval yet, so there is no approved ' +
                'award to bill against. Send it for approval on Subcontractors first.'
              : 'This work order is waiting for approval. A bill cannot be raised against an ' +
                'award nobody has approved.',
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

      // FR-016: derived from the two parties' own registration numbers, with the project's flag as
      // the fallback and **the derivation reported either way** (FR-016a). Decided at composition
      // because the rate it selects is frozen onto the bill; a basis chosen at render time would
      // change an issued document the first time a party's registration was corrected.
      const parties = await this.partyGstins(
        ctx,
        tx,
        companyId,
        input.direction,
        project.clientId,
        workOrder?.partnerId ?? null,
      );
      const taxDecision = decideTaxBasis({
        issuerGstin: parties.issuerGstin,
        receiverGstin: parties.receiverGstin,
        projectCgstApplicable: project.cgstApplicable,
      });

      // **One number, minted once.** The bill's number is the running account — scoped to the work
      // order by 028 FR-001, and what the counterparty signs for — so the package takes its
      // sequence from it rather than counting packages separately. Both spell themselves `RA-nn`
      // and 027 observed they read identically in the ordinary case; they stop doing so the moment
      // a bill is raised on the sheet, which consumes a bill number and no package sequence. On
      // 2026-10-08 that put RA-04 on the document and RA-06 on the subcontractor's account, for
      // one bill, on two screens open at the same time.
      //
      // Allocated here rather than at the create below so the sequence can be read out of it.
      // Uniqueness survives the change: bill numbers are unique per work order and per project,
      // which is the same population `@@unique([projectId, direction, counterpartyKey,
      // sequenceNo])` scopes to, and a number is freed only by discarding the bill — which
      // cascades the package holding it.
      const billNumber =
        input.direction === BillDirection.to_client
          ? await nextClientBillNumber(tx, input.projectId)
          : await nextRaBillNumber(tx, (workOrder as { id: string }).id);
      const sequenceNo = sequenceOf(billNumber) ?? 1;
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
      // Both creates are wrapped, because the number each allocates is read-then-written and two
      // composes racing on one subject take the same one. 028 FR-003: this path had no handler at
      // all, so `[P2002]: Invalid 'prisma.rABill.create()' invocation` reached a user's screen —
      // `RaBillsService.compose` and `ClientBillsService.compose` have both mapped it for a year.
      const bill = await this.createBillOrConflict(async () =>
        input.direction === BillDirection.to_client
          ? tx.clientBill.create({
              data: {
                companyId,
                projectId: input.projectId,
                // Counted from the bills on this project, not from `sequenceNo` — the bill sheet
                // composes into the same table, and numbering from the package's own sequence
                // could not see what the sheet had already raised (027). The package's sequence
                // now follows this, above.
                billNumber,
                billingDate: new Date(input.periodTo),
                quotedPercentage,
                grossAmount: gross,
                retentionAmount: 0,
                netAmount: gross,
                status: ClientBillStatus.draft,
              },
              select: { id: true },
            })
          : tx.rABill.create({
              data: {
                companyId,
                projectId: input.projectId,
                // Counted from the bills on this work order, not from `sequenceNo` — the RA bill
                // sheet composes into the same table, and numbering from the package's own
                // sequence could not see what the sheet had already raised (027). The package's
                // sequence now follows this, above.
                billNumber,
                amount: gross,
                billingDate: new Date(input.periodTo),
                status: RaBillStatus.draft,
                // Never null, and the bill's number depends on it: uniqueness is scoped to the
                // work order (028 FR-001) and Postgres does not collide NULLs, so a bill with no
                // work order would be unconstrained. The guard is above — `workOrderRequired`
                // refuses a subcontractor package without one — and this reads it from the row
                // that guard resolved rather than from the input, so the two cannot drift.
                workOrderId: (workOrder as { id: string }).id,
                grossAmount: gross,
                netPayable: gross,
              },
              select: { id: true },
            }),
      );

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
          taxBasis: taxDecision.basis,
          taxBasisSource: taxDecision.source,
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

  /**
   * Issues the package: freezes every figure and the statutory header (FR-044).
   *
   * **Freezing is what makes the rest of the feature true.** FR-028's "produced twice is identical"
   * and FR-014's "up to previous is read from the predecessor's stored position" both rest on this
   * row stopping moving at this moment. After it, the party records can be corrected, a statute can
   * change a tax rate, and the BOQ can be revised — and this document still reproduces exactly as
   * the client has it on paper.
   *
   * Refuses an unpriced line carrying a non-zero claim (FR-009): 018's `unpriced` flag means
   * "nobody has priced this", not "this is free", so issuing one bills work at zero and nothing
   * downstream would notice a bill that was quietly short.
   *
   * Reports, never refuses: the header fields that could not be filled (FR-027, FR-027a) and the
   * check-list gaps (FR-043, FR-043a). The client's own footer says non-compliance "may delay the
   * process", which is a human judgement rather than a validation rule — and a bill blocked by an
   * unticked box is a bill nobody can send while the person who could tick it is on site.
   */
  async issue(
    ctx: RlsContext,
    companyId: string,
    userId: string | null,
    packageId: string,
  ): Promise<{
    package: BillPackageView;
    missingHeaderFields: string[];
    checkListGaps: ReturnType<typeof checkListGaps>;
  }> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        include: {
          project: {
            select: { name: true, clientId: true, cgstApplicable: true },
          },
          raBill: { select: { workOrderId: true, grossAmount: true } },
          clientBill: { select: { grossAmount: true } },
          claims: {
            select: {
              claimedQty: true,
              clientBillLine: {
                select: {
                  rate: true,
                  boqTaskItem: { select: { boqNo: true } },
                },
              },
              raBillLine: { select: { rate: true } },
            },
          },
          checkListAnswers: {
            select: { questionKey: true, answer: true, answeredAt: true },
          },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      if (pkg.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message: `${packageLabel(pkg.sequenceNo)} has already been issued.`,
        });
      }

      // FR-009, and it is deliberately here rather than at composition: FR-003 proposes **every**
      // line, so a package may legitimately carry an unpriced one at zero. What cannot leave the
      // building is an unpriced line with a quantity against it.
      const unpriced = pkg.claims.filter(
        (claim) =>
          !claim.claimedQty.isZero() &&
          (
            claim.clientBillLine?.rate ??
            claim.raBillLine?.rate ??
            dec(0)
          ).isZero(),
      );
      if (unpriced.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          code: PACKAGE_ERRORS.unpricedLineClaimed,
          message:
            'These lines carry a claim and no rate, so issuing this bill would bill the work at ' +
            `zero: ${unpriced
              .map(
                (claim) =>
                  claim.clientBillLine?.boqTaskItem.boqNo ?? '(award line)',
              )
              .join(
                ', ',
              )}. A zero rate is almost always an unpriced line rather than free work.`,
          boqNumbers: unpriced.map(
            (claim) => claim.clientBillLine?.boqTaskItem.boqNo ?? '',
          ),
        });
      }

      const header = await this.freezeHeader(ctx, tx, companyId, pkg);
      const abstract = await this.abstractColumns(tx, pkg);

      await tx.billPackage.update({
        where: { id: pkg.id },
        data: {
          status: BillPackageStatus.issued,
          issuedAt: new Date(),
          issuedByUserId: userId,
          ...header.columns,
          missingHeaderFields: header.missing,
          // The cumulative position, frozen (FR-014a, D1). From here the next bill reads these and
          // nothing recomputes them.
          ...abstract,
        },
      });

      // **The 018 bill this package is built on leaves draft here too** (025 FR-043).
      //
      // Composing creates it in `draft`, which is right while the package is a draft. Nothing then
      // moved it, so an issued package — a bill that has gone out, with every figure frozen and a
      // PDF emailed — sat on a bill the rest of the product still read as unsent. The project
      // position counts bills that have left draft, so Position reported no revenue at all for
      // every running-account bill ever issued, and the Client bills tab showed it as a draft
      // beside it. Issuing is the act of sending; one act, one status, in one transaction.
      //
      // **And what it is payable at** (2026-10-09). The bill row carries its own
      // `retentionAmount` and net, and 028 stopped the bill sheet writing them — so for a bill
      // composed through a package they stayed at zero, and net came out equal to gross. Two
      // screens then disagreed about one bill: the Subcontractors list read the row and said
      // ₹35,193.50 while the document said ₹40,120.59, and `bill-payments.service.ts` reads the
      // same column to decide what a bill may be paid, so the amount actually owed was refused as
      // an overpayment.
      //
      // Copied here rather than computed on the way out, because this is the moment the payable
      // becomes a fact: the frozen column beside it was written in this same statement, from this
      // same abstract. A later reader recomputing it could only get a different answer by being
      // wrong. `netPayable` carries tax, as the document's payable does — `grossAmount` is the
      // work done before it, and the P&L reads that one.
      const settled = {
        retentionAmount: abstract.retentionAmount,
        netPayable: abstract.payable,
      };
      if (pkg.clientBillId) {
        await tx.clientBill.update({
          where: { id: pkg.clientBillId },
          data: {
            status: ClientBillStatus.submitted,
            submittedAt: new Date(),
            retentionAmount: settled.retentionAmount,
            netAmount: settled.netPayable,
          },
        });
      } else if (pkg.raBillId) {
        await tx.rABill.update({
          where: { id: pkg.raBillId },
          data: {
            status: RaBillStatus.submitted,
            submittedAt: new Date(),
            ...settled,
          },
        });
      }

      return {
        missing: header.missing,
        gaps: checkListGaps(mergeCheckList(pkg.checkListAnswers)),
      };
    });

    return {
      package: await this.view(ctx, packageId),
      missingHeaderFields: result.missing,
      checkListGaps: result.gaps,
    };
  }

  /**
   * The statutory header, copied **once** and never re-read (FR-026, FR-028).
   *
   * Each party comes through the service that owns its table — Principle I forbids reading
   * `settings.Company` or `partners.Vendor` from here — and `projects.Client` is this module's own.
   * A field the party's record does not carry is listed in `missingHeaderFields` rather than
   * refused: `Client` has no `state` and no `pan` today, so on a bill to a client those two are the
   * likeliest gaps, and a bill that cannot be produced because a permanent account number is
   * unrecorded is worse than one produced with a blank somebody fills in by hand.
   */
  private async freezeHeader(
    ctx: RlsContext,
    tx: Prisma.TransactionClient,
    companyId: string,
    pkg: {
      direction: BillDirection;
      project: { name: string; clientId: string };
      raBill: { workOrderId: string | null } | null;
    },
  ): Promise<{ columns: Record<string, string | null>; missing: string[] }> {
    const company = await this.companies.getBillingIdentity(companyId);

    let issuer: PartyIdentity;
    let receiver: PartyIdentity;

    if (pkg.direction === BillDirection.to_client) {
      const client = await tx.client.findFirst({
        where: { id: pkg.project.clientId },
        select: {
          name: true,
          gstin: true,
          address: true,
          pan: true,
          state: true,
        },
      });
      // The authority occupies the "Company Name" slot and the company is the contractor beneath
      // it — the client's own layout, and the reason this is a binding rather than a second
      // renderer.
      //
      // **`pan` and `state` read from the client since 025 FR-039.** Both were hardcoded null here
      // because the table carried neither column, so every bill issued to a client reported two
      // missing header fields — on the real RA-12 those two rows are filled in by hand.
      //
      // They do **not** move the tax decision: `decideTaxBasis` reads the two GSTINs, whose first
      // two characters are the state code, so a client with a GSTIN has always been taxed
      // correctly. These are what the header *prints*, which is a smaller claim than it looks and
      // worth stating precisely rather than overselling.
      //
      // A client recorded before these columns existed still reports them missing, which is the
      // right answer: unrecorded is not the same as absent from the model.
      issuer = {
        name: client?.name ?? null,
        gstin: client?.gstin ?? null,
        pan: client?.pan ?? null,
        state: client?.state ?? null,
        address: client?.address ?? null,
        code: null,
      };
      receiver = { ...company, code: null };
    } else {
      const workOrder = pkg.raBill?.workOrderId
        ? await tx.workOrder.findFirst({
            where: { id: pkg.raBill.workOrderId },
            select: { partnerId: true, workDetail: true },
          })
        : null;
      const source = this.sources.vendorIdentitySource();
      const vendor =
        workOrder?.partnerId && source
          ? await source.getBillingIdentity(workOrder.partnerId, companyId)
          : null;
      issuer = { ...company, code: null };
      receiver = vendor ?? {
        name: null,
        gstin: null,
        pan: null,
        state: null,
        address: null,
        code: null,
      };
    }

    const columns: Record<string, string | null> = {
      issuerName: issuer.name,
      issuerGstin: issuer.gstin,
      issuerPan: issuer.pan,
      issuerState: issuer.state,
      issuerAddress: issuer.address,
      receiverName: receiver.name,
      receiverGstin: receiver.gstin,
      receiverPan: receiver.pan,
      receiverState: receiver.state,
      receiverAddress: receiver.address,
      receiverCode: receiver.code,
    };

    const missing = Object.entries(columns)
      .filter(([, value]) => value === null)
      .map(([key]) => key);

    return { columns, missing };
  }

  /**
   * The cumulative columns to freeze at issue (FR-014a).
   *
   * This bill's own figures added to the previous **issued** package's stored ones, which is the
   * chain FR-014 reads back. Nothing here is recomputed from current data — that is the whole of
   * decision D1.
   */
  private async abstractColumns(
    tx: Prisma.TransactionClient,
    pkg: {
      projectId: string;
      direction: BillDirection;
      counterpartyKey: string;
      sequenceNo: number;
      taxBasis: BillTaxBasis;
      retentionFraction: Prisma.Decimal;
      cgstFraction: Prisma.Decimal;
      sgstFraction: Prisma.Decimal;
      igstFraction: Prisma.Decimal;
      tdsFraction: Prisma.Decimal;
      releaseWithheld: Prisma.Decimal;
      recoveryDiesel: Prisma.Decimal;
      debitAgainstCivil: Prisma.Decimal;
      otherRecoveries: Prisma.Decimal;
      mechanicalDebit: Prisma.Decimal;
      mobilizationAdvance: Prisma.Decimal;
      performanceSecurity: Prisma.Decimal;
      theftWithheld: Prisma.Decimal;
      mobilizationAdvanceTotal: Prisma.Decimal | null;
      performanceSecurityTotal: Prisma.Decimal | null;
      clientBill: { grossAmount: Prisma.Decimal } | null;
      raBill: { grossAmount: Prisma.Decimal } | null;
    },
  ): Promise<Record<string, Prisma.Decimal>> {
    const previous = await this.previousIssuedColumn(tx, pkg);
    const workDone =
      pkg.clientBill?.grossAmount ?? pkg.raBill?.grossAmount ?? dec(0);

    const abstract = billAbstract({
      workDone,
      entered: {
        releaseWithheld: pkg.releaseWithheld,
        recoveryDiesel: pkg.recoveryDiesel,
        debitAgainstCivil: pkg.debitAgainstCivil,
        otherRecoveries: pkg.otherRecoveries,
        mechanicalDebit: pkg.mechanicalDebit,
        mobilizationAdvance: pkg.mobilizationAdvance,
        performanceSecurity: pkg.performanceSecurity,
        theftWithheld: pkg.theftWithheld,
      },
      rates: {
        retentionFraction: pkg.retentionFraction,
        cgstFraction: pkg.cgstFraction,
        sgstFraction: pkg.sgstFraction,
        igstFraction: pkg.igstFraction,
        tdsFraction: pkg.tdsFraction,
      },
      taxBasis: pkg.taxBasis,
      previous,
      oneTime: {
        mobilizationAdvance: {
          total: pkg.mobilizationAdvanceTotal,
          recoveredBefore: previous?.mobilizationAdvance ?? dec(0),
        },
        performanceSecurity: {
          total: pkg.performanceSecurityTotal,
          recoveredBefore: previous?.performanceSecurity ?? dec(0),
        },
      },
    });

    const { thisBill, uptoDate } = abstract;
    return {
      workDone: thisBill.workDone,
      cgstAmount: thisBill.cgstAmount,
      sgstAmount: thisBill.sgstAmount,
      igstAmount: thisBill.igstAmount,
      retentionAmount: thisBill.retentionAmount,
      tdsAmount: thisBill.tdsAmount,
      payable: thisBill.payable,
      workDoneUptoDate: uptoDate.workDone,
      releaseWithheldUptoDate: uptoDate.releaseWithheld,
      cgstAmountUptoDate: uptoDate.cgstAmount,
      sgstAmountUptoDate: uptoDate.sgstAmount,
      igstAmountUptoDate: uptoDate.igstAmount,
      recoveryDieselUptoDate: uptoDate.recoveryDiesel,
      debitAgainstCivilUptoDate: uptoDate.debitAgainstCivil,
      otherRecoveriesUptoDate: uptoDate.otherRecoveries,
      mechanicalDebitUptoDate: uptoDate.mechanicalDebit,
      mobilizationAdvanceUptoDate: uptoDate.mobilizationAdvance,
      retentionAmountUptoDate: uptoDate.retentionAmount,
      performanceSecurityUptoDate: uptoDate.performanceSecurity,
      theftWithheldUptoDate: uptoDate.theftWithheld,
      tdsAmountUptoDate: uptoDate.tdsAmount,
      payableUptoDate: uptoDate.payable,
    };
  }

  /**
   * Sets the month's entered recoveries, deductions and withholdings (025 FR-044).
   *
   * **Draft only.** Issue freezes every figure on this bill, and a recovery changed afterwards is
   * either an edit to a signed document or a deduction the bill never actually made — the same
   * reasoning that refuses a debit applied after issue.
   *
   * **Omission leaves a column unchanged; an explicit `0` sets it to zero.** A caller that posted
   * the whole set every time would be indistinguishable from one clearing the fields it did not
   * render, and these are money columns.
   */
  async setAdjustments(
    ctx: RlsContext,
    packageId: string,
    input: SetBillAdjustmentsDto,
  ): Promise<BillPackageView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { id: true, status: true, sequenceNo: true },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      if (pkg.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message:
            `${packageLabel(
              pkg.sequenceNo,
            )} has been issued, so its recoveries and ` +
            'deductions cannot change. Record them on the next bill — a deduction added after ' +
            'issue is either a change to a signed document or one this bill never made.',
        });
      }

      // Built field by field rather than spread, so a key the caller omitted never reaches the
      // update as `undefined` and a key it sent as "0" always does.
      const data: Prisma.BillPackageUpdateInput = {};
      for (const key of ADJUSTABLE) {
        const value = input[key];
        if (value !== undefined) data[key] = dec(value);
      }
      if (Object.keys(data).length > 0) {
        await tx.billPackage.update({ where: { id: pkg.id }, data });
      }
    });
    return this.view(ctx, packageId);
  }

  /**
   * Records a revision (FR-045, FR-046).
   *
   * Counted with a reason. What the package stated at issue stays readable — the frozen columns are
   * not touched — because a bill is a document that was sent, and a reader reconciling a payment
   * against a bill whose history has moved is the one thing nobody can do.
   */
  async revise(
    ctx: RlsContext,
    userId: string | null,
    packageId: string,
    reason: string,
  ): Promise<BillPackageView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const moved = await tx.billPackage.updateMany({
        where: {
          id: packageId,
          status: {
            in: [BillPackageStatus.issued, BillPackageStatus.certified],
          },
        },
        data: {
          revisionCount: { increment: 1 },
          lastRevisedAt: new Date(),
          lastRevisedByUserId: userId,
          lastRevisionReason: reason,
        },
      });
      if (moved.count === 1) return;
      const existing = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Bill package not found');
      throw new ConflictException({
        statusCode: 409,
        code: PACKAGE_ERRORS.packageIssued,
        message:
          'Only an issued bill can be revised. A draft is simply edited.',
      });
    });
    return this.view(ctx, packageId);
  }

  /**
   * Records what the counterparty certified (FR-047).
   *
   * Kept **beside** the billed figure and never instead of it — 018's existing reasoning, kept. The
   * variance between the two is what a project manager chases, and overwriting the billed amount
   * erases the fact that there was a shortfall at all.
   */
  async certify(
    ctx: RlsContext,
    packageId: string,
    certifiedAmount: string,
  ): Promise<BillPackageView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { id: true, status: true, clientBillId: true },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      if (pkg.status === BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message: 'A draft cannot be certified — issue it first.',
        });
      }

      await tx.billPackage.update({
        where: { id: pkg.id },
        data: { status: BillPackageStatus.certified },
      });
      // The certified figure lives on the bill 018 already owns, beside its gross and net — and
      // the bill's own status moves with the package's, for the reason `issue` does the same: a
      // package and the bill under it describing different stages of the same claim is how the
      // Client bills tab came to show a draft beside a bill that had been issued and emailed.
      if (pkg.clientBillId) {
        await tx.clientBill.update({
          where: { id: pkg.clientBillId },
          data: {
            status: ClientBillStatus.certified,
            certifiedAmount,
            certifiedAt: new Date(),
          },
        });
      }
    });
    return this.view(ctx, packageId);
  }

  /**
   * The two parties' registration numbers, in the positions the bill's direction puts them (FR-025).
   *
   * **The issuing slot is not always us.** For a bill the company issues to a subcontractor, the
   * company issues it. For a bill issued to a government client, the authority occupies the
   * "Company Name" slot and the company is the contractor beneath it — which is the client's own
   * layout and the reason the renderer has two bindings rather than two renderers.
   *
   * Each party is read through the service that owns its table, never across the schema boundary
   * (Principle I). `projects.Client` is this module's own, so it is read directly.
   */
  private async partyGstins(
    ctx: RlsContext,
    tx: Prisma.TransactionClient,
    companyId: string,
    direction: BillDirection,
    clientId: string,
    partnerId: string | null,
  ): Promise<{ issuerGstin: string | null; receiverGstin: string | null }> {
    const company = await this.companies.getBillingIdentity(companyId);

    if (direction === BillDirection.to_client) {
      const client = await tx.client.findFirst({
        where: { id: clientId },
        select: { gstin: true },
      });
      return {
        issuerGstin: client?.gstin ?? null,
        receiverGstin: company.gstin,
      };
    }

    // A work order with no partner on it is possible — the column is nullable — so the receiver's
    // number is simply unknown rather than an error, and the fallback reports itself.
    const source = this.sources.vendorIdentitySource();
    const vendor =
      partnerId && source
        ? await source.getBillingIdentity(partnerId, companyId)
        : null;
    return {
      issuerGstin: company.gstin,
      receiverGstin: vendor?.gstin ?? null,
    };
  }

  /**
   * The abstract: four blocks, three columns (FR-012 to FR-023).
   *
   * **The up-to-previous column is read from the previous package's stored figures** (FR-013a,
   * FR-014) — the previous being the highest sequence number below this one, to the same
   * counterparty, that has been **issued**. Never derived from this bill's own up-to-date figure
   * less its own amount: that is numerically equal only while the chain is unbroken, and it makes
   * FR-035's footer identity a restatement of its own definition.
   *
   * A package that has not been issued has no frozen cumulative position (FR-014a), so its
   * up-to-date column is marked **provisional** (FR-013b). A figure that changes when the engineer
   * presses Issue is a figure they did not approve.
   */
  async abstractFor(
    ctx: RlsContext,
    packageId: string,
  ): Promise<{
    packageId: string;
    label: string;
    periodFrom: string;
    periodTo: string;
    taxBasis: string;
    /** How the basis was decided, reported rather than merely stored (FR-016a). */
    taxBasisSource: string;
    /** True while the package is a draft: the cumulative column is not yet frozen (FR-013b). */
    cumulativeProvisional: boolean;
    rates: FrozenRates;
    columns: {
      thisBill: Record<string, string>;
      uptoPrevious: Record<string, string>;
      uptoDate: Record<string, string>;
    };
  }> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        include: {
          clientBill: { select: { grossAmount: true } },
          raBill: { select: { grossAmount: true } },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      const previous = await this.previousIssuedColumn(tx, pkg);

      const abstract = billAbstract({
        workDone:
          pkg.clientBill?.grossAmount ?? pkg.raBill?.grossAmount ?? dec(0),
        entered: {
          releaseWithheld: pkg.releaseWithheld,
          recoveryDiesel: pkg.recoveryDiesel,
          debitAgainstCivil: pkg.debitAgainstCivil,
          otherRecoveries: pkg.otherRecoveries,
          mechanicalDebit: pkg.mechanicalDebit,
          mobilizationAdvance: pkg.mobilizationAdvance,
          performanceSecurity: pkg.performanceSecurity,
          theftWithheld: pkg.theftWithheld,
        },
        rates: {
          retentionFraction: pkg.retentionFraction,
          cgstFraction: pkg.cgstFraction,
          sgstFraction: pkg.sgstFraction,
          igstFraction: pkg.igstFraction,
          tdsFraction: pkg.tdsFraction,
        },
        taxBasis: pkg.taxBasis,
        previous,
        oneTime: {
          mobilizationAdvance: {
            total: pkg.mobilizationAdvanceTotal,
            recoveredBefore: previous?.mobilizationAdvance ?? dec(0),
          },
          performanceSecurity: {
            total: pkg.performanceSecurityTotal,
            recoveredBefore: previous?.performanceSecurity ?? dec(0),
          },
        },
      });

      return {
        packageId: pkg.id,
        label: packageLabel(pkg.sequenceNo),
        periodFrom: iso(pkg.periodFrom),
        periodTo: iso(pkg.periodTo),
        taxBasis: pkg.taxBasis,
        taxBasisSource: pkg.taxBasisSource,
        cumulativeProvisional: pkg.status === BillPackageStatus.draft,
        rates: {
          retentionFraction: pkg.retentionFraction.toFixed(6),
          cgstFraction: pkg.cgstFraction.toFixed(6),
          sgstFraction: pkg.sgstFraction.toFixed(6),
          igstFraction: pkg.igstFraction.toFixed(6),
          tdsFraction: pkg.tdsFraction.toFixed(6),
        },
        columns: {
          thisBill: renderColumn(abstract.thisBill),
          uptoPrevious: renderColumn(abstract.uptoPrevious),
          uptoDate: renderColumn(abstract.uptoDate),
        },
      };
    });
  }

  /**
   * The previous **issued** package's stored cumulative column, or null where there is none
   * (FR-014).
   *
   * A draft between two issued packages is skipped rather than read: FR-014a freezes the cumulative
   * position at issue, so a draft has no stored position to read and treating its zeros as a
   * position would reset the chain.
   */

  /**
   * Creates a bill, turning the database's duplicate-number refusal into one a caller can act on.
   *
   * **028 FR-003.** Both numbers here are allocated read-then-written inside the transaction, so two
   * composes racing on one work order — or one project, for a client bill — read the same highest
   * number and the second is refused by the unique constraint. That is the constraint working.
   *
   * What was wrong is what the caller saw: this path had no handler, so Prisma's own text reached
   * the screen as `[P2002]: Invalid 'prisma.rABill.create()' invocation:Unique constraint failed on
   * the (not available)`. `RaBillsService.compose` and `ClientBillsService.compose` have both mapped
   * this for a year; only the package path was missed.
   *
   * The remedy is to compose again — nothing the caller entered was wrong — and the message says so,
   * because a bare 409 sends somebody looking for the mistake they made.
   */
  private async createBillOrConflict<T>(create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.duplicateNumber,
          message:
            'That bill number was taken while this package was being composed. Nothing you ' +
            'entered was wrong — compose it again and it will take the next number.',
        });
      }
      throw error;
    }
  }

  private async previousIssuedColumn(
    tx: Prisma.TransactionClient,
    pkg: {
      projectId: string;
      direction: BillDirection;
      counterpartyKey: string;
      sequenceNo: number;
    },
  ): Promise<AbstractColumn | null> {
    const previous = await tx.billPackage.findFirst({
      where: {
        projectId: pkg.projectId,
        direction: pkg.direction,
        counterpartyKey: pkg.counterpartyKey,
        sequenceNo: { lt: pkg.sequenceNo },
        status: { in: [BillPackageStatus.issued, BillPackageStatus.certified] },
      },
      orderBy: { sequenceNo: 'desc' },
    });
    if (!previous) return null;

    return {
      workDone: previous.workDoneUptoDate,
      releaseWithheld: previous.releaseWithheldUptoDate,
      cgstAmount: previous.cgstAmountUptoDate,
      sgstAmount: previous.sgstAmountUptoDate,
      igstAmount: previous.igstAmountUptoDate,
      workTotal: previous.workDoneUptoDate
        .plus(previous.releaseWithheldUptoDate)
        .plus(previous.cgstAmountUptoDate)
        .plus(previous.sgstAmountUptoDate)
        .plus(previous.igstAmountUptoDate),
      recoveryDiesel: previous.recoveryDieselUptoDate,
      debitAgainstCivil: previous.debitAgainstCivilUptoDate,
      otherRecoveries: previous.otherRecoveriesUptoDate,
      mechanicalDebit: previous.mechanicalDebitUptoDate,
      recoveriesTotal: previous.recoveryDieselUptoDate
        .plus(previous.debitAgainstCivilUptoDate)
        .plus(previous.otherRecoveriesUptoDate)
        .plus(previous.mechanicalDebitUptoDate),
      mobilizationAdvance: previous.mobilizationAdvanceUptoDate,
      retentionAmount: previous.retentionAmountUptoDate,
      performanceSecurity: previous.performanceSecurityUptoDate,
      theftWithheld: previous.theftWithheldUptoDate,
      deductionsTotal: previous.mobilizationAdvanceUptoDate
        .plus(previous.retentionAmountUptoDate)
        .plus(previous.performanceSecurityUptoDate)
        .plus(previous.theftWithheldUptoDate),
      tdsAmount: previous.tdsAmountUptoDate,
      taxDeductionsTotal: previous.tdsAmountUptoDate,
      payable: previous.payableUptoDate,
    };
  }

  /** Every package on a project, newest first. */
  async list(
    ctx: RlsContext,
    projectId: string,
  ): Promise<
    {
      id: string;
      label: string;
      direction: BillDirection;
      periodFrom: string;
      periodTo: string;
      status: BillPackageStatus;
      issuedAt: string | null;
      payable: string;
    }[]
  > {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const rows = await tx.billPackage.findMany({
        where: { projectId },
        orderBy: [{ direction: 'asc' }, { sequenceNo: 'desc' }],
        select: {
          id: true,
          sequenceNo: true,
          direction: true,
          periodFrom: true,
          periodTo: true,
          status: true,
          issuedAt: true,
          payable: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        label: packageLabel(row.sequenceNo),
        direction: row.direction,
        periodFrom: iso(row.periodFrom),
        periodTo: iso(row.periodTo),
        status: row.status,
        issuedAt: row.issuedAt?.toISOString() ?? null,
        payable: displayRupees(row.payable),
      }));
    });
  }

  /**
   * The six check-list questions and whatever has been answered (FR-041, FR-042, FR-043a).
   *
   * All six come back whether or not they carry an answer, and the gaps come back beside them — a
   * question absent from a response and a question answered no are indistinguishable to the caller,
   * and the caller is a document somebody signs.
   */
  async checkListFor(
    ctx: RlsContext,
    packageId: string,
  ): Promise<{
    items: ReturnType<typeof mergeCheckList>;
    gaps: ReturnType<typeof checkListGaps>;
    footer: string;
    signatories: readonly string[];
  }> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: {
          checkListAnswers: {
            select: { questionKey: true, answer: true, answeredAt: true },
          },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      const items = mergeCheckList(pkg.checkListAnswers);
      return {
        items,
        gaps: checkListGaps(items),
        footer: CHECK_LIST_FOOTER,
        signatories: CHECK_LIST_SIGNATORIES,
      };
    });
  }

  /** Answers the check list. An omitted answer leaves the question unanswered (FR-042). */
  async setCheckList(
    ctx: RlsContext,
    companyId: string,
    userId: string | null,
    packageId: string,
    answers: { questionKey: string; answer?: CheckListAnswer }[],
  ): Promise<ReturnType<BillPackageService['checkListFor']>> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { id: true, status: true },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      if (pkg.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message:
            'This package has been issued. The check list records what was attached when the ' +
            'bill went out, so it does not change afterwards.',
        });
      }

      // One statement per answer is at most six round trips, which is bounded by the format
      // itself — there are six questions and there will always be six.
      for (const answer of answers) {
        await tx.billPackageCheckListAnswer.upsert({
          where: {
            packageId_questionKey: {
              packageId,
              questionKey: answer.questionKey,
            },
          },
          create: {
            companyId,
            packageId,
            questionKey: answer.questionKey,
            answer: answer.answer ?? null,
            answeredByUserId: answer.answer ? userId : null,
            answeredAt: answer.answer ? new Date() : null,
          },
          update: {
            answer: answer.answer ?? null,
            answeredByUserId: answer.answer ? userId : null,
            answeredAt: answer.answer ? new Date() : null,
          },
        });
      }
    });
    return this.checkListFor(ctx, packageId);
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

      // Asked for only when it explains something. A package that proposed figures needs no
      // account of itself, and the query is skipped rather than its answer discarded.
      const nothingProposed =
        claims.length > 0 &&
        claims.every(
          (claim) =>
            claim.proposedQty === null || Number(claim.proposedQty) === 0,
        );
      const latestApproved = nothingProposed
        ? await tx.dailyWorkReport.findFirst({
            where: { projectId: pkg.projectId, status: DwrStatus.approved },
            select: { workDate: true, dprNumber: true },
            orderBy: { workDate: 'desc' },
          })
        : null;

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
        latestApprovedWork: latestApproved
          ? {
              workDate: iso(latestApproved.workDate),
              dprNumber: latestApproved.dprNumber,
            }
          : null,
      };
    });
  }
}

/** A stored date as the day it is, with no timezone in the way. */
function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * A column as a caller reads it: **every figure rendered to the rupee, once** (FR-012a).
 *
 * The single display rounding, applied here and nowhere upstream. `bill-abstract.ts`'s docblock
 * carries the proof that this is the client's own rule — block A of the real RA-12 totals 21,73,189
 * while its two displayed taxes sum to 21,73,190.
 */
function renderColumn(column: AbstractColumn): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(column)) {
    out[key] = displayRupees(value);
  }
  return out;
}
