import { PnlDrillDownService } from './pnl-drill-down.service';

/**
 * Opening a figure on the project summary (018 FR-012, T031).
 *
 * The assertion that earns the task: **the records add up to the total they were opened from.** A
 * drill-down that nearly adds up tells the reader the number is wrong without telling them how, and
 * from then on they check everything by hand.
 */

const dec = (value: number) => ({
  toNumber: () => value,
  equals: (other: { toNumber: () => number }) => other.toNumber() === value,
});

function build(opts: {
  clientBills?: {
    id: string;
    billNumber: string;
    billingDate: string;
    grossAmount: number;
    status?: string;
    description?: string | null;
    certifiedAmount?: number | null;
  }[];
  raBills?: {
    id: string;
    billNumber: string;
    billingDate: string;
    grossAmount: number;
    amount?: number;
    status?: string;
  }[];
  /** Categories with a registered source, and the records each lists (absent = cannot itemise). */
  sources?: Record<
    string,
    | {
        id: string;
        reference: string;
        date: string;
        amount: number;
      }[]
    | 'total-only'
    | 'throws'
  >;
}) {
  const tx = {
    $executeRaw: async () => 0,
    clientBill: {
      findMany: async () =>
        (opts.clientBills ?? []).map((bill) => ({
          id: bill.id,
          billNumber: bill.billNumber,
          billingDate: new Date(bill.billingDate),
          grossAmount: dec(bill.grossAmount),
          status: bill.status ?? 'submitted',
          description: bill.description ?? null,
          certifiedAmount:
            bill.certifiedAmount === undefined || bill.certifiedAmount === null
              ? null
              : dec(bill.certifiedAmount),
        })),
    },
    rABill: {
      findMany: async () =>
        (opts.raBills ?? []).map((bill) => ({
          id: bill.id,
          billNumber: bill.billNumber,
          billingDate: new Date(bill.billingDate),
          grossAmount: dec(bill.grossAmount),
          amount: dec(bill.amount ?? bill.grossAmount),
          status: bill.status ?? 'approved',
          description: null,
        })),
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const registry = {
    costSource: (category: string) => {
      const configured = opts.sources?.[category];
      if (!configured) return null;
      if (configured === 'total-only') {
        return { category, costsByProject: async () => new Map() };
      }
      if (configured === 'throws') {
        return {
          category,
          costsByProject: async () => new Map(),
          recordsByProject: async () => {
            throw new Error('labour is down');
          },
        };
      }
      return {
        category,
        costsByProject: async () => new Map(),
        recordsByProject: async () =>
          configured.map((row) => ({
            ...row,
            status: 'approved',
            description: null,
          })),
      };
    },
  };

  return new PnlDrillDownService(prisma as never, registry as never);
}

const ctx = { isSuperAdmin: true } as never;
const open = (
  service: PnlDrillDownService,
  figure: string,
  scope?: 'month' | 'cumulative',
) => service.drillInto(ctx, 'co-1', 'p-1', '2026-09', figure, scope);

describe('revenue opens into the client bills behind it', () => {
  const service = () =>
    build({
      clientBills: [
        {
          id: 'cb-1',
          billNumber: 'RA/01',
          billingDate: '2026-09-04',
          grossAmount: 1200000.25,
        },
        {
          id: 'cb-2',
          billNumber: 'RA/02',
          billingDate: '2026-09-28',
          grossAmount: 49999.75,
        },
      ],
    });

  it('sums the records it returns, to the paisa', async () => {
    const view = await open(service(), 'revenue');

    expect(view.records?.map((row) => row.reference)).toEqual([
      'RA/01',
      'RA/02',
    ]);
    expect(view.total).toBe(1250000);
    expect(
      view.records?.reduce((total, row) => total + row.amount, 0),
    ).toBeCloseTo(view.total ?? 0, 2);
  });

  it('says where a bill was certified short, rather than leaving two screens to compare', async () => {
    const view = await open(
      build({
        clientBills: [
          {
            id: 'cb-1',
            billNumber: 'RA/01',
            billingDate: '2026-09-04',
            grossAmount: 100000,
            certifiedAmount: 92000,
          },
        ],
      }),
      'revenue',
    );

    expect(view.records?.[0].description).toContain(
      'Certified 92000.00 of 100000.00',
    );
  });

  it('leaves a bill certified in full unannotated', async () => {
    const view = await open(
      build({
        clientBills: [
          {
            id: 'cb-1',
            billNumber: 'RA/01',
            billingDate: '2026-09-04',
            grossAmount: 100000,
            certifiedAmount: 100000,
            description: 'September measurement',
          },
        ],
      }),
      'revenue',
    );

    expect(view.records?.[0].description).toBe('September measurement');
  });
});

describe('subcontractor cost opens into RA bills, at gross', () => {
  it('reads gross, and falls back to amount for a pre-018 bill', async () => {
    const view = await open(
      build({
        raBills: [
          {
            id: 'ra-1',
            billNumber: 'WO1/RA1',
            billingDate: '2026-09-10',
            grossAmount: 500000,
          },
          // Raised before 018: `grossAmount` defaulted to 0 and `amount` is the only figure it
          // ever had. Reading gross alone would drop it from a total meant to match the summary.
          {
            id: 'ra-2',
            billNumber: 'WO2/RA1',
            billingDate: '2026-09-20',
            grossAmount: 0,
            amount: 75000,
          },
        ],
      }),
      'subcontractors',
    );

    expect(view.total).toBe(575000);
    expect(view.records?.[1].amount).toBe(75000);
  });
});

describe('“cannot be itemised” is not an empty list (FR-010’s rule, one level down)', () => {
  it('names a category no module registered a source for', async () => {
    const view = await open(build({}), 'overheads');

    expect(view.records).toBeNull();
    expect(view.total).toBeNull();
    expect(view.unavailableReason).toContain('No module has registered');
  });

  it('distinguishes a module that reports a total but lists nothing', async () => {
    const view = await open(
      build({ sources: { machinery: 'total-only' } }),
      'machinery',
    );

    expect(view.records).toBeNull();
    expect(view.total).toBeNull();
    expect(view.unavailableReason).toContain('does not list the records');
    // The distinction that matters: the summary's figure is still real.
    expect(view.unavailableReason).toContain('measured figure');
  });

  it('reports a failed read as a failed read, not as nothing spent', async () => {
    const view = await open(build({ sources: { labour: 'throws' } }), 'labour');

    expect(view.records).toBeNull();
    expect(view.total).toBeNull();
    expect(view.unavailableReason).toContain('could not be read');
    expect(view.unavailableReason).toContain('figure on the summary stands');
  });

  it('never returns a zero total for a figure it could not list', async () => {
    for (const figure of ['overheads', 'machinery', 'labour']) {
      const view = await open(
        build({ sources: { machinery: 'total-only', labour: 'throws' } }),
        figure,
      );
      expect(view.total).not.toBe(0);
      expect(view.total).toBeNull();
    }
  });
});

describe('labour points at its own register rather than copying it', () => {
  it('lists the sheets and says where the per-worker view is', async () => {
    const view = await open(
      build({
        sources: {
          labour: [
            {
              id: 'sheet-1',
              reference: 'direct wages 2026-08-25 to 2026-09-07',
              date: '2026-09-07',
              amount: 3000,
            },
            {
              id: 'sheet-2',
              reference: 'direct wages 2026-09-08 to 2026-09-21',
              date: '2026-09-21',
              amount: 6400,
            },
          ],
        },
      }),
      'labour',
    );

    expect(view.total).toBe(9400);
    expect(view.itemisedFurtherAt).toEqual({
      endpoint: 'labour/reports/monthly-wage-rollup',
      query: { projectId: 'p-1', year: '2026', month: '9' },
    });
  });
});

describe('the figure and the period are validated before anything is read', () => {
  it('refuses a figure that is not on the summary', async () => {
    await expect(open(build({}), 'profit')).rejects.toThrow(
      /figure must be one of/,
    );
  });

  it('refuses a malformed period', async () => {
    await expect(
      build({}).drillInto(ctx, 'co-1', 'p-1', 'September', 'revenue'),
    ).rejects.toThrow(/period must be YYYY-MM/);
  });

  it('restates the scope it answered, so a month total is never read as cumulative', async () => {
    expect((await open(build({}), 'revenue', 'cumulative')).scope).toBe(
      'cumulative',
    );
    expect((await open(build({}), 'revenue')).scope).toBe('month');
  });
});
