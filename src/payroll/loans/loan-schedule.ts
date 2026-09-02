/**
 * EMI schedule generation, as a pure function (005 US7, FR-021).
 *
 * Separated from the service so the amortisation can be asserted directly — an
 * off-by-one in the final instalment silently over- or under-recovers from an
 * employee's pay, which is the kind of bug nobody notices until someone complains.
 */

export interface ScheduleEntry {
  /** Period key, `YYYY-MM`. */
  month: string;
  emiAmount: number;
  principal: number;
  interest: number;
  remainingBalance: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Advances a `YYYY-MM` key by one month, rolling the year over in December. */
export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The `YYYY-MM` a date falls in. */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Builds the month-by-month recovery schedule for a loan.
 *
 * These are interest-free salary advances — `interest` is present on every entry
 * and always zero, because the column exists for a future interest-bearing variant
 * and omitting it would make that change a migration rather than a value change.
 *
 * The final instalment is whatever is actually left, not a full EMI. A fixed EMI
 * that does not divide the principal evenly would otherwise recover more than was
 * advanced — the employee would be repaying money they never received.
 */
export function generateSchedule(
  amount: number,
  emiAmount: number,
  firstPeriod: string,
): ScheduleEntry[] {
  if (amount <= 0) throw new Error('Loan amount must be positive.');
  if (emiAmount <= 0) throw new Error('EMI amount must be positive.');

  const entries: ScheduleEntry[] = [];
  let remaining = r2(amount);
  let period = firstPeriod;

  // Bounded to keep a pathological input (a one-rupee EMI against a large
  // principal) from generating an unbounded schedule.
  const MAX_INSTALMENTS = 600;

  while (remaining > 0 && entries.length < MAX_INSTALMENTS) {
    const instalment = r2(Math.min(emiAmount, remaining));
    remaining = r2(remaining - instalment);
    entries.push({
      month: period,
      emiAmount: instalment,
      principal: instalment,
      interest: 0,
      remainingBalance: remaining,
    });
    period = nextPeriod(period);
  }

  if (remaining > 0) {
    throw new Error(
      `An EMI of ${emiAmount} against ${amount} would take more than ${MAX_INSTALMENTS} months to recover.`,
    );
  }

  return entries;
}
