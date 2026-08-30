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
  now: Date = new Date(),
): boolean {
  const capturedYear = capturedAt.getUTCFullYear();
  const capturedMonth = capturedAt.getUTCMonth();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

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
  return now.getUTCDate() >= payrollLockDay;
}
