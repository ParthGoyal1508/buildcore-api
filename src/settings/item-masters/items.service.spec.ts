import { callerFor, createPrismaMock } from '../testing/prisma-mock';
import { ItemsService } from './items.service';

describe('ItemsService.getItemIdsMatching (036 M5)', () => {
  it('selects ids only, unpaginated, with the same filter findAll uses', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: 250 }, (_, i) => ({ id: `item-${i}` })),
      );
    const prisma = createPrismaMock({ item: { findMany } });
    const service = new ItemsService(
      prisma as never,
      { record: jest.fn() } as never,
      {} as never,
    );

    const ids = await service.getItemIdsMatching(callerFor('co-1'), {
      categoryId: 'cat-1',
      search: 'cem',
    });

    expect(ids).toHaveLength(250);
    const args = findMany.mock.calls[0][0];
    expect(args.select).toEqual({ id: true });
    expect(args.take).toBeUndefined();
    expect(args.where).toMatchObject({
      companyId: 'co-1',
      categoryId: 'cat-1',
    });
    expect(args.where.OR).toHaveLength(3);
  });
});
