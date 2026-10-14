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

/**
 * An edit to the body or name of a template whose wording this product manages (2026-10-14).
 *
 * The shipped kinds with a standard template (offer, appointment, relieving …) carry the same
 * wording for every company, re-applied on every application start. Accepting the edit would
 * look like it worked and then be silently undone at the next deploy, so it is refused instead.
 */
export const LETTER_TEMPLATE_STANDARD_LOCKED =
  'LETTER_TEMPLATE_STANDARD_LOCKED';

export type LetterErrorCode =
  | typeof DOCUMENT_TYPE_RESTRICTED
  | typeof LETTER_TEMPLATE_MISSING
  | typeof LETTER_ALREADY_ISSUED
  | typeof LETTER_NOT_ISSUED
  | typeof LETTER_KIND_FORBIDDEN
  | typeof SIGNATORY_REQUIRED
  | typeof LETTER_TEMPLATE_STANDARD_LOCKED;

/** An item line on a work order, LOI or purchase order that cannot be read (2026-10-14). */
export const LETTER_LINE_ITEMS_UNREADABLE = 'LETTER_LINE_ITEMS_UNREADABLE';
