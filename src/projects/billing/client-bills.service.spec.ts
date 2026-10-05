import { ClientBillsService } from './client-bills.service';

/**
 * Client bills measured against the BOQ (018 US1, FR-002 to FR-005 — tasks T011, T012) —
 * `bugs.md` item 11.
 *
 * **T011 is the assertion the feature turns on**: revise the BOQ rate and a submitted bill does not
 * move. Everything else here protects the arithmetic around it.
 */

const dec = (value: number) => ({ toNumber: () => value });

interface ItemFixture {
  id: string;
  boqNo: string;
  taskName: string;
  unit: string;
  scopeQty: number;
  rate: number;
  isVariation?: boolean;
}

function item(over: Partial<ItemFixture> = {}): ItemFixture {
  return {
    id: 'boq-1',
    boqNo: '1.0',
    taskName: 'Earth work in excavation',
    unit: 'Cum',
    scopeQty: 1000,
    rate: 251,
    ...over,
  };
}

function build(opts: {
  items?: ItemFixture[];
  quotedPercentage?: number;
  /** Quantity already billed per BOQ line on non-draft bills. */
  previouslyBilled?: Record<string, number>;
  bill?: Record<string, unknown> | null;
  duplicateNumber?: boolean;
}) {
  const items = opts.items ?? [item()];
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> | null = opts.bill ?? null;

  // `group` is selected by `view()` so a bill can print the heading its lines sit under — a BOQ
  // line's own text is only the qualifier ("suspended floors …"), and the work is in the heading.
  const hydrate = (i: ItemFixture) => ({
    ...i,
    scopeQty: dec(i.scopeQty),
    rate: dec(i.rate),
    isVariation: i.isVariation ?? false,
    variationRef: null,
    group: { id: 'grp-1', name: 'Earthwork' },
  });

  const tx = {
    $executeRaw: async () => 0,
    project: {
      findFirst: async () => ({
        id: 'p-1',
        quotedPercentage: dec(opts.quotedPercentage ?? 0),
      }),
    },
    bOQTaskItem: { findMany: async () => items.map(hydrate) },
    clientBillLine: {
      groupBy: async () =>
        Object.entries(opts.previouslyBilled ?? {}).map(([id, qty]) => ({
          boqTaskItemId: id,
          _sum: { quantity: dec(qty) },
        })),
    },
    clientBill: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (opts.duplicateNumber) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        created.push(args.data);
        const lines =
          (args.data.lines as { create: Record<string, unknown>[] }).create ??
          [];
        stored = {
          id: 'bill-1',
          projectId: 'p-1',
          billNumber: args.data.billNumber,
          description: args.data.description ?? null,
          billingDate: args.data.billingDate,
          status: 'draft',
          quotedPercentage: dec(args.data.quotedPercentage as number),
          grossAmount: dec(args.data.grossAmount as number),
          retentionAmount: dec(args.data.retentionAmount as number),
          netAmount: dec(args.data.netAmount as number),
          certifiedAmount: null,
          certifiedAt: null,
          submittedAt: null,
          lines: lines.map((line, index) => ({
            id: `line-${index}`,
            boqTaskItemId: line.boqTaskItemId,
            quantity: dec(line.quantity as number),
            rate: dec((line.rate as { toNumber(): number }).toNumber()),
            amount: dec(line.amount as number),
            exceedsScope: line.exceedsScope,
            overScopeReason: line.overScopeReason,
            boqTaskItem: hydrate(
              items.find((i) => i.id === line.boqTaskItemId) as ItemFixture,
            ),
          })),
        };
        return stored;
      },
      findFirst: async () => stored,
      update: async (args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        stored = { ...(stored as Record<string, unknown>), ...args.data };
        if (args.data.certifiedAmount !== undefined) {
          (stored as Record<string, unknown>).certifiedAmount = dec(
            args.data.certifiedAmount as number,
          );
        }
        return stored;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return {
    service: new ClientBillsService(prisma as never),
    created,
    updated,
    setStored: (value: Record<string, unknown> | null) => {
      stored = value;
    },
  };
}

const ctx = { isSuperAdmin: true } as never;

const compose = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p-1',
  billNumber: 'RA-01',
  billingDate: '2026-08-21',
  lines: [{ boqTaskItemId: 'boq-1', quantity: 100 }],
  ...overrides,
});

