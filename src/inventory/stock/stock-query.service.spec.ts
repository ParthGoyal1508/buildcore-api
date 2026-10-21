import { Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { StockQueryService } from './stock-query.service';
import { StockService } from './stock.service';

const decimal = (n: number) => new Prisma.Decimal(n);

const build = () => {
  const prisma = createPrismaMock({
    stockBalance: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  });
  prisma.tx.$queryRaw.mockResolvedValue([{ id: 'bal-1' }, { id: 'bal-2' }]);
  const refs = {
    itemsByIds: jest.fn().mockResolvedValue(new Map()),
    siteNames: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new StockQueryService(
    prisma as never,
    new StockService(),
    refs as never,
  );
  return { service, prisma };
};

describe('StockQueryService.list inStockOnly (039)', () => {
  it('pages over the rows with stock on hand, found in SQL first', async () => {
    const { service, prisma } = build();
    await service.list(callerFor('co-1'), {
      siteId: 'site-1',
      inStockOnly: true,
      page: 2,
      pageSize: 10,
    });

    const sql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(
      /"received" \+ "transferIn" - "issued" - "transferOut" > 0/,
    );
    const page = prisma.tx.stockBalance.findMany.mock.calls[0][0];
    expect(page.where).toMatchObject({
      siteId: 'site-1',
      id: { in: ['bal-1', 'bal-2'] },
    });
    expect(page.skip).toBe(10);
    expect(prisma.tx.stockBalance.count.mock.calls[0][0].where.id).toEqual({
      in: ['bal-1', 'bal-2'],
    });
  });

  it('leaves the stock list unchanged without the flag', async () => {
    const { service, prisma } = build();
    prisma.tx.stockBalance.findMany.mockResolvedValue([
      {
        itemId: 'i',
        siteId: 's',
        received: decimal(0),
        issued: decimal(0),
        transferIn: decimal(0),
        transferOut: decimal(0),
        avgRate: decimal(0),
      },
    ]);
    await service.list(callerFor('co-1'), { siteId: 'site-1' });
    expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    expect(
      prisma.tx.stockBalance.findMany.mock.calls[0][0].where.id,
    ).toBeUndefined();
  });
});
