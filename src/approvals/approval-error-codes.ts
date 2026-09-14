/**
 * Machine-readable reasons the approval spine refuses something (016 FR-001b, FR-003,
 * contracts/approval-service.md).
 *
 * They are separate codes because they have separate remedies, and a single `403`
 * sends people to fix the wrong thing. The distinction that matters most is between
 * the two that look identical from outside:
 *
 * - `APPROVAL_NOT_AUTHORISED` means *go and get the right person to approve this*.
 * - `APPROVAL_SLOT_UNMAPPED` means *nobody can approve this until somebody opens
 *   settings*, and no amount of finding the right person will help.
 *
 * A shared `403 Forbidden` for both is the reason an administrator spends an afternoon
 * auditing permissions for a problem that lives in a configuration table. Feature 015
 * learned the same lesson about a bare `401` on a session refusal, and the pattern
 * being followed here is that one: clients branch on a stable identifier, never on
 * prose, so the wording stays free to change.
 */

/** The caller's roles do not include the role this level's slot maps to. */
export const APPROVAL_NOT_AUTHORISED = 'APPROVAL_NOT_AUTHORISED';

/**
 * The caller already recorded a decision on this item in this round (FR-021a).
 *
 * This is the code the interface most needs and the one a browser cannot compute.
 * Super Admin holds *every* permission in this system, so without this code the only
 * honest-looking message left is "you do not have permission" — said to the one person
 * who has all of them, who will then go and change permissions that were never the
 * problem.
 */
export const APPROVAL_ALREADY_DECIDED = 'APPROVAL_ALREADY_DECIDED';

/**
 * This level's slot has no role mapped for this company — a configuration fault, not
 * an authorisation failure (FR-001b). Its remedy is a settings screen.
 */
export const APPROVAL_SLOT_UNMAPPED = 'APPROVAL_SLOT_UNMAPPED';

/** The item is not awaiting a decision: already approved, rejected or abandoned. */
export const APPROVAL_NOT_PENDING = 'APPROVAL_NOT_PENDING';

/** Rejection and return both require a stated reason (FR-006). */
export const APPROVAL_REASON_REQUIRED = 'APPROVAL_REASON_REQUIRED';

/**
 * No active chain is configured for this `(company, actionType)` (FR-001b).
 *
 * Raised by `submit()` rather than `decide()`, and deliberately NOT a 403: an item that
 * cannot enter a chain is a setup problem, and reporting it as "forbidden" would have
 * the submitting user asking for permissions they already hold.
 */
export const APPROVAL_CHAIN_NOT_CONFIGURED = 'APPROVAL_CHAIN_NOT_CONFIGURED';

/** A live chain already exists for this item — the double-submit guard (FR-007). */
export const APPROVAL_ALREADY_SUBMITTED = 'APPROVAL_ALREADY_SUBMITTED';

/**
 * A reassignment was attempted by the person the item is currently awaiting.
 *
 * Reassignment exists so an item does not die when an approver leaves (FR-019). It is
 * an administrative act, and letting the current approver use it would turn it into a
 * way to duck one's own level while appearing to act.
 */
export const APPROVAL_REASSIGN_FORBIDDEN = 'APPROVAL_REASSIGN_FORBIDDEN';

/**
 * A slot mapping would make an active chain unsatisfiable (FR-021b) — two of its levels
 * would resolve to the same role.
 *
 * Refused when the mapping is written, not when work stops. Under FR-021a such a chain
 * cannot complete wherever one person holds that role, and the failure is silent,
 * total, and discovered by a payroll run that never moves.
 */
export const APPROVAL_CHAIN_UNSATISFIABLE = 'APPROVAL_CHAIN_UNSATISFIABLE';

/**
 * The caller may not read this item's approval history (FR-009, US3 scenario 4).
 *
 * Distinct from `APPROVAL_NOT_AUTHORISED`, which is about *deciding*. Someone can be
 * entitled to read an item's history without being entitled to act on it, and far more
 * often the reverse — so collapsing the two would have the interface offer "ask for
 * approval rights" to somebody who only wanted to read.
 */
export const APPROVAL_VIEW_FORBIDDEN = 'APPROVAL_VIEW_FORBIDDEN';

/** Every refusal code the spine can return. */
export type ApprovalErrorCode =
  | typeof APPROVAL_NOT_AUTHORISED
  | typeof APPROVAL_ALREADY_DECIDED
  | typeof APPROVAL_SLOT_UNMAPPED
  | typeof APPROVAL_NOT_PENDING
  | typeof APPROVAL_REASON_REQUIRED
  | typeof APPROVAL_CHAIN_NOT_CONFIGURED
  | typeof APPROVAL_ALREADY_SUBMITTED
  | typeof APPROVAL_REASSIGN_FORBIDDEN
  | typeof APPROVAL_CHAIN_UNSATISFIABLE
  | typeof APPROVAL_VIEW_FORBIDDEN;
