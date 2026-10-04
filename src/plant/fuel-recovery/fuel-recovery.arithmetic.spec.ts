import { computeHireBillAmounts } from '../hire-bills/hire-bills.service';
import { computeFuelShortfall } from '../fuel/fuel.service';

/**
 * 020 FR-004 (T056) and FR-001 — the two pieces of arithmetic that decide how much money moves.
 *
 * Tested without a database because both are pure, and because an arithmetic error here is not a bug
 * somebody notices: it is a vendor underpaid or an operator overcharged by an amount that looks
 * plausible.
 */
describe('hire bill net payable with fuel deductions', () => {
  const bill = { billedHours: 100, rate: 500, tdsRate: 2 } as const;
  // 100 × 500 = 50,000 gross; 2% TDS = 1,000.

  it('is gross less TDS when there are no deductions', () => {
    expect(computeHireBillAmounts({ ...bill, deductions: [] })).toMatchObject({
      grossAmount: 50000,
      tdsAmount: 1000,
      deductionTotal: 0,
      netPayable: 49000,
    });
  });

  it('subtracts one deduction', () => {
    expect(
      computeHireBillAmounts({ ...bill, deductions: [1250.5] }),
    ).toMatchObject({ deductionTotal: 1250.5, netPayable: 47749.5 });
  });

  it('subtracts two deductions', () => {
    expect(
      computeHireBillAmounts({ ...bill, deductions: [1250.5, 300.25] }),
    ).toMatchObject({ deductionTotal: 1550.75, netPayable: 47449.25 });
  });

  it('is unchanged when the deductions argument is omitted', () => {
    // Every existing caller omits it. If the default were anything but "no deductions" this change
    // would have silently altered every bill in the system.
    expect(computeHireBillAmounts(bill).netPayable).toBe(49000);
  });

  it('recomputes rather than accumulating, so removing a deduction restores the net', () => {
    // FR-010's reversal is "delete the row and recompute". This asserts the property that makes that
    // safe: the net is a function of the current deduction set, with no memory of a previous one.
    const withTwo = computeHireBillAmounts({
      ...bill,
      deductions: [1000, 2000],
    });
    const withOne = computeHireBillAmounts({ ...bill, deductions: [1000] });
    expect(withTwo.netPayable).toBe(46000);
    expect(withOne.netPayable).toBe(48000);
  });
});

describe('computeFuelShortfall', () => {
  it('measures the excess against what the benchmark allowed for the hours run', () => {
    // 4 hours at 2 l/hr allows 8 litres; 11 burned is a 3 litre excess, not 11 litres of fault.
    expect(
      computeFuelShortfall({
        fuelConsumed: 11,
        totalHours: 4,
        benchmark: 2,
        rate: 95,
      }),
    ).toEqual({ shortfallQuantity: 3, shortfallAmount: 285 });
  });

  it('is zero for consumption at or under benchmark', () => {
    // A benchmark edited since the reading was flagged can put a confirmed exception here. A negative
    // recovery would be money paid *to* somebody for using less fuel than expected.
    expect(
      computeFuelShortfall({
        fuelConsumed: 8,
        totalHours: 4,
        benchmark: 2,
        rate: 95,
      }),
    ).toEqual({ shortfallQuantity: 0, shortfallAmount: 0 });
    expect(
      computeFuelShortfall({
        fuelConsumed: 5,
        totalHours: 4,
        benchmark: 2,
        rate: 95,
      }).shortfallAmount,
    ).toBe(0);
  });

  it('is zero with no benchmark, no hours or no reading', () => {
    const rate = 95;
    expect(
      computeFuelShortfall({
        fuelConsumed: 11,
        totalHours: 4,
        benchmark: null,
        rate,
      }).shortfallAmount,
    ).toBe(0);
    expect(
      computeFuelShortfall({
        fuelConsumed: 11,
        totalHours: 0,
        benchmark: 2,
        rate,
      }).shortfallAmount,
    ).toBe(0);
    expect(
      computeFuelShortfall({
        fuelConsumed: null,
        totalHours: 4,
        benchmark: 2,
        rate,
      }).shortfallAmount,
    ).toBe(0);
  });

  it('does not derive the money from the rounded variance percentage', () => {
    // `variancePercent` is stored rounded to two decimals. Deriving money from it would make a payslip
    // figure that cannot be reproduced from the readings behind it — which is the first thing anybody
    // disputing it would try to do.
    const result = computeFuelShortfall({
      fuelConsumed: 10.333,
      totalHours: 3,
      benchmark: 2,
      rate: 101.75,
    });
    // 10.333 − 6 = 4.333 litres exactly, × 101.75 = 440.88 (to paise).
    expect(result.shortfallQuantity).toBe(4.333);
    expect(result.shortfallAmount).toBe(440.88);
  });
});
