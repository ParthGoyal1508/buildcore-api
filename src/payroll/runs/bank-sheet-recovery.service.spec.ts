import { BankSheetRecoveryService } from './bank-sheet-recovery.service';

/**
 * Advances settling against the transfer (021 FR-010 to FR-013, tasks T048 to T051) — `bugs.md`
 * item 9.
 *
 * The case item 9 exists for is an advance taken **between approval and payment day**: the run is
 * immutable by then, so the money comes out of the transfer and the run stays as approved.
 */

const DRAWN_UP = new Date('2026-07-31T00:00:00.000Z');
const AFTER = new Date('2026-08-05T00:00:00.000Z');

interface AdvanceFixture {
  id: string;
  employeeId: string;
  outstandingBalance: number;
  createdAt: Date;
  status: string;
}

function advance(over: Partial<AdvanceFixture> = {}): AdvanceFixture {
  return {
    id: 'adv-1',
    employeeId: 'e1',
    outstandingBalance: 5000,
    // After the run was drawn up — the case this feature exists for.
    createdAt: AFTER,
    status: 'disbursed',
    ...over,
  };
}

function build(opts: {
  advances?: AdvanceFixture[];
  existing?: {
    employeeId: string;
    salaryAdvanceId: string;
    amount: number;
  }[];
}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  let duplicateNext = false;

  const dec = (value: number) => ({ toNumber: () => value });

  const tx = {
    $executeRaw: async () => 0,
    bankSheetRecovery: {
      findMany: async () =>
        (opts.existing ?? []).map((r) => ({
          ...r,
          amount: dec(r.amount),
        })),
      create: async (args: Record<string, unknown>) => {
        if (duplicateNext) {
          duplicateNext = false;
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          });
        }
        created.push(args);
        return args;
      },
    },
    salaryAdvance: {
      // The eligibility `where` is asserted on directly rather than simulated: which advances this
      // touches is the decision that matters, and a double that filtered for the service would
      // prove the double right rather than the service.
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        return (opts.advances ?? []).map((a) => ({
          ...a,
          outstandingBalance: dec(a.outstandingBalance),
        }));
      },
      update: async (args: Record<string, unknown>) => {
        updated.push(args);
        return args;
      },
    },
  };
  const queries: Record<string, unknown>[] = [];
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return {
    service: new BankSheetRecoveryService(prisma as never),
    created,
    updated,
    queries,
    failDuplicateOnce: () => {
      duplicateNext = true;
    },
  };
}

const ctx = { isSuperAdmin: true } as never;
const run = { id: 'run-1', companyId: 'co-1', drawnUpAt: DRAWN_UP };

