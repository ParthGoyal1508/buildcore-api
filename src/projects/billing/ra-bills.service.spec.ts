import { RaBillsService } from './ra-bills.service';

/**
 * Subcontractor bills measured against the award (018 US2, FR-006 to FR-008 — tasks T019, T020) —
 * `bugs.md` item 12.
 *
 * Two properties carry the phase: **each deduction visible in its own right**, and **the P&L figure is
 * gross rather than net**. The second is the one that would silently understate every project.
 */

const dec = (value: number) => ({ toNumber: () => value });

interface AwardFixture {
  id: string;
  description: string;
  unit: string;
  awardedQty: number;
  rate: number;
}

function award(over: Partial<AwardFixture> = {}): AwardFixture {
  return {
    id: 'aw-1',
    description: 'RCC M25 in foundations',
    unit: 'Cum',
    awardedQty: 100,
    rate: 4500,
    ...over,
  };
}

function build(opts: {
  awardLines?: AwardFixture[];
  retentionPercent?: number;
  measuredToDate?: Record<string, number>;
  billedAlready?: number;
}) {
  const lines = opts.awardLines ?? [award()];
  const created: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> | null = null;

  const hydrate = (a: AwardFixture) => ({
    ...a,
    awardedQty: dec(a.awardedQty),
    rate: dec(a.rate),
  });

  const tx = {
    $executeRaw: async () => 0,
    workOrder: {
      findFirst: async () => ({
        id: 'wo-1',
        retentionPercent: dec(opts.retentionPercent ?? 0),
      }),
    },
    workOrderBOQItem: {
      findMany: async () => lines.map(hydrate),
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: lines.length }),
    },
    rABillLine: {
      count: async () => opts.billedAlready ?? 0,
      groupBy: async () =>
        Object.entries(opts.measuredToDate ?? {}).map(([id, qty]) => ({
          workOrderBoqItemId: id,
          _sum: { quantity: dec(qty) },
        })),
    },
    rABill: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        const billLines =
          (args.data.lines as { create: Record<string, unknown>[] }).create ??
          [];
        stored = {
          id: 'ra-1',
          projectId: 'p-1',
          workOrderId: 'wo-1',
          billNumber: args.data.billNumber,
          description: null,
          billingDate: args.data.billingDate,
          status: 'draft',
          grossAmount: dec(args.data.grossAmount as number),
          retentionAmount: dec(args.data.retentionAmount as number),
          advanceRecovery: dec(args.data.advanceRecovery as number),
          otherDeductions: dec(args.data.otherDeductions as number),
          netPayable: dec(args.data.netPayable as number),
          lines: billLines.map((line, index) => ({
            id: `rl-${index}`,
            workOrderBoqItemId: line.workOrderBoqItemId,
            quantity: dec(line.quantity as number),
            rate: dec((line.rate as { toNumber(): number }).toNumber()),
            amount: dec(line.amount as number),
            workOrderBoqItem: hydrate(
              lines.find(
                (a) => a.id === line.workOrderBoqItemId,
              ) as AwardFixture,
            ),
          })),
        };
        return stored;
      },
      findFirst: async () => stored,
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return { service: new RaBillsService(prisma as never), created };
}

const ctx = { isSuperAdmin: true } as never;

const measure = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p-1',
  workOrderId: 'wo-1',
  billNumber: 'SC-01',
  billingDate: '2026-08-21',
  lines: [{ workOrderBoqItemId: 'aw-1', quantity: 40 }],
  ...overrides,
});

describe('the award is the subcontractor’s own rates', () => {
  it('captures award lines on the work order', async () => {
    const { service } = build({});

    const stored = await service.setAward(ctx, 'co-1', 'wo-1', [
      {
        description: 'RCC M25 in foundations',
        unit: 'Cum',
        awardedQty: 100,
        rate: 4500,
      },
    ]);

    // The subcontractor's rate, kept separately from the client's BOQ rate — the margin between the two
    // is what the P&L exists to show, and one column called "the rate" makes it unrepresentable.
    expect(stored[0]).toMatchObject({ awardedQty: 100, rate: 4500 });
  });

  it('refuses to replace an award that has been measured against', async () => {
    // Changing it would move the remaining quantity on bills already issued, and the subcontractor's
    // copy would then disagree with ours.
    const { service } = build({ billedAlready: 2 });

    await expect(
      service.setAward(ctx, 'co-1', 'wo-1', [
        { description: 'x', unit: 'Cum', awardedQty: 1, rate: 1 },
      ]),
    ).rejects.toThrow(/measured against/);
  });
});

