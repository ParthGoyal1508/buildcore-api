import { AttendanceType } from '@prisma/client';

/**
 * Pure labour wage computation (013 FR-022). Kept free of Prisma and Nest so it can
 * be unit-tested directly and reused by the payment-sheet generator.
 *
 * Gross wage for a worker over a period is, per FR-022:
 *   Σ over worked dates of (dayFraction × applicableDailyRate)
 *   + overtimeHours × (applicableDailyRate / standardHours) × companyOtMultiplier
 *
 * The OT multiplier is the company's existing 005 FR-014a setting, read by the
 * caller and passed in — never redefined here (FR-049).
 */

/** The fraction of a day each attendance type counts as (FR-022). */
export function dayFractionOf(type: AttendanceType): number {
  switch (type) {
    case AttendanceType.full_day:
      return 1;
    case AttendanceType.half_day:
      return 0.5;
    case AttendanceType.overtime_only:
    case AttendanceType.absent:
      return 0;
    default:
      // An unrecognised type contributes no base day; overtime is still paid.
      return 0;
  }
}

export interface WorkedDay {
  attendanceType: AttendanceType;
  overtimeHours: number;
  /** The daily rate applicable on that date (override or project rate). */
  dailyRate: number;
}

export interface WageComputation {
  daysWorked: number;
  overtimeHours: number;
  grossWage: number;
}

/** Rounds to paise (2 dp) the way currency figures are stored. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Aggregates a worker's worked days into days, overtime and gross wage.
 *
 * `standardHours` derives the hourly rate for overtime; `otMultiplier` is the
 * company setting. A single rate is not assumed across days — each `WorkedDay`
 * carries the rate in force on it, so a mid-period rate change prices correctly.
 */
export function computeWage(
  days: WorkedDay[],
  standardHours: number,
  otMultiplier: number,
): WageComputation {
  let daysWorked = 0;
  let overtimeHours = 0;
  let gross = 0;

  for (const day of days) {
    const fraction = dayFractionOf(day.attendanceType);
    daysWorked += fraction;
    gross += fraction * day.dailyRate;

    const ot = day.overtimeHours ?? 0;
    if (ot > 0 && standardHours > 0) {
      overtimeHours += ot;
      gross += ot * (day.dailyRate / standardHours) * otMultiplier;
    }
  }

  return {
    daysWorked: roundMoney(daysWorked),
    overtimeHours: roundMoney(overtimeHours),
    grossWage: roundMoney(gross),
  };
}
