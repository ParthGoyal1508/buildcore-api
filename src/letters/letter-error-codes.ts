/**
 * Machine-readable refusals from the letters surface (017 US3, US4, FR-024).
 *
 * `APPROVAL_NOT_COMPLETE` is deliberately **absent** — 016 owns that code and 017
 * consumes it. Re-declaring it here would produce two constants for one condition, and
 * the first client to branch on the wrong one would be silently wrong.
 */

/**
 * A template referenced a restricted `DocumentType` (FR-024).
 *
 * Raised by the resolver rather than by a list of forbidden kinds, so it holds for
 * letter kinds nobody has defined yet — which is the difference between a rule and a
 * note.
 */
export const DOCUMENT_TYPE_RESTRICTED = 'DOCUMENT_TYPE_RESTRICTED';

/** No active template exists for the kind being issued. */
export const LETTER_TEMPLATE_MISSING = 'LETTER_TEMPLATE_MISSING';

/** The letter has already been issued; issuing again is `reissue`. */
export const LETTER_ALREADY_ISSUED = 'LETTER_ALREADY_ISSUED';

/** The letter has not been issued yet, and the operation needs an issued one. */
export const LETTER_NOT_ISSUED = 'LETTER_NOT_ISSUED';

/** The caller's roles do not carry the permission this kind of letter requires. */
export const LETTER_KIND_FORBIDDEN = 'LETTER_KIND_FORBIDDEN';

/** A kind requiring a signature was issued without naming a signatory. */
export const SIGNATORY_REQUIRED = 'SIGNATORY_REQUIRED';

export type LetterErrorCode =
  | typeof DOCUMENT_TYPE_RESTRICTED
  | typeof LETTER_TEMPLATE_MISSING
  | typeof LETTER_ALREADY_ISSUED
  | typeof LETTER_NOT_ISSUED
  | typeof LETTER_KIND_FORBIDDEN
  | typeof SIGNATORY_REQUIRED;
