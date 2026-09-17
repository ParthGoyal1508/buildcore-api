/**
 * Events the attendance module emits for other modules to react to (016 FR-017).
 *
 * The name and payload live in `hr` because `hr` is what emits them. A listener in
 * `payroll` subscribes; nothing here knows that, which is the point — Principle I directs
 * fan-out that needs no answer onto the event bus precisely so the emitter need not know
 * its audience.
 *
 * Contrast with the lock in the other direction (FR-016): the attendance write path must
 * know *before* it proceeds whether a period is under review, so that one is a direct
 * call to payroll's exported service. An answer is needed, so it is a call; no answer is
 * needed here, so it is an event.
 */
export const ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT =
  'attendance.changed-under-review';

/**
 * Attendance for a period under payroll review has changed.
 *
 * Carries only what a listener needs to find the affected run. Deliberately not the
 * punch, the employee, or the before/after values: the run's approvals are void
 * regardless of *what* changed, and a payload that invited a listener to decide
 * otherwise would be an invitation to get it wrong.
 */
export interface AttendanceChangedUnderReviewEvent {
  companyId: string;
  /** The period key the edit fell in, e.g. `2026-08`. */
  period: string;
  employeeId: string;
  /** Who made the edit — recorded on the abandonment so the restart is explicable. */
  actorUserId: string | null;
}
