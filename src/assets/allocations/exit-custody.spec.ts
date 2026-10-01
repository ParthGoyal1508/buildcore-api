import { AllocationService } from './allocation.service';

/**
 * What the assets module reports as an employee's custody (021 FR-014a, FR-014d, T076, T077).
 *
 * The query's `where` clause is what is asserted, because that clause *is* the requirement: an
 * allocation with no custodian must never reach an exit clearance, and reading it fresh is what
 * catches one opened after the exit was initiated.
 */
describe('AllocationService.openCustodyFor', () => {
  const capture = (rows: Record<string, unknown>[] = []) => {
    const seen: { where?: Record<string, unknown> }[] = [];
    const tx = {
      $executeRaw: async () => 0,
      assetAllocation: {
        findMany: async (args: { where?: Record<string, unknown> }) => {
          seen.push(args);
          return rows;
        },
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new AllocationService(
      { register: jest.fn() } as never,
      prisma as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
    );
    return { service, seen };
  };

  const ctx = { isSuperAdmin: true } as never;

  it('asks only for allocations naming this employee as custodian (FR-014d)', async () => {
    // An asset held by a project or a site is the project's obligation, not a departing
    // person's. Filtering on the custodian is what makes that true rather than remembered.
    const { service, seen } = capture();
    await service.openCustodyFor(ctx, 'co-1', 'emp-1');

    const where = seen[0].where as Record<string, unknown>;
    expect(where.custodianEmployeeId).toBe('emp-1');
    expect(where.companyId).toBe('co-1');
  });

  it('asks only for allocations that are still open', async () => {
    const { service, seen } = capture();
    await service.openCustodyFor(ctx, 'co-1', 'emp-1');
    const where = seen[0].where as Record<string, unknown>;
    expect(where.status).toBe('open');
    // And not soft-deleted, or a removed allocation would block an exit forever.
    expect(where.deletedAt).toBeNull();
  });

  it('reads fresh on every call, so a late allocation is caught (FR-014e)', async () => {
    // Recomputing at read time is not an extra requirement — it is what deriving means, and it
    // is the only thing that catches an allocation opened after the exit was initiated.
    const { service, seen } = capture();
    await service.openCustodyFor(ctx, 'co-1', 'emp-1');
    await service.openCustodyFor(ctx, 'co-1', 'emp-1');
    expect(seen).toHaveLength(2);
  });

  it('carries what the clearance needs to name the asset', async () => {
    const { service } = capture([
      {
        id: 'alloc-1',
        assetId: 'a-1',
        projectId: 'p-1',
        siteId: 'site-1',
        quantity: 2,
        expectedReturnDate: new Date('2026-10-01T00:00:00.000Z'),
        asset: { name: 'Total Station', assetCode: 'AST-9' },
      },
    ]);
    const held = await service.openCustodyFor(ctx, 'co-1', 'emp-1');
    expect(held[0]).toMatchObject({
      allocationId: 'alloc-1',
      assetName: 'Total Station',
      assetCode: 'AST-9',
      quantity: 2,
    });
  });
});