describe('BankSheetRecoveryService', () => {
  it('recovers an advance taken after the run was drawn up (SC-005)', async () => {
    // This is the case item 9 exists for, and the only one it exists for.
    const { service } = build({ advances: [advance()] });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 20000 },
    ]);

    const result = transfers.get('e1');
    expect(result?.recoveredTotal).toBe(5000);
    expect(result?.transferAmount).toBe(15000);
    // The approved run's own figure, reported untouched beside it.
    expect(result?.netPay).toBe(20000);
  });

  it('asks only for advances the run could not have seen', async () => {
    // T051's property, asserted on the **query** rather than on behaviour. An advance the engine
    // already capped must stay capped: taking its remainder from the transfer would drive the
    // transfer to zero, which is the outcome FR-012's cap exists to prevent.
    const { service, queries } = build({ advances: [] });

    await service.apply(ctx, run, [{ employeeId: 'e1', netPay: 20000 }]);

    expect(queries[0]).toMatchObject({
      status: 'disbursed',
      outstandingBalance: { gt: 0 },
      createdAt: { gt: DRAWN_UP },
    });
  });

  it('caps at net pay, never producing a negative transfer (T048)', async () => {
    // An employee whose advance exceeds one month's net still gets paid something — nothing, in this
    // case, but never a transfer the bank cannot execute.
    const { service, updated } = build({
      advances: [advance({ outstandingBalance: 30000 })],
    });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 20000 },
    ]);

    expect(transfers.get('e1')?.transferAmount).toBe(0);
    expect(transfers.get('e1')?.recoveredTotal).toBe(20000);
    // And the remainder stays outstanding rather than being written off (FR-012).
    expect(updated[0]).toMatchObject({
      data: expect.objectContaining({ outstandingBalance: 10000 }),
    });
  });

  it('leaves a partially recovered advance open', async () => {
    const { service, updated } = build({
      advances: [advance({ outstandingBalance: 30000 })],
    });

    await service.apply(ctx, run, [{ employeeId: 'e1', netPay: 20000 }]);

    // Not closed: a closed advance stops being recovered, and 10,000 is still owed.
    expect(JSON.stringify(updated[0])).not.toContain('closed');
  });

  it('closes an advance recovered in full', async () => {
    const { service, updated } = build({ advances: [advance()] });

    await service.apply(ctx, run, [{ employeeId: 'e1', netPay: 20000 }]);

    expect(updated[0]).toMatchObject({
      data: expect.objectContaining({ status: 'closed' }),
    });
  });

  it('recovers once when the sheet is produced twice (T049, FR-013)', async () => {
    // The second production reads back what the first recovered and writes nothing further. The
    // database's unique index is what guarantees it; this asserts the service does not fight it.
    const { service, created } = build({
      advances: [advance()],
      existing: [{ employeeId: 'e1', salaryAdvanceId: 'adv-1', amount: 5000 }],
    });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 20000 },
    ]);

    expect(created).toEqual([]);
    // And the figure is still right: the recovery already written still comes off the transfer.
    expect(transfers.get('e1')?.transferAmount).toBe(15000);
  });

  it('counts recoveries already written against the headroom', async () => {
    // Otherwise a second pass could recover past net pay by forgetting what the first took, and the
    // transfer would go negative through a route the cap never sees.
    const { service, created } = build({
      advances: [advance({ id: 'adv-2', outstandingBalance: 30000 })],
      existing: [{ employeeId: 'e1', salaryAdvanceId: 'adv-1', amount: 18000 }],
    });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 20000 },
    ]);

    expect(created).toHaveLength(1);
    expect((created[0] as { data: { amount: number } }).data.amount).toBe(2000);
    expect(transfers.get('e1')?.transferAmount).toBe(0);
  });

  it('treats a concurrent duplicate as success, not an error', async () => {
    // A unique violation means another request already recovered this advance for this run — which is
    // the outcome FR-013 asks for. Raising would be the caller being told off for being right.
    const { service, failDuplicateOnce } = build({ advances: [advance()] });
    failDuplicateOnce();

    await expect(
      service.apply(ctx, run, [{ employeeId: 'e1', netPay: 20000 }]),
    ).resolves.toBeDefined();
  });

  it('recovers nothing for an employee with no advances', async () => {
    const { service } = build({ advances: [] });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 20000 },
    ]);

    expect(transfers.get('e1')).toMatchObject({
      recoveries: [],
      recoveredTotal: 0,
      transferAmount: 20000,
    });
  });

  it('spends the headroom across several advances, oldest first', async () => {
    const { service, created } = build({
      advances: [
        advance({ id: 'adv-1', outstandingBalance: 8000, createdAt: AFTER }),
        advance({
          id: 'adv-2',
          outstandingBalance: 8000,
          createdAt: new Date('2026-08-06T00:00:00.000Z'),
        }),
      ],
    });

    const transfers = await service.apply(ctx, run, [
      { employeeId: 'e1', netPay: 10000 },
    ]);

    // 8,000 then 2,000: the second advance is partly recovered rather than skipped, because an
    // employee owing two advances should see both reduce rather than one sit untouched.
    expect(
      created.map((c) => (c as { data: { amount: number } }).data.amount),
    ).toEqual([8000, 2000]);
    expect(transfers.get('e1')?.transferAmount).toBe(0);
  });
});
