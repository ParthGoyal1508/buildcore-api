import { parseDateOnly, zonedDateOnly } from '../leave/leave-days';

/**
 * Whether a punch or leave date falls in a period already locked for payroll.
 *
 * The rule (FR-010): once `payrollLockDay` of a month has passed, the *previous*
 * month is closed to further attendance writes. A punch dated in the current month
 * is always open; one dated two months back is always closed.
 *
 * Kept as a pure function, separate from the services that call it, because it is
 * the same rule for punches and for leave applications, and because a date rule
 * with a month-boundary edge is exactly the kind of logic that should be testable
 * without a database.
 */
export function isPayrollLocked(
  capturedAt: Date,
  payrollLockDay: number,
  now: Date,
  timeZone: string,
): boolean {
  // Both instants are reduced to the calendar dates they fall on *for the
  // employee*, because the rule is stated in calendar months and a lock day. Read
  // in UTC, a punch made just after local midnight on the 1st belongs to the
  // previous month, and the lock closes a day early on it.
  const captured = parseDateOnly(zonedDateOnly(capturedAt, timeZone));
  const today = parseDateOnly(zonedDateOnly(now, timeZone));

  const capturedYear = captured.getUTCFullYear();
  const capturedMonth = captured.getUTCMonth();
  const currentYear = today.getUTCFullYear();
  const currentMonth = today.getUTCMonth();

  const monthsElapsed =
    (currentYear - capturedYear) * 12 + (currentMonth - capturedMonth);

  // Current month, or somehow the future: always open. A future-dated punch is a
  // separate concern (the offline-age check), not a lock question.
  if (monthsElapsed <= 0) {
    return false;
  }
  // Two or more months back: the lock day for that period has certainly passed.
  if (monthsElapsed > 1) {
    return true;
  }
  // Exactly last month: locked once this month has reached the lock day.
  return today.getUTCDate() >= payrollLockDay;
}
