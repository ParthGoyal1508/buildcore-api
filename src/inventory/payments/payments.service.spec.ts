import { Prisma, PaymentMode, PurchaseBillStatus } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { PaymentsService } from './payments.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const bill = (id: string, total: number, paid = 0) => ({
  id,
  totalAmount: decimal(total),
  paidAmount: decimal(paid),
});

const refs = {
  targetCompanyOf: () => 'co-1',
  parseDate: (value: string) => new Date(`${value}T00:00:00.000Z`),
  requireVendorName: async () => 'Acme Cement',
  requireActiveVendor: async () => 'Acme Cement',
  vendorNames: async () => new Map([['vendor-1', 'Acme Cement']]),
} as never;

/**
 * A prisma mock whose `$queryRaw` returns the outstanding bills the FIFO walk asks
 * for, and which records every bill update so the assertions can be about amounts
 * and statuses rather than about call counts.
 */
const build = (bills: ReturnType<typeof bill>[]) => {
  const billUpdates: { id: string; paidAmount: number; status: string }[] = [];
  const allocations: { billId: string; allocatedAmount: number }[] = [];
  let createdPayment: Record<string, unknown> = {};

  const prisma = createPrismaMock({
    purchaseBill: {
      update: jest.fn(async ({ where, data }: never) => {
        const w = where as { id: string };
        const d = data as { paidAmount: number; paymentStatus: string };
        billUpdates.push({
          id: w.id,
          paidAmount: d.paidAmount,
          status: d.paymentStatus,
        });
        return {};
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: never) => {
        createdPayment = data as Record<string, unknown>;
        return {
          id: 'pay-1',
          createdAt: new Date(),
          referenceNumber: createdPayment.referenceNumber,
          ...createdPayment,
        };
      }),
    },
    paymentAllocation: {
      createMany: jest.fn(async ({ data }: never) => {
        for (const row of data as {
          billId: string;
          allocatedAmount: number;
        }[]) {
          allocations.push(row);
        }
        return { count: (data as unknown[]).length };
      }),
    },
  });
  prisma.tx.$queryRaw = jest.fn().mockResolvedValue(bills);

  const service = new PaymentsService(
    prisma as never,
    { record: jest.fn() } as never,
    refs,
    // 017 US7: storage is only reached by the proof endpoints, which these tests do not
    // exercise.
    { put: jest.fn(), get: jest.fn() } as never,
  );
  return {
    service,
    prisma,
    billUpdates,
    allocations,
    payment: () => createdPayment,
  };
};

const dto = (amount: number) => ({
  vendorId: 'vendor-1',
  amount,
  date: '2026-09-04',
  paymentMode: PaymentMode.bank_transfer,
  referenceNumber: 'UTR-1',
});

describe('PaymentsService — automatic FIFO allocation (FR-005, research.md §7)', () => {
  it('settles the oldest bill first', async () => {
    // The query is ordered oldest-first, so position in the array is FIFO order.
    const { service, billUpdates } = build([
      bill('old', 5000),
      bill('new', 3000),
    ]);
    await service.create(caller, dto(5000), '127.0.0.1');

    expect(billUpdates).toHaveLength(1);
    expect(billUpdates[0]).toEqual({
      id: 'old',
      paidAmount: 5000,
      status: PurchaseBillStatus.paid,
    });
  });

  it('carries the remainder onto the next bill and part-pays it', async () => {
    const { service, billUpdates } = build([
      bill('old', 5000),
      bill('new', 3000),
    ]);
    await service.create(caller, dto(7000), '127.0.0.1');

    expect(billUpdates).toEqual([
      { id: 'old', paidAmount: 5000, status: PurchaseBillStatus.paid },
      { id: 'new', paidAmount: 2000, status: PurchaseBillStatus.part_paid },
    ]);
  });

  it('part-pays a single bill without marking it settled', async () => {
    const { service, billUpdates } = build([bill('old', 5000)]);
    await service.create(caller, dto(1200), '127.0.0.1');

    expect(billUpdates[0]).toEqual({
      id: 'old',
      paidAmount: 1200,
      status: PurchaseBillStatus.part_paid,
    });
  });

  it('tops up a bill that was already part-paid', async () => {
    const { service, billUpdates } = build([bill('old', 5000, 2000)]);
    await service.create(caller, dto(3000), '127.0.0.1');

    expect(billUpdates[0]).toEqual({
      id: 'old',
      paidAmount: 5000,
      status: PurchaseBillStatus.paid,
    });
  });

  it('records the surplus as unallocated rather than refusing an over-payment', async () => {
    // Paying a vendor ahead of billing is ordinary. The surplus sits on the
    // payment until the next purchase is billed.
    const { service, billUpdates } = build([bill('only', 3000)]);
    const result = await service.create(caller, dto(10000), '127.0.0.1');

    expect(billUpdates).toHaveLength(1);
    expect(result.allocatedAmount).toBe(3000);
    expect(result.unallocatedBalance).toBe(7000);
  });

  it('allocates nothing when the vendor has no outstanding bills', async () => {
    const { service, billUpdates, allocations } = build([]);
    const result = await service.create(caller, dto(4000), '127.0.0.1');

    expect(billUpdates).toHaveLength(0);
    expect(allocations).toHaveLength(0);
    expect(result.unallocatedBalance).toBe(4000);
  });

  it('writes one allocation row per bill it touched', async () => {
    const { service, allocations } = build([
      bill('old', 5000),
      bill('new', 3000),
    ]);
    await service.create(caller, dto(7000), '127.0.0.1');

    expect(allocations).toEqual([
      {
        companyId: 'co-1',
        paymentId: 'pay-1',
        billId: 'old',
        allocatedAmount: 5000,
      },
      {
        companyId: 'co-1',
        paymentId: 'pay-1',
        billId: 'new',
        allocatedAmount: 2000,
      },
    ]);
  });

  it('locks the bills it is about to allocate against, oldest first', async () => {
    // Two concurrent payments to one vendor must take the bills in the same total
    // order or they can deadlock; `billDate` alone is not total, because two bills
    // can share a date. A mocked test cannot observe an actual lock, so what is
    // asserted is the statement that takes it.
    const { service, prisma } = build([bill('old', 5000)]);
    await service.create(caller, dto(1000), '127.0.0.1');

    const sql = (prisma.tx.$queryRaw as jest.Mock).mock.calls[0][0].join('?');
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY "billDate" ASC, "id" ASC/);
  });

  it('rounds to paise so a long bill list cannot drift', async () => {
    const { service, billUpdates } = build([
      bill('a', 33.33),
      bill('b', 33.33),
      bill('c', 33.34),
    ]);
    const result = await service.create(caller, dto(100), '127.0.0.1');

    expect(billUpdates.map((update) => update.paidAmount)).toEqual([
      33.33, 33.33, 33.34,
    ]);
    expect(result.allocatedAmount).toBe(100);
    expect(result.unallocatedBalance).toBe(0);
  });

  it('skips a bill that is already fully paid', async () => {
    const { service, billUpdates } = build([
      bill('settled', 5000, 5000),
      bill('open', 2000),
    ]);
    await service.create(caller, dto(2000), '127.0.0.1');

    expect(billUpdates).toEqual([
      { id: 'open', paidAmount: 2000, status: PurchaseBillStatus.paid },
    ]);
  });
});

