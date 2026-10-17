import { BadRequestException } from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { IssuesService } from './issues.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const issue = (over: Record<string, unknown> = {}) => ({
  id: 'iss-1',
  companyId: 'co-1',
  itemId: 'item-1',
  siteId: 'site-1',
  quantity: decimal(10),
  returnedQuantity: null as Prisma.Decimal | null,
  indentLineId: null as string | null,
  deleted: false,
  ...over,
});

const build = (row: ReturnType<typeof issue>) => {
  const prisma = createPrismaMock({
    issue: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn(async ({ data }: never) => ({
        ...row,
        ...(data as object),
        returnedQuantity: decimal(
          (data as { returnedQuantity: number }).returnedQuantity,
        ),
      })),
    },
    stockBalance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  });
  const stock = { appendLedgerEntry: jest.fn() };
  const fulfilment = { reverseFulfilment: jest.fn() };
  const service = new IssuesService(
    prisma as never,
    { record: jest.fn() } as never,
    stock as never,
    {
      parseDate: (value: string) => new Date(`${value}T00:00:00.000Z`),
    } as never,
    {} as never,
    fulfilment as never,
    {} as never,
  );
  return { service, prisma, stock, fulfilment };
};

const base = { returnedOn: '2026-10-16', receivedBy: 'Store keeper' };

describe('IssuesService.returnMaterial (036 M4, M2)', () => {
  it('accepts the quantity coming back now and credits exactly that', async () => {
    const { service, stock, prisma } = build(
      issue({ returnedQuantity: decimal(3) }),
    );
    await service.returnMaterial(
      caller,
      'iss-1',
      { ...base, returnedNow: 2 },
      'ip',
    );
    expect(stock.appendLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: StockLedgerType.issue_reversal,
        quantity: 2,
      }),
    );
    expect(prisma.tx.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ returnedQuantity: 5 }),
      }),
    );
  });

  it('still accepts the old cumulative total', async () => {
    const { service, stock } = build(issue({ returnedQuantity: decimal(3) }));
    await service.returnMaterial(
      caller,
      'iss-1',
      { ...base, returnedQuantity: 5 },
      'ip',
    );
    expect(stock.appendLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity: 2 }),
    );
  });

  it('refuses both fields when they disagree', async () => {
    const { service } = build(issue({ returnedQuantity: decimal(3) }));
    await expect(
      service.returnMaterial(
        caller,
        'iss-1',
        { ...base, returnedNow: 2, returnedQuantity: 2 },
        'ip',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses returning more than is still out', async () => {
    const { service, stock } = build(issue({ returnedQuantity: decimal(8) }));
    await expect(
      service.returnMaterial(
        caller,
        'iss-1',
        { ...base, returnedNow: 3 },
        'ip',
      ),
    ).rejects.toThrow(/at most 2 more/);
    expect(stock.appendLedgerEntry).not.toHaveBeenCalled();
  });

  it('refuses a request with neither field', async () => {
    const { service } = build(issue());
    await expect(
      service.returnMaterial(caller, 'iss-1', base as never, 'ip'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('row-locks the issue before reading its returned total', async () => {
    const { service, prisma } = build(issue());
    await service.returnMaterial(
      caller,
      'iss-1',
      { ...base, returnedNow: 1 },
      'ip',
    );
    const sql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/"Issue"[\s\S]*FOR UPDATE/);
    expect(prisma.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tx.issue.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('gives the returned quantity back to the indent line it fulfilled', async () => {
    const { service, fulfilment } = build(issue({ indentLineId: 'line-1' }));
    await service.returnMaterial(
      caller,
      'iss-1',
      { ...base, returnedNow: 4 },
      'ip',
    );
    expect(fulfilment.reverseFulfilment).toHaveBeenCalledWith(
      expect.anything(),
      { indentLineId: 'line-1', quantity: 4 },
    );
  });
});
