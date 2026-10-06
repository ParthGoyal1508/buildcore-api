/**
 * Every way a daily work report operation can be refused (022 contract).
 *
 * **Each names its own condition, and that is the requirement rather than a courtesy.** The person
 * who hit one needs a different action for each: fix a field, get somebody else to approve, revise
 * a bill first, unlock the project, or stop trying because it already happened. One "could not save
 * the report" sends all of them to the same place, which is nowhere.
 *
 * Two of these deserve reading before they are used.
 *
 * `MEASUREMENT_BILLED` is a **floor, not provenance** (FR-020, research §4). Nothing in the schema
 * links a bill line to the measurement it consumed, so "has this report been billed" is not a
 * question the database can answer. What it can answer is whether reversing would drop a BOQ line's
 * done quantity below the quantity already billed against it. The message must therefore say what
 * was actually checked, because a message claiming the stronger thing would be a lie that survives
 * into a support conversation.
 *
 * `NOTHING_TO_REPAIR` refuses rather than silently succeeding (FR-039c). A caller who asked to
 * repair a drift they were chasing needs to learn it is already gone — a 200 would tell them their
 * repair worked, which is a different and false thing.
 */
export const DWR_ERRORS = {
  // ── Recording ────────────────────────────────────────────────────────────
  /** A factor supplied as 0, which would zero the line (FR-004). Names the factor. */
  factorZero: 'DWR_FACTOR_ZERO',
  /** Measurement factors sent on a presence-paid line (FR-030b). Refused, not ignored. */
  factorsOnPresenceLine: 'DWR_FACTORS_ON_PRESENCE_LINE',
  /** A served quantity below a full day with no remark (FR-030c). */
  shortDayNeedsRemark: 'DWR_SHORT_DAY_NEEDS_REMARK',
  /** A report describes a day that happened (FR-025). */
  workDateInFuture: 'DWR_WORK_DATE_IN_FUTURE',
  /** The BOQ line belongs to another project. Names both. */
  boqItemOtherProject: 'DWR_BOQ_ITEM_OTHER_PROJECT',
  /**
   * The BOQ line is on the project's **internal estimate**, not its contract schedule (027).
   *
   * A project may carry two schedules describing the same work, and a tender section and its
   * costing twin read identically in a picker. Measuring against the costing one moves a `doneQty`
   * that no bill will ever draw on, that the alerts deliberately ignore, and that no client has
   * agreed to — so the day's work is recorded and then absent from progress, which is worse than
   * refusing it.
   */
  boqItemIsEstimate: 'DWR_BOQ_ITEM_IS_ESTIMATE',

  // ── Lifecycle ────────────────────────────────────────────────────────────
  /** Nothing to assert — refused at submission, accepted as a draft (FR-024). */
  noLines: 'DWR_NO_LINES',
  /** Not in the status this transition requires. Names the status it is in. */
  wrongStatus: 'DWR_WRONG_STATUS',
  /** Already approved — and the counter does not move a second time (FR-014). */
  alreadyApproved: 'DWR_ALREADY_APPROVED',
  /** The approver submitted it (FR-012a, decision D2). */
  approverIsAuthor: 'DWR_APPROVER_IS_AUTHOR',
  /** An approved report cannot be edited. The message names the reversal path (FR-018). */
  approvedNotEditable: 'DWR_APPROVED_NOT_EDITABLE',
  /** A line could not be moved, so none were (FR-013, FR-013a). Names the line. */
  approvalIncomplete: 'DWR_APPROVAL_INCOMPLETE',

  // ── Reversal ─────────────────────────────────────────────────────────────
  /** A reversal moves a quantity a bill may depend on, so it states why (FR-019). */
  reversalNeedsReason: 'DWR_REVERSAL_NEEDS_REASON',
  /**
   * Reversing would drop a BOQ line's done quantity **below the quantity already billed against
   * it** on a bill that has left draft (FR-020). Names the bill.
   *
   * A floor rather than provenance — see this file's docblock.
   */
  measurementBilled: 'DWR_MEASUREMENT_BILLED',
  /** Would drive a counter negative, which only drift can cause (FR-021). */
  reversalBelowZero: 'DWR_REVERSAL_BELOW_ZERO',

  // ── Reading and reconciliation ───────────────────────────────────────────
  /** `to` precedes `from` (FR-038). */
  rangeInverted: 'DWR_RANGE_INVERTED',
  /** A repair moves a counter, so it states why (FR-039c). */
  repairNeedsReason: 'DWR_REPAIR_NEEDS_REASON',
  /** The named lines have no discrepancy. Refused, not silently successful (FR-039c). */
  nothingToRepair: 'DWR_NOTHING_TO_REPAIR',
} as const;

export type DwrErrorCode = (typeof DWR_ERRORS)[keyof typeof DWR_ERRORS];

/**
 * Reported alongside a 2xx rather than instead of it (FR-025, US1 AC8).
 *
 * The distinction is the point: each of these is a fact worth telling somebody and **not** a reason
 * to refuse the write. A work date before the project's start date is usually a start date that was
 * corrected late, not invented work; a second report for a day happens when two crews work two
 * stretches. Refusing either would lose a real day's record to protect a tidiness nobody asked for.
 */
export const DWR_WARNINGS = {
  /** The work date precedes `Project.startDate` (FR-025). */
  workDateBeforeProjectStart: 'DWR_WORK_DATE_BEFORE_PROJECT_START',
  /** Another report already covers this project and date (US1 AC8). Names it. */
  dateAlreadyReported: 'DWR_DATE_ALREADY_REPORTED',
  /** A line whose quantity passes its BOQ line's scope (FR-006). Flagged, never refused. */
  exceedsScope: 'DWR_LINE_EXCEEDS_SCOPE',
  /** A line references no BOQ line, so it moves nothing and feeds no period figure (FR-007). */
  lineWithoutBoqItem: 'DWR_LINE_WITHOUT_BOQ_ITEM',
} as const;

export type DwrWarningCode = (typeof DWR_WARNINGS)[keyof typeof DWR_WARNINGS];
