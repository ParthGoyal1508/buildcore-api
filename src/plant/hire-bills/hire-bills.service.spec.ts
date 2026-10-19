import { HireBillStatus, MeterType } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { computeHireBillAmounts, HireBillsService } from './hire-bills.service';

/** SC-003: `netPayable` equals `grossAmount − tdsAmount` in every case. */
describe('computeHireBillAmounts (FR-005, SC-003)', () => {
  it('computes gross, TDS and net from hours, rate and the vendor TDS rate', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 160,
      rate: 1250,
      tdsRate: 2,
    });
    expect(amounts.grossAmount).toBe(200000);
    expect(amounts.tdsAmount).toBe(4000);
    expect(amounts.netPayable).toBe(196000);
  });

  it('leaves net equal to gross when the vendor has no TDS rate on file', () => {
    // Null is "no deduction declared", not "zero percent by policy" — but the
    // arithmetic result is the same, and it must not become NaN.
    const amounts = computeHireBillAmounts({
      billedHours: 100,
      rate: 900,
      tdsRate: null,
    });
    expect(amounts.tdsAmount).toBe(0);
    expect(amounts.netPayable).toBe(amounts.grossAmount);
  });

  it('keeps net = gross − tds exactly, with a rate that does not divide evenly', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 37.5,
      rate: 1333.33,
      tdsRate: 1.5,
    });
    // The invariant, not the literal: this is the property SC-003 states, and it is
    // what a paisa-level rounding slip would break.
    expect(amounts.netPayable).toBe(
      Math.round((amounts.grossAmount - amounts.tdsAmount) * 100) / 100,
    );
  });

  it('rounds to paise rather than carrying float noise into the ledger', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 3,
      rate: 0.1,
      tdsRate: null,
    });
    // 3 × 0.1 is 0.30000000000000004 in binary floating point. Stored unrounded it
    // would make a bill a fraction of a paisa out from its own components.
    expect(amounts.grossAmount).toBe(0.3);
  });

  it('deducts nothing at a zero TDS rate', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 10,
      rate: 100,
      tdsRate: 0,
    });
    expect(amounts.tdsAmount).toBe(0);
    expect(amounts.netPayable).toBe(1000);
  });
});

describe('HireBillsService — overlap, readings, net and maker-checker (036 K3, K8)', () => {
  const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;
  const build = (opts: { overlap?: unknown; bill?: unknown } = {}) => {
    const prisma = createPrismaMock({
      equipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'eq-1',
          code: 'JCB-01',
          companyId: 'co-1',
          categoryId: 'cat-1',
          ownership: 'hired',
          meterType: MeterType.hours,
        }),
      },
      hireBill: {
        findFirst: jest.fn().mockResolvedValue(opts.overlap ?? null),
        findUnique: jest.fn().mockResolvedValue(opts.bill ?? null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      logbookEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalHours: 100 } }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      fuelEntry: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { quantity: 0, amount: 0 } }),
      },
      equipmentCategory: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const refs = {
      parseDate: (value: string) =>
        new Date(`${value.slice(0, 10)}T00:00:00.000Z`),
      requireVendorName: jest.fn().mockResolvedValue('Hirer'),
      vendorTds: jest.fn().mockResolvedValue({ tdsRate: null }),
    };
    const service = new HireBillsService(
      prisma as never,
      { record: jest.fn() } as never,
      refs as never,
      { getEffectiveHireRate: jest.fn() } as never,
    );
    return { service, prisma };
  };
  const dto = {
    equipmentId: 'eq-1',
    vendorId: 'v-1',
    billingPeriodFrom: '2026-09-01',
    billingPeriodTo: '2026-09-30',
    billedHours: 100,
    rate: 1000,
  };

  it('refuses a bill overlapping an existing one for the machine (K3)', async () => {
    const { service, prisma } = build({
      overlap: {
        invoiceNo: 'INV-1',
        billingPeriodFrom: new Date('2026-09-15T00:00:00.000Z'),
        billingPeriodTo: new Date('2026-10-14T00:00:00.000Z'),
      },
    });
    await expect(service.create(caller, dto, 'ip')).rejects.toThrow(
      /already has a hire bill \(INV-1\) for 2026-09-15 to 2026-10-14/,
    );
    expect(prisma.tx.hireBill.create).not.toHaveBeenCalled();
    // Locked before the check, so two at once cannot both pass it.
    const sql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/"Equipment"[\s\S]*FOR UPDATE/);
  });

  it('refuses an end reading below the start reading (K8)', async () => {
    const { service } = build();
    await expect(
      service.create(
        caller,
        { ...dto, startReading: 500, endReading: 400 },
        'ip',
      ),
    ).rejects.toThrow(/end reading \(400\) is below the start reading/);
  });

  it('refuses a negative net payable (K8)', async () => {
    const { service, prisma } = build();
    await expect(
      service.create(caller, { ...dto, deductionAmount: 200000 }, 'ip'),
    ).rejects.toThrow(/deductions exceed the bill/);
    expect(prisma.tx.hireBill.create).not.toHaveBeenCalled();
  });

  it('records who raised the bill (K8)', async () => {
    const { service, prisma } = build();
    await service.create(caller, dto, 'ip').catch(() => undefined);
    expect(prisma.tx.hireBill.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdByUserId: 'u-1' }),
      }),
    );
  });

  const pending = (createdByUserId: string | null) => ({
    id: 'hb-1',
    companyId: 'co-1',
    status: HireBillStatus.pending_verification,
    createdByUserId,
  });

  it('refuses verification by the person who raised the bill (K8)', async () => {
    const { service, prisma } = build({ bill: pending('u-1') });
    await expect(service.verify(caller, 'hb-1', 'ip')).rejects.toThrow(
      /someone else must verify/,
    );
    expect(prisma.tx.hireBill.update).not.toHaveBeenCalled();
  });

  it('lets someone else verify it, and anyone verify a bill of unknown creator', async () => {
    for (const creator of ['u-2', null]) {
      const { service, prisma } = build({ bill: pending(creator) });
      await service.verify(caller, 'hb-1', 'ip').catch(() => undefined);
      expect(prisma.tx.hireBill.update).toHaveBeenCalled();
    }
  });

  it('stamps today when paid without a payment date (K8)', async () => {
    const { service, prisma } = build({
      bill: { ...pending('u-2'), status: HireBillStatus.verified },
    });
    await service
      .pay(caller, 'hb-1', { paymentReference: 'NEFT-1' }, 'ip')
      .catch(() => undefined);
    const data = prisma.tx.hireBill.update.mock.calls[0][0].data;
    expect(data.paymentDate).toBeInstanceOf(Date);
    expect(data.paymentDate.toISOString()).toMatch(/T00:00:00.000Z$/);
  });
});
