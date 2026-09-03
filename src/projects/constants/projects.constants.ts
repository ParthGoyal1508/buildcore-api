/**
 * Tunable values for the Projects module.
 *
 * Constitution Principle III: a number that encodes a business rule belongs in one
 * named place, not inline at the point of use where nobody can find every occurrence
 * when the rule changes.
 */

/**
 * How far actual spend may exceed budget before the P&L flags a cost overrun (spec
 * FR-009). 0.10 = 10%.
 */
export const COST_OVERRUN_THRESHOLD = 0.1;

/**
 * Upper bound on rows in one BOQ Excel import (spec SC-004). Beyond this the upload
 * is refused with 413 rather than accepted and processed slowly — a 10,000-row paste
 * is nearly always a wrong-file mistake, and failing fast says so.
 */
export const MAX_BOQ_IMPORT_ROWS = 1000;

/** Rows per page when a list request does not say. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Ceiling on `pageSize`, so a client cannot turn a paginated endpoint into an
 * unbounded table scan by asking for everything at once. Matches the limit 007's
 * vendor list already applies.
 */
export const MAX_PAGE_SIZE = 200;

/** Infix for project codes allocated from the company's PROJECTS series: `ACME-PRJ-0001`. */
export const PROJECT_CODE_INFIX = 'PRJ';

/**
 * `423 Locked`, returned by `ProjectLockGuard` for a write to a frozen project.
 *
 * Spelled out because Nest 10's `HttpStatus` enum has no `LOCKED` member — it stops
 * at the codes the framework itself raises, and 423 comes from WebDAV (RFC 4918
 * §11.3). Named here rather than left as a bare `423` at the throw site, per
 * Principle III.
 */
export const HTTP_STATUS_LOCKED = 423;
