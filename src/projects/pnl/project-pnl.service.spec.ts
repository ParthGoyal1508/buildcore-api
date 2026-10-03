import { ProjectPnlService, periodRange } from './project-pnl.service';

/**
 * The project P&L (018 US3, FR-010 to FR-013 — tasks T033, T048) — `bugs.md` item 11.
 *
 * **T033 is the assertion that matters most**: a missing module is *named*, never zeroed. It is the
 * distinction a director acts on, and getting it wrong makes a project look profitable because half its
 * costs are invisible.
 */

const dec = (value: number) => ({ toNumber: () => value });

function build(opts: {
  projects?: { id: string; name: string }[];
  clientBills?: {
    projectId: string;
    billingDate: string;
    grossAmount: number;
    overScope?: boolean;
    /** How much of `grossAmount` is variation work (FR-015a). The rest is original scope. */
    variationAmount?: number;
  }[];
  raBills?: {
    projectId: string;
    billingDate: string;
    grossAmount: number;
    amount?: number;
  }[];
  budgets?: { projectId: string; category: string; amount: number }[];
  /** Categories with a registered source, and what each reports. */
  costSources?: Record<string, Record<string, number>>;
}) {
  const projects = opts.projects ?? [{ id: 'p-1', name: 'Ring Road' }];

  const tx = {
    $executeRaw: async () => 0,
    project: { findMany: async () => projects },
    clientBill: {
      findMany: async () =>
        (opts.clientBills ?? []).map((bill) => ({
          projectId: bill.projectId,
          billingDate: new Date(bill.billingDate),
          grossAmount: dec(bill.grossAmount),
          // Mirrors the service's own `select`: a bill line carries its amount and whether the BOQ
          // line behind it is a variation (FR-015a). Two lines so a bill can be part original scope
          // and part variation, which is the case the split exists for.
          lines: [
            {
              exceedsScope: bill.overScope ?? false,
              amount: dec(bill.grossAmount - (bill.variationAmount ?? 0)),
              boqTaskItem: { isVariation: false },
            },
            {
              exceedsScope: false,
              amount: dec(bill.variationAmount ?? 0),
              boqTaskItem: { isVariation: true },
            },
          ],
        })),
    },
    rABill: {
      findMany: async () =>
        (opts.raBills ?? []).map((bill) => ({
          projectId: bill.projectId,
          billingDate: new Date(bill.billingDate),
          grossAmount: dec(bill.grossAmount),
          amount: dec(bill.amount ?? bill.grossAmount),
        })),
    },
    projectBudget: {
      findMany: async () =>
        (opts.budgets ?? []).map((row) => ({
          projectId: row.projectId,
          category: row.category,
          amount: dec(row.amount),
        })),
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const registry = {
    costSource: (category: string) => {
      const figures = opts.costSources?.[category];
      if (!figures) return null;
      return {
        category,
        costsByProject: async () => new Map(Object.entries(figures)),
      };
    },
  };

  return new ProjectPnlService(prisma as never, registry as never);
}

const ctx = { isSuperAdmin: true } as never;

describe('a missing module is named, never zeroed (FR-010, T033)', () => {
  it('lists a category with no registered source', async () => {
    const service = build({ costSources: { labour: { 'p-1': 50000 } } });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.unavailableCategories).toEqual([
      'materials',
      'machinery',
      'fuel',
      'overheads',
    ]);
  });

  it('excludes unavailable categories from the cost total', async () => {
    // **The line that matters.** Counting them as zero makes a project look profitable because half its
    // costs are invisible, and nothing on the screen says so.
    const service = build({ costSources: { labour: { 'p-1': 50000 } } });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    // Labour plus subcontractors (zero here) — not six categories of which five are fictional zeroes.
    expect(pnl.costCumulative).toBe(50000);
  });

  it('still renders a row for an unavailable category', async () => {
    // A missing row reads as a category this project has none of. The row is there, at zero, *and* the
    // category is named as unavailable — the two together are what let a reader tell the difference.
    const service = build({ costSources: { labour: { 'p-1': 50000 } } });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.categories.map((row) => row.category)).toEqual([
      'labour',
      'materials',
      'machinery',
      'fuel',
      'subcontractors',
      'overheads',
    ]);
  });

  it('reports nothing unavailable when every source is registered', async () => {
    const service = build({
      costSources: {
        labour: { 'p-1': 10 },
        materials: { 'p-1': 20 },
        machinery: { 'p-1': 30 },
        fuel: { 'p-1': 40 },
        overheads: { 'p-1': 50 },
      },
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.unavailableCategories).toEqual([]);
    expect(pnl.costCumulative).toBe(150);
  });
});

describe('revenue is billed gross on bills that have left draft', () => {
  it('sums submitted bills in the month and cumulatively', async () => {
    const service = build({
      clientBills: [
        { projectId: 'p-1', billingDate: '2026-07-15', grossAmount: 100000 },
        { projectId: 'p-1', billingDate: '2026-08-20', grossAmount: 250000 },
      ],
      costSources: {},
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.revenueMonthly).toBe(250000);
    expect(pnl.revenueCumulative).toBe(350000);
  });

  it('states what the figure counts, rather than leaving it to be discovered', async () => {
    // A reader comparing this to the bank will find a gap — retention plus whatever is uncertified. The
    // response says so, because a figure somebody cannot reconcile is a figure they stop trusting.
    const service = build({ costSources: {} });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.revenueNote).toMatch(/before retention/i);
  });

  it('carries the over-scope flag up to the summary', async () => {
    // A total over a bill containing an over-quantity line is arithmetically right and materially
    // misleading: it reports revenue against scope that was never awarded, and nothing else on this
    // screen would say so.
    const service = build({
      clientBills: [
        {
          projectId: 'p-1',
          billingDate: '2026-08-20',
          grossAmount: 250000,
          overScope: true,
        },
      ],
      costSources: {},
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(pnl.revenueIncludesOverScope).toBe(true);
  });
});

describe('subcontractor cost is gross, not net', () => {
  it('reads grossAmount', async () => {
    // Reading `netPayable` would understate every project by the retention held across it, and the
    // understatement grows with the project.
    const service = build({
      raBills: [
        { projectId: 'p-1', billingDate: '2026-08-10', grossAmount: 180000 },
      ],
      costSources: {},
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    const subcontract = pnl.categories.find(
      (row) => row.category === 'subcontractors',
    );
    expect(subcontract?.cumulative).toBe(180000);
  });

  it('falls back to the pre-018 `amount` for a historical bill', async () => {
    // A bill raised before this feature has gross 0 and an `amount` that is the only figure it ever had.
    // Reading gross alone would silently drop every historical subcontractor cost from the P&L.
    const service = build({
      raBills: [
        {
          projectId: 'p-1',
          billingDate: '2026-08-10',
          grossAmount: 0,
          amount: 95000,
        },
      ],
      costSources: {},
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    expect(
      pnl.categories.find((row) => row.category === 'subcontractors')
        ?.cumulative,
    ).toBe(95000);
  });
});

describe('budgets and variance', () => {
  it('reports no budget as null, not zero', async () => {
    // "Nobody set a budget" and "the budget is nil" lead to different conversations, and a zero budget
    // makes every rupee spent read as an overrun.
    const service = build({ costSources: { labour: { 'p-1': 1000 } } });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    const labour = pnl.categories.find((row) => row.category === 'labour');
    expect(labour?.budget).toBeNull();
    expect(labour?.variance).toBeNull();
  });

  it('computes variance as budget less cumulative', async () => {
    const service = build({
      costSources: { labour: { 'p-1': 120000 } },
      budgets: [{ projectId: 'p-1', category: 'labour', amount: 100000 }],
    });

    const pnl = await service.summaryFor(ctx, 'co-1', 'p-1', '2026-08');

    const labour = pnl.categories.find((row) => row.category === 'labour');
    // Negative: over budget. Reported as a signed number rather than an absolute with a flag, because
    // "20,000 over" and "20,000 under" are the same magnitude and opposite news.
    expect(labour?.variance).toBe(-20000);
  });
});

describe('the group view sums the rows it shows (T046, T048)', () => {
  it('returns one row per project and a total equal to their sum', async () => {
    const service = build({
      projects: [
        { id: 'p-1', name: 'Ring Road' },
        { id: 'p-2', name: 'Police Station' },
      ],
      clientBills: [
        { projectId: 'p-1', billingDate: '2026-08-10', grossAmount: 100000 },
        { projectId: 'p-2', billingDate: '2026-08-11', grossAmount: 60000 },
      ],
      costSources: { labour: { 'p-1': 40000, 'p-2': 25000 } },
    });

    const rows = await service.summariesFor(
      ctx,
      'co-1',
      ['p-1', 'p-2'],
      '2026-08',
    );

    expect(rows.size).toBe(2);
    const total = [...rows.values()].reduce(
      (sum, row) => sum + row.revenueCumulative,
      0,
    );
    // The group total **is** the sum of the rows, by construction rather than by a second aggregate
    // query — which is what makes it impossible for the two to disagree (research §7).
    expect(total).toBe(160000);
  });

  it('asks each cost source once for every project, not once per project', async () => {
    // A per-project signature makes the group view an N+1 no registrant can fix from their side.
    let calls = 0;
    const service = new ProjectPnlService(
      {
        $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
          fn({
            $executeRaw: async () => 0,
            project: {
              findMany: async () => [
                { id: 'p-1', name: 'A' },
                { id: 'p-2', name: 'B' },
                { id: 'p-3', name: 'C' },
              ],
            },
            clientBill: { findMany: async () => [] },
            rABill: { findMany: async () => [] },
            projectBudget: { findMany: async () => [] },
          }),
      } as never,
      {
        costSource: () => ({
          category: 'labour',
          costsByProject: async () => {
            calls += 1;
            return new Map();
          },
        }),
      } as never,
    );

    await service.summariesFor(ctx, 'co-1', ['p-1', 'p-2', 'p-3'], '2026-08');

    // Five registry categories × two ranges (monthly and cumulative) = ten. **Not** thirty, which is
    // what a per-project loop over three projects would produce.
    expect(calls).toBe(10);
  });

  it('returns nothing for projects that do not exist', async () => {
    const service = build({ projects: [] });

    const rows = await service.summariesFor(ctx, 'co-1', ['nope'], '2026-08');

    expect(rows.size).toBe(0);
  });
});

describe('periodRange', () => {
  it('bounds the month inclusively at both ends', () => {
    const { monthStart, monthEnd } = periodRange('2026-02');
    expect(monthStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    // The 28th, and the last millisecond of it: a bill dated the last day of the month is inside it.
    expect(monthEnd.toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('handles a 31-day month', () => {
    expect(periodRange('2026-08').monthEnd.toISOString()).toBe(
      '2026-08-31T23:59:59.999Z',
    );
  });

  it('handles a leap February', () => {
    expect(periodRange('2028-02').monthEnd.toISOString()).toBe(
      '2028-02-29T23:59:59.999Z',
    );
  });

  it('refuses a malformed period', () => {
    expect(() => periodRange('2026-13')).toThrow();
    expect(() => periodRange('nonsense')).toThrow();
  });
});
