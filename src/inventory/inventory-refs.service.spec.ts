import { BadRequestException } from '@nestjs/common';

import { callerFor } from '../settings/testing/prisma-mock';
import { InventoryRefsService } from './inventory-refs.service';

const caller = callerFor('co-1');

const build = (vendor: Record<string, unknown> | null) => {
  const partners = { getVendorById: jest.fn().mockResolvedValue(vendor) };
  const items = { getItemIdsMatching: jest.fn() };
  const service = new InventoryRefsService(
    items as never,
    {} as never,
    partners as never,
    {} as never,
  );
  return { service, items };
};

const vendor = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  name: 'Acme Cement',
  code: 'AC',
  type: 'material',
  active: true,
  companyId: 'co-1',
  ...over,
});

describe('InventoryRefsService.requireActiveVendor (036 M6)', () => {
  it('returns the name of an active vendor of the company', async () => {
    const { service } = build(vendor());
    await expect(
      service.requireActiveVendor(caller, 'v-1', 'co-1'),
    ).resolves.toBe('Acme Cement');
  });

  it("refuses another company's vendor, even one the caller can see", async () => {
    const { service } = build(vendor({ companyId: 'co-2' }));
    await expect(
      service.requireActiveVendor(caller, 'v-1', 'co-1'),
    ).rejects.toThrow(/does not exist in this company/);
  });

  it('refuses an inactive vendor', async () => {
    const { service } = build(vendor({ active: false }));
    await expect(
      service.requireActiveVendor(caller, 'v-1', 'co-1'),
    ).rejects.toThrow(/inactive/);
  });

  it('refuses an unknown vendor', async () => {
    const { service } = build(null);
    await expect(
      service.requireActiveVendor(caller, 'v-1', 'co-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InventoryRefsService.itemIdsMatching (036 M5)', () => {
  it('asks the item master for ids only, with no page size to truncate at', async () => {
    const { service, items } = build(null);
    const ids = Array.from({ length: 250 }, (_, i) => `item-${i}`);
    items.getItemIdsMatching.mockResolvedValue(ids);
    await expect(
      service.itemIdsMatching(caller, { categoryId: 'cat-1' }),
    ).resolves.toHaveLength(250);
    expect(items.getItemIdsMatching).toHaveBeenCalledWith(caller, {
      search: undefined,
      categoryId: 'cat-1',
      companyId: undefined,
    });
  });
});
