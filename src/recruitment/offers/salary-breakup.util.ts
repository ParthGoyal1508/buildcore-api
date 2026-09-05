/**
 * Offer salary-breakup reconciliation (011 FR-010). Pure and framework-free.
 *
 * The sum of the monthly component amounts must equal `offeredCtc / 12` within a
 * company-configured tolerance (rounding). Kept here so it is unit tested directly
 * and shared verbatim by the client's disable-Save guard.
 */

export interface SalaryComponent {
  name: string;
  monthlyAmount: number;
}

export function breakupTotal(components: SalaryComponent[]): number {
  const sum = components.reduce((acc, c) => acc + (c.monthlyAmount ?? 0), 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/** The monthly target `offeredCtc / 12`, rounded to paise. */
export function monthlyTarget(offeredCtc: number): number {
  return Math.round((offeredCtc / 12 + Number.EPSILON) * 100) / 100;
}

/** Signed variance between the breakup total and the monthly target. */
export function breakupVariance(
  components: SalaryComponent[],
  offeredCtc: number,
): number {
  return (
    Math.round((breakupTotal(components) - monthlyTarget(offeredCtc)) * 100) /
    100
  );
}

/** Whether the breakup reconciles to the monthly CTC within `tolerance` rupees. */
export function breakupReconciles(
  components: SalaryComponent[],
  offeredCtc: number,
  tolerance: number,
): boolean {
  return Math.abs(breakupVariance(components, offeredCtc)) <= tolerance;
}
