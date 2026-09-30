import { ExitClearanceService, CLEARANCE_KIND } from './exit-clearance.service';

/**
 * The derived exit clearance (021 T074-T078).
 *
 * The properties worth pinning are the ones a refactor would quietly break: that an allocation
 * with no custodian never appears, that a waiver does not discharge the underlying obligation,
 * that a bulk allocation reads as outstanding with its count stated, and that "could not ask" is
 * never reported as "nothing outstanding".
 */
describe('ExitClearanceService', () => {
  const build = (opts: {
    assets?: Record<string, unknown>[];
    kitRows?: Record<string, unknown>[];
    recoverableKitIds?: string[];
    advances?: Record<string, unknown>[];
    waivers?: Record<string, unknown>[];
    noCustodySource?: boolean;
  }) => {
    const waiverWrites: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: async () => 0,
      exitRecord: {
        findFirst: async () => ({ id: 'exit-1', employeeId: 'emp-1' }),
      },
      exitClearanceWaiver: {
        findMany: async () => opts.waivers ?? [],
        upsert: async (args: Record<string, unknown>) => {
          waiverWrites.push(args);
          return args;
        },
      },
      onboardingItem: { findMany: async () => opts.kitRows ?? [] },
      kitItem: {
        findMany: async () =>
          (opts.recoverableKitIds ?? []).map((id) => ({ id })),
      },
      salaryAdvance: { findMany: async () => opts.advances ?? [] },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const registry = {
      source: () =>
        opts.noCustodySource
          ? null
          : { openCustodyFor: async () => opts.assets ?? [] },
    };
    return {
      service: new ExitClearanceService(prisma as never, registry as never),
      waiverWrites,
    };
  };

  const ctx = { isSuperAdmin: true } as never;

  const allocation = (over: Record<string, unknown> = {}) => ({
    allocationId: 'alloc-1',
    assetId: 'a-1',
    assetName: 'Total Station',
    assetCode: 'AST-9',
    projectId: 'p-1',
    siteId: 'site-1',
    quantity: 1,
    expectedReturnDate: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  });

  it('lists an open asset allocation as outstanding', async () => {
    const { service } = build({ assets: [allocation()] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    expect(clearance.items).toHaveLength(1);
    expect(clearance.items[0].kind).toBe(CLEARANCE_KIND.asset);
    expect(clearance.items[0].label).toContain('Total Station');
    expect(clearance.items[0].detail).toContain('site-1');
    expect(clearance.settleable).toBe(false);
  });

  it('states the quantity for a bulk allocation', async () => {
    // The asset register closes an allocation as a whole — it holds no partial return — so the
    // checklist reports the count rather than pretending some came back.
    const { service } = build({ assets: [allocation({ quantity: 10 })] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items[0].detail).toContain('10 units');
  });

  it('is settleable once everything is returned', async () => {
    const { service } = build({ assets: [] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items).toHaveLength(0);
    expect(clearance.settleable).toBe(true);
  });

  it('is settleable when an outstanding item is waived', async () => {
    const { service } = build({
      assets: [allocation()],
      waivers: [
        {
          itemKind: CLEARANCE_KIND.asset,
          itemRef: 'alloc-1',
          reason: 'Written off — asset lost on site',
          waivedByUserId: 'u-1',
          waivedAt: new Date(),
        },
      ],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    // Still outstanding, and settleable anyway. The distinction matters: the asset did not come
    // back, and the summary must say so.
    expect(clearance.items[0].outstanding).toBe(true);
    expect(clearance.items[0].waiver?.reason).toContain('Written off');
    expect(clearance.settleable).toBe(true);
  });

  it('a waiver writes no change to the allocation itself (FR-014c)', async () => {
    const { service, waiverWrites } = build({ assets: [allocation()] });
    await service.waive(
      ctx,
      'co-1',
      'emp-1',
      {
        kind: CLEARANCE_KIND.asset,
        ref: 'alloc-1',
        reason: 'Written off — asset lost on site',
      },
      'u-1',
    );

    // Exactly one write, and it is the waiver. The asset register owns custody: marking the
    // allocation returned would put a false fact in the table that holds the truth.
    expect(waiverWrites).toHaveLength(1);
    expect(JSON.stringify(waiverWrites[0])).not.toContain('actualReturnDate');
    expect(JSON.stringify(waiverWrites[0])).not.toContain('closed');
  });

  it('refuses a waiver for something not on the clearance', async () => {
    const { service } = build({ assets: [allocation()] });
    await expect(
      service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'not-a-real-allocation',
          reason: 'Trying it on, at length',
        },
        'u-1',
      ),
    ).rejects.toThrow();
  });

  it('lists only kit the company expects back', async () => {
    // A branded notebook is issued and never recovered. Listing it would make every exit look
    // incomplete, and the flag on `KitItem` is what says which is which.
    const { service } = build({
      assets: [],
      kitRows: [
        { id: 'oi-1', label: 'Laptop', kitItemId: 'kit-1' },
        { id: 'oi-2', label: 'Notebook', kitItemId: 'kit-2' },
      ],
      recoverableKitIds: ['kit-1'],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    const kit = clearance.items.filter((i) => i.kind === CLEARANCE_KIND.kit);
    expect(kit).toHaveLength(1);
    expect(kit[0].label).toBe('Laptop');
  });

  it('lists an advance with a balance still owed', async () => {
    const { service } = build({
      assets: [],
      advances: [{ id: 'adv-1', outstandingBalance: '5000' }],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items[0].kind).toBe(CLEARANCE_KIND.advance);
    expect(clearance.items[0].detail).toContain('5000');
  });

  it('never reports "could not ask" as "nothing outstanding"', async () => {
    // If feature 012 is not deployed, a clearance reporting no assets would be lying — and the
    // lie would let somebody leave with a laptop. So the source is named and settlement is
    // refused: the safe answer when part of the question went unanswered is "assume yes".
    const { service } = build({ noCustodySource: true });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    expect(clearance.items).toHaveLength(0);
    expect(clearance.unavailableSources).toEqual(['asset_custody']);
    expect(clearance.settleable).toBe(false);
  });

  it('names every blocking item when it refuses a settlement', async () => {
    // A refusal saying only "something is outstanding" sends somebody hunting through a screen
    // they have already read.
    const { service } = build({ assets: [allocation()] });
    await expect(
      service.assertSettleable(ctx, 'co-1', 'emp-1'),
    ).rejects.toMatchObject({
      response: {
        code: 'EXIT_CLEARANCE_OUTSTANDING',
        blocking: [expect.stringContaining('Total Station')],
      },
    });
  });

  it('permits a settlement once nothing blocks it', async () => {
    const { service } = build({ assets: [] });
    await expect(
      service.assertSettleable(ctx, 'co-1', 'emp-1'),
    ).resolves.toBeUndefined();
  });
});
