/**
 * Every way composing or issuing a bill package can be refused (023 contract).
 *
 * **Each names its own condition, and that is the requirement rather than a courtesy.** The person
 * who hit one needs a different action for each: change the period, price a line, fix the
 * subcontract's mapping, or go and look at the bill that already covers the month. One "could not
 * compose" sends all of them to the same place, which is nowhere.
 *
 * Follows `src/projects/boq/boq-error-codes.ts`, whose own docblock makes the same argument about a
 * BOQ import — and which found that the worst of its refusals, an empty workbook, would otherwise
 * present as a *successful* import of an empty project.
 */
export const PACKAGE_ERRORS = {
  /** `periodTo` precedes `periodFrom`. */
  periodInverted: 'BILL_PERIOD_INVERTED',
  /** Issue was asked of a bill the approval chain has not passed (2026-10-13). */
  notApproved: 'BILL_NOT_APPROVED',
  /** An action was asked of a bill in a status it does not apply to. */
  wrongStatus: 'BILL_WRONG_STATUS',
  /** A deduction line was malformed, or sent for a bill whose abstract has no place for it. */
  deductionLineInvalid: 'BILL_DEDUCTION_LINE_INVALID',
  /**
   * The period overlaps one already billed **on this schedule to this counterparty** (FR-002).
   *
   * Not per project: one project is billed to its client and to several subcontractors over the same
   * month, legitimately, and a per-project rule would refuse the second of those. The refusal names
   * the package that covers the overlap, because a day's measurement claimed on two bills is claimed
   * twice and the remedy is to look at the first one.
   */
  periodOverlaps: 'BILL_PERIOD_OVERLAPS',
  /** This schedule and period already have a package; the existing one is returned (FR-007). */
  packageExists: 'BILL_PACKAGE_EXISTS',
  /** The project has no BOQ lines, or the work order no award lines (FR-011). */
  noSchedule: 'BILL_NO_SCHEDULE',
  /**
   * Two or more award lines map to one BOQ line (FR-003b).
   *
   * Refused rather than resolved by guessing. Measurement is attributed to BOQ lines, so proposing
   * that line's full approved quantity to each award line would claim the same work twice on one
   * bill — and FR-008's one-line-per-item rule would not catch it, because they are two different
   * lines.
   */
  ambiguousAwardMapping: 'BILL_AMBIGUOUS_AWARD_MAPPING',
  /**
   * A required rate is not available. **Refused rather than defaulted to zero**: a silent zero
   * produces a bill with no retention and a payable five per cent too high, which is the error most
   * likely to be paid before anybody notices (research §4).
   */
  rateMissing: 'BILL_RATE_MISSING',
  /** A claim differs from its proposal and no reason was given (FR-004, FR-006). */
  claimNeedsReason: 'BILL_CLAIM_NEEDS_REASON',
  /** The package has been issued; revise it instead (FR-044). */
  packageIssued: 'BILL_PACKAGE_ISSUED',
  /** A work order is required for a bill to a subcontractor, and none was named. */
  workOrderRequired: 'BILL_WORK_ORDER_REQUIRED',
  /**
   * The award has not been approved, so there is nothing approved to bill against (028 FR-009).
   *
   * A work order used to go active the moment one person saved it, while the first bill under it
   * required an approval. This is the refusal that makes the new order of those two mean something.
   */
  workOrderNotApproved: 'WORK_ORDER_NOT_APPROVED',
  /** An unpriced line carries a non-zero claim, refused at **issue** and not at composition. */
  unpricedLineClaimed: 'BILL_UNPRICED_LINE_CLAIMED',
  /** A debit already recovered on another package (FR-037). */
  debitAlreadyRecovered: 'DEBIT_ALREADY_RECOVERED',
  /** A recovery would carry the amount recovered to date past its recorded total (FR-020b). */
  recoveryExceedsTotal: 'BILL_RECOVERY_EXCEEDS_TOTAL',
  /** A non-BOQ item another bill already carries cannot be removed or re-priced (2026-10-14). */
  nonBoqItemInUse: 'NON_BOQ_ITEM_IN_USE',
  /** A subcontractor's non-BOQ items go on the work order, not on the bill (2026-10-14). */
  nonBoqOnSubcontractorBill: 'NON_BOQ_ON_SUBCONTRACTOR_BILL',
  /**
   * Certified quantities line by line, or a certified copy read for them, on a subcontractor's bill
   * (2026-10-15). The company certifies those itself, as one figure; line-by-line certification is
   * the client's, and is what the outstanding BOQ is counted from.
   */
  certifiedLinesClientOnly: 'CERTIFIED_LINES_CLIENT_ONLY',
} as const;

export type PackageErrorCode =
  (typeof PACKAGE_ERRORS)[keyof typeof PACKAGE_ERRORS];
