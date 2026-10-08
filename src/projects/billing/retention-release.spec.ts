import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { retentionBalance } from './bill-totals';
import { BILLING_ERRORS } from './billing-error-codes';
import { RaBillsService } from './ra-bills.service';

const dec = (value: number) => new Prisma.Decimal(value);
const ctx = { isSuperAdmin: false, companyId: 'co-1' };

/**
 * Retention released back to a subcontractor (018 FR-016a, Phase 7, T040).
 *
 * The client confirmed on 2026-10-03 that release is an act somebody performs, not a schedule the
 * system runs — chosen over two automatic schedules they were offered. That makes the refusal below
 * the load-bearing part of the whole phase: with no schedule to bound it, the only thing standing
 * between a typo and money the company never held is this check.
 */
function build(opts: {
  withheld?: number;
  released?: number;
  workOrder?: {
    id: string;
    companyId: string;
    retentionPercent: unknown;
  } | null;
  releases?: {
    id: string;
    amount: Prisma.Decimal;
    releasedOn: Date;
    reason: string | null;
    releasedByUserId: string | null;
  }[];
}) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 0,
    workOrder: {
      findFirst: async () =>
        opts.workOrder === undefined
          ? { id: 'wo-1', companyId: 'co-1', retentionPercent: dec(0.05) }
          : opts.workOrder,
    },
    rABill: {
      aggregate: async () => ({
        _sum: { retentionAmount: dec(opts.withheld ?? 0) },
      }),
    },
    retentionRelease: {
      aggregate: async () => ({ _sum: { amount: dec(opts.released ?? 0) } }),
      findMany: async () => opts.releases ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const service = new RaBillsService(
    prisma as never,
    { submit: jest.fn() } as never,
    // The audit trail, stubbed: these tests are about what the service stores.
    { record: async () => undefined } as never,
  );
  return { service, created };
}

describe('retentionBalance', () => {
  it('is what was withheld less what has gone back', () => {
    expect(retentionBalance({ withheld: 150000, released: 50000 })).toEqual({
      withheld: 150000,
      released: 50000,
      outstanding: 100000,
    });
  });

  /**
   * Each part is rounded, then subtracted — 1000.56 less 100.11, not 900.444 rounded.
   *
   * The order matters and this pins it: a reader checking the balance subtracts the two figures
   * printed in front of them, and a balance computed from the unrounded inputs can differ from
   * theirs by a paisa. Being right in the fourth decimal is worth less than agreeing with the
   * person holding the screen.
   */
  it('rounds each part before subtracting, so the figures shown agree', () => {
    expect(retentionBalance({ withheld: 1000.555, released: 100.111 })).toEqual(
      { withheld: 1000.56, released: 100.11, outstanding: 900.45 },
    );
  });

  /**
   * Not clamped at zero. A negative balance should be impossible — the release path refuses to
   * create one — so if it ever appears it is a defect worth seeing rather than a cell to tidy away.
   */
  it('reports a negative balance rather than hiding it', () => {
    expect(retentionBalance({ withheld: 100, released: 150 }).outstanding).toBe(
      -50,
    );
  });
});

describe('RaBillsService.releaseRetention', () => {
  const input = {
    amount: 50000,
    releasedOn: '2026-10-01',
    reason: 'Practical completion certificate issued',
  };

  it('records a release within the balance held', async () => {
    const { service, created } = build({ withheld: 150000, released: 0 });

    await service.releaseRetention(ctx, 'wo-1', input, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workOrderId: 'wo-1',
      companyId: 'co-1',
      amount: 50000,
      reason: 'Practical completion certificate issued',
      releasedByUserId: 'user-1',
    });
  });

  /**
   * **The refusal this ledger exists for.** Retention released past the balance is money the company
   * never held being paid out as though it had, and nothing downstream catches it: the bills it was
   * withheld from are closed, and no subcontractor queries a payment in their favour.
   */
  it('refuses more than was ever withheld', async () => {
    const { service, created } = build({ withheld: 150000, released: 0 });

    await expect(
      service.releaseRetention(ctx, 'wo-1', { ...input, amount: 150001 }, 'u'),
    ).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.retentionExceedsHeld },
    });
    expect(created).toHaveLength(0);
  });

  it('counts earlier releases against the balance', async () => {
    const { service, created } = build({ withheld: 150000, released: 120000 });

    // 30,000 remains; 40,000 is refused and 30,000 exactly is allowed.
    await expect(
      service.releaseRetention(ctx, 'wo-1', { ...input, amount: 40000 }, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);

    await service.releaseRetention(
      ctx,
      'wo-1',
      { ...input, amount: 30000 },
      'u',
    );
    expect(created).toHaveLength(1);
  });

  /**
   * Required rather than encouraged. An optional field on a path that moves money is an empty
   * field, and "which milestone was this against" is the first question asked of a release.
   */
  it('refuses a release with no reason', async () => {
    const { service, created } = build({ withheld: 150000 });

    await expect(
      service.releaseRetention(ctx, 'wo-1', { ...input, reason: '   ' }, 'u'),
    ).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.retentionReasonRequired },
    });
    expect(created).toHaveLength(0);
  });

  it('refuses a zero or negative release', async () => {
    const { service } = build({ withheld: 150000 });

    await expect(
      service.releaseRetention(ctx, 'wo-1', { ...input, amount: 0 }, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a release against a work order that does not exist', async () => {
    const { service } = build({ workOrder: null });

    await expect(
      service.releaseRetention(ctx, 'wo-1', input, 'u'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RaBillsService.retentionFor', () => {
  it('reports withheld, released and outstanding together, with the releases behind them', async () => {
    const { service } = build({
      withheld: 150000,
      released: 50000,
      releases: [
        {
          id: 'rel-1',
          amount: dec(50000),
          releasedOn: new Date('2026-09-15'),
          reason: 'Practical completion',
          releasedByUserId: 'user-1',
        },
      ],
    });

    const ledger = await service.retentionFor(ctx, 'wo-1');

    // All three, not just the balance: "how much are you still holding" is really also "and how
    // did it get to that", and one figure sends somebody to add up bills by hand.
    expect(ledger).toMatchObject({
      workOrderId: 'wo-1',
      withheld: 150000,
      released: 50000,
      outstanding: 100000,
    });
    expect(ledger.releases).toHaveLength(1);
    expect(ledger.releases[0].reason).toBe('Practical completion');
  });

  it('reports a work order with nothing withheld as nothing outstanding', async () => {
    const { service } = build({ withheld: 0, released: 0 });

    const ledger = await service.retentionFor(ctx, 'wo-1');

    expect(ledger.outstanding).toBe(0);
    expect(ledger.releases).toEqual([]);
  });
});
