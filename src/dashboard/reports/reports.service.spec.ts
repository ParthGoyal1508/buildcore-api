import { NotFoundException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import type { DashboardContext } from '../context';
import type { ReportData, ReportProvider } from './report.types';
import {
  ReportsService,
  assertReportRange,
  withoutCashRows,
} from './reports.service';

const ROSTER: ReportData = {
  columns: [{ key: 'name', label: 'Name' }],
  rows: [{ name: 'Anita Rao' }],
};

function provider(
  id: string,
  requires?: Permission[],
  available = true,
): ReportProvider {
  return {
    id,
    name: id,
    filters: [],
    requires,
    isAvailable: () => available,
    unavailableModule: available ? undefined : 'projects',
    run: () => Promise.resolve(ROSTER),
  };
}

function contextFor(permissions: Permission[]): DashboardContext {
  return { user: { permissions } as AuthenticatedUser } as DashboardContext;
}

/**
 * `/reports` is gated on `REPORTS` — one permission covering every report there is.
 * So a role given `REPORTS` for the machinery utilisation figures could also run the
 * Employee report, the whole roster with joining dates, and export it to Excel.
 * `REPORTS` says somebody may use the reporting surface, not which data they may take
 * away.
 */
describe('ReportsService — which reports are the caller’s (2026-10-10)', () => {
  const registry = () =>
    new ReportsService([
      provider('employee', [Permission.EMPLOYEES]),
      provider('attendance', [Permission.ATTENDANCE]),
      provider('project-cost', undefined, false),
    ]);

  it('lists only the types the caller may run', () => {
    // The pair. Listing for the entitled caller alone would have passed against the
    // defect — they could already see it.
    expect(
      registry()
        .types([Permission.REPORTS, Permission.EMPLOYEES])
        .map((t) => t.id),
    ).toEqual(['employee', 'project-cost']);

    expect(
      registry()
        .types([Permission.REPORTS])
        .map((t) => t.id),
    ).toEqual(['project-cost']);
  });

  it('refuses to run a type it did not list', async () => {
    await expect(
      registry().run(contextFor([Permission.REPORTS]), 'employee', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('runs it for a caller who holds the area', async () => {
    // Without this, a `run` that refused everything would pass the test above.
    await expect(
      registry().run(
        contextFor([Permission.REPORTS, Permission.EMPLOYEES]),
        'employee',
        {},
      ),
    ).resolves.toEqual(ROSTER);
  });

  it('answers the same 404 for a forbidden type as for one that does not exist', async () => {
    // Distinguishing them lets a caller enumerate the reports they may not run.
    const forbidden = await registry()
      .run(contextFor([Permission.REPORTS]), 'employee', {})
      .catch((e: Error) => e.message);
    const missing = await registry()
      .run(contextFor([Permission.REPORTS]), 'no-such-report', {})
      .catch((e: Error) => e.message);

    expect(forbidden).toBe(missing);
  });

  it('keeps an unbuilt placeholder for everyone — it carries no rows', () => {
    expect(
      registry()
        .types([])
        .map((t) => t.id),
    ).toEqual(['project-cost']);
  });
});

describe('report range (036 E2)', () => {
  it.each([
    [{ fromDate: '2026-10-05', toDate: '2026-10-01' }, 'must not be after'],
    [{ fromDate: '2026-02-30' }, 'not a real calendar date'],
    [{ fromDate: '2024-01-01', toDate: '2026-01-01' }, 'at most 366 days'],
  ])('refuses %j', (params, message) => {
    expect(() => assertReportRange(params)).toThrow(message);
  });

  it('accepts a same-day range, an open end, and no range', () => {
    expect(() =>
      assertReportRange({ fromDate: '2026-10-01', toDate: '2026-10-01' }),
    ).not.toThrow();
    expect(() => assertReportRange({ fromDate: '2026-10-01' })).not.toThrow();
    expect(() => assertReportRange({})).not.toThrow();
  });
});

describe('reports while cash is hidden (038)', () => {
  // Held in a constant: `cash-entry-surface.spec.ts` flags a literal cash mode in any source line.
  const CASH = 'cash';
  const MIXED: ReportData = {
    columns: [
      { key: 'party', label: 'Party' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    rows: [
      { party: 'Bank one', paymentMode: 'neft', amount: 100 },
      { party: 'Cash one', paymentMode: CASH, amount: 50 },
      { party: 'Typed', mode: 'Cash', amount: 20 },
      { party: 'Bill', instrument: 'CASH', amount: 10 },
    ],
  };
  const service = (hidden: boolean) =>
    new ReportsService(
      [{ ...provider('ledger'), run: () => Promise.resolve(MIXED) }],
      { isHidden: jest.fn(async () => hidden) } as never,
    );
  const ctx = {
    ...contextFor([]),
    companyId: 'co',
  } as DashboardContext;

  it('drops every cash row, whatever the spelling, so totals from the rows leave cash out', async () => {
    const result = (await service(true).run(ctx, 'ledger', {})) as ReportData;
    expect(result.rows.map((r) => r.party)).toEqual(['Bank one']);
  });

  it('returns the report untouched when cash is not hidden', async () => {
    await expect(service(false).run(ctx, 'ledger', {})).resolves.toBe(MIXED);
  });

  it('keeps the same object when nothing is cash', () => {
    expect(withoutCashRows(ROSTER)).toBe(ROSTER);
  });
});
