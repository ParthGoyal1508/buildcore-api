import { Permission } from '@prisma/client';

import type { RunStatutoryTotals } from '../../payroll/challans/challans.service';
import { buildDashboardContext } from '../context';
import {
  buildStatutoryCalendar,
  dueDatesInWindow,
  StatutoryCalendarProvider,
  statutoryDueDate,
} from './statutory-calendar.provider';

/**
 * The Statutory Calendar (2026-10-15): fixed statutory dates, amounts from processed
 * runs, and nothing that claims a payment was or was not made.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (
  companyId: string,
  period: string,
  figures: Partial<RunStatutoryTotals> = {},
): RunStatutoryTotals => ({
  companyId,
  runId: `run-${companyId}-${period}`,
  period,
  employees: 10,
  gross: 100_000,
  pf: 12_000,
  esic: 3_000,
  pt: 2_000,
  tds: 4_000,
  ...figures,
});

const COMPANIES = [
  { id: 'co-a', name: 'Dummy Alpha Test Firm', shortCode: 'DATF' },
  { id: 'co-b', name: 'Dummy Beta Test Firm', shortCode: 'DBTF' },
];

describe('statutoryDueDate', () => {
  it('puts PF and ESIC on the 15th of the following month', () => {
    expect(statutoryDueDate('PF', '2026-09')).toBe('2026-10-15');
    expect(statutoryDueDate('ESIC', '2026-12')).toBe('2027-01-15');
  });

  it('puts TDS on the 7th, except March, which is due 30 April', () => {
    expect(statutoryDueDate('TDS', '2026-09')).toBe('2026-10-07');
    expect(statutoryDueDate('TDS', '2027-03')).toBe('2027-04-30');
  });
});

describe('dueDatesInWindow', () => {
  it('keeps the last week and the next 45 days, nothing else', () => {
    // September's TDS fell due on 7 Oct — eight days back, one past the lookback.
    expect(dueDatesInWindow('2026-10-15', ['PF', 'TDS'])).toEqual([
      { scheme: 'PF', period: '2026-09', dueDate: '2026-10-15' },
      { scheme: 'PF', period: '2026-10', dueDate: '2026-11-15' },
      { scheme: 'TDS', period: '2026-10', dueDate: '2026-11-07' },
    ]);
    expect(dueDatesInWindow('2026-10-14', ['TDS'])).toContainEqual({
      scheme: 'TDS',
      period: '2026-09',
      dueDate: '2026-10-07',
    });
  });

  it("reaches back for March's TDS while it is still in the window", () => {
    const dates = dueDatesInWindow('2027-04-20', ['TDS']);
    expect(dates).toContainEqual({
      scheme: 'TDS',
      period: '2027-03',
      dueDate: '2027-04-30',
    });
  });
});

describe('buildStatutoryCalendar', () => {
  const build = (
    latest: RunStatutoryTotals[],
    inWindow: RunStatutoryTotals[],
  ) =>
    buildStatutoryCalendar({
      today: '2026-10-15',
      companies: COMPANIES,
      schemes: ['PF', 'ESIC', 'TDS'],
      latest,
      inWindow,
    });

  it('lists processed months with amounts and the month in progress without', () => {
    const sep = run('co-a', '2026-09');
    const items = build([sep], [sep]);

    expect(
      items.map((i) => [
        i.scheme,
        i.period,
        i.dueDate,
        i.daysRemaining,
        i.amount,
      ]),
    ).toEqual([
      ['PF', '2026-09', '2026-10-15', 0, 12_000],
      ['ESIC', '2026-09', '2026-10-15', 0, 3_000],
      ['TDS', '2026-10', '2026-11-07', 23, null],
      ['PF', '2026-10', '2026-11-15', 31, null],
      ['ESIC', '2026-10', '2026-11-15', 31, null],
    ]);
  });

  it('skips a company that has never processed payroll', () => {
    const items = build([run('co-a', '2026-09')], [run('co-a', '2026-09')]);
    expect(items.every((i) => i.companyId === 'co-a')).toBe(true);
  });

  it('leaves off a scheme the run puts nothing on, rather than ₹0 due', () => {
    const sep = run('co-a', '2026-09', { esic: 0, tds: 0 });
    const items = build([sep], [sep]);
    expect(items.map((i) => i.scheme)).toEqual(['PF', 'PF']);
  });

  it('sorts by date, then company code', () => {
    const a = run('co-a', '2026-09', { tds: 0, esic: 0 });
    const b = run('co-b', '2026-09', { tds: 0, esic: 0 });
    const items = build([a, b], [a, b]);
    expect(items.map((i) => `${i.dueDate} ${i.shortCode}`)).toEqual([
      '2026-10-15 DATF',
      '2026-10-15 DBTF',
      '2026-11-15 DATF',
      '2026-11-15 DBTF',
    ]);
  });
});

describe('StatutoryCalendarProvider', () => {
  const setup = () => {
    const companies = { listAccessible: jest.fn(async () => COMPANIES) };
    const sep = run('co-a', '2026-09');
    const challans = {
      latestRunTotals: jest.fn(async () => [sep]),
      runTotalsForPeriods: jest.fn(async () => [sep]),
    };
    return {
      provider: new StatutoryCalendarProvider(
        companies as any,
        challans as any,
      ),
      challans,
    };
  };
  const ctx = (permissions: Permission[]) =>
    buildDashboardContext(
      {
        id: 'u-1',
        companyId: 'co-a',
        permissions: [Permission.DASHBOARD, ...permissions],
        roleIds: [],
      } as any,
      '127.0.0.1',
    );
  // Noon UTC is 17:30 in Kolkata, the same calendar day either way.
  const now = new Date('2026-10-15T12:00:00Z');

  it('is a real list now, not the "module pending" placeholder', async () => {
    const { provider } = setup();
    const result: any = await provider.build(ctx([Permission.PAYROLL]), now);
    expect(result).not.toHaveProperty('unavailable');
    expect(result.value.items.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/Filing is not tracked/);
  });

  it('shows PF and ESIC but not TDS to a CHALLANS-only caller', async () => {
    const { provider } = setup();
    const result: any = await provider.build(ctx([Permission.CHALLANS]), now);
    expect(result.value.schemes).toEqual(['PF', 'ESIC']);
    expect(result.value.items.some((i: any) => i.scheme === 'TDS')).toBe(false);
  });

  it('reads nothing for a caller with no payroll permission', async () => {
    const { provider, challans } = setup();
    const result: any = await provider.build(ctx([]), now);
    expect(result.value.items).toEqual([]);
    expect(challans.latestRunTotals).not.toHaveBeenCalled();
  });
});
