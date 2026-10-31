import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Site } from '@prisma/client';
import {
  AdvanceStatus,
  AuditAction,
  AuditEntityType,
  EngagementType,
  LabourPaymentMode,
  MusterStatus,
  PaymentSheetLineStatus,
  PaymentSheetStatus,
  Prisma,
  RateSource,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  CashPolicyService,
  cashHiddenError,
} from '../../common/cash/cash-policy';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { SitesService } from '../../projects/sites/sites.service';
import { ACKNOWLEDGEMENT_NAMESPACE } from '../constants/labour.constants';
import { LabourRefsService } from '../labour-refs.service';
import { SiteWageRateService } from '../site-rates/site-wage-rate.service';
import { LabourDayService } from '../attendance/labour-day.service';
import { SupervisorSiteService } from '../supervisor-sites/supervisor-site.service';
import { computeWage, roundMoney, WorkedDay } from './wage-calc.util';
import { computeDenominationBreakup, WorkerNet } from './denomination.util';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';
import {
  type DeductionEntry,
  deductionEntries,
  lineContractorId,
  paidAmountProblem,
  periodEndProblem,
  planAdvanceDeductions,
  recoveryFor,
  reservedByAdvance,
  restoreFor,
} from './payment-sheet.rules';
import {
  cashCarrySources,
  isCashLine,
  isCashSheet,
  isHiddenLine,
  visibleSheetLines,
} from '../cash/labour-cash-view';

export type { DeductionEntry } from './payment-sheet.rules';

/** What a sheet's lines are built from: the sheet row and the site it pays. */
interface SheetForLines {
  id: string;
  companyId: string;
  projectId: string | null;
  siteId: string;
  periodFrom: Date;
  periodTo: Date;
  engagementType: EngagementType;
}

