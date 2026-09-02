import {
  capDeclaration,
  computeTds,
  financialYearOf,
  remainingMonthsInFy,
  taxForIncome,
  validateSlabs,
  type TaxSlabBand,
} from './tds-computation';

/** New-regime-shaped bands, used throughout. */
const SLABS: TaxSlabBand[] = [
  { lowerBound: 0, upperBound: 300000, ratePercent: 0 },
  { lowerBound: 300000, upperBound: 700000, ratePercent: 5 },
  { lowerBound: 700000, upperBound: 1000000, ratePercent: 10 },
  { lowerBound: 1000000, upperBound: null, ratePercent: 20 },
];

const CEILINGS = { '80C': 150000, '80D': 25000, HRA: 0 };

describe('taxForIncome', () => {
  it('charges nothing below the first threshold', () => {
    expect(taxForIncome(250000, SLABS)).toBe(0);
  });

  it('taxes marginally, not at a flat band rate', () => {
    // 500000: nothing on the first 300000, 5% on the next 200000.
    expect(taxForIncome(500000, SLABS)).toBe(10000);
  });

  it('accumulates across several bands', () => {
    // 300000@0 + 400000@5% (20000) + 300000@10% (30000) = 50000
    expect(taxForIncome(1000000, SLABS)).toBe(50000);
  });

  it('applies the open-ended band above the last threshold', () => {
    // 50000 up to 1000000, plus 20% of the 500000 above it.
    expect(taxForIncome(1500000, SLABS)).toBe(150000);
  });

  it('is exactly at a boundary, not over it', () => {
    expect(taxForIncome(300000, SLABS)).toBe(0);
    expect(taxForIncome(700000, SLABS)).toBe(20000);
  });

  it('returns zero for zero or negative income', () => {
    expect(taxForIncome(0, SLABS)).toBe(0);
    expect(taxForIncome(-1000, SLABS)).toBe(0);
  });
});

describe('validateSlabs', () => {
  it('accepts a contiguous, open-ended set', () => {
    expect(validateSlabs(SLABS)).toBeNull();
  });

  it('names the gap rather than just failing', () => {
    const gapped: TaxSlabBand[] = [
      { lowerBound: 0, upperBound: 300000, ratePercent: 0 },
      { lowerBound: 400000, upperBound: null, ratePercent: 5 },
    ];
    expect(validateSlabs(gapped)).toMatch(/Gap between 300000 and 400000/);
  });

  it('names an overlap', () => {
    const overlapping: TaxSlabBand[] = [
      { lowerBound: 0, upperBound: 400000, ratePercent: 0 },
      { lowerBound: 300000, upperBound: null, ratePercent: 5 },
    ];
    expect(validateSlabs(overlapping)).toMatch(/Overlap between 300000 and 400000/);
  });

  it('requires the set to start at zero', () => {
    expect(
      validateSlabs([{ lowerBound: 100, upperBound: null, ratePercent: 5 }]),
    ).toMatch(/must start at 0/);
  });

  it('requires the last band to be open-ended', () => {
    const closed: TaxSlabBand[] = [
      { lowerBound: 0, upperBound: 300000, ratePercent: 0 },
      { lowerBound: 300000, upperBound: 700000, ratePercent: 5 },
    ];
    expect(validateSlabs(closed)).toMatch(/must be open-ended/);
  });

  it('rejects an open band that is not last', () => {
    const misplaced: TaxSlabBand[] = [
      { lowerBound: 0, upperBound: null, ratePercent: 0 },
      { lowerBound: 300000, upperBound: null, ratePercent: 5 },
    ];
    expect(validateSlabs(misplaced)).toMatch(/Only the last slab/);
  });

  it('rejects an empty set', () => {
    expect(validateSlabs([])).toMatch(/At least one slab/);
  });
});

describe('capDeclaration', () => {
  it('caps at the section ceiling', () => {
    expect(capDeclaration('80C', 200000, CEILINGS)).toBe(150000);
  });

  it('leaves a claim below the ceiling alone', () => {
    expect(capDeclaration('80C', 120000, CEILINGS)).toBe(120000);
  });

  it('does not zero a section with no configured ceiling', () => {
    // An unconfigured section must not silently wipe out a legitimate claim.
    expect(capDeclaration('HRA', 90000, CEILINGS)).toBe(90000);
    expect(capDeclaration('UNKNOWN', 40000, CEILINGS)).toBe(40000);
  });
});

