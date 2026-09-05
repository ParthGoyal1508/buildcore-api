import {
  breakupReconciles,
  breakupTotal,
  breakupVariance,
  monthlyTarget,
} from './salary-breakup.util';

describe('salary-breakup.util', () => {
  const components = [
    { name: 'Basic', monthlyAmount: 30000 },
    { name: 'HRA', monthlyAmount: 15000 },
    { name: 'Special', monthlyAmount: 5000 },
  ];

  it('sums the components', () => {
    expect(breakupTotal(components)).toBe(50000);
  });

  it('computes the monthly target from annual CTC', () => {
    expect(monthlyTarget(600000)).toBe(50000);
  });

  it('reconciles when the breakup equals monthly CTC', () => {
    expect(breakupVariance(components, 600000)).toBe(0);
    expect(breakupReconciles(components, 600000, 1)).toBe(true);
  });

  it('fails reconciliation outside tolerance', () => {
    expect(breakupReconciles(components, 660000, 1)).toBe(false);
    expect(breakupVariance(components, 660000)).toBe(-5000);
  });

  it('accepts a difference within tolerance (rounding)', () => {
    // 600001 / 12 = 50000.08 → variance 0.08 within a ₹1 tolerance.
    expect(breakupReconciles(components, 600001, 1)).toBe(true);
  });
});
