import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EngagementType,
  MusterStatus,
  PaymentSheetStatus,
  RateSource,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { RlsContext } from '../../common/prisma/rls-context';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  ProjectSourcesRegistry,
  type ProjectCostRecord,
  type ProjectCostSource,
} from '../../projects/portfolio/project-sources.registry';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { companyScope } from '../../settings/company-scope';
import { dayFractionOf, roundMoney } from '../payment-sheets/wage-calc.util';

/**
 * The sheet statuses whose figures the roll-up counts (FR-013 says *approved* sheets).
 *
 * `draft` is excluded and **counted separately** — a draft sheet is a proposal, and a month that
 * quietly included one would move the moment somebody edited it. The count is on the response so a
 * reader can see the figure is partial rather than take it as final.
 */
export const COUNTED_SHEET_STATUSES: readonly PaymentSheetStatus[] = [
  PaymentSheetStatus.approved,
  PaymentSheetStatus.partially_disbursed,
  PaymentSheetStatus.closed,
];

/** How a sheet's figures were placed into the month. */
export type ApportionmentBasis =
  /** Days worked inside the month, from the approved muster behind each line (plan D12). */
  | 'muster-days'
  /** At least one line had no approved muster day in the period — see `placedByPeriodEnd`. */
  | 'sheet-period-end';

/** One worker's wages inside the month, as the sheets recorded them. */
export interface MonthlyWageWorkerRow {
  workerId: string;
  labourCode: string | null;
  fullName: string | null;
  /** Days attributed to this month. Full day = 1, half day = 0.5, as the muster recorded it. */
  daysWorked: number;
  overtimeHours: number;
  /**
   * The rate the sheet applied. `null` when two contributing sheets applied different rates — a
   * mid-month rate revision is legitimate, and one number would have to pick a side and hide it.
   */
  resolvedRate: number | null;
  rateSource: RateSource | null;
  grossWage: number;
  deductions: number;
  netPayable: number;
  /** Which sheets contributed, so any figure here can be opened. */
  sheetIds: string[];
  /** True when any contributing sheet straddled the month boundary. */
  apportioned: boolean;
}

/** One contributing sheet, its own totals, and what this month took from it. */
export interface MonthlyWageSheetRow {
  sheetId: string;
  periodFrom: string;
  periodTo: string;
  engagementType: EngagementType;
  status: PaymentSheetStatus;
  /** Exactly as the sheet recorded them. Nothing here is recomputed (FR-010b). */
  recorded: { grossTotal: number; deductionTotal: number; netTotal: number };
  /** What this month takes, summed from the sheet's own lines — never apportioned separately. */
  inMonth: { grossTotal: number; deductionTotal: number; netTotal: number };
  apportioned: boolean;
  /** Present only for a sheet that straddled the boundary — FR-010a requires it be stated. */
  apportionment: {
    basis: ApportionmentBasis;
    /** Muster day-equivalents inside the month, summed across the sheet's workers. */
    daysInMonth: number;
    /** The same across the sheet's whole period. The ratio of the two is the apportionment. */
    daysInPeriod: number;
    /** Lines with no approved muster day in the period, placed whole by the period's end month. */
    placedByPeriodEnd: number;
    note: string;
  } | null;
}

/** Per-engagement subtotals, so the per-worker list can be reconciled against the month. */
export interface MonthlyWageEngagementTotals {
  engagementType: EngagementType;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  sheetCount: number;
  /** Workers itemised. Zero for contractor engagement, which is not a per-worker disbursement. */
  workerCount: number;
}

export interface ProjectMonthlyWageRollup {
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  /** `YYYY-MM` — the same key the P&L's `period` uses, so the two surfaces join. */
  period: string;
  monthStart: string;
  monthEnd: string;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  byEngagement: MonthlyWageEngagementTotals[];
  /**
   * Directly engaged workers only, and `workersNote` says so.
   *
   * A contractor sheet is the contractor's basis of payment, not a disbursement to the people named
   * on it (the spec's edge case), so itemising it would present payments that were never made to
   * anybody listed. That money is still in `grossTotal` and in `byEngagement`.
   */
  workers: MonthlyWageWorkerRow[];
  workersNote: string;
  sheets: MonthlyWageSheetRow[];
  /** Sheets overlapping the month that are still in draft, and therefore excluded. */
  draftSheetCount: number;
  note: string;
}

