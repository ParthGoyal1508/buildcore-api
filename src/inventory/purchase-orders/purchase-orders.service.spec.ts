import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import {
  PO_LINE_MISMATCH,
  PO_LINE_OVER_RECEIPT,
  PurchaseOrdersService,
} from './purchase-orders.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const line = (over: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  companyId: 'co-1',
  lineNo: 1,
  itemId: 'item-1',
  description: 'CEM-001 - Cement OPC 53',
  unit: 'BAG',
  quantity: decimal(100),
  purchaseOrder: { vendorId: 'vendor-1', referenceNo: 'DBT/2026-27/0042' },
  ...over,
});

const receivable = (received: number, row = line()) => {
  const prisma = createPrismaMock({
    purchaseOrderLine: { findFirst: jest.fn().mockResolvedValue(row) },
    purchase: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { quantity: decimal(received) } }),
    },
  });
  const service = new PurchaseOrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tx: prisma.tx };
};

const input = (quantity: number, over: Record<string, unknown> = {}) => ({
  companyId: 'co-1',
  purchaseOrderLineId: 'pol-1',
  itemId: 'item-1',
  vendorId: 'vendor-1',
  quantity,
  ...over,
});

describe('PurchaseOrdersService.assertReceivable (036 M9)', () => {
  it('lets a delivery through up to what is left on the line', async () => {
    const { service, tx } = receivable(60);
    await expect(
      service.assertReceivable(tx as never, input(40)),
    ).resolves.toBeUndefined();
  });

  it('refuses receiving more than was ordered, saying how much is left', async () => {
    const { service, tx } = receivable(60);
    const failure = service.assertReceivable(tx as never, input(40.001));
    await expect(failure).rejects.toBeInstanceOf(BadRequestException);
    await expect(failure).rejects.toMatchObject({
      response: { code: PO_LINE_OVER_RECEIPT, remainingQuantity: 40 },
    });
  });

  it('locks the line before counting what was received', async () => {
    const { service, tx } = receivable(0);
    await service.assertReceivable(tx as never, input(1));
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.purchase.aggregate.mock.invocationCallOrder[0],
    );
  });

  it('refuses a line for another item', async () => {
    const { service, tx } = receivable(0);
    await expect(
      service.assertReceivable(tx as never, input(1, { itemId: 'item-2' })),
    ).rejects.toMatchObject({ response: { code: PO_LINE_MISMATCH } });
  });

  it('refuses a typed line, which names no item', async () => {
    const { service, tx } = receivable(0, line({ itemId: null }));
    await expect(
      service.assertReceivable(tx as never, input(1)),
    ).rejects.toMatchObject({ response: { code: PO_LINE_MISMATCH } });
  });

  it('refuses a delivery from a vendor the PO was not placed on', async () => {
    const { service, tx } = receivable(0);
    await expect(
      service.assertReceivable(tx as never, input(1, { vendorId: 'vendor-2' })),
    ).rejects.toMatchObject({ response: { code: PO_LINE_MISMATCH } });
  });

  it('refuses a line of another company', async () => {
    const { service, tx } = receivable(0, null as never);
    await expect(
      service.assertReceivable(tx as never, input(1)),
    ).rejects.toMatchObject({ response: { code: PO_LINE_MISMATCH } });
  });
});

describe('PurchaseOrdersService structuring an issued PO letter (036 M9)', () => {
  const letter = (over: Record<string, unknown> = {}) => ({
    id: 'letter-1',
    referenceNo: 'DBT/2026-27/0042',
    version: 1,
    isSuperseded: false,
    issuedAt: new Date('2026-10-17T05:00:00Z'),
    subjectType: 'vendor',
    subjectId: 'vendor-1',
    composedVariables: {
      lineItems:
        'CEM-001 - Cement OPC 53 | BAG | 100 | 410\nTyped freight line | LS | 1 | 2500',
      gstRate: '',
    },
    ...over,
  });

  const build = (letters: unknown[]) => {
    const prisma = createPrismaMock({
      purchaseOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'po-1' }),
      },
      purchaseOrderLine: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const items = {
      findAll: jest.fn().mockResolvedValue({
        items: [
          { id: 'item-1', companyId: 'co-1', code: 'CEM-001' },
          { id: 'item-9', companyId: 'co-1', code: 'CEM-0011' },
        ],
      }),
    };
    const service = new PurchaseOrdersService(
      prisma as never,
      { listForSubject: jest.fn().mockResolvedValue(letters) } as never,
      items as never,
      { vendorNames: jest.fn().mockResolvedValue(new Map()) } as never,
    );
    return { service, tx: prisma.tx, items };
  };

  it('stores the lines the letter printed, matching item-master rows by code', async () => {
    const { service, tx } = build([letter()]);
    await service.openLines(caller, {});

    expect(tx.purchaseOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'co-1',
        letterId: 'letter-1',
        referenceNo: 'DBT/2026-27/0042',
        vendorId: 'vendor-1',
        // Blank `gstRate` prints at 18%, so it is stored as 18.
        gstPercent: 18,
      }),
    });
    const rows = tx.purchaseOrderLine.upsert.mock.calls.map(
      ([arg]: [{ create: Record<string, unknown> }]) => arg.create,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        lineNo: 1,
        itemId: 'item-1',
        description: 'CEM-001 - Cement OPC 53',
        unit: 'BAG',
        quantity: 100,
        rate: 410,
        amount: 41000,
      }),
      // A typed row is kept, so the PO is traceable whole, but names no item.
      expect.objectContaining({
        lineNo: 2,
        itemId: null,
        amount: 2500,
      }),
    ]);
  });

  it('leaves composed (unissued) and superseded letters alone', async () => {
    const { service, tx } = build([
      letter({ issuedAt: null }),
      letter({ id: 'letter-0', isSuperseded: true }),
    ]);
    await service.openLines(caller, {});
    expect(tx.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('does nothing more for a letter already structured', async () => {
    const { service, tx, items } = build([letter()]);
    tx.purchaseOrder.findMany.mockResolvedValueOnce([{ letterId: 'letter-1' }]);
    await service.openLines(caller, {});
    expect(items.findAll).not.toHaveBeenCalled();
    expect(tx.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it('moves a reissued PO onto its new version, keeping a received line that was dropped', async () => {
    const { service, tx } = build([
      letter({
        id: 'letter-2',
        version: 2,
        composedVariables: {
          lineItems: 'CEM-001 - Cement OPC 53 | BAG | 80 | 410',
          gstRate: '12',
        },
      }),
    ]);
    tx.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: 'po-1',
      version: 1,
      lines: [
        { id: 'pol-1', lineNo: 1, _count: { purchases: 1 } },
        { id: 'pol-2', lineNo: 2, _count: { purchases: 1 } },
        { id: 'pol-3', lineNo: 3, _count: { purchases: 0 } },
      ],
    });
    tx.purchaseOrder.update = jest.fn().mockResolvedValue({ id: 'po-1' });
    tx.purchaseOrderLine.update = jest.fn();
    tx.purchaseOrderLine.delete = jest.fn();

    await service.openLines(caller, {});

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: 'po-1' },
      data: expect.objectContaining({
        letterId: 'letter-2',
        version: 2,
        gstPercent: 12,
      }),
    });
    expect(tx.purchaseOrderLine.update).toHaveBeenCalledWith({
      where: { id: 'pol-2' },
      data: { quantity: 0, amount: 0 },
    });
    expect(tx.purchaseOrderLine.delete).toHaveBeenCalledWith({
      where: { id: 'pol-3' },
    });
  });
});
