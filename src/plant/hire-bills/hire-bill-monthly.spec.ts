import { MeterType } from '@prisma/client';

import {
  computeHireBillAmounts,
  expectedDiesel,
  monthlyGross,
} from './hire-bills.service';

/** The vehicle hiring bill's monthly basis (2026-10-15). */
describe('monthly hire bill arithmetic', () => {
  it('charges the full rent for a whole month', () => {
    expect(monthlyGross(150000, 31, new Date('2026-08-01'))).toBe(150000);
  });

  it('pro-rates by the days of the period’s own month', () => {
    expect(monthlyGross(150000, 15, new Date('2026-08-01'))).toBe(72580.65);
    expect(monthlyGross(140000, 14, new Date('2026-02-01'))).toBe(70000);
  });

  it('takes the deduction and the hold off the given gross, after TDS', () => {
    expect(
      computeHireBillAmounts({
        billedHours: 6879,
        rate: 150000,
        tdsRate: 2,
        grossAmount: 150000,
        otherDeductions: [42082, 5000],
      }),
    ).toMatchObject({
      grossAmount: 150000,
      tdsAmount: 3000,
      deductionTotal: 47082,
      netPayable: 99918,
    });
  });

  it('works the diesel the run should have taken from the agreed average', () => {
    expect(expectedDiesel(MeterType.hours, 89.1, 4)).toBe(356.4);
    expect(expectedDiesel(MeterType.km, 6872, 16.2)).toBe(424.198);
    expect(expectedDiesel(MeterType.km, 6872, null)).toBeNull();
  });
});