describe('measuring against the award (FR-007)', () => {
  it('prices at the awarded rate', async () => {
    const { service, created } = build({});

    await service.compose(ctx, 'co-1', measure());

    expect(created[0].grossAmount).toBe(180000);
  });

  it('reports this-period, to-date and remaining', async () => {
    const { service } = build({ measuredToDate: { 'aw-1': 30 } });

    const view = await service.compose(ctx, 'co-1', measure());

    expect(view.lines[0]).toMatchObject({
      awardedQty: 100,
      thisPeriodQty: 40,
      toDateQty: 30,
      remainingQty: 70,
    });
  });

  it('refuses measuring more than the award, naming the line', async () => {
    // **The asymmetry with a client BOQ is deliberate.** Over-measuring a client BOQ is a claim the
    // client can reject; over-measuring an award is the company agreeing to pay for work it never
    // ordered, and there is nobody downstream to catch it.
    const { service } = build({ measuredToDate: { 'aw-1': 90 } });

    await expect(
      service.compose(
        ctx,
        'co-1',
        measure({ lines: [{ workOrderBoqItemId: 'aw-1', quantity: 20 }] }),
      ),
    ).rejects.toThrow(/RCC M25 in foundations/);
  });

  it('names the route out of the refusal', async () => {
    const { service } = build({ measuredToDate: { 'aw-1': 90 } });

    await expect(
      service.compose(
        ctx,
        'co-1',
        measure({ lines: [{ workOrderBoqItemId: 'aw-1', quantity: 20 }] }),
      ),
    ).rejects.toThrow(/variation/);
  });

  it('refuses a line that is not on this work order’s award', async () => {
    const { service } = build({ awardLines: [] });

    await expect(service.compose(ctx, 'co-1', measure())).rejects.toThrow(
      /not on this work order/,
    );
  });

  it('refuses a bill with no lines', async () => {
    const { service } = build({});

    await expect(
      service.compose(ctx, 'co-1', measure({ lines: [] })),
    ).rejects.toThrow(/at least one/);
  });
});

describe('gross, the three deductions, and net (FR-008, T019)', () => {
  it('shows each deduction in its own right', async () => {
    // Not one net figure. A subcontractor disputing a payment asks *which* deduction accounts for the
    // difference, and a single `netPayable` cannot answer.
    const { service } = build({ retentionPercent: 0.05 });

    const view = await service.compose(
      ctx,
      'co-1',
      measure({ advanceRecovery: 10000, otherDeductions: 2000 }),
    );

    expect(view).toMatchObject({
      grossAmount: 180000,
      retentionAmount: 9000,
      advanceRecovery: 10000,
      otherDeductions: 2000,
      deductionTotal: 21000,
      netPayable: 159000,
    });
  });

  it('computes retention on gross, not on net', async () => {
    // The deduction most likely to be taken on the wrong base. Taking it on net would make retention
    // depend on the advance recovery, which has nothing to do with it.
    const { service } = build({ retentionPercent: 0.1 });

    const view = await service.compose(
      ctx,
      'co-1',
      measure({ advanceRecovery: 50000 }),
    );

    expect(view.retentionAmount).toBe(18000);
  });

  it('reports the P&L amount as gross, never net', async () => {
    // **The one that would silently understate every project.** Retention is money withheld and an
    // advance recovery is money already paid; neither is spend. Exposed on the view rather than left
    // for a consumer to work out, because the consumer that gets it wrong is the P&L — and it gets it
    // wrong by reading the field that looks most like "the amount".
    const { service } = build({ retentionPercent: 0.05 });

    const view = await service.compose(
      ctx,
      'co-1',
      measure({ advanceRecovery: 10000 }),
    );

    expect(view.pnlAmount).toBe(180000);
    expect(view.pnlAmount).not.toBe(view.netPayable);
  });

  it('sets the legacy `amount` column to gross, matching the migration’s backfill', async () => {
    // So a screen still reading `amount` sees the work rather than the net, and bills raised either side
    // of this change cannot disagree about what `amount` meant.
    const { service, created } = build({ retentionPercent: 0.05 });

    await service.compose(ctx, 'co-1', measure());

    expect(created[0].amount).toBe(created[0].grossAmount);
  });
});
