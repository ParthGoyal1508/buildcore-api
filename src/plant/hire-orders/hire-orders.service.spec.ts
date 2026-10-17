import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { HireOrdersService } from './hire-orders.service';

describe('HireOrdersService.findAll paging (036 K17)', () => {
  const build = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(260);
    const prisma = createPrismaMock({ hireOrder: { findMany, count } });
    const service = new HireOrdersService(
      prisma as never,
      { vendorNames: jest.fn().mockResolvedValue(new Map()) } as never,
      {} as never,
    );
    return { service, findMany, count };
  };
  const caller = callerFor('co-1');

  it('returns a page with its total when a page is asked for', async () => {
    const { service, findMany } = build();
    const result = await service.findAll(caller, { page: 3, pageSize: 50 });
    expect(result).toEqual({ items: [], total: 260, page: 3, pageSize: 50 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 50 });
  });

  it('keeps the old bare array without paging parameters', async () => {
    const { service, findMany, count } = build();
    const result = await service.findAll(caller, {});
    expect(Array.isArray(result)).toBe(true);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 200 });
    expect(count).not.toHaveBeenCalled();
  });

  it('caps the page size', async () => {
    const { service, findMany } = build();
    await service.findAll(caller, { page: 1, pageSize: 5000 });
    expect(findMany.mock.calls[0][0].take).toBe(200);
  });
});
