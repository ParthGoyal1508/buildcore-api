/**
 * Machine-readable refusals from the company-document surface (017 FR-004, FR-024).
 *
 * Separate codes because they have separate remedies, and clients branch on a stable
 * identifier rather than on prose — the contract 015 established with `SESSION_EXPIRED`
 * and 016 extended across the approval spine. Wording stays free to change.
 */

/**
 * The kind expires and no expiry date was supplied (FR-004).
 *
 * Refused rather than stored with a null date: a certificate whose expiry nobody recorded
 * cannot raise the reminder FR-005 promises, so it would sit in the system looking present
 * and silently never warn anyone.
 */
export const DOCUMENT_EXPIRY_REQUIRED = 'DOCUMENT_EXPIRY_REQUIRED';

/** No `DocumentType` exists for the supplied id, or it belongs to another company. */
export const DOCUMENT_TYPE_NOT_FOUND = 'DOCUMENT_TYPE_NOT_FOUND';

/**
 * A restricted kind was referenced where restricted kinds may not go (FR-024).
 *
 * Reserved here for the company-document surface; the letter template resolver raises the
 * same code, because from a caller's point of view it is the same rule.
 */
export const DOCUMENT_TYPE_RESTRICTED = 'DOCUMENT_TYPE_RESTRICTED';

export type CompanyDocumentErrorCode =
  | typeof DOCUMENT_EXPIRY_REQUIRED
  | typeof DOCUMENT_TYPE_NOT_FOUND
  | typeof DOCUMENT_TYPE_RESTRICTED;
