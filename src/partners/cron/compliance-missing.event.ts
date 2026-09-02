/** The event name, as a constant rather than a string literal at each call site —
 * a typo'd subscriber silently never fires, which is the worst way to learn about
 * one. */
export const COMPLIANCE_MISSING_EVENT = 'compliance.missing';

/**
 * Emitted once per contractor with no filing for a concluded month (007 FR-010).
 *
 * The payload contract for feature 004's reminders engine, which is the intended
 * subscriber and does not exist yet. Nothing listens to this today — that is
 * deliberate. Publishing into a bus with no subscriber is inert, and defining the
 * shape now is what lets 004 be built against a real interface rather than one
 * invented later and retrofitted here.
 */
export interface ComplianceMissingEvent {
  contractorProfileId: string;
  contractorName: string;
  companyId: string;
  /** `YYYY-MM` of the month with no filing. */
  month: string;
}
