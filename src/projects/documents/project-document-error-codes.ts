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
/**
 * A creation was refused because a mandatory kind had no document attached (017 FR-009).
 *
 * The message names every missing kind's **label**, never its id: a refusal naming internal
 * identifiers is one the reader cannot act on, which is the same argument that produced FR-007a.
 */
export const PROJECT_DOCUMENTS_MANDATORY_MISSING =
  'PROJECT_DOCUMENTS_MANDATORY_MISSING';

/**
 * A staged document id was not usable (017 FR-009c, plan D10a).
 *
 * **Deliberately the same code for three different situations**: the id does not exist, it belongs
 * to another user, or it belongs to another company. Distinguishing them would let a caller probe
 * for other people's staged uploads — "this one is forbidden" confirms it exists. The refusal says
 * only that the reference is not usable by this caller.
 */
export const PROJECT_STAGED_DOCUMENT_UNKNOWN =
  'PROJECT_STAGED_DOCUMENT_UNKNOWN';

/**
 * A kind cannot be marked mandatory while the company has no document type for it (017 FR-007d).
 *
 * The same refusal the PUT already gives for an unknown type, at a different strength: a mandatory
 * kind nobody can file against would block every project creation with no way to comply.
 */
export const PROJECT_DOCUMENT_KIND_NOT_DEFINED =
  'PROJECT_DOCUMENT_KIND_NOT_DEFINED';

export const PROJECT_DOCUMENT_KIND_NOT_REQUIRED =
  'PROJECT_DOCUMENT_KIND_NOT_REQUIRED';

/**
 * A document was filed against a kind that expires, with no expiry date (2026-10-09).
 *
 * The same refusal `CompanyDocumentsService` gives, and for the same reason: without a date the
 * certificate sits in the system looking present and never warns anybody that it has lapsed. The
 * vocabulary already said so — `DocumentType.hasExpiry` — and this surface was the one that
 * ignored it.
 *
 * Asked for **before the bytes are stored**, so a refusal leaves no orphaned blob behind.
 */
export const PROJECT_DOCUMENT_EXPIRY_REQUIRED =
  'PROJECT_DOCUMENT_EXPIRY_REQUIRED';

export type ProjectDocumentErrorCode =
  | typeof PROJECT_DOCUMENT_TYPE_UNKNOWN
  | typeof PROJECT_DOCUMENTS_MANDATORY_MISSING
  | typeof PROJECT_STAGED_DOCUMENT_UNKNOWN
  | typeof PROJECT_DOCUMENT_KIND_NOT_DEFINED
  | typeof PROJECT_DOCUMENT_KIND_NOT_REQUIRED
  | typeof PROJECT_DOCUMENT_EXPIRY_REQUIRED;
