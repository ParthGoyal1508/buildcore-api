/**
 * Every refusal the billing surface can give (018 FR-002, FR-003, FR-004).
 *
 * Named constants rather than literals at the throw sites, for the reason feature 017's
 * `letter-kind-error-codes.ts` has them: a client branches on these strings, and a typo in one is a
 * refusal the interface renders as an unexplained failure.
 */
export const BILLING_ERRORS = {
  /**
   * A BOQ line whose rate is still 0 (FR-002).
   *
   * **Refused rather than billed at zero.** The rate column defaults to 0 because the table was
   * already populated, so 0 means "nobody has priced this" far more often than it means "free". A bill
   * carrying a zero line is a bill whose total is quietly short, and it looks finished.
   */
  rateMissing: 'BOQ_RATE_MISSING',
  /** The project has no BOQ at all, so there is nothing to bill against. */
  boqRequired: 'BOQ_REQUIRED',
  /**
   * An over-scope line at submit with no reason given (FR-003).
   *
   * The flag is raised at composition and tolerated there; this is the gate. Over-measurement is often
   * correct and always worth a sentence.
   */
  overScopeReasonRequired: 'OVER_SCOPE_REASON_REQUIRED',
  /** A bill that has left draft cannot have its lines changed. */
  notDraft: 'BILL_NOT_DRAFT',
  /** Certifying something that was never submitted. */
  notSubmitted: 'BILL_NOT_SUBMITTED',
  /** A bill with no lines. Submitting one would send a client a document saying nothing. */
  noLines: 'BILL_HAS_NO_LINES',
  /** Two bills on one project cannot share a number. */
  duplicateNumber: 'BILL_NUMBER_IN_USE',
  /** A measured quantity past what the work order awarded, with no variation to cover it. */
  exceedsAward: 'RA_BILL_EXCEEDS_AWARD',
  /** Certifying more than was billed. The client cannot certify work nobody claimed. */
  certifiedExceedsBilled: 'CERTIFIED_EXCEEDS_BILLED',
  /**
   * Revising a bill's quantities without saying why (FR-009, FR-016).
   *
   * A certified bill going round again costs somebody a second decision, and "why" is the first
   * thing they will ask. Required rather than encouraged, because an optional field on this path is
   * an empty field.
   */
  revisionReasonRequired: 'RA_BILL_REVISION_REASON_REQUIRED',
  /**
   * Revising a pre-018 bill that has no work-order award behind it.
   *
   * Those bills have `amount` and nothing else — no lines, no award, no rate. Inventing an award to
   * re-measure against would be a fiction, so the refusal says to raise a new bill instead.
   */
  awardRequired: 'RA_BILL_HAS_NO_AWARD',
  /**
   * Releasing more retention than was ever withheld (FR-016a).
   *
   * The one refusal this whole ledger exists for. Retention released past the balance is money the
   * company never held being paid out as though it had, and nothing downstream would catch it: the
   * bills it was withheld from are already closed, and the subcontractor is not going to query a
   * payment in their favour.
   */
  retentionExceedsHeld: 'RETENTION_EXCEEDS_HELD',
  /** A release with no reason. "Which milestone was this against" is asked within the year. */
  retentionReasonRequired: 'RETENTION_RELEASE_REASON_REQUIRED',
} as const;
