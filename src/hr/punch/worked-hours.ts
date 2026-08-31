/**
 * Worked hours and overtime for one punch-in/punch-out pair (spec FR-009).
 *
 * A pure function, deliberately separate from PunchService: overtime is a
 * payroll-affecting number, and the rule for producing it should be verifiable
 * without a database, a shift fixture, or a punch round-trip.
 */

export interface WorkedHours {
  workedHours: number;
  /** Hours beyond the scheduled shift length. Never negative — a short day is
   * simply fewer worked hours, not negative overtime. */
  otHours: number;
}

/** Rounds to two decimals, so stored hours match what a payslip shows rather than
 * carrying floating-point noise into a money calculation. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeWorkedHours(
  punchInAt: Date,
  punchOutAt: Date,
  shiftDurationHours: number,
): WorkedHours {
  const elapsedMs = punchOutAt.getTime() - punchInAt.getTime();
  // An out before its in is not a negative shift; it is bad data, and reporting
  // zero keeps it out of payroll rather than crediting or debiting hours.
  const workedHours = elapsedMs > 0 ? round2(elapsedMs / 3_600_000) : 0;
  return {
    workedHours,
    otHours: round2(Math.max(0, workedHours - shiftDurationHours)),
  };
}