/**
 * The per-project, per-calendar-month labour wage roll-up (018 FR-010a, FR-010b — `bugs.md` item 14).
 *
 * ## It is a view, and it computes no wage
 *
 * Every figure here is read from `PaymentSheetLine` as the sheet recorded it. The roll-up adds up and
 * apportions; it does not price a day, resolve a rate or apply a deduction. That is FR-010b and plan
 * D13, and it is why this phase added no table: a stored roll-up would be a second figure for the
 * same wage, and the two would disagree the first time a sheet was reopened — which the spec's own
 * edge case says happens.
 *
 * ## Overlapping, not contained
 *
 * A payment sheet covers a *wage period* its creator named. Nothing makes that a calendar month, and
 * under a fortnightly cycle a month boundary falls inside one. So the month's sheets are the ones
 * **overlapping** it (`periodFrom <= monthEnd AND periodTo >= monthStart`). A containment test on
 * `periodFrom` would silently drop a fortnight beginning on the 28th from the month that paid most
 * of it.
 *
 * ## Apportionment is on days worked, never on elapsed calendar days
 *
 * Plan D12. `PaymentSheetLine.daysWorked` comes from approved muster rows, and those rows carry
 * dates, so the days falling inside the month are **knowable exactly**. A worker who worked four days
 * of a fortnight all in the first week is not half-attributable to each month, and a labour figure
 * that disagrees with the muster is worse than one that is merely coarse.
 *
 * The one case the muster cannot answer is a line with no approved muster day in the period — a
 * hand-built sheet, or a muster withdrawn after the sheet was generated. Pro-rating by calendar days
 * there would invent precisely the figure D12 refuses; attributing nothing would **lose the wage from
 * both months**, which is worse still, because the month then stops reconciling to the sheet and
 * nothing says why. Such a line is placed whole in the month containing the sheet's `periodTo` and
 * counted in `placedByPeriodEnd` — so the money is never lost, never counted twice, and never silent.
 *
 * ## No cross-schema query
 *
 * This lives in `labour` because it reads `labour`'s tables (Principle I). `projects` reaches it
 * through this exported service, the way FR-033's labour cost already travels.
 */
