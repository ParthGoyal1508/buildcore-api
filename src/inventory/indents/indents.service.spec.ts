import { IndentStatus, Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { IndentsService } from './indents.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

const CEMENT = {
  id: 'item-cement',
  name: 'OPC 53 Cement',
  code: 'DC-ITM-0001',
  unit: 'BAG',
  categoryName: 'CEMENT',
  reorderLevel: 100 as number | null,
  companyId: 'co-1',
  active: true,
};

const refs = {
  itemsByIds: async () => new Map([[CEMENT.id, CEMENT]]),
  siteNames: async () => new Map([['site-1', 'Site A']]),
} as never;

const indentLine = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  indentId: 'indent-1',
  itemId: CEMENT.id,
  approvedQuantity: decimal(500),
  fulfilledQuantity: decimal(0),
  indent: {
    indentNumber: 'DC-IND-0001',
    siteId: 'site-1',
    requiredByDate: new Date('2026-09-20T00:00:00.000Z'),
  },
  ...over,
});

const stockBalance = (inStock: number) => ({
  itemId: CEMENT.id,
  siteId: 'site-1',
  received: decimal(inStock),
  issued: decimal(0),
  transferIn: decimal(0),
  transferOut: decimal(0),
  avgRate: decimal(350),
});

const build = (
  lines: ReturnType<typeof indentLine>[],
  balances: ReturnType<typeof stockBalance>[],
) => {
  const prisma = createPrismaMock({
    materialIndentLine: { findMany: jest.fn().mockResolvedValue(lines) },
    stockBalance: { findMany: jest.fn().mockResolvedValue(balances) },
  });
  return new IndentsService(
    prisma as never,
    { record: jest.fn() } as never,
    refs,
    {} as never,
  );
};

describe('IndentsService.procurementNeeded (FR-027)', () => {
  it('reports indent demand and reorder shortfall as two separate lists', async () => {
    // The same item, at the same site, in both: 500 bags indented and the store is
    // 40 below its reorder level. Summing them would order 540 bags for a site that
    // needs 500. Keeping them apart is the requirement.
    const service = build([indentLine()], [stockBalance(60)]);
    const result = await service.procurementNeeded(caller);

    expect(result.indentDemand).toHaveLength(1);
    expect(result.reorderShortfall).toHaveLength(1);
    expect(result.indentDemand[0].outstandingQuantity).toBe(500);
    expect(result.reorderShortfall[0].shortfall).toBe(40);
    // And there is no combined figure anywhere in the response to be misread as one.
    expect(Object.keys(result).sort()).toEqual([
      'indentDemand',
      'reorderShortfall',
    ]);
  });

  it('reports outstanding demand net of what has already been fulfilled', async () => {
    const service = build(
      [indentLine({ fulfilledQuantity: decimal(200) })],
      [],
    );
    const result = await service.procurementNeeded(caller);
    expect(result.indentDemand[0].outstandingQuantity).toBe(300);
  });

  it('drops a line whose demand has been met in full', async () => {
    const service = build(
      [indentLine({ fulfilledQuantity: decimal(500) })],
      [],
    );
    const result = await service.procurementNeeded(caller);
    expect(result.indentDemand).toHaveLength(0);
  });

  it('leaves an item at or above its reorder level out of the shortfall list', async () => {
    const service = build([], [stockBalance(100)]);
    const result = await service.procurementNeeded(caller);
    expect(result.reorderShortfall).toHaveLength(0);
  });

  it('never lists an item that has no reorder level at all', async () => {
    const noFloor = { ...CEMENT, reorderLevel: null };
    const prisma = createPrismaMock({
      materialIndentLine: { findMany: jest.fn().mockResolvedValue([]) },
      stockBalance: {
        findMany: jest.fn().mockResolvedValue([stockBalance(0)]),
      },
    });
    const service = new IndentsService(
      prisma as never,
      { record: jest.fn() } as never,
      {
        itemsByIds: async () => new Map([[noFloor.id, noFloor]]),
        siteNames: async () => new Map([['site-1', 'Site A']]),
      } as never,
      {} as never,
    );
    const result = await service.procurementNeeded(caller);
    expect(result.reorderShortfall).toHaveLength(0);
  });

  it('only counts demand from approved indents', async () => {
    const service = build([indentLine()], []);
    await service.procurementNeeded(caller);
    const where = (
      service as unknown as {
        prisma: { tx: { materialIndentLine: { findMany: jest.Mock } } };
      }
    ).prisma.tx.materialIndentLine.findMany.mock.calls[0][0].where;

    expect(where.procurementPending).toBe(true);
    expect(where.indent.status.in).toEqual([
      IndentStatus.approved,
      IndentStatus.partially_fulfilled,
    ]);
    expect(where.indent.deleted).toBe(false);
  });
});
