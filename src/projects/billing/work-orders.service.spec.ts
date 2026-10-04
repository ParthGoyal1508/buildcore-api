import { WorkOrdersService } from './work-orders.service';

/**
 * Work orders in the minimal form 018 needs (018 US2).
 *
 * The assertion that matters: **the retention basis locks once a bill has been raised.** The
 * retention on an issued RA bill is already withheld at the old rate, so moving the basis afterwards
 * makes the subcontractor's copy disagree with ours about money already held — and nothing on either
 * screen would say which was right.
 */

const dec = (value: number) => ({ toNumber: () => value });

function build(opts: {
  retentionPercent?: number;
  billCount?: number;
  awardLineCount?: number;
  missing?: boolean;
}) {
  const updates: Record<string, unknown>[] = [];
  const row = {
    id: 'wo-1',
    projectId: 'p-1',
    partnerId: 'v-1',
    workDetail: 'RCC works — blocks A to C',
    terms: null,
    requirements: null,
    hireContract: null,
    labourAmount: dec(500000),
    materialAmount: dec(0),
    retentionPercent: dec(opts.retentionPercent ?? 0.05),
    status: 'active' as const,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    _count: {
      awardLines: opts.awardLineCount ?? 3,
      raBills: opts.billCount ?? 0,
    },
  };

  const tx = {
    $executeRaw: async () => 0,
    project: { findFirst: async () => ({ id: 'p-1' }) },
    workOrder: {
      findMany: async () => [row],
      findFirst: async () => (opts.missing ? null : row),
      create: async () => ({ id: 'wo-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return row;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { service: new WorkOrdersService(prisma as never), updates };
}

const ctx = { isSuperAdmin: true } as never;

describe('reading a work order', () => {
  it('says how many award lines and bills it has', async () => {
    const { service } = build({ awardLineCount: 0, billCount: 0 });

    const view = await service.view(ctx, 'wo-1');

    // 0 award lines means nothing can be measured against it, which is what lets the RA bill sheet
    // say so rather than presenting an empty grid.
    expect(view.awardLineCount).toBe(0);
    expect(view.billCount).toBe(0);
    expect(view.retentionPercent).toBe(0.05);
  });

  it('reports a missing one as not found', async () => {
    const { service } = build({ missing: true });

    await expect(service.view(ctx, 'wo-404')).rejects.toThrow(
      'Work order not found',
    );
  });
});

describe('the retention basis locks once a bill exists', () => {
  it('refuses a change naming why', async () => {
    const { service, updates } = build({
      retentionPercent: 0.05,
      billCount: 2,
    });

    await expect(
      service.update(ctx, 'wo-1', { retentionPercent: 0.1 }),
    ).rejects.toThrow(/money already held/);
    expect(updates).toEqual([]);
  });

  it('allows the same value through, so an unrelated edit is not blocked', async () => {
    // A screen that sends the whole form back must not be refused for re-sending the figure it
    // was shown.
    const { service, updates } = build({
      retentionPercent: 0.05,
      billCount: 2,
    });

    await service.update(ctx, 'wo-1', {
      retentionPercent: 0.05,
      workDetail: 'RCC works — blocks A to D',
    });

    expect(updates[0]).toEqual(
      expect.objectContaining({ workDetail: 'RCC works — blocks A to D' }),
    );
  });

  it('allows a change while no bill has been raised', async () => {
    const { service, updates } = build({ retentionPercent: 0, billCount: 0 });

    await service.update(ctx, 'wo-1', { retentionPercent: 0.075 });

    expect(updates[0]).toEqual(
      expect.objectContaining({ retentionPercent: 0.075 }),
    );
  });
});