@Injectable()
export class PaymentSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly sites: SitesService,
    private readonly siteRates: SiteWageRateService,
    private readonly supervisorSites: SupervisorSiteService,
    private readonly storage: StorageService,
    private readonly images: ImageProcessingService,
    private readonly days: LabourDayService,
    /** 038: hiding cash. Optional so unit tests can omit it (then nothing is hidden). */
    @Optional() private readonly cash?: CashPolicyService,
  ) {}

  /** 038: whether cash is hidden for this company. */
  private cashHidden(companyId: string | null | undefined): Promise<boolean> {
    return this.cash ? this.cash.isHidden(companyId) : Promise.resolve(false);
  }

  /** 038: a direct (cash) sheet cannot be generated, approved, reopened, rebuilt, deleted or paid
   * while cash is hidden for its company. */
  private async assertSheetWritable(sheet: {
    companyId: string;
    engagementType: EngagementType;
  }): Promise<void> {
    if (isCashSheet(sheet) && (await this.cashHidden(sheet.companyId))) {
      throw cashHiddenError();
    }
  }

  /**
   * Generates a draft sheet for one site and period (031) from the period's approved musters —
   * which, since 031, the face punches write: one line per worker with days (since 034 counted from
   * the hours between punch in and out, by the company's day rules), the rate for their gender at
   * the site, gross, advance deductions and net. A worked day with no rate fails with 409 naming
   * the worker, gender and date, and a past day with a missing punch fails until it is corrected.
   * A sheet overlapping this one for the same site, or a pre-031 project sheet covering the site,
   * is rejected (FR-023).
   *
   * 036: the period must have ended (O3) — the last day is before today in the company's zone —
   * and a worker short-paid on an earlier sheet gets the shortfall as a line of its own (O4).
   */
  async generate(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      siteId: string;
      periodFrom: string;
      periodTo: string;
      engagementType?: EngagementType;
    },
    ipAddress: string,
  ) {
    const periodFrom = new Date(`${dto.periodFrom.slice(0, 10)}T00:00:00.000Z`);
    const periodTo = new Date(`${dto.periodTo.slice(0, 10)}T00:00:00.000Z`);
    if (periodTo < periodFrom) {
      throw new BadRequestException(
        'The "to" date must be on or after the "from" date',
      );
    }
    const endProblem = periodEndProblem(
      dto.periodTo.slice(0, 10),
      this.days.today(),
    );
    if (endProblem) {
      throw new BadRequestException({
        code: 'LABOUR_SHEET_PERIOD_NOT_ENDED',
        message: endProblem,
      });
    }
    const engagementType = dto.engagementType ?? EngagementType.direct;

    await this.supervisorSites.assertSiteAllowed(caller, dto.siteId);
    const site = await this.sites.getSiteById(
      rlsContextFor(caller),
      dto.siteId,
    );
    assertInScope(caller, site, `Site ${dto.siteId}`);
    // The sheet belongs to the site's company, whoever generates it.
    const companyId = site.companyId;
    const projectId = site.projectId ?? null;
    // 038: a direct sheet is paid in cash; none is generated while cash is hidden.
    await this.assertSheetWritable({ companyId, engagementType });

    const sheetId = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.lockForSheet(tx, companyId, dto.siteId);

        // Overlap guard (FR-023): this site's sheets, and any pre-031 sheet for its project,
        // which priced this site's musters too. Read under the lock, so two generates for the
        // same dates cannot both find nothing and both write a sheet (036 O3).
        const overlap = await tx.labourPaymentSheet.findFirst({
          where: {
            companyId,
            engagementType,
            deletedAt: null,
            periodFrom: { lte: periodTo },
            periodTo: { gte: periodFrom },
            OR: [
              { siteId: dto.siteId },
              ...(projectId ? [{ siteId: null, projectId }] : []),
            ],
          },
        });
        if (overlap) {
          throw new ConflictException({
            message: `A payment sheet for ${overlap.periodFrom
              .toISOString()
              .slice(0, 10)} to ${overlap.periodTo
              .toISOString()
              .slice(0, 10)} already covers part of these dates`,
            existingSheetId: overlap.id,
          });
        }

        const created = await tx.labourPaymentSheet.create({
          data: {
            companyId,
            projectId,
            siteId: dto.siteId,
            periodFrom,
            periodTo,
            engagementType,
            status: PaymentSheetStatus.draft,
            createdBy: caller.id,
          },
        });
        await this.buildLines(
          tx,
          caller,
          { ...created, siteId: dto.siteId },
          site,
        );
        return created.id;
      },
    );

    await this.audit(AuditAction.CREATE, sheetId, companyId, caller, ipAddress);
    return this.findOne(caller, sheetId);
  }

  /**
   * Serialises everything that decides what a sheet holds (036 O1, O3).
   *
   * The company lock makes generates, regenerates and reopens take turns, so an advance instalment
   * one of them earmarks is visible to the next — two sheets at different sites can carry the same
   * worker. The site lock is the exclusive side of the one `assertNotOnPaymentSheet` takes shared:
   * a punch or correction already past its check finishes before the sheet reads the attendance,
   * and one that starts afterwards finds the sheet.
   */
  private async lockForSheet(
    tx: Prisma.TransactionClient,
    companyId: string,
    siteId: string,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labour-sheet-company:${companyId}`}))`;
    await this.days.lockSiteForSheet(tx, siteId);
  }

  /**
   * Writes a draft sheet's lines from the attendance as it stands and sets its totals. The sheet
   * must have no lines when this runs: `generate` has just created it, and `regenerate` and
   * `reopen` delete the old ones first. Every refusal throws, so the caller's transaction rolls the
   * whole change back.
   */
  private async buildLines(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    sheet: SheetForLines,
    site: Pick<Site, 'name'>,
  ): Promise<void> {
    const { periodFrom, periodTo, engagementType, companyId, projectId } =
      sheet;
    const siteId = sheet.siteId;

    // 034: overtime is priced on the company's labour shift, the one it is counted beyond.
    const { otMultiplier, standardHours } = await this.refs.getLabourSettings(
      companyId,
    );

    // 034: a day with a missing punch is not counted until it is corrected, and once a sheet
    // covers it, it can no longer be corrected — so the sheet waits for the corrections.
    const unresolved = await this.days.unresolvedDays(
      tx,
      siteId,
      periodFrom,
      periodTo,
    );
    if (unresolved.length > 0) {
      throw new ConflictException({
        code: 'LABOUR_UNRESOLVED_PUNCHES',
        message: `${unresolved.length} labour day${
          unresolved.length === 1 ? ' has' : 's have'
        } a missing or wrong punch between these dates (first on ${
          unresolved[0].date
        }). Correct them under Labour → Muster attendance, then generate again.`,
        unresolved,
      });
    }

    // 036 O4: a muster entered before 031 and still waiting for approval is not counted, and once
    // a sheet covers its date it can no longer be approved — so it would never be paid.
    const awaiting = await tx.musterRoll.findFirst({
      where: {
        siteId,
        date: { gte: periodFrom, lte: periodTo },
        status: MusterStatus.submitted,
        deletedAt: null,
      },
      orderBy: { date: 'asc' },
      select: { id: true, date: true },
    });
    if (awaiting) {
      const date = awaiting.date.toISOString().slice(0, 10);
      throw new ConflictException({
        code: 'LABOUR_MUSTER_AWAITING_APPROVAL',
        message: `The muster for ${date} at this site is still waiting for approval. Approve or return it under Labour → Musters, then generate again.`,
        musterId: awaiting.id,
        date,
      });
    }

    const musterLines = await tx.musterLine.findMany({
      where: {
        muster: {
          siteId,
          date: { gte: periodFrom, lte: periodTo },
          status: MusterStatus.approved,
          deletedAt: null,
        },
      },
      include: { muster: { select: { date: true } } },
    });

    if (musterLines.length === 0) {
      throw new ConflictException(
        'No attendance was marked at this site between these dates',
      );
    }

    const workerIds = Array.from(new Set(musterLines.map((l) => l.workerId)));
    const workers = await tx.labourWorker.findMany({
      where: { id: { in: workerIds } },
    });
    const workerById = new Map(workers.map((w) => [w.id, w]));

    // 052: a worker whose engagement was edited can have days this site already priced on a sheet
    // of the other engagement type; those days are left off, so no day is paid twice.
    const pricedElsewhere = await this.daysOnOtherSheets(
      tx,
      sheet,
      workers
        .filter((w) => w.engagementType === engagementType)
        .map((w) => w.id),
    );

    // Group lines per worker, filtered to the requested engagement type.
    const perWorker = new Map<string, typeof musterLines>();
    for (const line of musterLines) {
      const worker = workerById.get(line.workerId);
      if (!worker || worker.engagementType !== engagementType) continue;
      if (
        pricedElsewhere
          .get(line.workerId)
          ?.some(
            ([from, to]) => line.muster.date >= from && line.muster.date <= to,
          )
      ) {
        continue;
      }
      const list = perWorker.get(line.workerId) ?? [];
      list.push(line);
      perWorker.set(line.workerId, list);
    }

    if (perWorker.size === 0) {
      throw new ConflictException(
        engagementType === EngagementType.direct
          ? 'No directly engaged labour worked at this site between these dates'
          : 'No contractor labour worked at this site between these dates',
      );
    }

    const paidWorkerIds = Array.from(perWorker.keys());
    const reserved = await this.reservedAdvances(tx, paidWorkerIds, sheet.id);
    const carries = await this.carriesFor(tx, paidWorkerIds, sheet.id);

    let grossTotal = 0;
    let deductionTotal = 0;
    let netTotal = 0;

    for (const [workerId, lines] of perWorker) {
      const worker = workerById.get(workerId);
      if (!worker) continue;
      const rateOverride = worker.rateOverride
        ? worker.rateOverride.toNumber()
        : null;

      const workedDays: WorkedDay[] = [];
      let resolvedRateForLine = rateOverride ?? 0;
      let rateSource: RateSource = RateSource.site_rate;
      for (const line of lines) {
        const resolved = await this.siteRates.resolveDayRate(caller, tx, {
          rateOverride,
          gender: worker.gender,
          siteId,
          projectId,
          skillCategoryIdOnDay: line.skillCategoryIdOnDay,
          date: line.muster.date,
        });
        if (!resolved) {
          const date = line.muster.date.toISOString().slice(0, 10);
          throw new ConflictException({
            code: worker.gender
              ? 'LABOUR_SITE_RATE_MISSING'
              : 'LABOUR_GENDER_MISSING',
            message: worker.gender
              ? `No ${worker.gender} daily rate is set for ${site.name} on ${date}. Set it under Labour → Site rates, then generate again.`
              : `${worker.fullName} (${worker.labourCode}) has no gender recorded, so no rate applies. Set it on their labour record, then generate again.`,
            workerId,
            siteId,
            gender: worker.gender,
            date,
          });
        }
        resolvedRateForLine = resolved.rate;
        rateSource = resolved.source;
        workedDays.push({
          attendanceType: line.attendanceType,
          overtimeHours: line.overtimeHours ? line.overtimeHours.toNumber() : 0,
          dailyRate: resolved.rate,
        });
      }

      const wage = computeWage(workedDays, standardHours, otMultiplier);

      const { deductions, deductionAmount } = await this.buildDeductions(
        tx,
        workerId,
        periodFrom,
        wage.grossWage,
        reserved,
      );

      const netPayable = roundMoney(
        Math.max(wage.grossWage - deductionAmount, 0),
      );

      await tx.paymentSheetLine.create({
        data: {
          companyId,
          sheetId: sheet.id,
          workerId,
          daysWorked: wage.daysWorked,
          overtimeHours: wage.overtimeHours,
          resolvedRate: resolvedRateForLine,
          rateSource,
          // 052: who engaged the worker when the line was priced — a later edit leaves it alone.
          contractorId:
            worker.engagementType === EngagementType.contractor
              ? worker.contractorId
              : null,
          grossWage: wage.grossWage,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          netPayable,
          carriedForwardBalance: 0,
          status: PaymentSheetLineStatus.pending,
        },
      });

      grossTotal += wage.grossWage;
      deductionTotal += deductionAmount;
      netTotal += netPayable;

      // 036 O4 (decision 2): each earlier shortfall is a line of its own, so the sheet shows what
      // is this period's wage and what is owed from before. Its gross is zero — the wage was
      // earned, and costed to the project, on the sheet that first priced it.
      for (const carry of carries.get(workerId) ?? []) {
        await tx.paymentSheetLine.create({
          data: {
            companyId,
            sheetId: sheet.id,
            workerId,
            daysWorked: 0,
            overtimeHours: 0,
            resolvedRate: 0,
            rateSource,
            contractorId:
              worker.engagementType === EngagementType.contractor
                ? worker.contractorId
                : null,
            grossWage: 0,
            deductions: [] as unknown as Prisma.InputJsonValue,
            netPayable: carry.amount,
            carriedForwardBalance: 0,
            carriedFromLineId: carry.lineId,
            status: PaymentSheetLineStatus.pending,
          },
        });
        netTotal += carry.amount;
      }
    }

    await tx.labourPaymentSheet.update({
      where: { id: sheet.id },
      data: {
        grossTotal: roundMoney(grossTotal),
        deductionTotal: roundMoney(deductionTotal),
        netTotal: roundMoney(netTotal),
      },
    });
  }

  /**
   * 052: for each worker, the periods of this site's other live sheets — of the other engagement
   * type — that already carry a wage line for them. Only an engagement edit puts a worker on both
   * kinds of sheet; sheets of the same type cannot overlap at a site (FR-023).
   */
  private async daysOnOtherSheets(
    tx: Prisma.TransactionClient,
    sheet: SheetForLines,
    workerIds: string[],
  ): Promise<Map<string, [Date, Date][]>> {
    const found = new Map<string, [Date, Date][]>();
    if (workerIds.length === 0) return found;
    const sheets = await tx.labourPaymentSheet.findMany({
      where: {
        companyId: sheet.companyId,
        id: { not: sheet.id },
        deletedAt: null,
        engagementType: { not: sheet.engagementType },
        periodFrom: { lte: sheet.periodTo },
        periodTo: { gte: sheet.periodFrom },
        OR: [
          { siteId: sheet.siteId },
          ...(sheet.projectId
            ? [{ siteId: null, projectId: sheet.projectId }]
            : []),
        ],
      },
      select: {
        periodFrom: true,
        periodTo: true,
        lines: {
          where: { workerId: { in: workerIds }, carriedFromLineId: null },
          select: { workerId: true },
        },
      },
    });
    for (const other of sheets) {
      for (const { workerId } of other.lines) {
        found.set(workerId, [
          ...(found.get(workerId) ?? []),
          [other.periodFrom, other.periodTo],
        ]);
      }
    }
    return found;
  }

  /**
   * Advance instalments already earmarked by lines not yet disbursed on other live sheets (036
   * O1). The balance falls only at disbursement, so these are taken out of what this sheet may
   * deduct.
   */
  private async reservedAdvances(
    tx: Prisma.TransactionClient,
    workerIds: string[],
    sheetId: string,
  ): Promise<Map<string, number>> {
    const pending = await tx.paymentSheetLine.findMany({
      where: {
        workerId: { in: workerIds },
        status: PaymentSheetLineStatus.pending,
        sheetId: { not: sheetId },
        sheet: { deletedAt: null },
      },
      select: { deductions: true },
    });
    return reservedByAdvance(pending);
  }

  /**
   * Shortfalls still owed to these workers (036 O4): disbursed lines on live sheets paid below
   * their net, whose remainder no line on a live sheet pays yet. Deleting the sheet that carried
   * one frees it for the next.
   */
  private async carriesFor(
    tx: Prisma.TransactionClient,
    workerIds: string[],
    sheetId: string,
  ): Promise<Map<string, { lineId: string; amount: number }[]>> {
    const shortPaid = await tx.paymentSheetLine.findMany({
      where: {
        workerId: { in: workerIds },
        status: PaymentSheetLineStatus.disbursed,
        carriedForwardBalance: { gt: 0 },
        sheetId: { not: sheetId },
        sheet: { deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, workerId: true, carriedForwardBalance: true },
    });
    if (shortPaid.length === 0) return new Map();
    const carried = await tx.paymentSheetLine.findMany({
      where: {
        carriedFromLineId: { in: shortPaid.map((l) => l.id) },
        sheetId: { not: sheetId },
        sheet: { deletedAt: null },
      },
      select: { carriedFromLineId: true },
    });
    const taken = new Set(carried.map((c) => c.carriedFromLineId));
    const out = new Map<string, { lineId: string; amount: number }[]>();
    for (const line of shortPaid) {
      if (taken.has(line.id)) continue;
      const list = out.get(line.workerId) ?? [];
      list.push({
        lineId: line.id,
        amount: line.carriedForwardBalance.toNumber(),
      });
      out.set(line.workerId, list);
    }
    return out;
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      projectId?: string;
      siteId?: string;
      engagementType?: EngagementType;
      status?: PaymentSheetStatus;
    },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPaymentSheet.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            deletedAt: null,
            ...(query.projectId ? { projectId: query.projectId } : {}),
            ...(query.siteId ? { siteId: query.siteId } : {}),
            ...(query.engagementType
              ? { engagementType: query.engagementType }
              : {}),
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: { periodFrom: 'desc' },
        }),
    );
    // 038: with cash hidden for a sheet's company, a direct (cash) sheet is not listed and a
    // contractor sheet's totals leave out its cash lines.
    const hidden = this.cash
      ? await this.cash.hiddenAmong(rows.map((r) => r.companyId))
      : new Set<string>();
    let visibleRows = rows;
    if (hidden.size > 0) {
      visibleRows = rows.filter(
        (r) => !(hidden.has(r.companyId) && isCashSheet(r)),
      );
      const affected = visibleRows.filter((r) => hidden.has(r.companyId));
      if (affected.length > 0) {
        const totals = await withRlsContext(
          this.prisma,
          rlsContextFor(caller),
          async (tx) => {
            const lines = await tx.paymentSheetLine.findMany({
              where: { sheetId: { in: affected.map((r) => r.id) } },
            });
            const sources = await cashCarrySources(tx, lines);
            return new Map(
              affected.map((r) => [
                r.id,
                visibleSheetLines(
                  r,
                  lines.filter((l) => l.sheetId === r.id),
                  sources,
                ),
              ]),
            );
          },
        );
        visibleRows = visibleRows.map((r) => {
          const t = totals.get(r.id);
          return t
            ? {
                ...r,
                grossTotal: new Prisma.Decimal(t.grossTotal),
                deductionTotal: new Prisma.Decimal(t.deductionTotal),
                netTotal: new Prisma.Decimal(t.netTotal),
              }
            : r;
        });
      }
    }
    return visibleRows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      siteId: row.siteId,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: row.periodTo.toISOString().slice(0, 10),
      engagementType: row.engagementType,
      status: row.status,
      grossTotal: row.grossTotal.toNumber(),
      deductionTotal: row.deductionTotal.toNumber(),
      netTotal: row.netTotal.toNumber(),
    }));
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourPaymentSheet.findUnique({
        where: { id },
        include: { lines: true },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Payment sheet ${id} not found`);
    }
    assertInScope(caller, row, `Payment sheet ${id}`);

    // 038: with cash hidden, a direct (cash) sheet does not exist, and a contractor sheet shows
    // only its non-cash lines with totals worked out from them.
    if (await this.cashHidden(row.companyId)) {
      if (isCashSheet(row)) {
        throw new NotFoundException(`Payment sheet ${id} not found`);
      }
      const sources = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) => cashCarrySources(tx, row.lines),
      );
      const view = visibleSheetLines(row, row.lines, sources);
      if (view.changed) {
        row.lines = view.lines;
        row.grossTotal = new Prisma.Decimal(view.grossTotal);
        row.deductionTotal = new Prisma.Decimal(view.deductionTotal);
        row.netTotal = new Prisma.Decimal(view.netTotal);
        row.denominationBreakup = null;
      }
    }

    const disbursed = row.lines.filter(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    const pending = row.lines.filter(
      (l) => l.status === PaymentSheetLineStatus.pending,
    );
    // 036 O8: names beside the ids. Additive.
    const workers = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: { id: { in: [...new Set(row.lines.map((l) => l.workerId))] } },
          select: {
            id: true,
            fullName: true,
            labourCode: true,
            contractorId: true,
          },
        }),
    );
    const workerById = new Map(workers.map((w) => [w.id, w]));
    // 052: the contractor each line was priced under.
    const lineContractor = (l: {
      contractorId: string | null;
      workerId: string;
    }) => lineContractorId(row, l, workerById.get(l.workerId));
    const contractorNames = await this.refs.contractorNames(
      caller,
      row.lines.map(lineContractor),
    );
    const siteName = row.siteId
      ? (await this.refs.siteNames(caller, [row.siteId])).get(row.siteId) ??
        null
      : null;

    const disbursedAmount = roundMoney(
      disbursed.reduce((s, l) => s + (l.paidAmount?.toNumber() ?? 0), 0),
    );
    const outstandingAmount = roundMoney(
      pending.reduce((s, l) => s + l.netPayable.toNumber(), 0),
    );

    return {
      id: row.id,
      projectId: row.projectId,
      siteId: row.siteId,
      siteName,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: row.periodTo.toISOString().slice(0, 10),
      engagementType: row.engagementType,
      status: row.status,
      grossTotal: row.grossTotal.toNumber(),
      deductionTotal: row.deductionTotal.toNumber(),
      netTotal: row.netTotal.toNumber(),
      denominationBreakup: row.denominationBreakup ?? null,
      approvedBy: row.approvedBy,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      summary: {
        disbursedCount: disbursed.length,
        pendingCount: pending.length,
        disbursedAmount,
        outstandingAmount,
        carriedForwardAmount: roundMoney(
          row.lines
            .filter((l) => l.carriedFromLineId)
            .reduce((s, l) => s + l.netPayable.toNumber(), 0),
        ),
      },
      lines: row.lines.map((l) => ({
        id: l.id,
        workerId: l.workerId,
        workerName: workerById.get(l.workerId)?.fullName ?? null,
        labourCode: workerById.get(l.workerId)?.labourCode ?? null,
        contractorId: lineContractor(l),
        contractorName: contractorNames.get(lineContractor(l) ?? '') ?? null,
        daysWorked: l.daysWorked.toNumber(),
        overtimeHours: l.overtimeHours.toNumber(),
        resolvedRate: l.resolvedRate.toNumber(),
        rateSource: l.rateSource,
        grossWage: l.grossWage.toNumber(),
        deductions: l.deductions,
        netPayable: l.netPayable.toNumber(),
        paymentMode: l.paymentMode,
        paidOn: l.paidOn ? l.paidOn.toISOString().slice(0, 10) : null,
        paidAmount: l.paidAmount ? l.paidAmount.toNumber() : null,
        shortPaymentReason: l.shortPaymentReason,
        carriedForwardBalance: l.carriedForwardBalance.toNumber(),
        status: l.status,
        // 036 O4: a carry-forward line pays an earlier line's shortfall; it has no days of its own.
        kind: l.carriedFromLineId ? 'carry_forward' : 'wage',
        carriedFromLineId: l.carriedFromLineId,
      })),
    };
  }

  /** Approves a sheet, freezing every figure (FR-026). A direct-engagement sheet
   * gains its cash denomination breakup at this point (FR-027); a contractor sheet
   * does not (FR-028). */
  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    // The sheet's own company for the audit row, not the caller's home company: a Super Admin
    // working in a selected company would otherwise file it under the wrong one (036 3e, 2026-10-17).
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sheet = await tx.labourPaymentSheet.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!sheet || sheet.deletedAt) {
        throw new NotFoundException(`Payment sheet ${id} not found`);
      }
      assertInScope(caller, sheet, `Payment sheet ${id}`);
      companyId = sheet.companyId;
      await this.assertSheetWritable(sheet);
      if (sheet.status !== PaymentSheetStatus.draft) {
        throw new ConflictException('Only a draft sheet can be approved');
      }

      let denominationBreakup: Prisma.InputJsonValue | undefined;
      if (sheet.engagementType === EngagementType.direct) {
        const { cashDenominations } = await this.refs.getLabourSettings(
          sheet.companyId,
        );
        const nets: WorkerNet[] = sheet.lines.map((l) => ({
          workerId: l.workerId,
          netPayable: l.netPayable.toNumber(),
        }));
        denominationBreakup = computeDenominationBreakup(
          nets,
          cashDenominations,
        ) as unknown as Prisma.InputJsonValue;
      }

      await tx.labourPaymentSheet.update({
        where: { id },
        data: {
          status: PaymentSheetStatus.approved,
          approvedBy: caller.id,
          approvedAt: new Date(),
          ...(denominationBreakup ? { denominationBreakup } : {}),
        },
      });
    });
    await this.audit(AuditAction.UPDATE, id, companyId, caller, ipAddress);
    return this.findOne(caller, id);
  }

  /** The cash denomination breakup for an approved direct sheet (FR-027). */
  async getDenominations(caller: AuthenticatedUser, id: string) {
    const sheet = await this.findOne(caller, id);
    if (sheet.engagementType !== EngagementType.direct) {
      throw new BadRequestException(
        'Contractor sheets have no cash denomination breakup',
      );
    }
    if (sheet.status === PaymentSheetStatus.draft) {
      throw new ConflictException(
        'Denominations are available only once the sheet is approved',
      );
    }
    return sheet.denominationBreakup;
  }

  /**
   * Reopens an approved sheet to draft, blocked once any line is disbursed. 036 O2: the lines are
   * worked out again from the attendance, rates, advances and shortfalls as they stand now, so a
   * reopened sheet never keeps figures nothing supports any more.
   */
  async reopen(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sheet = await this.sheetForRebuild(tx, caller, id);
      companyId = sheet.companyId;
      if (
        sheet.status !== PaymentSheetStatus.approved &&
        sheet.status !== PaymentSheetStatus.draft
      ) {
        throw new ConflictException(
          'This sheet has a disbursed line and cannot be reopened',
        );
      }
      const anyDisbursed = sheet.lines.some(
        (l) => l.status === PaymentSheetLineStatus.disbursed,
      );
      if (anyDisbursed) {
        throw new ConflictException(
          'This sheet has a disbursed line and cannot be reopened',
        );
      }
      await tx.labourPaymentSheet.update({
        where: { id },
        data: {
          status: PaymentSheetStatus.draft,
          reopenReason: reason,
          denominationBreakup: Prisma.DbNull,
          approvedBy: null,
          approvedAt: null,
        },
      });
      await this.rebuild(tx, caller, sheet);
    });
    await this.audit(AuditAction.UPDATE, id, companyId, caller, ipAddress, {
      reopened: true,
      reason,
    });
    return this.findOne(caller, id);
  }

  /**
   * Works a draft sheet's lines out again from the attendance as it stands (036 O2) — after a rate
   * is set or changed, an advance disbursed, or a sheet holding a shortfall deleted.
   */
  async regenerate(caller: AuthenticatedUser, id: string, ipAddress: string) {
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sheet = await this.sheetForRebuild(tx, caller, id);
      companyId = sheet.companyId;
      if (sheet.status !== PaymentSheetStatus.draft) {
        throw new ConflictException(
          'Only a draft sheet can be regenerated. Reopen an approved sheet first.',
        );
      }
      await this.rebuild(tx, caller, sheet);
    });
    await this.audit(AuditAction.UPDATE, id, companyId, caller, ipAddress, {
      regenerated: true,
    });
    return this.findOne(caller, id);
  }

  /**
   * Deletes a draft sheet (036 O2). Soft: the row and its lines stay for the audit trail, but every
   * read skips it, so its days can be corrected again, the advance instalments it earmarked are
   * free, and any shortfall it carried goes onto the next sheet instead.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    reason: string | undefined,
    ipAddress: string,
  ) {
    const sheet = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const row = await tx.labourPaymentSheet.findUnique({ where: { id } });
        if (!row || row.deletedAt) {
          throw new NotFoundException(`Payment sheet ${id} not found`);
        }
        assertInScope(caller, row, `Payment sheet ${id}`);
        await this.assertSheetWritable(row);
        if (row.siteId) {
          await this.supervisorSites.assertSiteAllowed(caller, row.siteId);
        }
        // Conditional on the status, so an approval racing this delete cannot be undone by it.
        const { count } = await tx.labourPaymentSheet.updateMany({
          where: { id, status: PaymentSheetStatus.draft, deletedAt: null },
          data: { deletedAt: new Date(), deletedBy: caller.id },
        });
        if (count === 0) {
          throw new ConflictException(
            'Only a draft sheet can be deleted. Reopen an approved sheet first; a sheet with a paid line cannot be deleted.',
          );
        }
        return row;
      },
    );
    await this.audit(
      AuditAction.DELETE,
      id,
      sheet.companyId,
      caller,
      ipAddress,
      {
        siteId: sheet.siteId,
        periodFrom: sheet.periodFrom.toISOString().slice(0, 10),
        periodTo: sheet.periodTo.toISOString().slice(0, 10),
        ...(reason ? { reason } : {}),
      },
    );
    return { id, deleted: true };
  }

  /** A live site sheet, in scope, with the locks a rebuild needs already held. */
  private async sheetForRebuild(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    id: string,
  ) {
    const found = await tx.labourPaymentSheet.findUnique({ where: { id } });
    if (!found || found.deletedAt) {
      throw new NotFoundException(`Payment sheet ${id} not found`);
    }
    assertInScope(caller, found, `Payment sheet ${id}`);
    await this.assertSheetWritable(found);
    if (found.siteId) {
      await this.lockForSheet(tx, found.companyId, found.siteId);
    }
    // Read again under the lock: the status may have moved while we waited for it.
    const sheet = await tx.labourPaymentSheet.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!sheet || sheet.deletedAt) {
      throw new NotFoundException(`Payment sheet ${id} not found`);
    }
    return sheet;
  }

  /** Replaces a sheet's lines with freshly built ones. Pre-031 project sheets have no site to
   * rebuild from and keep their lines. */
  private async rebuild(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    sheet: Awaited<ReturnType<PaymentSheetService['sheetForRebuild']>>,
  ) {
    if (!sheet.siteId) return;
    const site = await this.sites.getSiteById(
      rlsContextFor(caller),
      sheet.siteId,
    );
    await tx.paymentSheetLine.deleteMany({ where: { sheetId: sheet.id } });
    await this.buildLines(tx, caller, { ...sheet, siteId: sheet.siteId }, site);
  }

  private async buildDeductions(
    tx: Prisma.TransactionClient,
    workerId: string,
    periodFrom: Date,
    grossWage: number,
    reserved: Map<string, number>,
  ): Promise<{ deductions: DeductionEntry[]; deductionAmount: number }> {
    const advances = await tx.labourAdvance.findMany({
      where: {
        workerId,
        status: AdvanceStatus.disbursed,
        outstandingBalance: { gt: 0 },
        recoveryStartPeriod: { lte: periodFrom },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    // Capped so net never goes negative (FR-024), and short of what other sheets have earmarked
    // (036 O1); the remainder is recovered on a later sheet.
    return planAdvanceDeductions(
      advances.map((a) => ({
        id: a.id,
        instalmentAmount: a.instalmentAmount.toNumber(),
        outstandingBalance: a.outstandingBalance.toNumber(),
      })),
      reserved,
      grossWage,
    );
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
    changes?: Prisma.InputJsonObject,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_PAYMENT_SHEET,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
      ...(changes ? { changes } : {}),
    });
  }

  // ── Disbursement (US6) ────────────────────────────────────────────────────────

  async disburseLine(
    caller: AuthenticatedUser,
    lineId: string,
    dto: {
      paymentMode: LabourPaymentMode;
      paidOn: string;
      paidAmount: number;
      acknowledgement?: string;
      shortPaymentReason?: string;
    },
    ipAddress: string,
  ) {
    let sheetId = '';
    // The line's own company for the audit row, not the caller's home company (036 3e).
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const line = await tx.paymentSheetLine.findUnique({
        where: { id: lineId },
        include: { sheet: true },
      });
      if (!line) {
        throw new NotFoundException(`Payment line ${lineId} not found`);
      }
      assertInScope(caller, line, `Payment line ${lineId}`);
      sheetId = line.sheetId;
      companyId = line.sheet.companyId;
      // 038: nothing cash is paid while cash is hidden — not a cash payment, not a line of a direct
      // (cash) sheet, not the remainder of an earlier cash payment.
      await this.assertLineWritable(tx, line, dto.paymentMode);

      if (
        line.sheet.status !== PaymentSheetStatus.approved &&
        line.sheet.status !== PaymentSheetStatus.partially_disbursed
      ) {
        throw new ConflictException('Only an approved sheet can be disbursed');
      }
      if (line.status !== PaymentSheetLineStatus.pending) {
        throw new ConflictException('This line is already disbursed');
      }

      let acknowledgementRef: string | null = null;
      if (dto.paymentMode === LabourPaymentMode.cash) {
        if (!dto.acknowledgement) {
          throw new BadRequestException(
            'A cash disbursement requires an acknowledgement image',
          );
        }
        const bytes = decodePhotoPayload(
          dto.acknowledgement,
          'Acknowledgement image',
        );
        const compressed = await this.images.compressReceipt(bytes);
        acknowledgementRef = await this.storage.put(
          ACKNOWLEDGEMENT_NAMESPACE,
          compressed,
          'image/jpeg',
        );
      } else {
        const worker = await tx.labourWorker.findUnique({
          where: { id: line.workerId },
          select: { bankAccount: true },
        });
        if (!worker?.bankAccount) {
          throw new BadRequestException(
            'This worker has no recorded bank account for a bank transfer',
          );
        }
      }

      const netPayable = line.netPayable.toNumber();
      // 036 O4: no overpayment — there is nowhere to carry a negative balance.
      const overpaid = paidAmountProblem(dto.paidAmount, netPayable);
      if (overpaid) {
        throw new BadRequestException({
          code: 'LABOUR_PAID_ABOVE_NET',
          message: overpaid,
        });
      }
      let carriedForward = 0;
      if (dto.paidAmount !== netPayable) {
        if (!dto.shortPaymentReason) {
          throw new BadRequestException(
            'A paid amount differing from net payable requires a reason',
          );
        }
        // Paid on the worker's next sheet, as a line of its own (036 O4).
        carriedForward = roundMoney(netPayable - dto.paidAmount);
      }

      // Apply advance recovery (FR-025): outstanding reduced only now. What each deduction
      // actually took is written back on the line, so a reversal returns exactly that (036 O1).
      const deductions = deductionEntries(line.deductions);
      for (const d of deductions) {
        if (d.type === 'advance' && d.advanceId) {
          d.recovered = await this.applyRecovery(tx, d.advanceId, d.amount);
        }
      }

      await tx.paymentSheetLine.update({
        where: { id: lineId },
        data: {
          paymentMode: dto.paymentMode,
          paidOn: new Date(`${dto.paidOn.slice(0, 10)}T00:00:00.000Z`),
          paidAmount: dto.paidAmount,
          acknowledgementRef,
          shortPaymentReason: dto.shortPaymentReason ?? null,
          carriedForwardBalance: carriedForward,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          status: PaymentSheetLineStatus.disbursed,
        },
      });

      await this.recomputeSheetStatus(tx, line.sheetId);
    });

    // The line and its mode, so the activity log can tell a cash disbursal (038).
    await this.audit(
      AuditAction.UPDATE,
      sheetId,
      companyId,
      caller,
      ipAddress,
      {
        lineId,
        paymentMode: dto.paymentMode,
      },
    );
    return this.findOne(caller, sheetId);
  }

  async reverseLine(
    caller: AuthenticatedUser,
    lineId: string,
    reason: string,
    ipAddress: string,
  ) {
    let sheetId = '';
    let reversedMode: LabourPaymentMode | null = null;
    // The line's own company for the audit row, not the caller's home company (036 3e).
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const line = await tx.paymentSheetLine.findUnique({
        where: { id: lineId },
        include: { sheet: true },
      });
      if (!line) {
        throw new NotFoundException(`Payment line ${lineId} not found`);
      }
      assertInScope(caller, line, `Payment line ${lineId}`);
      sheetId = line.sheetId;
      companyId = line.sheet.companyId;
      // 038: a cash payment is not reversed while cash is hidden.
      await this.assertLineWritable(tx, line, null);
      reversedMode = line.paymentMode;

      if (line.status !== PaymentSheetLineStatus.disbursed) {
        throw new ConflictException('Only a disbursed line can be reversed');
      }
      if (line.sheet.status === PaymentSheetStatus.closed) {
        throw new ConflictException(
          'Reopen the closed sheet before reversing a line',
        );
      }

      // 036 O4: a shortfall already on a live sheet would be paid twice if this line went back to
      // pending — it would be paid in full here, and the carry-forward line would pay it again.
      if (line.carriedForwardBalance.toNumber() > 0) {
        const carriedOn = await tx.paymentSheetLine.findFirst({
          where: { carriedFromLineId: line.id, sheet: { deletedAt: null } },
          select: {
            sheet: { select: { periodFrom: true, periodTo: true } },
          },
        });
        if (carriedOn) {
          throw new ConflictException({
            code: 'LABOUR_SHORTFALL_CARRIED',
            message: `The unpaid part of this line is on the payment sheet for ${carriedOn.sheet.periodFrom
              .toISOString()
              .slice(0, 10)} to ${carriedOn.sheet.periodTo
              .toISOString()
              .slice(
                0,
                10,
              )}. Delete that sheet while it is a draft, then reverse this line.`,
          });
        }
      }

      // Give back what the disbursement recovered — not the deduction, which can be more when the
      // balance was already lower (036 O1).
      const deductions = deductionEntries(line.deductions);
      for (const d of deductions) {
        if (d.type === 'advance' && d.advanceId) {
          await this.applyRecovery(tx, d.advanceId, -restoreFor(d));
          delete d.recovered;
        }
      }

      await tx.paymentSheetLine.update({
        where: { id: lineId },
        data: {
          status: PaymentSheetLineStatus.pending,
          paymentMode: null,
          paidOn: null,
          paidAmount: null,
          acknowledgementRef: null,
          shortPaymentReason: null,
          carriedForwardBalance: 0,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          reversalReason: reason,
        },
      });

      await this.recomputeSheetStatus(tx, line.sheetId);
    });

    // The line and the mode it had been paid in, so the activity log can tell a cash reversal (038).
    await this.audit(
      AuditAction.UPDATE,
      sheetId,
      companyId,
      caller,
      ipAddress,
      {
        lineId,
        paymentMode: reversedMode,
        reversed: true,
      },
    );
    return this.findOne(caller, sheetId);
  }

  /**
   * 038: refuses a change to a line that is cash — on a direct sheet, disbursed in cash, about to be
   * paid in cash, or carrying forward a cash payment's remainder — while cash is hidden.
   */
  private async assertLineWritable(
    tx: Prisma.TransactionClient,
    line: {
      paymentMode: LabourPaymentMode | null;
      carriedFromLineId: string | null;
      sheet: { companyId: string; engagementType: EngagementType };
    },
    newMode: LabourPaymentMode | null,
  ): Promise<void> {
    const maybeCash =
      isCashSheet(line.sheet) ||
      isCashLine(line) ||
      newMode === LabourPaymentMode.cash ||
      !!line.carriedFromLineId;
    if (!maybeCash || !(await this.cashHidden(line.sheet.companyId))) return;
    if (
      isCashSheet(line.sheet) ||
      newMode === LabourPaymentMode.cash ||
      isHiddenLine(line, await cashCarrySources(tx, [line]))
    ) {
      throw cashHiddenError();
    }
  }

  /**
   * Reduces an advance's outstanding balance by `amount` (negative gives back), closing it at zero
   * (US7 AC7) and reopening it when a reversal gives some back. Returns what actually moved, which
   * a recovery caps at the balance. The row is locked first, so two lines disbursed at once cannot
   * both read the same balance.
   */
  private async applyRecovery(
    tx: Prisma.TransactionClient,
    advanceId: string,
    amount: number,
  ): Promise<number> {
    await tx.$queryRaw`SELECT 1 FROM "labour"."LabourAdvance" WHERE "id" = ${advanceId} FOR UPDATE`;
    const advance = await tx.labourAdvance.findUnique({
      where: { id: advanceId },
    });
    if (!advance) return 0;
    const outstanding = advance.outstandingBalance.toNumber();
    const moved = amount >= 0 ? recoveryFor(outstanding, amount) : amount;
    const next = roundMoney(outstanding - moved);
    await tx.labourAdvance.update({
      where: { id: advanceId },
      data: {
        outstandingBalance: next,
        status: next <= 0 ? AdvanceStatus.closed : AdvanceStatus.disbursed,
      },
    });
    return moved;
  }

  private async recomputeSheetStatus(
    tx: Prisma.TransactionClient,
    sheetId: string,
  ) {
    const lines = await tx.paymentSheetLine.findMany({
      where: { sheetId },
      select: { status: true },
    });
    const anyDisbursed = lines.some(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    const allDisbursed = lines.every(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    await tx.labourPaymentSheet.update({
      where: { id: sheetId },
      data: allDisbursed
        ? { status: PaymentSheetStatus.closed, closedAt: new Date() }
        : anyDisbursed
        ? { status: PaymentSheetStatus.partially_disbursed, closedAt: null }
        : { status: PaymentSheetStatus.approved, closedAt: null },
    });
  }
}
