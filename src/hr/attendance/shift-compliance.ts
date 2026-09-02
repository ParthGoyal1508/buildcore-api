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
  /** `HH:mm`, or null when the employee never punched in. */
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

/** `HH:mm` → minutes since midnight. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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
  if (!punches.inTime && !punches.outTime) {
    return { marker: 'no_punch_times', ...NOTHING };
  }

  const shiftIn = minutesOf(shift.inTime);
  const shiftOut = minutesOf(shift.outTime);
  // A shift crossing midnight would otherwise compute a negative duration.
  const shiftMinutes =
    shiftOut > shiftIn ? shiftOut - shiftIn : shiftOut + 24 * 60 - shiftIn;

  const lateMinutes = punches.inTime
    ? Math.max(minutesOf(punches.inTime) - shiftIn - shift.graceMinutes, 0)
    : 0;

  const earlyDepartureMinutes = punches.outTime
    ? Math.max(shiftOut - minutesOf(punches.outTime), 0)
    : 0;

  // Short hours is measured against the whole shift, and is not simply late plus
  // early: an employee can arrive on time, leave on time, and still fall short if
  // the punches say so.
  let workedMinutes = 0;
  if (punches.inTime && punches.outTime) {
    const start = minutesOf(punches.inTime);
    const end = minutesOf(punches.outTime);
    workedMinutes = end > start ? end - start : end + 24 * 60 - start;
  }
  const shortMinutes =
    punches.inTime && punches.outTime
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
