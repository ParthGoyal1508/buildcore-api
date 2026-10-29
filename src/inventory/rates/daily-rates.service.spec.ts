import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DailyRatesService, pickEffective } from './daily-rates.service';

const row = (vendorId: string | null, rate: number, date: string) => ({
  vendorId,
  rate: new Prisma.Decimal(rate),
  effectiveFrom: new Date(`${date}T00:00:00Z`),
});

describe('pickEffective (050)', () => {
  it('offers nothing when no rate was ever set', () => {
    expect(pickEffective(undefined, undefined)).toBeNull();
  });

  it('offers the market rate to a vendor with no override', () => {
    expect(pickEffective(row(null, 92.4, '2026-10-28'), undefined)).toEqual({
      rate: 92.4,
      effectiveFrom: '2026-10-28',
      source: 'market',
    });
  });

  it("offers a vendor's override while it is newer than the market rate", () => {
    expect(
      pickEffective(
        row(null, 92.4, '2026-10-27'),
        row('v1', 91.8, '2026-10-28'),
      ),
    ).toMatchObject({ rate: 91.8, source: 'vendor' });
  });

  it('a market update after the override moves that vendor too — one edit per item', () => {
    expect(
      pickEffective(row(null, 93, '2026-10-29'), row('v1', 91.8, '2026-10-28')),
    ).toMatchObject({
      rate: 93,
      source: 'market',
      effectiveFrom: '2026-10-29',
    });
  });

  it('an override set the same day as the market rate wins', () => {
    expect(
      pickEffective(row(null, 93, '2026-10-29'), row('v1', 92.5, '2026-10-29')),
    ).toMatchObject({ rate: 92.5, source: 'vendor' });
  });
});

describe('DailyRatesService.set (050)', () => {
  const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;
  const make = (items: { id: string }[] = [{ id: 'diesel' }]) => {
    const refs = {
      targetCompanyOf: () => 'c1',
      parseDate: (v: string) => new Date(`${v.slice(0, 10)}T00:00:00Z`),
      requireVendorName: jest.fn().mockResolvedValue('Pump'),
    };
    const service = new DailyRatesService(
      { $transaction: jest.fn() } as never,
      { dailyRateItems: jest.fn().mockResolvedValue(items) } as never,
      refs as never,
      { record: jest.fn() } as never,
      { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
    );
    return { service, refs };
  };

  it('refuses a future date', async () => {
    const { service } = make();
    await expect(
      service.set(
        caller,
        { date: '2999-01-01', rates: [{ itemId: 'diesel', rate: 90 }] },
        '::1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an item that is not a daily-rate item', async () => {
    const { service } = make();
    await expect(
      service.set(
        caller,
        { date: '2026-10-01', rates: [{ itemId: 'sand', rate: 90 }] },
        '::1',
      ),
    ).rejects.toThrow('not a daily-rate item');
  });
});
