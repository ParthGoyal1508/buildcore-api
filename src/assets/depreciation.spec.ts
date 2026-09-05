import {
  accumulatedDepreciation,
  bookValue,
  depreciationForDays,
  monthlyDepreciation,
  monthsElapsed,
} from './depreciation';

/** A 120,000 asset at 20% p.a. depreciates 2,000 a month — round numbers chosen so
 * an assertion failure points at the logic rather than at floating point. */
const asset = {
  purchaseCost: 120_000,
  depreciationRatePercent: 20,
  salvageValue: 0,
  capitalisationDate: new Date(Date.UTC(2026, 0, 15)),
};

describe('monthlyDepreciation', () => {
  it('is cost × rate / 100 / 12', () => {
    expect(monthlyDepreciation(120_000, 20)).toBe(2_000);
  });

  it('is zero for a free or non-depreciating asset', () => {
    expect(monthlyDepreciation(0, 20)).toBe(0);
    expect(monthlyDepreciation(120_000, 0)).toBe(0);
  });
});

describe('monthsElapsed', () => {
  it('counts only whole months', () => {
    const from = new Date(Date.UTC(2026, 0, 15));
    expect(monthsElapsed(from, new Date(Date.UTC(2026, 1, 14)))).toBe(0);
    expect(monthsElapsed(from, new Date(Date.UTC(2026, 1, 15)))).toBe(1);
    expect(monthsElapsed(from, new Date(Date.UTC(2026, 6, 20)))).toBe(6);
  });

  it('is zero before capitalisation, never negative (FR-019)', () => {
    expect(
      monthsElapsed(
        new Date(Date.UTC(2026, 5, 1)),
        new Date(Date.UTC(2026, 0, 1)),
      ),
    ).toBe(0);
  });
});

describe('accumulatedDepreciation', () => {
  it('accrues per whole month from the capitalisation date', () => {
    expect(
      accumulatedDepreciation(asset, new Date(Date.UTC(2026, 6, 15))),
    ).toBe(12_000);
  });

  it('is zero for a date before capitalisation (spec Edge Cases)', () => {
    expect(
      accumulatedDepreciation(asset, new Date(Date.UTC(2025, 11, 31))),
    ).toBe(0);
  });

  it('never exceeds cost less salvage (SC-008)', () => {
    const withSalvage = { ...asset, salvageValue: 20_000 };
    // Ten years in, straight-line would have written off far more than the asset
    // is allowed to lose.
    expect(
      accumulatedDepreciation(withSalvage, new Date(Date.UTC(2036, 0, 15))),
    ).toBe(100_000);
  });
});

describe('bookValue', () => {
  it('is cost less accumulated depreciation', () => {
    expect(bookValue(asset, new Date(Date.UTC(2026, 6, 15)))).toBe(108_000);
  });

  it('is the salvage floor once fully depreciated, never below zero', () => {
    const withSalvage = { ...asset, salvageValue: 20_000 };
    expect(bookValue(withSalvage, new Date(Date.UTC(2036, 0, 15)))).toBe(
      20_000,
    );
    expect(bookValue(asset, new Date(Date.UTC(2036, 0, 15)))).toBe(0);
  });
});

describe('depreciationForDays', () => {
  it('pro-rates a part month by its own length', () => {
    // 15 of January's 31 days, at 2,000 for the month.
    expect(
      depreciationForDays(
        asset,
        new Date(Date.UTC(2026, 0, 15)),
        new Date(Date.UTC(2026, 0, 29)),
      ),
    ).toBeCloseTo((2_000 * 15) / 31, 2);
  });

  it('contributes nothing for days before capitalisation', () => {
    expect(
      depreciationForDays(
        asset,
        new Date(Date.UTC(2025, 0, 1)),
        new Date(Date.UTC(2025, 11, 31)),
      ),
    ).toBe(0);
  });

  it('never double-counts a day across two allocations (FR-022)', () => {
    // Two back-to-back allocations covering all of March must sum to March's
    // charge, not to more than it.
    const first = depreciationForDays(
      asset,
      new Date(Date.UTC(2026, 2, 1)),
      new Date(Date.UTC(2026, 2, 15)),
    );
    const second = depreciationForDays(
      asset,
      new Date(Date.UTC(2026, 2, 16)),
      new Date(Date.UTC(2026, 2, 31)),
    );
    expect(first + second).toBeCloseTo(2_000, 2);
  });

  it('spans a month boundary without over-charging either month', () => {
    const spanning = depreciationForDays(
      asset,
      new Date(Date.UTC(2026, 2, 20)),
      new Date(Date.UTC(2026, 3, 10)),
    );
    expect(spanning).toBeCloseTo((2_000 * 12) / 31 + (2_000 * 10) / 30, 2);
  });
});
