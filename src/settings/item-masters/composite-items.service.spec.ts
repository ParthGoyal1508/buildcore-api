import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { callerFor, createPrismaMock } from '../testing/prisma-mock';
import { CompositeItemsService } from './composite-items.service';

const caller = callerFor('co-1');

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  code: id.toUpperCase(),
  unit: 'MT',
  companyId: 'co-1',
  active: true,
  ...over,
});

const build = (items: ReturnType<typeof item>[], clash = false) => {
  const create = jest.fn(async ({ data }: { data: Record<string, any> }) => ({
    id: 'cmp-1',
    companyId: data.companyId,
    name: data.name,
    unit: data.unit,
    description: data.description,
    active: true,
    createdAt: new Date(),
    components: data.components.create,
  }));
  const prisma = createPrismaMock({
    item: { findMany: jest.fn().mockResolvedValue(items) },
    compositeItem: {
      findFirst: jest.fn().mockResolvedValue(clash ? { id: 'other' } : null),
      create,
    },
  });
  const audit = { record: jest.fn() };
  const service = new CompositeItemsService(prisma as never, audit as never);
  return { service, create, audit };
};

const dto = {
  name: 'M20 Concrete for plant foundation',
  unit: 'CUM' as const,
  components: [
    { itemId: 'cement', qtyPerUnit: 0.18 },
    { itemId: 'msand', qtyPerUnit: 0.827 },
  ],
};

describe('CompositeItemsService.create (039)', () => {
  it('stores the recipe in order, as decimals, and audits it', async () => {
    const { service, create, audit } = build([item('cement'), item('msand')]);
    const view = await service.create(caller, dto, 'ip');

    const rows = create.mock.calls[0][0].data.components.create;
    expect(rows.map((r: { position: number }) => r.position)).toEqual([0, 1]);
    expect(rows[1].qtyPerUnit).toEqual(new Prisma.Decimal('0.827'));
    expect(view.components.map((c) => [c.itemName, c.qtyPerUnit])).toEqual([
      ['cement', 0.18],
      ['msand', 0.827],
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'COMPOSITE_ITEM',
        action: 'CREATE',
      }),
    );
  });

  it('refuses the same sub-item twice', async () => {
    const { service } = build([item('cement')]);
    await expect(
      service.create(
        caller,
        {
          ...dto,
          components: [
            { itemId: 'cement', qtyPerUnit: 0.1 },
            { itemId: 'cement', qtyPerUnit: 0.08 },
          ],
        },
        'ip',
      ),
    ).rejects.toThrow(/only once/);
  });

  it('refuses a retired item and another company’s item', async () => {
    const retired = build([item('cement', { active: false }), item('msand')]);
    await expect(retired.service.create(caller, dto, 'ip')).rejects.toThrow(
      /retired/,
    );
    const foreign = build([
      item('cement', { companyId: 'co-2' }),
      item('msand'),
    ]);
    await expect(
      foreign.service.create(caller, dto, 'ip'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an empty recipe and a duplicate name', async () => {
    const { service } = build([]);
    await expect(
      service.create(caller, { ...dto, components: [] }, 'ip'),
    ).rejects.toThrow(/at least one/);
    const clash = build([item('cement'), item('msand')], true);
    await expect(
      clash.service.create(caller, dto, 'ip'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