describe('PaymentsService — cash, duplicates and double submits (036 M10)', () => {
  it('records a cash payment with no reference as a blank one', async () => {
    const { service, payment } = build([]);
    await service.create(
      caller,
      {
        ...dto(100),
        paymentMode: PaymentMode.cash,
        referenceNumber: undefined,
      },
      '127.0.0.1',
    );
    expect(payment().referenceNumber).toBe('');
  });

  it('stores the Idempotency-Key with the payment', async () => {
    const { service, payment } = build([]);
    const created = await service.create(
      caller,
      dto(100),
      '127.0.0.1',
      undefined,
      'key-1',
    );
    expect(payment().idempotencyKey).toBe('key-1');
    expect(created.replayed).toBe(false);
  });

  const earlier = (over: Record<string, unknown> = {}) => ({
    id: 'pay-0',
    companyId: 'co-1',
    vendorId: 'vendor-1',
    amount: decimal(100),
    allocatedAmount: decimal(0),
    date: new Date('2026-09-04T00:00:00.000Z'),
    paymentMode: PaymentMode.bank_transfer,
    referenceNumber: 'UTR-1',
    proofRef: null,
    proofUploadedAt: null,
    createdAt: new Date(),
    deleted: false,
    _count: { allocations: 0 },
    ...over,
  });

  it('answers a repeated key with the first payment, recording nothing new', async () => {
    const { service, prisma } = build([bill('old', 5000)]);
    prisma.tx.payment.findUnique.mockResolvedValue(earlier());
    const replay = await service.create(
      caller,
      dto(100),
      '127.0.0.1',
      undefined,
      'key-1',
    );
    expect(replay).toMatchObject({ id: 'pay-0', replayed: true });
    expect(prisma.tx.payment.create).not.toHaveBeenCalled();
    expect(prisma.tx.purchaseBill.update).not.toHaveBeenCalled();
  });

  it('refuses a key reused for a different payment', async () => {
    const { service, prisma } = build([]);
    prisma.tx.payment.findUnique.mockResolvedValue(
      earlier({ amount: decimal(999) }),
    );
    await expect(
      service.create(caller, dto(100), '127.0.0.1', undefined, 'key-1'),
    ).rejects.toThrow(/different payment/);
  });

  it('answers the loser of a same-key race with the winner', async () => {
    const { service, prisma } = build([]);
    prisma.tx.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(earlier());
    prisma.tx.payment.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const result = await service.create(
      caller,
      dto(100),
      '127.0.0.1',
      undefined,
      'key-1',
    );
    expect(result).toMatchObject({ id: 'pay-0', replayed: true });
  });

  it('warns, without refusing, when the vendor already has a payment with this reference', async () => {
    const { service, prisma } = build([]);
    prisma.tx.payment.findFirst.mockResolvedValue({
      date: new Date('2026-09-01T00:00:00.000Z'),
      amount: decimal(5000),
    });
    const created = await service.create(caller, dto(100), '127.0.0.1');
    expect(created.warnings).toHaveLength(1);
    expect(created.warnings[0]).toMatch(
      /UTR-1 was already used .* on 01-09-2026/,
    );
  });
});
