/**
 * Tunable values for the Dashboard module.
 *
 * Constitution Principle III: a number that encodes a business rule belongs in one
 * named place, not inline at the point of use where nobody can find every occurrence
 * when the rule changes.
 *
 * Feature 004 is being built in slices. Only the reminders engine exists today, so
 * only its constants are here; the widget refresh interval and the async-export row
 * threshold arrive with T003/T004.
 */

/**
 * When the nightly evaluation sweep runs (spec FR-032/FR-033).
 *
 * 06:30 rather than midnight: reminders are read at the start of a working day, and a
 * sweep that lands just before people arrive means the ledger reflects today's dates
 * rather than yesterday's. Every rule's window is measured in whole days, so a run
 * more often than daily would emit nothing new.
 */
export const REMINDER_SWEEP_CRON = '30 6 * * *';

/**
 * Ceiling on reminders returned in one list response.
 *
 * The list is computed, not paginated — every registered rule is evaluated on every
 * request, so there is no cursor to page from. This is a guard against a
 * misconfigured rule (a lead window of 3650 days over ten thousand records) turning
 * one request into a response nobody can render, not a paging mechanism: it is set
 * far above any plausible real total, and the response says when it has bitten.
 */
export const MAX_REMINDERS_PER_RESPONSE = 500;

/** Milliseconds in a day, for whole-day arithmetic over calendar dates. */
export const MS_PER_DAY = 86_400_000;