describe('composing a client bill', () => {
  it('prices from the BOQ rate and freezes it onto the line (T011)', async () => {
    const { service, created } = build({});

    await service.compose(ctx, 'co-1', compose());

    const lines = (
      created[0].lines as { create: { rate: { toNumber(): number } }[] }
    ).create;
    // Written to the line, not referenced. Revise the BOQ afterwards and this does not move — a bill
    // is a document that was sent, and rendering it from a live rate table makes every historical bill
    // a lie that changes shape.
    expect(lines[0].rate.toNumber()).toBe(251);
    expect(created[0].grossAmount).toBe(25100);
  });

  it('applies the project’s quoted percentage', async () => {
    // `docs/BOQ_794578.xls` is a percentage BoQ: the bidder quotes one percentage against the
    // schedule. Pricing from line rates alone is short by it on every line.
    const { service, created } = build({ quotedPercentage: 0.0246 });

    await service.compose(ctx, 'co-1', compose());

    expect(created[0].grossAmount).toBe(25717.46);
    // Frozen too, so correcting the project's percentage later does not move a bill already raised.
    expect(created[0].quotedPercentage).toBe(0.0246);
  });

  it('refuses a BOQ line with no rate rather than billing it at zero', async () => {
    // The column defaults to 0 because the table was already populated, so 0 means "nobody priced
    // this" far more often than "free" — and a bill carrying a zero line is quietly short while
    // looking finished.
    const { service } = build({ items: [item({ rate: 0 })] });

    await expect(service.compose(ctx, 'co-1', compose())).rejects.toThrow(
      /no rate/,
    );
  });

  it('names the unpriced lines', async () => {
    const { service } = build({
      items: [item({ id: 'boq-1', boqNo: '7.0', rate: 0 })],
    });

    await expect(service.compose(ctx, 'co-1', compose())).rejects.toThrow(
      /7\.0/,
    );
  });

  it('refuses a project with no BOQ, with its own code', async () => {
    // Distinct from "this line is not on the BOQ": the remedy is to enter a BOQ, not to fix a line.
    const { service } = build({ items: [] });

    await expect(service.compose(ctx, 'co-1', compose())).rejects.toThrow(
      /no BOQ lines/,
    );
  });

  it('refuses a bill with no lines', async () => {
    const { service } = build({});

    await expect(
      service.compose(ctx, 'co-1', compose({ lines: [] })),
    ).rejects.toThrow(/at least one/);
  });

  it('refuses a duplicate bill number on the same project', async () => {
    const { service } = build({ duplicateNumber: true });

    await expect(service.compose(ctx, 'co-1', compose())).rejects.toThrow(
      /already has a bill numbered/,
    );
  });

  it('withholds retention on gross, and keeps it visible', async () => {
    // Retention is the client's money held back. Not a cost, not revenue — a timing difference.
    const { service, created } = build({});

    await service.compose(ctx, 'co-1', compose({ retentionPercent: 0.05 }));

    expect(created[0].grossAmount).toBe(25100);
    expect(created[0].retentionAmount).toBe(1255);
    expect(created[0].netAmount).toBe(23845);
  });
});

describe('cumulative quantity and over-scope (FR-003, T012)', () => {
  it('counts earlier bills toward the cumulative figure', async () => {
    const { service, created } = build({
      previouslyBilled: { 'boq-1': 400 },
    });

    await service.compose(ctx, 'co-1', compose());

    const lines = (created[0].lines as { create: { exceedsScope: boolean }[] })
      .create;
    // 400 + 100 against a scope of 1000 — well within.
    expect(lines[0].exceedsScope).toBe(false);
  });

  it('flags a line that takes cumulative past scope, and still composes', async () => {
    // A flag, not a refusal. Over-measurement happens on real sites and is often correct; refusing it
    // at entry means the measurement goes in a notebook instead.
    const { service, created } = build({
      previouslyBilled: { 'boq-1': 950 },
    });

    await service.compose(ctx, 'co-1', compose());

    const lines = (created[0].lines as { create: { exceedsScope: boolean }[] })
      .create;
    expect(lines[0].exceedsScope).toBe(true);
    expect(created[0].grossAmount).toBe(25100);
  });
});