@Injectable()
export class MonthlyWageRollupService
  implements OnModuleInit, ProjectCostSource
{
  private readonly logger = new Logger(MonthlyWageRollupService.name);

  /** This service accounts for the P&L's labour category (018 T026). */
  readonly category = 'labour' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /**
   * Announces labour's cost source to the project P&L (T026).
   *
   * Registration rather than `ProjectsModule` importing `LabourModule`: that module is already
   * imported *by* this one, and closing the loop would make the dependency a cycle. See
   * `ProjectSourcesRegistry`.
   *
   * **This service and not `LabourService`.** `LabourService.getLabourCostByProject()` prices the
   * approved muster, re-resolving each day's rate; this one reads what the payment sheets actually
   * recorded. Both are defensible figures and they are **not the same figure** — the muster is what
   * was worked, the sheet is what was approved for payment. FR-013 requires the P&L's monthly labour
   * cost reconcile to the approved payment sheets, so the sheets are what the P&L must read, and
   * reading them through the same code the roll-up uses is what makes the drill-down add up to the
   * total rather than nearly add up to it.
   */
  onModuleInit(): void {
    this.sources.registerCostSource(this);
  }

  /**
   * The P&L's labour cost for several projects at once (T026, FR-010, FR-013).
   *
   * Batched in one query over every named project's overlapping sheets, then apportioned exactly as
   * `rollupFor` apportions — the two share `lineShare()`, so the drill-down and the total cannot
   * drift apart.
   *
   * **Gross, not net.** A deduction is money recovered from the worker, not money the project did
   * not spend: a P&L reading `netPayable` would understate labour by every advance instalment
   * recovered in the period, and the error would grow with the project. `bill-totals.ts` makes the
   * same call about an RA bill's retention, for the same reason.
   *
   * A project that cannot be computed is **omitted from the map** rather than returned as zero. The
   * P&L reports a category with no source as unavailable; a project with no entry is the same fact
   * one level down, and a zero here would be indistinguishable from a month with no labour.
   */
  async costsByProject(
    projectIds: string[],
    companyId: string,
    range: { from: Date; to: Date },
  ): Promise<Map<string, number>> {
    const ctx = { isSuperAdmin: false, companyId };
    const totals = new Map<string, number>();
    if (projectIds.length === 0) return totals;

    try {
      const sheets = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.labourPaymentSheet.findMany({
          where: {
            companyId,
            projectId: { in: projectIds },
            deletedAt: null,
            periodFrom: { lte: range.to },
            periodTo: { gte: range.from },
          },
          include: { lines: true },
        }),
      );

      const counted = sheets.filter((sheet) =>
        COUNTED_SHEET_STATUSES.includes(sheet.status),
      );
      for (const projectId of projectIds) totals.set(projectId, 0);

      // Only the sheets crossing a range boundary need the muster, and only those projects.
      const straddling = counted.filter(
        (sheet) => sheet.periodFrom < range.from || sheet.periodTo > range.to,
      );
      const musterDays = new Map<string, Map<string, MusterDays>>();
      for (const projectId of new Set(straddling.map((s) => s.projectId))) {
        const forProject = await this.musterDaysBySheet(
          ctx,
          projectId,
          straddling.filter((sheet) => sheet.projectId === projectId),
          range.from,
          range.to,
        );
        for (const [sheetId, days] of forProject) musterDays.set(sheetId, days);
      }

      for (const sheet of counted) {
        const apportioned =
          sheet.periodFrom < range.from || sheet.periodTo > range.to;
        const perWorker = musterDays.get(sheet.id);
        let gross = totals.get(sheet.projectId) ?? 0;
        for (const line of sheet.lines) {
          const { share } = lineShare(
            apportioned,
            line.daysWorked.toNumber(),
            perWorker?.get(line.workerId),
            sheet.periodTo <= range.to,
          );
          if (share === 0) continue;
          gross = roundMoney(
            gross + roundMoney(line.grossWage.toNumber() * share),
          );
        }
        totals.set(sheet.projectId, gross);
      }
      return totals;
    } catch (error) {
      // Logged and dropped, not thrown: a P&L that renders every other cost line is more useful
      // than one that fails outright, and the P&L says which categories it could not ask.
      this.logger.warn(
        `Labour cost could not be computed for ${
          projectIds.length
        } project(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  async rollupFor(
    caller: AuthenticatedUser,
    query: {
      projectId: string;
      year: number;
      month: number;
      companyId?: string;
    },
  ): Promise<ProjectMonthlyWageRollup> {
    const ctx = rlsContextFor(caller);
    const { monthStart, monthEnd } = monthBounds(query.year, query.month);

    const sheets = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.labourPaymentSheet.findMany({
        where: {
          ...companyScope(caller, query.companyId),
          projectId: query.projectId,
          deletedAt: null,
          // FR-010a: overlapping the month, not contained by it.
          periodFrom: { lte: monthEnd },
          periodTo: { gte: monthStart },
        },
        include: { lines: true },
        orderBy: [{ periodFrom: 'asc' }, { engagementType: 'asc' }],
      }),
    );

    const counted = sheets.filter((sheet) =>
      COUNTED_SHEET_STATUSES.includes(sheet.status),
    );
    const draftSheetCount = sheets.length - counted.length;

    const straddling = new Set(
      counted
        .filter(
          (sheet) => sheet.periodFrom < monthStart || sheet.periodTo > monthEnd,
        )
        .map((sheet) => sheet.id),
    );
    // Only a straddling sheet needs the muster. A sheet wholly inside the month contributes in
    // full, exactly, with no ratio and so no rounding step for anybody to disagree about.
    const musterDays = straddling.size
      ? await this.musterDaysBySheet(
          ctx,
          query.projectId,
          counted.filter((sheet) => straddling.has(sheet.id)),
          monthStart,
          monthEnd,
        )
      : new Map<string, Map<string, MusterDays>>();

    const sheetRows: MonthlyWageSheetRow[] = [];
    const accumulated = new Map<string, WorkerAccumulator>();

    for (const sheet of counted) {
      const apportioned = straddling.has(sheet.id);
      const perWorker =
        musterDays.get(sheet.id) ?? new Map<string, MusterDays>();
      const periodEndsInMonth = sheet.periodTo <= monthEnd;
      let daysInMonth = 0;
      let daysInPeriod = 0;
      let placedByPeriodEnd = 0;
      const inMonth = { grossTotal: 0, deductionTotal: 0, netTotal: 0 };

      for (const line of sheet.lines) {
        const recordedDays = line.daysWorked.toNumber();
        const placement = lineShare(
          apportioned,
          recordedDays,
          perWorker.get(line.workerId),
          periodEndsInMonth,
        );
        const share = placement.share;
        const daysThisMonth = placement.daysInRange;
        const lineApportioned = apportioned;

        if (apportioned) {
          daysInMonth += placement.daysInRange;
          daysInPeriod += placement.daysInPeriod;
          if (placement.placedByPeriodEnd) placedByPeriodEnd += 1;
        }

        if (share === 0) continue;

        const gross = roundMoney(line.grossWage.toNumber() * share);
        const deduction = roundMoney(sumDeductions(line.deductions) * share);
        const net = roundMoney(line.netPayable.toNumber() * share);

        inMonth.grossTotal = roundMoney(inMonth.grossTotal + gross);
        inMonth.deductionTotal = roundMoney(inMonth.deductionTotal + deduction);
        inMonth.netTotal = roundMoney(inMonth.netTotal + net);

        // A contractor sheet contributes to the totals and is not itemised per worker.
        if (sheet.engagementType === EngagementType.direct) {
          accumulate(accumulated, line.workerId, {
            sheetId: sheet.id,
            daysWorked: roundMoney(daysThisMonth),
            overtimeHours: roundMoney(line.overtimeHours.toNumber() * share),
            resolvedRate: line.resolvedRate.toNumber(),
            rateSource: line.rateSource,
            grossWage: gross,
            deductions: deduction,
            netPayable: net,
            apportioned: lineApportioned,
          });
        }
      }

      sheetRows.push({
        sheetId: sheet.id,
        periodFrom: isoDate(sheet.periodFrom),
        periodTo: isoDate(sheet.periodTo),
        engagementType: sheet.engagementType,
        status: sheet.status,
        recorded: {
          grossTotal: sheet.grossTotal.toNumber(),
          deductionTotal: sheet.deductionTotal.toNumber(),
          netTotal: sheet.netTotal.toNumber(),
        },
        inMonth,
        apportioned,
        apportionment: apportioned
          ? {
              basis: placedByPeriodEnd > 0 ? 'sheet-period-end' : 'muster-days',
              daysInMonth: roundMoney(daysInMonth),
              daysInPeriod: roundMoney(daysInPeriod),
              placedByPeriodEnd,
              note: apportionmentNote(
                isoDate(sheet.periodFrom),
                isoDate(sheet.periodTo),
                roundMoney(daysInMonth),
                roundMoney(daysInPeriod),
                placedByPeriodEnd,
              ),
            }
          : null,
      });
    }

    const [identity, workers] = await Promise.all([
      this.projects.getProjectIdentityById(query.projectId, ctx),
      this.nameWorkers(ctx, accumulated),
    ]);

    return {
      projectId: query.projectId,
      projectCode: identity?.code ?? null,
      projectName: identity?.name ?? null,
      period: periodKey(query.year, query.month),
      monthStart: isoDate(monthStart),
      monthEnd: isoDate(monthEnd),
      grossTotal: sumRounded(sheetRows.map((row) => row.inMonth.grossTotal)),
      deductionTotal: sumRounded(
        sheetRows.map((row) => row.inMonth.deductionTotal),
      ),
      netTotal: sumRounded(sheetRows.map((row) => row.inMonth.netTotal)),
      byEngagement: engagementTotals(sheetRows, workers),
      workers,
      workersNote: WORKERS_NOTE,
      sheets: sheetRows,
      draftSheetCount,
      note: NOTE,
    };
  }

  /**
   * The sheets behind one project's labour figure, for the P&L drill-down (FR-012, T031).
   *
   * One record per contributing sheet, carrying **what the range took from it** rather than the
   * sheet's own total — so the records sum to the figure they were opened from. A drill-down whose
   * rows do not add up to the total is worse than no drill-down: it tells the reader the number is
   * wrong without telling them how.
   *
   * The per-worker itemisation is not duplicated here. It is one request away at
   * `labour/reports/monthly-wage-rollup`, and a second copy of it would be a second thing to keep
   * in step.
   */
  async recordsByProject(
    projectId: string,
    companyId: string,
    range: { from: Date; to: Date },
  ): Promise<ProjectCostRecord[]> {
    const ctx = { isSuperAdmin: false, companyId };
    // Deliberately **not** wrapped in a try/catch, unlike `costsByProject` above. A failure there
    // must not take the other cost lines down with it; a failure here is one person opening one
    // figure, and the drill-down reports it as unreadable rather than handing back an empty list
    // that reads as "this month had no wages".
    const sheets = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.labourPaymentSheet.findMany({
        where: {
          companyId,
          projectId,
          deletedAt: null,
          periodFrom: { lte: range.to },
          periodTo: { gte: range.from },
        },
        include: { lines: true },
        orderBy: { periodFrom: 'asc' },
      }),
    );

    const records: ProjectCostRecord[] = [];
    for (const sheet of sheets) {
      if (!COUNTED_SHEET_STATUSES.includes(sheet.status)) continue;
      const apportioned =
        sheet.periodFrom < range.from || sheet.periodTo > range.to;
      const perWorker = apportioned
        ? (
            await this.musterDaysBySheet(
              ctx,
              projectId,
              [sheet],
              range.from,
              range.to,
            )
          ).get(sheet.id)
        : undefined;

      let gross = 0;
      for (const line of sheet.lines) {
        const { share } = lineShare(
          apportioned,
          line.daysWorked.toNumber(),
          perWorker?.get(line.workerId),
          sheet.periodTo <= range.to,
        );
        if (share === 0) continue;
        gross = roundMoney(
          gross + roundMoney(line.grossWage.toNumber() * share),
        );
      }
      if (gross === 0) continue;

      records.push({
        id: sheet.id,
        reference: `${sheet.engagementType} wages ${isoDate(
          sheet.periodFrom,
        )} to ${isoDate(sheet.periodTo)}`,
        date: isoDate(sheet.periodTo),
        amount: gross,
        status: sheet.status,
        description: apportioned
          ? 'Apportioned on days worked inside the period'
          : null,
      });
    }
    return records;
  }

  /**
   * Muster day-equivalents per sheet and worker: inside the month, and across the sheet's whole
   * period. The ratio of the two is the apportionment, and both are reported so a reader can
   * check it rather than take it on trust.
   */
  private async musterDaysBySheet(
    ctx: RlsContext,
    projectId: string,
    sheets: { id: string; periodFrom: Date; periodTo: Date }[],
    monthStart: Date,
    monthEnd: Date,
  ): Promise<Map<string, Map<string, MusterDays>>> {
    const result = new Map<string, Map<string, MusterDays>>();
    const siteIds = await this.projects.getSitesByProject(projectId, ctx);
    if (siteIds.length === 0) return result;

    for (const sheet of sheets) {
      const lines = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              status: MusterStatus.approved,
              deletedAt: null,
              date: { gte: sheet.periodFrom, lte: sheet.periodTo },
            },
          },
          select: {
            workerId: true,
            attendanceType: true,
            muster: { select: { date: true } },
          },
        }),
      );

      const perWorker = new Map<string, MusterDays>();
      for (const line of lines) {
        const fraction = dayFractionOf(line.attendanceType);
        if (fraction === 0) continue;
        const entry = perWorker.get(line.workerId) ?? {
          inMonth: 0,
          inPeriod: 0,
        };
        entry.inPeriod += fraction;
        if (line.muster.date >= monthStart && line.muster.date <= monthEnd) {
          entry.inMonth += fraction;
        }
        perWorker.set(line.workerId, entry);
      }
      result.set(sheet.id, perWorker);
    }
    return result;
  }

  /**
   * Puts a name and a labour code against each itemised worker.
   *
   * A roll-up of worker ids is a roll-up nobody can check against a muster board, and the id is
   * kept beside the name so the figure can still be opened. Aadhaar, bank account and face
   * enrolment are deliberately not selected — a wage report is not an identity document (FR-024).
   */
  private async nameWorkers(
    ctx: RlsContext,
    accumulated: Map<string, WorkerAccumulator>,
  ): Promise<MonthlyWageWorkerRow[]> {
    const rows = [...accumulated.values()].filter(
      (entry) => entry.daysWorked !== 0 || entry.grossWage !== 0,
    );
    if (rows.length === 0) return [];

    const workers = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.labourWorker.findMany({
        where: { id: { in: rows.map((row) => row.workerId) } },
        select: { id: true, labourCode: true, fullName: true },
      }),
    );
    const byId = new Map(workers.map((worker) => [worker.id, worker]));

    return rows
      .map((entry) => ({
        workerId: entry.workerId,
        labourCode: byId.get(entry.workerId)?.labourCode ?? null,
        fullName: byId.get(entry.workerId)?.fullName ?? null,
        daysWorked: entry.daysWorked,
        overtimeHours: entry.overtimeHours,
        resolvedRate: entry.rates.size === 1 ? [...entry.rates][0] : null,
        rateSource:
          entry.rateSources.size === 1 ? [...entry.rateSources][0] : null,
        grossWage: entry.grossWage,
        deductions: entry.deductions,
        netPayable: entry.netPayable,
        sheetIds: entry.sheetIds,
        apportioned: entry.apportioned,
      }))
      .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? ''));
  }
}

interface MusterDays {
  inMonth: number;
  inPeriod: number;
}

interface WorkerAccumulator {
  workerId: string;
  daysWorked: number;
  overtimeHours: number;
  rates: Set<number>;
  rateSources: Set<RateSource>;
  grossWage: number;
  deductions: number;
  netPayable: number;
  sheetIds: string[];
  apportioned: boolean;
}

function accumulate(
  into: Map<string, WorkerAccumulator>,
  workerId: string,
  line: {
    sheetId: string;
    daysWorked: number;
    overtimeHours: number;
    resolvedRate: number;
    rateSource: RateSource;
    grossWage: number;
    deductions: number;
    netPayable: number;
    apportioned: boolean;
  },
): void {
  const entry: WorkerAccumulator = into.get(workerId) ?? {
    workerId,
    daysWorked: 0,
    overtimeHours: 0,
    rates: new Set<number>(),
    rateSources: new Set<RateSource>(),
    grossWage: 0,
    deductions: 0,
    netPayable: 0,
    sheetIds: [],
    apportioned: false,
  };

  entry.daysWorked = roundMoney(entry.daysWorked + line.daysWorked);
  entry.overtimeHours = roundMoney(entry.overtimeHours + line.overtimeHours);
  entry.rates.add(line.resolvedRate);
  entry.rateSources.add(line.rateSource);
  entry.grossWage = roundMoney(entry.grossWage + line.grossWage);
  entry.deductions = roundMoney(entry.deductions + line.deductions);
  entry.netPayable = roundMoney(entry.netPayable + line.netPayable);
  if (!entry.sheetIds.includes(line.sheetId)) entry.sheetIds.push(line.sheetId);
  entry.apportioned = entry.apportioned || line.apportioned;
  into.set(workerId, entry);
}

/** `YYYY-MM`, zero-padded, matching the P&L's period key. */
export function periodKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * The month's first and last instant, in UTC.
 *
 * Deliberately the same arithmetic as `periodRange()` in the P&L, and asserted equal to it in this
 * service's spec. Not imported from there: `projects/pnl` must not become a dependency of `labour`
 * (Principle I), and a six-line date helper is a cheaper duplicate than an inverted module edge.
 */
export function monthBounds(
  year: number,
  month: number,
): { monthStart: Date; monthEnd: Date } {
  return {
    monthStart: new Date(Date.UTC(year, month - 1, 1)),
    // `Date.UTC(y, m, 0)` is the last day of month `m`, which is why the month index is not
    // decremented here. The last millisecond, so a muster dated the 31st is inside the month.
    monthEnd: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

/**
 * Where one payment-sheet line's figures belong, as a fraction of the line.
 *
 * Shared by the roll-up view and the P&L's batched cost source so the drill-down and the total
 * cannot drift apart — two implementations of an apportionment rule is two answers, and the second
 * one to be written is always the one nobody checks.
 *
 * Three cases:
 *
 * 1. The sheet is wholly inside the range: the whole line, exactly, with no ratio and so no
 *    rounding step for anybody to disagree about.
 * 2. The muster can answer: days worked inside the range over days worked across the period
 *    (plan D12).
 * 3. The muster cannot answer — no approved muster day for this worker in the period: the whole
 *    line, placed in the range that contains the sheet's end, and flagged. Pro-rating by calendar
 *    days would invent the figure D12 refuses; attributing nothing would lose the wage from both
 *    sides of the boundary, which is worse because the total then stops reconciling to the sheet.
 */
export function lineShare(
  apportioned: boolean,
  recordedDays: number,
  days: MusterDays | undefined,
  rangeContainsPeriodEnd: boolean,
): {
  share: number;
  daysInRange: number;
  daysInPeriod: number;
  placedByPeriodEnd: boolean;
} {
  if (!apportioned) {
    return {
      share: 1,
      daysInRange: recordedDays,
      daysInPeriod: recordedDays,
      placedByPeriodEnd: false,
    };
  }
  if (days && days.inPeriod > 0) {
    return {
      share: days.inMonth / days.inPeriod,
      daysInRange: days.inMonth,
      daysInPeriod: days.inPeriod,
      placedByPeriodEnd: false,
    };
  }
  return {
    share: rangeContainsPeriodEnd ? 1 : 0,
    daysInRange: rangeContainsPeriodEnd ? recordedDays : 0,
    daysInPeriod: recordedDays,
    placedByPeriodEnd: true,
  };
}

/**
 * The deductions a line applied, from the jsonb list the sheet stored.
 *
 * Summed from the entries rather than taken as `gross - net`: `netPayable` is clamped at zero when
 * deductions exceed the wage, so the subtraction understates the deduction on exactly the lines
 * where it matters most.
 */
export function sumDeductions(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const entry of value) {
    if (entry && typeof entry === 'object' && 'amount' in entry) {
      const amount = Number((entry as { amount: unknown }).amount);
      if (Number.isFinite(amount)) total += amount;
    }
  }
  return roundMoney(total);
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const sumRounded = (values: number[]): number =>
  roundMoney(values.reduce((sum, value) => sum + value, 0));

function apportionmentNote(
  from: string,
  to: string,
  daysInMonth: number,
  daysInPeriod: number,
  placedByPeriodEnd: number,
): string {
  const base =
    `This sheet covers ${from} to ${to}, which crosses the month boundary. ` +
    `${daysInMonth} of its ${daysInPeriod} muster day-equivalents fall inside this month, and each ` +
    `worker's recorded figures were split in that proportion.`;
  return placedByPeriodEnd === 0
    ? base
    : `${base} ${placedByPeriodEnd} line(s) had no approved muster day in the period and were ` +
        `placed whole in the month the period ends in, so no wage is lost or counted twice.`;
}

function engagementTotals(
  sheets: MonthlyWageSheetRow[],
  workers: MonthlyWageWorkerRow[],
): MonthlyWageEngagementTotals[] {
  return [EngagementType.direct, EngagementType.contractor]
    .map((engagementType) => {
      const rows = sheets.filter(
        (sheet) => sheet.engagementType === engagementType,
      );
      return {
        engagementType,
        grossTotal: sumRounded(rows.map((row) => row.inMonth.grossTotal)),
        deductionTotal: sumRounded(
          rows.map((row) => row.inMonth.deductionTotal),
        ),
        netTotal: sumRounded(rows.map((row) => row.inMonth.netTotal)),
        sheetCount: rows.length,
        workerCount:
          engagementType === EngagementType.direct ? workers.length : 0,
      };
    })
    .filter((row) => row.sheetCount > 0);
}

const WORKERS_NOTE =
  'Itemised per worker for directly engaged labour only. A contractor sheet is the contractor’s ' +
  'basis of payment rather than a disbursement to the people named on it, so it appears in the ' +
  'totals and in byEngagement but is not itemised here.';

const NOTE =
  'Every figure is read from the payment sheets as they recorded it; nothing is recomputed. ' +
  'Sheets overlapping the month are included, and a sheet crossing the month boundary is split on ' +
  'days worked inside the month taken from the approved muster — never on elapsed calendar days.';