describe('remainingMonthsInFy', () => {
  it('counts April as the full year', () => {
    expect(remainingMonthsInFy(4)).toBe(12);
  });

  it('counts March as the last month', () => {
    expect(remainingMonthsInFy(3)).toBe(1);
  });

  it('handles the calendar-year rollover', () => {
    expect(remainingMonthsInFy(12)).toBe(4); // Dec, Jan, Feb, Mar
    expect(remainingMonthsInFy(1)).toBe(3);
  });
});

describe('financialYearOf', () => {
  it('starts the year in April', () => {
    expect(financialYearOf(2026, 4)).toBe('2026-27');
    expect(financialYearOf(2026, 3)).toBe('2025-26');
  });
});

describe('computeTds', () => {
  const base = {
    earnedToDate: 0,
    currentMonthGross: 100000,
    remainingMonths: 12,
    deductedToDate: 0,
    totalDeductions: 0,
    standardDeduction: 50000,
    hasPan: true,
    noPanRatePercent: 20,
  };

  it('spreads the annual liability across the remaining months', () => {
    const r = computeTds(base, SLABS);
    expect(r.projectedAnnualGross).toBe(1200000);
    expect(r.taxableIncome).toBe(1150000); // less standard deduction
    expect(r.annualLiability).toBe(taxForIncome(1150000, SLABS));
    expect(r.monthlyTds).toBe(
      Math.round((r.annualLiability / 12) * 100) / 100,
    );
  });

  it('reduces taxable income by capped declarations', () => {
    const r = computeTds({ ...base, totalDeductions: 150000 }, SLABS);
    expect(r.taxableIncome).toBe(1000000);
    expect(r.annualLiability).toBe(50000);
  });

  it('never deducts a negative amount', () => {
    // More already deducted than is owed — the excess is refunded on filing, not
    // paid back by payroll.
    const r = computeTds({ ...base, deductedToDate: 999999 }, SLABS);
    expect(r.monthlyTds).toBe(0);
  });

  it('applies the penal flat rate with no PAN, ignoring slabs and declarations', () => {
    const r = computeTds(
      { ...base, hasPan: false, totalDeductions: 150000 },
      SLABS,
    );
    expect(r.noPanRateApplied).toBe(true);
    expect(r.annualLiability).toBe(240000); // 20% of 1200000
    expect(r.taxableIncome).toBe(1200000); // deductions deliberately ignored
  });

  it('does not divide by zero when no months remain', () => {
    const r = computeTds({ ...base, remainingMonths: 0 }, SLABS);
    expect(Number.isFinite(r.monthlyTds)).toBe(true);
  });

  it('self-corrects across a full year with a mid-year raise (SC-A01)', () => {
    // April–September at 100000, October–March at 150000. Simulating month by
    // month must land within a rounding of the true annual liability — that is
    // the whole promise of the projection method.
    let earnedToDate = 0;
    let deductedToDate = 0;

    for (let m = 1; m <= 12; m++) {
      const gross = m <= 6 ? 100000 : 150000;
      const r = computeTds(
        {
          ...base,
          earnedToDate,
          currentMonthGross: gross,
          remainingMonths: 12 - m + 1,
          deductedToDate,
          totalDeductions: 150000,
        },
        SLABS,
      );
      deductedToDate = Math.round((deductedToDate + r.monthlyTds) * 100) / 100;
      earnedToDate = Math.round((earnedToDate + gross) * 100) / 100;
    }

    const actualAnnualGross = 6 * 100000 + 6 * 150000; // 1,500,000
    const trueLiability = taxForIncome(
      actualAnnualGross - 50000 - 150000,
      SLABS,
    );

    expect(earnedToDate).toBe(actualAnnualGross);
    // Within one rupee: the only difference is per-month paise rounding.
    expect(Math.abs(deductedToDate - trueLiability)).toBeLessThanOrEqual(1);
  });

  it('recovers when a declaration arrives late in the year', () => {
    // Six months with no declaration, then 150000 declared. The remaining months
    // must absorb the over-deduction rather than leaving it to a year-end refund.
    let earnedToDate = 0;
    let deductedToDate = 0;

    for (let m = 1; m <= 12; m++) {
      const r = computeTds(
        {
          ...base,
          earnedToDate,
          remainingMonths: 12 - m + 1,
          deductedToDate,
          totalDeductions: m <= 6 ? 0 : 150000,
        },
        SLABS,
      );
      deductedToDate = Math.round((deductedToDate + r.monthlyTds) * 100) / 100;
      earnedToDate += 100000;
    }

    const trueLiability = taxForIncome(1200000 - 50000 - 150000, SLABS);
    expect(Math.abs(deductedToDate - trueLiability)).toBeLessThanOrEqual(1);
  });
});