describe('submitting', () => {
  const draftWithFlaggedLine = (reason: string | null) => ({
    id: 'bill-1',
    projectId: 'p-1',
    billNumber: 'RA-01',
    description: null,
    billingDate: new Date('2026-08-21'),
    status: 'draft',
    quotedPercentage: dec(0),
    grossAmount: dec(25100),
    retentionAmount: dec(0),
    netAmount: dec(25100),
    certifiedAmount: null,
    certifiedAt: null,
    submittedAt: null,
    lines: [
      {
        id: 'line-0',
        boqTaskItemId: 'boq-1',
        quantity: dec(100),
        rate: dec(251),
        amount: dec(25100),
        exceedsScope: true,
        overScopeReason: reason,
        boqTaskItem: {
          ...item(),
          scopeQty: dec(1000),
          rate: dec(251),
          isVariation: false,
          variationRef: null,
          group: { id: 'grp-1', name: 'Earthwork' },
        },
      },
    ],
  });

  it('refuses an over-scope line with no reason, naming it', async () => {
    // "Some lines exceed scope" sends somebody scanning three hundred rows for the ones that do.
    const { service } = build({ bill: draftWithFlaggedLine(null) });

    await expect(service.submit(ctx, 'bill-1')).rejects.toThrow(/1\.0/);
  });

  it('submits an over-scope line that carries a reason', async () => {
    const { service, updated } = build({
      bill: draftWithFlaggedLine(
        'Rock encountered; extra excavation instructed on site',
      ),
    });

    await service.submit(ctx, 'bill-1');

    expect(updated[0]).toMatchObject({ status: 'submitted' });
  });

  it('refuses to submit a bill that has already left draft', async () => {
    const { service } = build({
      bill: { ...draftWithFlaggedLine('reason'), status: 'submitted' },
    });

    await expect(service.submit(ctx, 'bill-1')).rejects.toThrow(/submitted/);
  });
});

describe('certification keeps both figures (FR-005)', () => {
  const submitted = {
    id: 'bill-1',
    projectId: 'p-1',
    billNumber: 'RA-01',
    description: null,
    billingDate: new Date('2026-08-21'),
    status: 'submitted',
    quotedPercentage: dec(0),
    grossAmount: dec(25100),
    retentionAmount: dec(0),
    netAmount: dec(25100),
    certifiedAmount: null,
    certifiedAt: null,
    submittedAt: new Date('2026-08-21'),
    lines: [
      {
        id: 'line-0',
        boqTaskItemId: 'boq-1',
        quantity: dec(100),
        rate: dec(251),
        amount: dec(25100),
        exceedsScope: false,
        overScopeReason: null,
        boqTaskItem: {
          ...item(),
          scopeQty: dec(1000),
          rate: dec(251),
          isVariation: false,
          variationRef: null,
          group: { id: 'grp-1', name: 'Earthwork' },
        },
      },
    ],
  };

  it('does not overwrite the billed amount', async () => {
    // A shortfall is a dispute to pursue, not a correction to absorb. Overwriting billed with certified
    // would erase the only record that there was one.
    const { service, updated } = build({ bill: { ...submitted } });

    const view = await service.certify(ctx, 'bill-1', 22000);

    expect(updated[0]).toMatchObject({ certifiedAmount: 22000 });
    expect(view.grossAmount).toBe(25100);
    expect(view.certifiedAmount).toBe(22000);
  });

  it('reports the variance rather than making a reader subtract two columns', async () => {
    const { service } = build({ bill: { ...submitted } });

    const view = await service.certify(ctx, 'bill-1', 22000);

    expect(view.certificationVariance).toBe(3100);
  });

  it('leaves cumulative billed quantity untouched', async () => {
    // The spec's edge case: a shortfall must not silently vanish from what has been measured, or the
    // next bill would re-bill the same work as though it had never been claimed.
    const { service } = build({ bill: { ...submitted } });

    const view = await service.certify(ctx, 'bill-1', 22000);

    expect(view.lines[0].quantity).toBe(100);
  });

  it('refuses certifying more than was billed', async () => {
    // A client cannot certify work nobody claimed. More likely a typo than a windfall, and the typo is
    // the one worth catching.
    const { service } = build({ bill: { ...submitted } });

    await expect(service.certify(ctx, 'bill-1', 30000)).rejects.toThrow(
      /more than billed/,
    );
  });

  it('refuses certifying a draft', async () => {
    const { service } = build({ bill: { ...submitted, status: 'draft' } });

    await expect(service.certify(ctx, 'bill-1', 1000)).rejects.toThrow(
      /not been submitted/,
    );
  });

  it('reports no variance before certification', async () => {
    const { service } = build({ bill: { ...submitted } });

    const view = await service.view(ctx, 'bill-1');

    expect(view.certifiedAmount).toBeNull();
    expect(view.certificationVariance).toBeNull();
  });
});

