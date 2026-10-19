import { BadRequestException } from '@nestjs/common';
import { Prisma, StockLedgerType, TransferStatus } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { TransfersService } from './transfers.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const transfer = (over: Record<string, unknown> = {}) => ({
  id: 'tr-1',
  companyId: 'co-1',
  itemId: 'item-1',
  fromSiteId: 'site-a',
  toSiteId: 'site-b',
  quantity: decimal(10),
  status: TransferStatus.in_transit,
  receivedQuantity: null,
  shortageReason: null,
  deleted: false,
  ...over,
});

const build = (row = transfer()) => {
  const prisma = createPrismaMock({
    stockTransfer: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn(async ({ data }: never) => ({
        ...row,
        ...(data as object),
        receivedQuantity:
          (data as { receivedQuantity?: number }).receivedQuantity === undefined
            ? null
            : decimal((data as { receivedQuantity: number }).receivedQuantity),
      })),
    },
    stockBalance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  });
  const stock = {
    validateAndLockStock: jest.fn().mockResolvedValue(10),
    appendLedgerEntry: jest.fn(),
  };
  const service = new TransfersService(
    prisma as never,
    { record: jest.fn() } as never,
    stock as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, stock };
};

describe('TransfersService.updateStatus — receiving (036 M3)', () => {
  it('refuses more received than was sent', async () => {
    const { service, stock } = build();
    await expect(
      service.updateStatus(
        caller,
        'tr-1',
        { status: TransferStatus.received, receivedQuantity: 25 },
        'ip',
      ),
    ).rejects.toThrow(/only 10 was sent/);
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
  });

  it('refuses a shortage with no reason', async () => {
    const { service } = build();
    await expect(
      service.updateStatus(
        caller,
        'tr-1',
        { status: TransferStatus.received, receivedQuantity: 8 },
        'ip',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes a shortage off at the destination, with its reason', async () => {
    const { service, stock, prisma } = build();
    await service.updateStatus(
      caller,
      'tr-1',
      {
        status: TransferStatus.received,
        receivedQuantity: 8,
        shortageReason: 'Two bags burst in transit',
      },
      'ip',
    );
    expect(stock.validateAndLockStock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: 'site-b', quantity: 2 }),
    );
    expect(stock.appendLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: 'site-b',
        type: StockLedgerType.transfer_in_reversal,
        quantity: 2,
      }),
    );
    expect(prisma.tx.stockBalance.updateMany).toHaveBeenCalledWith({
      where: { itemId: 'item-1', siteId: 'site-b' },
      data: { transferIn: { decrement: 2 } },
    });
    // Never back to the source (decision 3).
    expect(prisma.tx.stockBalance.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tx.stockTransfer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shortageReason: 'Two bags burst in transit',
        }),
      }),
    );
  });

  it('changes no stock on a full receipt', async () => {
    const { service, stock } = build();
    await service.updateStatus(
      caller,
      'tr-1',
      { status: TransferStatus.received, receivedQuantity: 10 },
      'ip',
    );
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
  });

  it('still accepts "received" with no counted quantity, as before', async () => {
    const { service, stock } = build();
    await service.updateStatus(
      caller,
      'tr-1',
      { status: TransferStatus.received },
      'ip',
    );
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
  });

  it('row-locks the transfer so it cannot be received twice', async () => {
    const { service, prisma } = build();
    await service.updateStatus(
      caller,
      'tr-1',
      { status: TransferStatus.received, receivedQuantity: 10 },
      'ip',
    );
    const sql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/"StockTransfer"[\s\S]*FOR UPDATE/);
  });
});
