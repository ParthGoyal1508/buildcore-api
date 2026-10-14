import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import config from '../../common/configs/config';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import {
  ChallansService,
  type RunStatutoryTotals,
} from '../../payroll/challans/challans.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { DashboardContext } from '../context';
import { daysBetween } from '../reminders/reminder-rule.types';
import type { WidgetResult } from './widget.types';

/** The schemes the calendar knows a statutory due date for. */
export type StatutoryScheme = 'PF' | 'ESIC' | 'TDS';

/** One due date on the calendar. */
export interface StatutoryDueItem {
  companyId: string;
  companyName: string;
  shortCode: string;
  scheme: StatutoryScheme;
  /** The payroll month the payment is for, `YYYY-MM`. */
  period: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  /** Whole days from today (business time zone) to `dueDate`; negative once passed. */
  daysRemaining: number;
  /**
   * What that month's processed run puts on the challan — null while the month has no
   * processed run, which is the ordinary state of the month in progress.
   */
  amount: number | null;
}

/** How far ahead the calendar looks. */
export const STATUTORY_HORIZON_DAYS = 45;
/**
 * How long a passed date stays on the calendar. Short on purpose: nothing records a
 * filing, so a date cannot drop off by being filed — only by ageing out — and a month-old
 * "overdue" that was paid on time would be the false alarm the old note warned about.
 */
export const STATUTORY_LOOKBACK_DAYS = 7;

/**
 * The statutory due date for one scheme and payroll month (2026-10-15).
 *
 * - **PF** (EPF Scheme, para 38) and **ESIC** (ESI (Central) Rules, r. 31): the 15th of
 *   the following month.
 * - **TDS on salary** (Income-tax Rules, r. 30): the 7th of the following month, except
 *   tax deducted in March, which is due by 30 April.
 *
 * Professional Tax is deliberately absent. Its due date is set by each state's own Act
 * (and varies with the employer's liability), and nothing in this codebase records a PT
 * rule per state — `Company.state` is free text and the PT slabs are one global
 * configuration. A calendar entry with a guessed date is worse than none.
 */
export function statutoryDueDate(
  scheme: StatutoryScheme,
  period: string,
): string {
  const [year, month] = period.split('-').map(Number);
  if (scheme === 'TDS' && month === 3) return `${year}-04-30`;
  const day = scheme === 'TDS' ? 7 : 15;
  // `month` is 1-based, so as a 0-based index it is already the following month;
  // Date.UTC rolls December into January of the next year.
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** `YYYY-MM` shifted by `delta` months. */
function addMonths(period: string, delta: number): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1))
    .toISOString()
    .slice(0, 7);
}

const AMOUNT: Record<StatutoryScheme, (t: RunStatutoryTotals) => number> = {
  PF: (t) => t.pf,
  ESIC: (t) => t.esic,
  TDS: (t) => t.tds,
};

const SCHEME_ORDER: StatutoryScheme[] = ['PF', 'ESIC', 'TDS'];

/**
 * Builds the calendar from run totals — pure, so the date rules are tested without a
 * database.
 *
 * A company appears only once it has **any** processed run: a company that does not run
 * payroll here has no PF date to be reminded of. For each month whose due date falls in
 * the window:
 *
 * - a processed run gives the amount, and a scheme that run puts nothing on (no
 *   PF-applicable staff, no TDS deducted) is left off rather than shown as ₹0 due;
 * - a month **after** the latest processed one (the month in progress, typically) is
 *   listed with no amount, for the schemes the latest run did carry — the date is
 *   statutory whether or not payroll has been run yet.
 */
