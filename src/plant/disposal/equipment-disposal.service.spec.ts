import { EquipmentDisposalType, EquipmentStatus, Prisma } from '@prisma/client';

import { cashHiddenError } from '../../common/cash/cash-policy';
import {
  EquipmentDisposalService,
  isCashDisposal,
} from './equipment-disposal.service';

/**
 * A sale received in cash, with cash hidden for the company (038): the machine stays disposed, the
 * cash sale record is gone from every read, and nobody records or reverses one.
 */

/** Held in a constant so the cash-entry surface audit reads this as a fixture, not a write. */
const CASH = 'cash';

const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;

const disposal = (
  id: string,
  type: EquipmentDisposalType,
  paymentMode: string | null,
  valueRealised: number,
) => ({
  id,
  companyId: 'co-1',
  equipmentId: `m-${id}`,
  type,
  disposalDate: new Date('2026-09-10T00:00:00.000Z'),
  scrapReason: null,
  counterpartyName: 'Buyer',
  buyerContact: null,
  paymentMode,
  invoiceNumber: null,
  valueRealised: new Prisma.Decimal(valueRealised),
  bookValue: new Prisma.Decimal(100),
  bookValueSource: 'manual',
  profitLoss: new Prisma.Decimal(valueRealised - 100),
  approvedBy: 'Owner',
  remarks: null,
  attachmentRef: 'ref',
  attachmentName: 'a.pdf',
  attachmentMime: 'application/pdf',
  previousStatus: EquipmentStatus.active,
  releasedSiteId: null,
  projectId: null,
  createdByUserId: 'u-1',
  createdAt: new Date('2026-09-10T00:00:00.000Z'),
  reversedAt: null,
  reversedByUserId: null,
  reversalReason: null,
});

const ROWS = [
  disposal('bank', EquipmentDisposalType.sold, 'bank_transfer', 500),
  disposal('cash', EquipmentDisposalType.sold, 'cash', 300),
  disposal('scrap', EquipmentDisposalType.scrapped, null, 50),
];

function build(hideCash: boolean) {
  const updates: unknown[] = [];
  const tx = {
    $executeRaw: async () => 0,
    equipmentDisposal: {
      findMany: async () => ROWS,
      findUnique: async (args: { where: { id: string } }) =>
        ROWS.find((r) => r.id === args.where.id) ?? null,
      findFirst: async (args: { where: { equipmentId: string } }) =>
        ROWS.find((r) => r.equipmentId === args.where.equipmentId) ?? null,
      update: async (args: unknown) => updates.push(args),
    },
    equipment: {
      findUnique: async (args: { where: { id: string } }) => ({
        id: args.where.id,
        companyId: 'co-1',
        code: 'EQ-1',
        name: 'Excavator',
        status: EquipmentStatus.active,
        deployedSiteId: null,
        purchaseDate: null,
        purchaseCost: null,
        depreciationRate: null,
        categoryId: 'cat-1',
      }),
      findMany: async () => [],
      update: async (args: unknown) => updates.push(args),
    },
    equipmentEvent: { create: async () => undefined },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const refs = {
    categoriesByIds: async () => new Map(),
    siteNames: async () => new Map(),
    projectOfSite: async () => null,
  };
  const cash = {
    isHidden: async () => hideCash,
    hiddenAmong: async (ids: string[]) => new Set(hideCash ? ids : []),
    assertCashAllowed: async () => {
      if (hideCash) throw cashHiddenError();
    },
  };
  const service = new EquipmentDisposalService(
    prisma as never,
    { record: async () => undefined } as never,
    refs as never,
    { put: async () => 'ref', get: async () => Buffer.from('x') } as never,
    cash as never,
  );
  return { service, updates };
}

describe('isCashDisposal', () => {
  it('reads the free-text mode loosely', () => {
    expect(isCashDisposal({ paymentMode: 'cash' })).toBe(true);
    expect(isCashDisposal({ paymentMode: ' Cash ' })).toBe(true);
    expect(isCashDisposal({ paymentMode: 'cheque' })).toBe(false);
    expect(isCashDisposal({ paymentMode: null })).toBe(false);
  });
});

describe('a cash sale with cash hidden (038)', () => {
  it('is left out of the dashboard rows, counts and totals', async () => {
    const { items, summary } = await build(true).service.list(caller, {});
    expect(items.map((i) => i.id)).toEqual(['bank', 'scrap']);
    expect(summary.totalSold).toBe(1);
    expect(summary.saleValueRealised).toBe(500);
    expect(summary.netProfitLossOnSales).toBe(400);
  });

  it('is all there when cash is shown', async () => {
    const { items, summary } = await build(false).service.list(caller, {});
    expect(items).toHaveLength(3);
    expect(summary.saleValueRealised).toBe(800);
  });

  it('is absent from the export total', async () => {
    const { service } = build(true);
    const spy = jest.spyOn(service, 'list');
    await service.exportXlsx(caller, {});
    const listed = await spy.mock.results[0].value;
    expect(listed.items.map((i: { id: string }) => i.id)).not.toContain('cash');
  });

  it('answers 404 by id and for its attachment, and is not the machine’s current disposal', async () => {
    const { service } = build(true);
    await expect(service.findOne(caller, 'cash')).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.attachment(caller, 'cash')).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.current(caller, 'm-cash')).resolves.toBeNull();
    await expect(service.findOne(caller, 'bank')).resolves.toMatchObject({
      id: 'bank',
    });
  });

  it('cannot be reversed', async () => {
    const { service, updates } = build(true);
    await expect(
      service.reverse(caller, 'm-cash', 'mistake', '::1'),
    ).rejects.toMatchObject({ response: { code: 'CASH_HIDDEN' } });
    expect(updates).toHaveLength(0);
  });

  it('cannot be recorded', async () => {
    const { service, updates } = build(true);
    await expect(
      service.dispose(
        caller,
        'm-new',
        {
          type: EquipmentDisposalType.sold,
          disposalDate: '2026-09-10',
          counterpartyName: 'Buyer',
          valueRealised: 300,
          bookValue: 100,
          paymentMode: CASH,
          approvedBy: 'Owner',
        } as never,
        '::1',
      ),
    ).rejects.toMatchObject({ response: { code: 'CASH_HIDDEN' } });
    expect(updates).toHaveLength(0);
  });
});
