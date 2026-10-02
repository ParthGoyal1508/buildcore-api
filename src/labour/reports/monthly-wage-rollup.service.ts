import { Injectable } from '@nestjs/common';
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
export class MonthlyWageRollupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

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
        let share = 1;
        let daysThisMonth = recordedDays;
        let lineApportioned = false;

        if (apportioned) {
          lineApportioned = true;
          const days = perWorker.get(line.workerId);
          if (days && days.inPeriod > 0) {
            share = days.inMonth / days.inPeriod;
            daysThisMonth = days.inMonth;
            daysInMonth += days.inMonth;
            daysInPeriod += days.inPeriod;
          } else {
            // No approved muster day to apportion on. Placed whole in the month the period ends
            // in — see the class comment; the alternative loses the wage from both months.
            placedByPeriodEnd += 1;
            share = periodEndsInMonth ? 1 : 0;
            daysThisMonth = periodEndsInMonth ? recordedDays : 0;
            daysInPeriod += recordedDays;
            if (periodEndsInMonth) daysInMonth += recordedDays;
          }
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
