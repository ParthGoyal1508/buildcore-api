/**
 * Machine-readable refusals from the project-document surface (017 US2).
 *
 * A stable identifier rather than prose, for the reason 015 established with
 * `SESSION_EXPIRED` and 016 extended across the approval spine: clients branch on the
 * code, and the wording stays free to change.
 */

/**
 * A requirement named a `DocumentType` this company does not have.
 *
 * Refused rather than stored, because a requirement pointing at nothing is a kind no
 * project can ever satisfy — every project would report itself short of a document that
 * cannot be uploaded, and the readiness figure would be permanently, silently wrong.
 */
export const PROJECT_DOCUMENT_TYPE_UNKNOWN = 'PROJECT_DOCUMENT_TYPE_UNKNOWN';

/**
 * A code outside the declared PROJECT set was passed to the kind materialiser (FR-007a).
 *
 * The route exists so a `SETTINGS` holder can bring one of the six kinds FR-007 names
 * into existence. Refusing everything else is what keeps it from reaching the company's
 * eight — which live behind `COMPANY_SETTINGS` — or arbitrary document-type creation,
 * which lives behind `EMPLOYEES`.
 */
export const PROJECT_DOCUMENT_KIND_NOT_REQUIRED =
  'PROJECT_DOCUMENT_KIND_NOT_REQUIRED';

export type ProjectDocumentErrorCode =
  | typeof PROJECT_DOCUMENT_TYPE_UNKNOWN
  | typeof PROJECT_DOCUMENT_KIND_NOT_REQUIRED;
