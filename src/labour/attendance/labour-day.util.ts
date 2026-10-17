import { AttendanceType, LabourPunchType } from '@prisma/client';

/**
 * How one labour day counts, from its punch times (034). Pure, so the punch, the correction, the
 * daily and monthly views and the export all apply the same rule.
 */

export interface LabourDayRules {
  /** At least this many hours between punch in and out is a full day. */
  fullDayHours: number;
  /** At least this many is a half day; fewer is short and not paid. */
  halfDayHours: number;
  /** Hours beyond this are overtime. */
  standardHours: number;
}

export const DEFAULT_LABOUR_DAY_RULES: LabourDayRules = {
  fullDayHours: 8,
  halfDayHours: 4,
  standardHours: 8,
};

export type LabourDayStatus =
  | 'full_day'
  | 'half_day'
  | 'short'
  /** Punched in today and not out yet: the day is not over. */
  | 'on_site'
  /** A punch is missing or the times are impossible: not counted until corrected. */
  | 'unresolved'
  | 'absent';

export type LabourDayFlag =
  | 'missing_punch_out'
  | 'missing_punch_in'
  | 'out_before_in';

export interface LabourDay {
  status: LabourDayStatus;
  flag: LabourDayFlag | null;
  /** Between punch in and out, to 2 dp; null without both or when out is not after in. */
  hours: number | null;
  overtimeHours: number;
}

/**
 * `isPast` is whether the day has ended in the company's zone. Punched in today without a punch out
 * is simply on site; the same on an earlier day is a missing punch out.
 */
export function deriveLabourDay(
  punchIn: Date | null,
  punchOut: Date | null,
  isPast: boolean,
  rules: LabourDayRules,
): LabourDay {
  if (!punchIn && !punchOut) {
    return { status: 'absent', flag: null, hours: null, overtimeHours: 0 };
  }
  if (!punchIn) {
    return {
      status: 'unresolved',
      flag: 'missing_punch_in',
      hours: null,
      overtimeHours: 0,
    };
  }
  if (!punchOut) {
    return isPast
      ? {
          status: 'unresolved',
          flag: 'missing_punch_out',
          hours: null,
          overtimeHours: 0,
        }
      : { status: 'on_site', flag: null, hours: null, overtimeHours: 0 };
  }
  const ms = punchOut.getTime() - punchIn.getTime();
  if (ms <= 0) {
    return {
      status: 'unresolved',
      flag: 'out_before_in',
      hours: null,
      overtimeHours: 0,
    };
  }
  const hours = round2(ms / 3_600_000);
  const status: LabourDayStatus =
    hours >= rules.fullDayHours
      ? 'full_day'
      : hours >= rules.halfDayHours
      ? 'half_day'
      : 'short';
  const overtimeHours =
    rules.standardHours > 0
      ? round2(Math.max(0, hours - rules.standardHours))
      : 0;
  return { status, flag: null, hours, overtimeHours };
}

/**
 * What the day's muster line should say — the line payment sheets, reports and project costing
 * price. Null means the day has no line: nothing is counted until both punches are in and in order.
 * A short day keeps a line, marked absent, so the record of the day is still there.
 */
export function musterLineFor(
  day: LabourDay,
): { attendanceType: AttendanceType; overtimeHours: number | null } | null {
  switch (day.status) {
    case 'full_day':
      return {
        attendanceType: AttendanceType.full_day,
        overtimeHours: day.overtimeHours > 0 ? day.overtimeHours : null,
      };
    case 'half_day':
      return {
        attendanceType: AttendanceType.half_day,
        overtimeHours: day.overtimeHours > 0 ? day.overtimeHours : null,
      };
    case 'short':
      return { attendanceType: AttendanceType.absent, overtimeHours: null };
    default:
      return null;
  }
}

/** Validates a set of day rules, returning the first problem or null. */
export function labourDayRulesProblem(rules: LabourDayRules): string | null {
  const { fullDayHours, halfDayHours, standardHours } = rules;
  for (const [label, v] of [
    ['Full day hours', fullDayHours],
    ['Half day hours', halfDayHours],
    ['Standard shift hours', standardHours],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0 || v > 24) {
      return `${label} must be more than 0 and at most 24.`;
    }
  }
  if (halfDayHours >= fullDayHours) {
    return 'Half day hours must be fewer than full day hours.';
  }
  return null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * How long after a punch-in a punch-out may still close it (036 O5, decision 6). Long enough for a
 * night shift that runs past midnight, short enough that a punch-out the next evening is not read
 * as closing yesterday morning's punch-in.
 */
export const OVERNIGHT_WINDOW_HOURS = 16;

/**
 * Which day a punch-out closes, from the worker's recent in-punches: the latest one, when it has no
 * out yet and — if it began on an earlier day than `today` — is no more than 16 hours old. Today's
 * own punch-in stays open all day, as it always has. Null when there is none to close. Pure, so
 * the rule is tested on its own.
 */
export function openShiftDate(
  punches: { punchDate: Date; type: LabourPunchType; punchedAt: Date }[],
  now: Date,
  today: string,
): string | null {
  const ins = punches
    .filter((p) => p.type === LabourPunchType.in)
    .sort((a, b) => b.punchedAt.getTime() - a.punchedAt.getTime());
  const latest = ins[0];
  if (!latest) return null;
  const date = latest.punchDate.toISOString().slice(0, 10);
  const closed = punches.some(
    (p) =>
      p.type === LabourPunchType.out &&
      p.punchDate.toISOString().slice(0, 10) === date,
  );
  if (closed) return null;
  if (date === today) return date;
  const age = now.getTime() - latest.punchedAt.getTime();
  if (age < 0 || age > OVERNIGHT_WINDOW_HOURS * 3_600_000) return null;
  return date;
}
