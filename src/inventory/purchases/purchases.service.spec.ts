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
