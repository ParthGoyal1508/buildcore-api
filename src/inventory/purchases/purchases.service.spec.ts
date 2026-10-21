import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { PurchasesService } from './purchases.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const purchase = (over: Record<string, unknown> = {}) => ({
  id: 'pur-1',
  companyId: 'co-1',
  itemId: 'item-1',
  siteId: 'site-1',
  vendorId: 'vendor-1',
  quantity: decimal(10),
  rate: decimal(100),
  date: new Date('2026-09-04T00:00:00.000Z'),
  deleted: false,
  indentLineId: null,
  bill: { id: 'bill-1', allocations: [] },
  ...over,
});

/** A purchases service whose stock lock reports `available` units in the store. */
const build = (available: number, marked = 1) => {
  const prisma = createPrismaMock({
    purchase: {
      findUnique: jest.fn().mockResolvedValue(purchase()),
      updateMany: jest.fn().mockResolvedValue({ count: marked }),
    },
    stockBalance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    purchaseBill: { delete: jest.fn() },
    goodsReceiptNote: { deleteMany: jest.fn() },
  });
  const stock = {
    lockAvailable: jest.fn().mockResolvedValue(available),
    appendLedgerEntry: jest.fn(),
    recomputeWAR: jest.fn(),
  };
  const service = new PurchasesService(
    prisma as never,
    { record: jest.fn() } as never,
    stock as never,
    {} as never,
    {} as never,
    {} as never,
    { reverseFulfilment: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, stock };
};

describe('PurchasesService.remove — stock must still be there (036 M1)', () => {
  it('refuses with 422 when part of the receipt has already been issued', async () => {
    const { service, stock, prisma } = build(4);
    const failure = service.remove(caller, 'pur-1', '127.0.0.1');
    await expect(failure).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(failure).rejects.toMatchObject({
      response: { availableStock: 4 },
    });
    expect(stock.lockAvailable).toHaveBeenCalledWith(expect.anything(), {
      itemId: 'item-1',
      siteId: 'site-1',
    });
    // Nothing was reversed.
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
    expect(prisma.tx.stockBalance.updateMany).not.toHaveBeenCalled();
  });

  it('reverses the purchase when the whole receipt is still in stock', async () => {
    const { service, stock, prisma } = build(10);
    await service.remove(caller, 'pur-1', '127.0.0.1');
    expect(stock.appendLedgerEntry).toHaveBeenCalledTimes(1);
    expect(prisma.tx.stockBalance.updateMany).toHaveBeenCalled();
  });

  it('locks the balance before marking the purchase deleted', async () => {
    const { service, stock, prisma } = build(10);
    await service.remove(caller, 'pur-1', '127.0.0.1');
    expect(stock.lockAvailable.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tx.purchase.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('lets only one of two simultaneous deletes through', async () => {
    // The second delete waited on the lock and finds the row already gone.
    const { service, stock } = build(10, 0);
    await expect(
      service.remove(caller, 'pur-1', '127.0.0.1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
  });
});

describe('PurchasesService — hiding cash (038)', () => {
  const listed = (hidden: boolean) => {
    const bill = {
      id: 'bill-1',
      totalAmount: decimal(1000),
      paidAmount: decimal(1000),
      paymentStatus: 'paid',
    };
    const prisma = createPrismaMock({
      company: {
        findMany: jest.fn().mockResolvedValue(hidden ? [{ id: 'co-1' }] : []),
      },
      purchase: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...purchase(),
            amount: decimal(1000),
            billFileRef: null,
            photoFileRef: null,
            grn: null,
            purchaseOrderLine: null,
            purchaseOrderLineId: null,
            remarks: null,
            createdAt: new Date(),
            bill,
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: decimal(1000), quantity: null },
        }),
      },
      purchaseBill: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { paidAmount: decimal(1000) } }),
      },
      paymentAllocation: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { allocatedAmount: decimal(700) } }),
        groupBy: jest
          .fn()
          .mockResolvedValue([
            { billId: 'bill-1', _sum: { allocatedAmount: decimal(700) } },
          ]),
      },
    });
    const refs = {
      itemsByIds: async () => new Map(),
      siteNames: async () => new Map(),
      vendorNames: async () => new Map(),
    };
    const service = new PurchasesService(
      prisma as never,
      { record: jest.fn() } as never,
      {} as never,
      refs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('reads paid figures and totals without cash while cash is hidden', async () => {
    const { service } = listed(true);
    const res = await service.findAll(caller, {} as never);
    expect(res.purchases[0]).toMatchObject({
      paidAmount: 300,
      paymentStatus: 'part_paid',
    });
    expect(res.totals.paidAmount).toBe(300);
  });

  it('reads the stored paid figures while cash is not hidden', async () => {
    const { service, prisma } = listed(false);
    const res = await service.findAll(caller, {} as never);
    expect(res.purchases[0]).toMatchObject({
      paidAmount: 1000,
      paymentStatus: 'paid',
    });
    expect(res.totals.paidAmount).toBe(1000);
    expect(prisma.tx.paymentAllocation.aggregate).not.toHaveBeenCalled();
  });

  it('refuses deleting a purchase whose bill was paid in hidden cash', async () => {
    const { service, prisma } = build(10);
    prisma.tx.purchase.findUnique.mockResolvedValue(
      purchase({ bill: { id: 'bill-1', allocations: [{ id: 'a1' }] } }),
    );
    prisma.tx.company = {
      findMany: jest.fn().mockResolvedValue([{ id: 'co-1' }]),
    };
    prisma.tx.paymentAllocation = {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { billId: 'bill-1', _sum: { allocatedAmount: decimal(10) } },
        ]),
    };
    await expect(
      service.remove(caller, 'pur-1', '127.0.0.1'),
    ).rejects.toMatchObject({ response: { code: 'CASH_HIDDEN' } });
  });
});