export function buildStatutoryCalendar(input: {
  today: string;
  companies: { id: string; name: string; shortCode: string }[];
  schemes: StatutoryScheme[];
  latest: RunStatutoryTotals[];
  inWindow: RunStatutoryTotals[];
}): StatutoryDueItem[] {
  const { today, companies, schemes, latest, inWindow } = input;
  const latestBy = new Map(latest.map((t) => [t.companyId, t]));
  const runBy = new Map(inWindow.map((t) => [`${t.companyId}|${t.period}`, t]));
  const items: StatutoryDueItem[] = [];

  for (const company of companies) {
    const last = latestBy.get(company.id);
    if (!last) continue;
    for (const { scheme, period, dueDate } of dueDatesInWindow(
      today,
      schemes,
    )) {
      const run = runBy.get(`${company.id}|${period}`);
      let amount: number | null;
      if (run) {
        amount = AMOUNT[scheme](run);
        if (amount === 0) continue;
      } else {
        if (period <= last.period || AMOUNT[scheme](last) === 0) continue;
        amount = null;
      }
      items.push({
        companyId: company.id,
        companyName: company.name,
        shortCode: company.shortCode,
        scheme,
        period,
        dueDate,
        daysRemaining: daysBetween(today, dueDate),
        amount,
      });
    }
  }

  return items.sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.shortCode.localeCompare(b.shortCode) ||
      SCHEME_ORDER.indexOf(a.scheme) - SCHEME_ORDER.indexOf(b.scheme),
  );
}

/** Every (scheme, payroll month) whose due date falls inside the window around `today`. */
export function dueDatesInWindow(
  today: string,
  schemes: StatutoryScheme[],
): { scheme: StatutoryScheme; period: string; dueDate: string }[] {
  const current = today.slice(0, 7);
  const out: { scheme: StatutoryScheme; period: string; dueDate: string }[] =
    [];
  // Three months back covers the lookback and March's late TDS date; one forward is as
  // far as a 45-day horizon can reach (a month's dues fall in the month after).
  for (let delta = -3; delta <= 1; delta++) {
    const period = addMonths(current, delta);
    for (const scheme of schemes) {
      const dueDate = statutoryDueDate(scheme, period);
      const days = daysBetween(today, dueDate);
      if (days >= -STATUTORY_LOOKBACK_DAYS && days <= STATUTORY_HORIZON_DAYS) {
        out.push({ scheme, period, dueDate });
      }
    }
  }
  return out;
}

/**
 * The Group Dashboard's Statutory Calendar (2026-10-15).
 *
 * Replaces the "unavailable" placeholder. That placeholder was right that nothing records
 * what has been **filed**, and that is still true; what it lacked — the due dates — are
 * fixed by statute and need no table, so they are computed here. The calendar therefore
 * says when each payment falls due and how much the run puts on it, and never whether it
 * was paid: an item's status is its distance from the date, nothing more.
 *
 * Schemes are gated like the screens behind them: PF and ESIC with the Challans screen
 * (`CHALLANS`, or `PAYROLL`), TDS with the payroll screens (`PAYROLL`). A caller holding
 * neither gets an empty calendar rather than amounts their role does not open.
 */
@Injectable()
export class StatutoryCalendarProvider {
  constructor(
    private readonly companies: CompaniesService,
    private readonly challans: ChallansService,
  ) {}

  async build(ctx: DashboardContext, now = new Date()): Promise<WidgetResult> {
    const held = (...permissions: Permission[]) =>
      permissions.some((p) => ctx.user.permissions.includes(p));
    const schemes: StatutoryScheme[] = [
      ...(held(Permission.CHALLANS, Permission.PAYROLL)
        ? (['PF', 'ESIC'] as const)
        : []),
      ...(held(Permission.PAYROLL) ? (['TDS'] as const) : []),
    ];
    const today = zonedDateOnly(now, config().settings.timezone);

    let items: StatutoryDueItem[] = [];
    if (schemes.length > 0) {
      const companies = await this.companies.listAccessible(ctx.user);
      const ids = companies.map((c) => c.id);
      const periods = [
        ...new Set(dueDatesInWindow(today, schemes).map((d) => d.period)),
      ];
      const [latest, inWindow] = await Promise.all([
        this.challans.latestRunTotals(ctx.rls, ids),
        this.challans.runTotalsForPeriods(ctx.rls, ids, periods),
      ]);
      items = buildStatutoryCalendar({
        today,
        companies,
        schemes,
        latest,
        inWindow,
      });
    }

    return {
      id: 'statutory-calendar',
      displayType: 'list',
      title: 'Statutory Calendar',
      section: 'group',
      value: {
        today,
        horizonDays: STATUTORY_HORIZON_DAYS,
        lookbackDays: STATUTORY_LOOKBACK_DAYS,
        schemes,
        items,
      },
      note:
        'Filing is not tracked here — dates are statutory, amounts are from processed ' +
        'payroll runs. Professional Tax is not listed: its due date is set per state.',
    };
  }
}
