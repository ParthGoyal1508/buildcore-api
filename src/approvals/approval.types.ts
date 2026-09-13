import { ApprovalDecisionAction, ApprovalState } from '@prisma/client';

import { ApprovalErrorCode } from './approval-error-codes';

/**
 * The states that still hold an item's one live chain slot.
 *
 * `returned` is here deliberately: the item is awaiting its originator's correction and
 * has not finished. Excluding it would let a module submit a second instance for an item
 * that is already mid-correction. The partial unique index in
 * `20260913110556_approval_spine` uses exactly this set, and the two must agree.
 */
export const LIVE_STATES: ApprovalState[] = ['pending', 'returned'];

/** True when this state still holds the item's live chain slot. */
export const isLive = (state: ApprovalState): boolean =>
  LIVE_STATES.includes(state);

/**
 * Why the caller cannot act right now (016 FR-011).
 *
 * Four values, and the reason there are four rather than one boolean is that they have
 * four different remedies. `awaiting_other` is "wait". `already_decided` is "you have
 * had your say". `insufficient_authority` is "find the right person".
 * `slot_unmapped` is "open settings" — and it is the one that never resolves itself.
 *
 * `already_decided` is knowable only on the server: the browser has no way to compute
 * that this caller decided at an earlier level, and without this value the interface
 * must fall back to "insufficient authority" — which, said to a Super Admin holding
 * every permission in the system, is simply untrue.
 */
export type InertReason =
  | 'awaiting_other'
  | 'already_decided'
  | 'insufficient_authority'
  | 'slot_unmapped';

/** One recorded act, as the interface renders it. */
export interface ApprovalDecisionView {
  position: number;
  levelLabel: string;
  actorUserId: string;
  /** Resolved for deactivated users too — history must stay readable (FR-008). */
  actorName: string;
  action: ApprovalDecisionAction;
  reason: string | null;
  decidedAt: Date;
  /** Which round of the chain this decision belongs to. */
  round: number;
}

/**
 * Everything the interface needs about one item's approval state, with nothing left for
 * it to infer (016 FR-010, FR-011, T013a).
 *
 * The rule this shape follows: if the browser cannot compute a field correctly, the
 * field is here. `canActNow` and `inertReason` are the two that matter — they depend on
 * the slot mapping, on who else holds the role, and on what this caller has already
 * done, none of which the browser knows.
 */
export interface ApprovalInstanceView {
  instanceId: string;
  companyId: string;
  actionType: string;
  entityType: string;
  entityId: string;

  subject: string;
  href: string | null;

  state: ApprovalState;
  currentPosition: number;
  /** Levels in the chain, so the interface can render "2 of 3" without a second call. */
  totalLevels: number;
  round: number;
  /** Times returned and resubmitted (FR-020), so repetition leaves a visible trace. */
  returnCount: number;

  originatorUserId: string;
  originatorName: string;

  /** The label of the level that decides now — null once the chain is finished. */
  levelLabel: string | null;
  /** The role that level resolves to for this company; null when the slot is unmapped. */
  awaitingRoleName: string | null;
  /**
   * The person it is waiting on, when that is a single person.
   *
   * Null when nobody holds the mapped role, when several people do, or when the chain
   * has finished. A level maps to a *role*, and naming one of five holders would be a
   * guess presented as a fact — so the interface gets the role name always and a person
   * only when there is exactly one.
   */
  awaitingUserName: string | null;
  /** How many active accounts could act at the current level. Zero is a real problem. */
  awaitingHolderCount: number;

  /** Whether *this* caller may record a decision right now. */
  canActNow: boolean;
  /** Why not, when `canActNow` is false. Null when they can act. */
  inertReason: InertReason | null;

  /** The most recent action on the record (FR-008), or null if never acted on. */
  latestDecision: ApprovalDecisionView | null;

  createdAt: Date;
  updatedAt: Date;
}

/** What a module hands over when it puts an item into a chain. */
export interface SubmitApprovalInput {
  companyId: string;
  actionType: string;
  entityType: string;
  entityId: string;
  originatorUserId: string;
  /**
   * What the queue row should say this is about — "Rajesh Kulkarni — 11 Sep, out of
   * geofence". Supplied by the owning module because the spine cannot read the item to
   * build it. This is the practical cost of the no-foreign-key design, and it is paid
   * right here (research.md §1).
   */
  subject: string;
  /** Where to send a reviewer to see the item itself. Also module-supplied, same reason. */
  href?: string | null;
}

/** One decision being recorded. */
export interface DecideApprovalInput {
  instanceId: string;
  action: ApprovalDecisionAction;
  /** Required for `reject` and `return` (FR-006). */
  reason?: string | null;
}

/** One row of the cross-module approval queue (contracts Part 2). */
export interface ApprovalQueueEntry {
  instanceId: string;
  actionType: string;
  entityType: string;
  entityId: string;
  subject: string;
  href: string | null;
  requestedById: string;
  requestedByName: string;
  requestedAt: Date;
  /** Hours since the item entered the chain, so a queue can be sorted by neglect. */
  ageHours: number;
  currentPosition: number;
  levelLabel: string;
}

/** A page of queue entries. */
export interface ApprovalQueuePage {
  items: ApprovalQueueEntry[];
  nextCursor: string | null;
}

/** The shape every refusal from this module carries in its response body. */
export interface ApprovalRefusal {
  statusCode: number;
  message: string;
  code: ApprovalErrorCode;
}
