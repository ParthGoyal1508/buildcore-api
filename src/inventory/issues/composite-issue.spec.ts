import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { compositeLines } from './composite-lines';
import { IssuesService } from './issues.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

/** The client's "DLC Concrete for plant foundation", per 1 CUM. */
const DLC = {
  id: 'cmp-dlc',
  companyId: 'co-1',
  name: 'DLC Concrete for plant foundation',
  unit: 'CUM',
  description: null,
  active: true,
  createdAt: new Date(),
  components: [
    ['item-cement', 'Cement', 0.08],
    ['item-dust', 'Crusher Dust', 0.827],
    ['item-agg20', 'Aggregate 20 mm', 0.75],
    ['item-agg10', 'Aggregate 10 mm', 0.525],
    ['item-flyash', 'Fly Ash', 0.1],
  ].map(([itemId, itemName, qtyPerUnit], position) => ({
    itemId: itemId as string,
    itemName: itemName as string,
    itemCode: '',
    itemUnit: 'MT',
    qtyPerUnit: qtyPerUnit as number,
    position,
  })),
};

describe('compositeLines (039)', () => {
  it('multiplies in decimal and rounds each line half-up to 3 places', () => {
    const lines = compositeLines(DLC, 10);
    const byName = Object.fromEntries(
      lines.map((l) => [l.itemName, l.quantity.toString()]),
    );
    expect(byName).toEqual({
      Cement: '0.8',
      'Crusher Dust': '8.27',
      'Aggregate 20 mm': '7.5',
      'Aggregate 10 mm': '5.25',
      'Fly Ash': '1',
    });
    // 0.0005 × 1 rounds up; 1.0005 would drift as a float product.
    const half = compositeLines(
      { components: [{ ...DLC.components[0], qtyPerUnit: 0.0005 }] },
      1,
    );
    expect(half[0].quantity.toString()).toBe('0.001');
    const tricky = compositeLines(
      { components: [{ ...DLC.components[0], qtyPerUnit: 0.000667 }] },
      1.5,
    );
    // 1.5 × 0.000667 = 0.0010005 → 0.001
    expect(tricky[0].quantity.toString()).toBe('0.001');
  });

  it('orders the lines by item id, the order balances are locked in', () => {
    const ids = compositeLines(DLC, 1).map((l) => l.itemId);
    expect(ids).toEqual([...ids].sort());
  });
});

const build = (available: Record<string, number>) => {
  const created: Record<string, unknown>[] = [];
  const prisma = createPrismaMock({
    issue: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: `iss-${created.length + 1}`,
          createdAt: new Date(),
        };
        created.push(row);
        return row;
      }),
    },
    stockBalance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  });
  const locked: string[] = [];
  const stock = {
    lockAvailable: jest.fn(async (_tx: unknown, p: { itemId: string }) => {
      locked.push(p.itemId);
      return available[p.itemId] ?? 0;
    }),
    appendLedgerEntry: jest.fn(),
  };
  const refs = {
    targetCompanyOf: () => 'co-1',
    requireActiveCompositeItem: jest.fn().mockResolvedValue(DLC),
    requireSiteName: jest.fn().mockResolvedValue('Tonk Store'),
    projectOfSite: jest.fn().mockResolvedValue(null),
    parseDate: (value: string) => new Date(`${value}T00:00:00.000Z`),
  };
  const codeSeries = { next: jest.fn().mockResolvedValue('PRPL-MIS-0007') };
  const audit = { record: jest.fn() };
  const service = new IssuesService(
    prisma as never,
    audit as never,
    stock as never,
    refs as never,
    {} as never,
    { applyFulfilment: jest.fn() } as never,
    codeSeries as never,
  );
  return { service, prisma, stock, created, locked, codeSeries, audit };
};

const plenty = {
  'item-cement': 100,
  'item-dust': 100,
  'item-agg20': 100,
  'item-agg10': 100,
  'item-flyash': 100,
};

const dto = {
  siteId: 'site-1',
  compositeItemId: 'cmp-dlc',
  date: '2026-10-20',
  quantity: 10,
  issuedTo: 'Ramesh (batching plant)',
};

