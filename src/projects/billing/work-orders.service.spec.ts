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
  // The code allocator, stubbed: `create` asks it for the work order's number inside the same
  // transaction, and these tests are about what the service stores rather than how a series is
  // advanced — `code-series.service.spec.ts` owns that.
  const codeSeries = { next: async () => 'PRPL-WO-0001' };
  return {
    // The approval spine, stubbed: 028 FR-009 sends an award for approval, and these tests are
    // about what the service stores. `submitForApproval` has its own coverage in the e2e suite,
    // where a refusal before approval and an acceptance after it can both be observed.
    service: new WorkOrdersService(
      prisma as never,
      codeSeries as never,
      { submit: async () => undefined } as never,
    ),
    updates,
  };
}

const ctx = { isSuperAdmin: true } as never;

describe('raising a work order', () => {
  it('allocates it a number from the company series', async () => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: async () => 0,
      project: { findFirst: async () => ({ id: 'p-1' }) },
      workOrder: {
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: 'wo-1' };
        },
        findFirst: async () => ({
          id: 'wo-1',
          projectId: 'p-1',
          partnerId: null,
          code: 'PRPL-WO-0007',
          workDetail: 'Earthwork',
          terms: null,
          requirements: null,
          hireContract: null,
          labourAmount: { toNumber: () => 0 },
          materialAmount: { toNumber: () => 0 },
          retentionPercent: { toNumber: () => 0.05 },
          status: 'draft',
          createdAt: new Date(),
          _count: { awardLines: 0, raBills: 0 },
        }),
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    // Asserted on the transaction it is handed, not merely on the string returned: a number
    // allocated outside the write would survive a rolled-back create and leave a gap in the
    // series, which reads as a deleted work order to whoever audits it later.
    const seen: unknown[] = [];
    const codeSeries = {
      next: async (t: unknown) => {
        seen.push(t);
        return 'PRPL-WO-0007';
      },
    };
    const service = new WorkOrdersService(
      prisma as never,
      codeSeries as never,
      { submit: async () => undefined } as never,
    );

    const view = await service.create(ctx, 'c-1', {
      projectId: 'p-1',
      workDetail: 'Earthwork',
    } as never);

    expect(created[0].code).toBe('PRPL-WO-0007');
    expect(seen[0]).toBe(tx);
    expect(view.code).toBe('PRPL-WO-0007');
  });
});

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
