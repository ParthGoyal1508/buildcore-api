/**
 * The statutory ceiling on what one payslip may have deducted from it (020 FR-007a to FR-007c).
 *
 * The Payment of Wages Act caps **total** deductions at half the wages for the period, and the client
 * confirmed that reading on 2026-10-02. The word doing the work is *total*: a rule that capped the
 * fuel recovery alone at 50% would satisfy itself while the payslip's combined deductions sailed past
 * the limit — each rule correct, the law broken. So the ceiling is computed on the sum, and a
 * recovery takes only the headroom that is left.
 *
 * Extracted as a pure function because this is the subtlest arithmetic in the feature and the one
 * nobody will re-derive when they come to change it. It is also the only part that can be tested
 * without a payroll run.
 */

/** Rupees to paise. Deduction arithmetic left unrounded is how a payslip ends up a paisa out. */
function paise(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DeductionCeilingInput {
  /**
   * The wages the ceiling is a proportion of — gross earnings for the period.
   *
   * Gross, not net: net is wages *after* deductions, so a ceiling expressed against it would move
   * every time a deduction was added and could never be satisfied.
   */
  grossWages: number;
  /**
   * Every deduction already on the line — statutory dues, TDS, loan instalments, advance recovery.
   *
   * Passed in as a list rather than a total so a caller cannot quietly omit one: a missing deduction
   * here does not fail, it silently raises the ceiling, which is the failure mode worth designing
   * against.
   */
  existingDeductions: readonly number[];
  /** What the fuel recovery wants to take, including any balance carried from earlier periods. */
  requested: number;
  /** The ceiling as a percentage of gross wages. 50 unless a company has lowered it. */
  ceilingPercent: number;
}

export interface DeductionCeilingResult {
  /** What may actually be deducted this period. */
  applied: number;
  /** What is left owing, to carry forward (FR-007b). */
  carried: number;
  /** The absolute ceiling, for an explanation a payroll clerk can read. */
  ceiling: number;
  /** What was left under the ceiling before this recovery. Zero means a full carry. */
  headroom: number;
}

/**
 * How much of a requested recovery this payslip can bear.
 *
 * Returns a **full carry** rather than throwing when there is no headroom. A payslip already at its
 * ceiling is an ordinary month for somebody repaying an advance, not an error — and FR-007c forbids
 * both ways software usually disposes of the remainder: expiring it, or deducting it anyway.
 */
export function applyDeductionCeiling(
  input: DeductionCeilingInput,
): DeductionCeilingResult {
  const ceiling = paise((input.grossWages * input.ceilingPercent) / 100);
  const existing = paise(
    input.existingDeductions.reduce((sum, amount) => sum + amount, 0),
  );

  // `max(0, …)` because existing deductions can already exceed the ceiling — a line carrying a large
  // contracted loan EMI, say. The ceiling binds what *this* recovery adds; it is not a licence to
  // claw back a deduction somebody else was entitled to make.
  const headroom = paise(Math.max(0, ceiling - existing));
  const applied = paise(Math.min(Math.max(0, input.requested), headroom));

  return {
    applied,
    carried: paise(Math.max(0, input.requested) - applied),
    ceiling,
    headroom,
  };
}
