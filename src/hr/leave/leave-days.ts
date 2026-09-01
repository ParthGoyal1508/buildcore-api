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

/** The inverse of `parseDateOnly`, for handing a date back out.
 *
 * UTC by construction, which is correct for the values it is given: `@db.Date`
 * columns and dates built from explicit UTC parts are already calendar dates
 * carried at UTC midnight. It is the wrong function for an *instant* — see
 * `zonedDateOnly`. */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar date an instant falls on, in a given zone.
 *
 * This is the conversion `toDateOnly` must not be used for. A punch is recorded as
 * an instant but belongs to a day, and which day depends on where the employee is
 * standing: at UTC+5:30, `toISOString()` files everything before 05:30 local under
 * the previous date, moving a whole early shift — and its overtime — onto the wrong
 * day.
 *
 * `en-CA` because its short date format is already `YYYY-MM-DD`; formatting to
 * parts and reassembling them by hand would be the same result with more to get
 * wrong.
 */
export function zonedDateOnly(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The instants a local calendar day starts and ends at, as a half-open range.
 *
 * The companion to `zonedDateOnly` for database queries: rows are stored as
 * instants, so selecting "the punches on 1 September" means selecting the instants
 * between local midnight and the next local midnight, not the UTC ones.
 *
 * Derived by measuring the zone's offset at that date rather than assuming a fixed
 * one, so a zone with DST returns a 23- or 25-hour day on its transition dates
 * instead of silently dropping or double-counting an hour.
 */
export function zonedDayBounds(
  dateOnly: string,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedMidnight(dateOnly, timeZone);
  const nextDay = toDateOnly(new Date(parseDateOnly(dateOnly).getTime() + MS_PER_DAY));
  return { start, end: zonedMidnight(nextDay, timeZone) };
}

/** The instant at which `dateOnly` begins in `timeZone`. */
function zonedMidnight(dateOnly: string, timeZone: string): Date {
  const utcMidnight = parseDateOnly(dateOnly);
  // The clock time an instant shows in the target zone, minus the instant itself,
  // is that zone's offset. Subtracting it from UTC midnight gives local midnight.
  //
  // Measured twice, each pass re-derived from `utcMidnight` rather than from the
  // previous result — compounding them would apply the offset twice over. The
  // second pass exists because the offset is sampled *at an instant*, and on a DST
  // transition date the first sample can come from the wrong side of it; the
  // second samples at the corrected instant and settles.
  let candidate = utcMidnight;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = new Date(
      `${zonedDateOnly(candidate, timeZone)}T${zonedTimeOnly(candidate, timeZone)}Z`,
    );
    const offset = shown.getTime() - candidate.getTime();
    candidate = new Date(utcMidnight.getTime() - offset);
  }
  return candidate;
}

/** `HH:mm:ss.mmm` for an instant in a zone, to pair with `zonedDateOnly`. */
function zonedTimeOnly(instant: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return `${time}.000`;
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
