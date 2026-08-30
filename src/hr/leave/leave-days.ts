/**
 * Leave day counting (spec FR-019).
 *
 * A pure function over calendar strings, deliberately separate from LeaveService:
 * this number is what a balance is debited by, so the rule behind it should be
 * verifiable without a database, a site fixture, or an HTTP round trip.
 *
 * Everything here is `YYYY-MM-DD` rather than `Date`. A leave day is a calendar
 * date, not an instant — the moment a `Date` enters the arithmetic, a server in one
 * timezone and a site in another disagree about which day a range starts on, and
 * the employee is charged an extra day or credited a free one.
 */

/** Days are enumerated at UTC midnight, where every day is exactly this long — no
 * DST transition can shorten or lengthen a step. */
const MS_PER_DAY = 86_400_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → the UTC-midnight instant used only for stepping and comparison. */
export function parseDateOnly(value: string): Date {
  if (!DATE_ONLY.test(value)) {
    throw new RangeError(`Expected a YYYY-MM-DD date, received "${value}"`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  // A well-formed but impossible date (2026-02-30) does not produce NaN — it rolls
  // silently forward to 2026-03-02. Comparing the round-trip is what catches it,
  // and catching it matters: a leave range that quietly starts two days later than
  // the employee asked for is worse than a rejected request.
  if (Number.isNaN(parsed.getTime()) || toDateOnly(parsed) !== value) {
    throw new RangeError(`"${value}" is not a real calendar date`);
  }
  return parsed;
}

/** The inverse of `parseDateOnly`, for handing a date back out. */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every calendar date from `from` to `to`, both inclusive. Empty when `to`
 * precedes `from`, which callers reject before reaching here. */
export function eachDateInRange(from: string, to: string): string[] {
  const start = parseDateOnly(from).getTime();
  const end = parseDateOnly(to).getTime();
  const dates: string[] = [];
  for (let t = start; t <= end; t += MS_PER_DAY) {
    dates.push(toDateOnly(new Date(t)));
  }
  return dates;
}

/**
 * Chargeable leave days in an inclusive date range.
 *
 * Weekly offs and site holidays are excluded because the employee was never
 * scheduled to work them — charging leave for a day nobody expected them to attend
 * would quietly shrink their entitlement.
 */
export function countLeaveDays(
  fromDate: string,
  toDate: string,
  weeklyOffDay: number,
  holidays: readonly string[],
): number {
  const holidaySet = new Set(holidays);
  return eachDateInRange(fromDate, toDate).filter((date) => {
    if (holidaySet.has(date)) {
      return false;
    }
    return parseDateOnly(date).getUTCDay() !== weeklyOffDay;
  }).length;
}

/**
 * The Indian financial year a date falls in, as `"2026-27"` (data-model.md
 * "Leave Balance").
 *
 * April to March, not January to December: leave entitlement is granted and
 * exhausted on the same cycle payroll runs on, and defaulting a balance lookup to
 * the calendar year would show an employee the wrong entitlement for nine months
 * of every twelve.
 */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
