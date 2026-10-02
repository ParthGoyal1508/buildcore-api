import { applyDeductionCeiling } from './deduction-ceiling';

/**
 * 020 FR-007a to FR-007c, the client's answer of 2026-10-02.
 *
 * The case that matters most is the third: a line already carrying other deductions. A per-deduction
 * cap passes every other test here and fails that one, which is precisely why the ceiling is on the
 * sum.
 */
describe('applyDeductionCeiling', () => {
  const base = { grossWages: 20000, ceilingPercent: 50 };

  it('allows a recovery that fits under the ceiling', () => {
    expect(
      applyDeductionCeiling({
        ...base,
        existingDeductions: [],
        requested: 4000,
      }),
    ).toMatchObject({ applied: 4000, carried: 0, ceiling: 10000 });
  });

  it('caps a recovery at the ceiling and carries the rest', () => {
    expect(
      applyDeductionCeiling({
        ...base,
        existingDeductions: [],
        requested: 15000,
      }),
    ).toMatchObject({ applied: 10000, carried: 5000 });
  });

  it('counts existing deductions against the same ceiling', () => {
    // **The test a per-deduction cap fails.** A line already carrying 8,000 of advance and statutory
    // dues has 2,000 of headroom on a 10,000 ceiling, so a 5,000 recovery takes 2,000 and carries
    // 3,000. A rule capping the fuel recovery alone at 50% would take all 5,000 and leave the payslip
    // 13,000 down on 20,000 of wages — each rule satisfied, the limit breached.
    expect(
      applyDeductionCeiling({
        ...base,
        existingDeductions: [1800, 200, 6000],
        requested: 5000,
      }),
    ).toMatchObject({ applied: 2000, carried: 3000, headroom: 2000 });
  });

  it('carries the whole recovery when the line is already at its ceiling', () => {
    // Not an error. An ordinary month for somebody repaying an advance, and FR-007c forbids both the
    // alternatives — expiring the balance, or deducting it anyway.
    expect(
      applyDeductionCeiling({
        ...base,
        existingDeductions: [10000],
        requested: 3000,
      }),
    ).toMatchObject({ applied: 0, carried: 3000, headroom: 0 });
  });

  it('never claws back when existing deductions already exceed the ceiling', () => {
    // A large contracted loan EMI can put a line past half its wages on its own. The ceiling binds
    // what this recovery adds; it is not a licence to reverse a deduction somebody else was entitled
    // to make, and a negative `applied` would be a payment to the employee.
    expect(
      applyDeductionCeiling({
        ...base,
        existingDeductions: [14000],
        requested: 3000,
      }),
    ).toMatchObject({ applied: 0, carried: 3000, headroom: 0 });
  });

  it('honours a company ceiling lower than 50', () => {
    expect(
      applyDeductionCeiling({
        grossWages: 20000,
        ceilingPercent: 25,
        existingDeductions: [],
        requested: 9000,
      }),
    ).toMatchObject({ applied: 5000, carried: 4000, ceiling: 5000 });
  });

  it('deducts nothing from a line with no wages', () => {
    // A full loss-of-pay month. Zero wages means zero ceiling, so the whole balance carries rather
    // than being written off against a month that paid nothing.
    expect(
      applyDeductionCeiling({
        grossWages: 0,
        ceilingPercent: 50,
        existingDeductions: [],
        requested: 2500,
      }),
    ).toMatchObject({ applied: 0, carried: 2500 });
  });

  it('rounds to paise', () => {
    expect(
      applyDeductionCeiling({
        grossWages: 20333.33,
        ceilingPercent: 50,
        existingDeductions: [],
        requested: 99999,
      }).applied,
    ).toBe(10166.67);
  });
});