describe('the BOQ as the billing sheet needs it (FR-001, web T056-T058)', () => {
  const boqFixture = {
    quotedPercentage: 0.0246,
    groups: [
      {
        id: 'g-12',
        boqNo: '12',
        name: 'Earthwork',
        items: [
          {
            id: 'i-1',
            boqNo: '12.01',
            taskName: 'Excavation in ordinary soil',
            unit: 'Cum',
            scopeQty: 1000,
            rate: 180.5,
          },
          {
            id: 'i-2',
            boqNo: '12.02',
            taskName: 'Refilling',
            unit: 'Cum',
            // Unpriced: the column defaults to 0 because the table was already populated.
            scopeQty: 400,
            rate: 0,
          },
        ],
      },
    ],
    billed: { 'i-1': 250 },
  };

  it('keeps the heading and its lines as two levels', async () => {
    const { service } = buildBoq(boqFixture);

    const boq = await service.billableBoq(ctx, 'p-1');

    expect(boq.groups).toHaveLength(1);
    expect(boq.groups[0]).toEqual(
      expect.objectContaining({ boqNo: '12', name: 'Earthwork' }),
    );
    // A heading carries no quantity and no rate of its own, so a sheet cannot render it as a
    // measured line of zero.
    expect(boq.groups[0]).not.toHaveProperty('rate');
    expect(boq.groups[0].items.map((item) => item.boqNo)).toEqual([
      '12.01',
      '12.02',
    ]);
  });

  it('applies the quoted percentage once, to the total', async () => {
    const { service } = buildBoq(boqFixture);

    const boq = await service.billableBoq(ctx, 'p-1');

    // 1000 × 180.50 = 180500; 400 × 0 = 0.
    expect(boq.estimatedTotal).toBe(180500);
    // × 1.0246. Applied per line and summed, this rounds differently and the grand total stops
    // matching the tender document it came from.
    expect(boq.quotedTotal).toBe(184940.3);
    expect(boq.quotedPercentage).toBe(0.0246);
  });

  it('marks an unpriced line before anybody measures it', async () => {
    const { service } = buildBoq(boqFixture);

    const boq = await service.billableBoq(ctx, 'p-1');

    expect(boq.groups[0].items[0].unpriced).toBe(false);
    expect(boq.groups[0].items[1].unpriced).toBe(true);
    expect(boq.unpricedCount).toBe(1);
  });

  it('carries what is already billed and what is left', async () => {
    const { service } = buildBoq(boqFixture);

    const boq = await service.billableBoq(ctx, 'p-1');

    expect(boq.groups[0].items[0].previouslyBilledQty).toBe(250);
    expect(boq.groups[0].items[0].remainingQty).toBe(750);
  });

  it('reports an over-measured line as negative rather than clamping it', async () => {
    const { service } = buildBoq({
      ...boqFixture,
      billed: { 'i-1': 1100 },
    });

    const boq = await service.billableBoq(ctx, 'p-1');

    expect(boq.groups[0].items[0].remainingQty).toBe(-100);
  });
});

function buildBoq(opts: {
  quotedPercentage: number;
  groups: {
    id: string;
    boqNo: string;
    name: string;
    items: {
      id: string;
      boqNo: string;
      taskName: string;
      unit: string;
      scopeQty: number;
      rate: number;
    }[];
  }[];
  billed?: Record<string, number>;
}) {
  const d = (value: number) => ({ toNumber: () => value });
  const tx = {
    $executeRaw: async () => 0,
    project: {
      findFirst: async () => ({
        id: 'p-1',
        quotedPercentage: d(opts.quotedPercentage),
      }),
    },
    bOQTaskGroup: {
      findMany: async () =>
        opts.groups.map((group) => ({
          id: group.id,
          boqNo: group.boqNo,
          name: group.name,
          items: group.items.map((item) => ({
            ...item,
            scopeQty: d(item.scopeQty),
            rate: d(item.rate),
            isVariation: false,
            variationRef: null,
          })),
        })),
    },
    clientBillLine: {
      groupBy: async () =>
        Object.entries(opts.billed ?? {}).map(([id, qty]) => ({
          boqTaskItemId: id,
          _sum: { quantity: d(qty) },
        })),
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { service: new ClientBillsService(prisma as never) };
}
