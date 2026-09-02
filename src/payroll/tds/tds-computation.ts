/**
 * Income-tax deduction at source, as pure functions (005 amendment US14).
 *
 * The method is the one Indian payroll actually uses, and the reason it matters is
 * FR-051: tax is computed on *projected annual* income, then spread over the months
 * that remain. That is what makes a mid-year salary change or a late investment
 * declaration self-correct — the next month's deduction absorbs the difference —
 * instead of needing a manual true-up at year end.
 */

export interface TaxSlabBand {
  /** Inclusive. */
  lowerBound: number;
  /** Exclusive; null marks the final open-ended band. */
  upperBound: number | null;
  ratePercent: number;
}

export interface TdsInput {
  /** Taxable salary already paid this financial year, before this month. */
  earnedToDate: number;
  /** This month's taxable gross. */
  currentMonthGross: number;
  /** Months left in the financial year, including the current one. */
  remainingMonths: number;
  /** TDS already deducted this financial year. */
  deductedToDate: number;
  /** Sum of capped, countable declared deductions. */
  totalDeductions: number;
  standardDeduction: number;
  /** No PAN on file → penal flat rate instead of the slabs (FR-053). */
  hasPan: boolean;
  noPanRatePercent: number;
}

export interface TdsResult {
  projectedAnnualGross: number;
  taxableIncome: number;
  annualLiability: number;
  /** This month's deduction. Never negative — payroll does not refund tax. */
  monthlyTds: number;
  /** Set when the penal no-PAN rate was applied instead of the slabs. */
  noPanRateApplied: boolean;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Tax on an amount under a slab set.
 *
 * Marginal, not flat: each band taxes only the portion of income that falls inside
 * it. Applying a single band's rate to the whole income is the classic mistake and
 * would overtax everyone above the first threshold.
 */
export function taxForIncome(income: number, slabs: TaxSlabBand[]): number {
  if (income <= 0 || slabs.length === 0) return 0;

  const ordered = [...slabs].sort((a, b) => a.lowerBound - b.lowerBound);
  let tax = 0;

  for (const band of ordered) {
    if (income <= band.lowerBound) break;
    const upper = band.upperBound ?? Infinity;
    const portion = Math.min(income, upper) - band.lowerBound;
    if (portion > 0) tax += (portion * band.ratePercent) / 100;
  }

  return r2(tax);
}

/**
 * Validates that a slab set is contiguous and non-overlapping (FR-050).
 *
 * Returns a human-readable problem rather than a boolean: an admin who typed a gap
 * needs to know *where*, and a set with a hole silently untaxes a band of income.
 */
export function validateSlabs(slabs: TaxSlabBand[]): string | null {
  if (slabs.length === 0) return 'At least one slab is required.';

  const ordered = [...slabs].sort((a, b) => a.lowerBound - b.lowerBound);

  if (ordered[0].lowerBound !== 0) {
    return `The first slab must start at 0; it starts at ${ordered[0].lowerBound}.`;
  }

  for (let i = 0; i < ordered.length - 1; i++) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (current.upperBound === null) {
      return 'Only the last slab may be open-ended.';
    }
    if (current.upperBound < next.lowerBound) {
      return `Gap between ${current.upperBound} and ${next.lowerBound} — income in that range would be untaxed.`;
    }
    if (current.upperBound > next.lowerBound) {
      return `Overlap between ${next.lowerBound} and ${current.upperBound} — income in that range would be taxed twice.`;
    }
  }

  if (ordered[ordered.length - 1].upperBound !== null) {
    return 'The last slab must be open-ended, or the highest incomes fall through it.';
  }

  return null;
}

/**
 * This month's TDS.
 *
 * The projection is the whole point: annual liability is recomputed every month
 * from actual earnings so far plus the remaining months at the current rate, then
 * reduced by what has already been deducted, then divided by the months left. A
 * raise in month 7 raises the remaining five deductions rather than leaving a
 * shortfall for March.
 */
export function computeTds(
  input: TdsInput,
  slabs: TaxSlabBand[],
): TdsResult {
  const {
    earnedToDate,
    currentMonthGross,
    remainingMonths,
    deductedToDate,
    totalDeductions,
    standardDeduction,
    hasPan,
    noPanRatePercent,
  } = input;

  // A period outside the financial year would divide by zero. Treating it as one
  // month is wrong in a way that is visible; NaN in a payslip is not.
  const months = Math.max(remainingMonths, 1);

  const projectedAnnualGross = r2(earnedToDate + currentMonthGross * months);

  if (!hasPan) {
    // Flat penal rate on gross, ignoring slabs and declarations entirely — that is
    // the point of the penalty, and applying deductions would soften it.
    const annualLiability = r2(
      (projectedAnnualGross * noPanRatePercent) / 100,
    );
    const remaining = Math.max(annualLiability - deductedToDate, 0);
    return {
      projectedAnnualGross,
      taxableIncome: projectedAnnualGross,
      annualLiability,
      monthlyTds: r2(remaining / months),
      noPanRateApplied: true,
    };
  }

  const taxableIncome = r2(
    Math.max(projectedAnnualGross - standardDeduction - totalDeductions, 0),
  );
  const annualLiability = taxForIncome(taxableIncome, slabs);

  // Floored at zero: if more has already been deducted than is owed — because
  // salary fell, or a declaration arrived late — the excess is refunded when the
  // employee files their return, not by payroll paying money back.
  const remaining = Math.max(annualLiability - deductedToDate, 0);

  return {
    projectedAnnualGross,
    taxableIncome,
    annualLiability,
    monthlyTds: r2(remaining / months),
    noPanRateApplied: false,
  };
}

/**
 * Caps a declared amount at its section's statutory ceiling (FR-052).
 *
 * A ceiling of 0 means the section has no configured limit here rather than that
 * nothing may be claimed — an unconfigured section should not silently zero an
 * employee's legitimate deduction.
 */
export function capDeclaration(
  sectionCode: string,
  declaredAmount: number,
  ceilings: Record<string, number>,
): number {
  const ceiling = ceilings[sectionCode];
  if (ceiling === undefined || ceiling <= 0) return r2(declaredAmount);
  return r2(Math.min(declaredAmount, ceiling));
}

/** Months left in an April–March financial year, including the current one. */
export function remainingMonthsInFy(month: number): number {
  // April is month 1 of the FY, March is month 12.
  const fyMonth = month >= 4 ? month - 3 : month + 9;
  return 12 - fyMonth + 1;
}

/** The April–March financial year a calendar month falls in, e.g. "2026-27". */
export function financialYearOf(year: number, month: number): string {
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
