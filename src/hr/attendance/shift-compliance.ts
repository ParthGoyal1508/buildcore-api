/**
 * Shift compliance, as pure functions (005 amendment US17).
 *
 * Feature 002 has configured shift in-time, out-time and a grace period since it
 * was built, and nothing has ever consumed them. This is what reads them.
 */

export interface ShiftWindow {
  /** `HH:mm`. */
  inTime: string;
  /** `HH:mm`. */
  outTime: string;
  graceMinutes: number;
}

export interface DayPunchTimes {
  /**
   * A punch time, or null when the employee never punched.
   *
   * Accepts either `HH:mm` or a full ISO timestamp, because the two producers in
   * this codebase disagree: `AttendanceAdminService.daily()` emits `HH:mm`, while
   * `AttendanceHistoryService` emits `firstIn.toISOString()`. The late-coming
   * report reads the second one, and parsing it as the first is what produced
   * `NaN` minutes — which JSON then serialised as `null`, so a report column
   * silently became "no value" rather than failing loudly.
   */
  inTime: string | null;
  outTime: string | null;
}

export type ComplianceMarker =
  | 'ok'
  | 'no_shift_assigned'
  | 'no_punch_times'
  | 'excluded';

export interface DayCompliance {
  marker: ComplianceMarker;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  shortHours: number;
}

/**
 * `HH:mm` → minutes since midnight.
 *
 * Retained with its original contract for callers that genuinely hold `HH:mm`
 * (the shift window). Use `punchMinutes` for a punch time, whose format depends
 * on which service produced it.
 */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * A punch time → minutes since midnight, or null if it cannot be read.
 *
 * Returning null rather than NaN is the whole point. NaN propagates silently:
 * it survives arithmetic, it survives `Math.max`, and `JSON.stringify` turns it
 * into `null` — so a malformed time became an empty cell in the late-coming
 * report instead of an error anyone would notice. A time this cannot parse is
 * "unmeasurable", which the report already has an honest way to say.
 *
 * ISO timestamps are read in UTC, matching `AttendanceAdminService.daily()`,
 * which derives its own `HH:mm` from the same instant the same way.
 */
export function punchMinutes(value: string | null): number | null {
  if (!value) return null;

  // `HH:mm` or `HH:mm:ss`, with no date part.
  const short = /^(\d{1,2}):(\d{2})/.exec(value);
  if (short && !value.includes('T')) {
    const h = Number(short[1]);
    const m = Number(short[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
}

const NOTHING: Omit<DayCompliance, 'marker'> = {
  lateMinutes: 0,
  earlyDepartureMinutes: 0,
  shortHours: 0,
};

/**
 * One day's compliance against the shift in force *that day*.
 *
 * The markers matter as much as the numbers (FR-062). An employee with no shift
 * configured, or a day with no punch times, must not be reported as zero minutes
 * late — that reads as perfect punctuality when it actually means "we don't know".
 * Distinguishing them is the difference between a report you can act on and one
 * that quietly flatters whoever has the least data.
 */
export function dayCompliance(
  shift: ShiftWindow | null,
  punches: DayPunchTimes,
  options: { excluded?: boolean } = {},
): DayCompliance {
  // Approved leave and holidays are not late (FR-063) — the employee was not
  // expected.
  if (options.excluded) return { marker: 'excluded', ...NOTHING };
  if (!shift) return { marker: 'no_shift_assigned', ...NOTHING };

  // Parsed up front so an unreadable time is reported as "we don't know" rather
  // than measured as zero. A punch that cannot be read is exactly as
  // unmeasurable as a punch that never happened, and this report already
  // distinguishes that from punctuality (FR-062).
  const inMinutes = punchMinutes(punches.inTime);
  const outMinutes = punchMinutes(punches.outTime);
  if (inMinutes === null && outMinutes === null) {
    return { marker: 'no_punch_times', ...NOTHING };
  }

  const shiftIn = minutesOf(shift.inTime);
  const shiftOut = minutesOf(shift.outTime);
  // A shift crossing midnight would otherwise compute a negative duration.
  const shiftMinutes =
    shiftOut > shiftIn ? shiftOut - shiftIn : shiftOut + 24 * 60 - shiftIn;

  const lateMinutes =
    inMinutes === null
      ? 0
      : Math.max(inMinutes - shiftIn - shift.graceMinutes, 0);

  const earlyDepartureMinutes =
    outMinutes === null ? 0 : Math.max(shiftOut - outMinutes, 0);

  // Short hours is measured against the whole shift, and is not simply late plus
  // early: an employee can arrive on time, leave on time, and still fall short if
  // the punches say so.
  let workedMinutes = 0;
  const bothKnown = inMinutes !== null && outMinutes !== null;
  if (bothKnown) {
    workedMinutes =
      outMinutes > inMinutes
        ? outMinutes - inMinutes
        : outMinutes + 24 * 60 - inMinutes;
  }
  const shortMinutes = bothKnown
    ? Math.max(shiftMinutes - workedMinutes, 0)
    : 0;

  return {
    marker: 'ok',
    lateMinutes,
    earlyDepartureMinutes,
    shortHours: Math.round((shortMinutes / 60) * 100) / 100,
  };
}

export interface EmployeeComplianceSummary {
  lateDays: number;
  totalLateMinutes: number;
  earlyDepartureDays: number;
  shortHoursDays: number;
  daysWithoutShift: number;
  daysWithoutPunchTimes: number;
  repeatLateComer: boolean;
}

/** Rolls a month of days into the figures the late-coming report shows. */
export function summarise(
  days: DayCompliance[],
  repeatThreshold: number,
): EmployeeComplianceSummary {
  const lateDays = days.filter((d) => d.lateMinutes > 0).length;
  return {
    lateDays,
    totalLateMinutes: days.reduce((a, d) => a + d.lateMinutes, 0),
    earlyDepartureDays: days.filter((d) => d.earlyDepartureMinutes > 0).length,
    shortHoursDays: days.filter((d) => d.shortHours > 0).length,
    daysWithoutShift: days.filter((d) => d.marker === 'no_shift_assigned').length,
    daysWithoutPunchTimes: days.filter((d) => d.marker === 'no_punch_times')
      .length,
    repeatLateComer: lateDays >= repeatThreshold,
  };
}