describe('IssuesService composite issue (039)', () => {
  it('issues each sub-item under one slip and one group, with ledger and balance', async () => {
    const { service, created, stock, prisma, codeSeries } = build(plenty);
    const result = await service.create(caller, dto, 'ip');

    expect(created).toHaveLength(5);
    expect(codeSeries.next).toHaveBeenCalledTimes(1);
    const groups = new Set(created.map((r) => r.issueGroupId));
    expect(groups.size).toBe(1);
    expect(created.every((r) => r.slipNo === 'PRPL-MIS-0007')).toBe(true);
    expect(created.every((r) => r.compositeItemId === 'cmp-dlc')).toBe(true);
    expect(created.every((r) => r.compositeQuantity === 10)).toBe(true);
    const dust = created.find((r) => r.itemId === 'item-dust');
    expect((dust?.quantity as Prisma.Decimal).toString()).toBe('8.27');

    expect(stock.appendLedgerEntry).toHaveBeenCalledTimes(5);
    expect(stock.appendLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        itemId: 'item-dust',
        type: StockLedgerType.issue,
        quantity: 8.27,
      }),
    );
    expect(prisma.tx.stockBalance.updateMany).toHaveBeenCalledTimes(5);
    expect('issues' in result && result.issues).toHaveLength(5);
  });

  it('locks every balance in item-id order before writing anything', async () => {
    const { service, locked, prisma, stock } = build(plenty);
    await service.create(caller, dto, 'ip');
    expect(locked).toEqual([...locked].sort());
    const lastLock = Math.max(...stock.lockAvailable.mock.invocationCallOrder);
    expect(lastLock).toBeLessThan(
      prisma.tx.issue.create.mock.invocationCallOrder[0],
    );
  });

  it('refuses with 422 listing every short sub-item, and writes nothing', async () => {
    const { service, created, codeSeries } = build({
      ...plenty,
      'item-cement': 0.5,
      'item-dust': 8,
    });
    const error = await service
      .create(caller, dto, 'ip')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const body = (error as UnprocessableEntityException).getResponse() as {
      shortfalls: unknown[];
    };
    expect(body.shortfalls).toEqual([
      {
        itemId: 'item-cement',
        itemName: 'Cement',
        unit: 'MT',
        required: 0.8,
        available: 0.5,
      },
      {
        itemId: 'item-dust',
        itemName: 'Crusher Dust',
        unit: 'MT',
        required: 8.27,
        available: 8,
      },
    ]);
    expect(created).toHaveLength(0);
    expect(codeSeries.next).not.toHaveBeenCalled();
  });

  it('takes exactly what is there despite float noise in the balance', async () => {
    const { service, created } = build({
      ...plenty,
      'item-dust': 8.270000000000001,
      'item-cement': 0.7999999999999999,
    });
    await service.create(caller, dto, 'ip');
    expect(created).toHaveLength(5);
  });

  it('refuses a quantity whose sub-item rounds to nothing', async () => {
    const { service, created } = build(plenty);
    await expect(
      service.create(caller, { ...dto, quantity: 0.001 }, 'ip'),
    ).rejects.toThrow(/less than 0.001 of Cement/);
    expect(created).toHaveLength(0);
  });

  it('refuses an indent line, and an item together with a composite', async () => {
    const { service } = build(plenty);
    await expect(
      service.create(caller, { ...dto, indentLineId: 'line-1' }, 'ip'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(caller, { ...dto, itemId: 'item-cement' }, 'ip'),
    ).rejects.toThrow(/not both/);
  });
});

describe('IssuesService.remove of a composite issue (039)', () => {
  const row = (id: string, itemId: string, over = {}) => ({
    id,
    companyId: 'co-1',
    itemId,
    siteId: 'site-1',
    date: new Date('2026-10-20'),
    quantity: decimal(2),
    returnedQuantity: null as Prisma.Decimal | null,
    indentLineId: null,
    issueGroupId: 'grp-1',
    deleted: false,
    ...over,
  });

  it('reverses every row of the group in one transaction, less what came back', async () => {
    const rows = [
      row('iss-1', 'item-a'),
      row('iss-2', 'item-b', { returnedQuantity: decimal(0.5) }),
    ];
    const prisma = createPrismaMock({
      issue: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          rows.find((r) => r.id === where.id),
        ),
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(),
      },
      stockBalance: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bal',
          issued: decimal(10),
        }),
        update: jest.fn(),
      },
    });
    const stock = { appendLedgerEntry: jest.fn() };
    const audit = { record: jest.fn() };
    const service = new IssuesService(
      prisma as never,
      audit as never,
      stock as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.remove(caller, 'iss-2', 'ip');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(
      /"issueGroupId" = \?[\s\S]*ORDER BY "id"[\s\S]*FOR UPDATE/,
    );
    expect(prisma.tx.issue.update).toHaveBeenCalledTimes(2);
    expect(stock.appendLedgerEntry.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({
        itemId: 'item-a',
        type: StockLedgerType.issue_reversal,
        quantity: 2,
      }),
      expect.objectContaining({ itemId: 'item-b', quantity: 1.5 }),
    ]);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});
