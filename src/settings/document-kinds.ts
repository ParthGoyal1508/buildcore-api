/**
 * The document kinds a company and a project are expected to hold (017 FR-002, FR-007).
 *
 * Configuration, not literals scattered through services (Constitution Principle III),
 * following the same precedent as `src/approvals/default-chains.ts`.
 *
 * **These are `DocumentType.code` values, not ids.** `DocumentType` is per-company, so
 * every company has its own row for GST — the code is what identifies the *kind* across
 * companies. A company that has not defined a type for one of these codes simply reports
 * it missing, which is the correct answer to "do you hold a GST certificate?".
 */

/** One required kind: the code to match on, and the words a person reads. */
export interface RequiredDocumentKind {
  code: string;
  label: string;
}

/**
 * The eight statutory papers FR-002 names.
 *
 * Aadhaar is here because the client asked for it and confirmed it on 2026-09-15. It is
 * regulated personal data and carries handling the other seven do not — see FR-024 and
 * `DocumentType.isRestricted`, which is where that is enforced rather than described.
 */
export const REQUIRED_COMPANY_DOCUMENT_KINDS: RequiredDocumentKind[] = [
  { code: 'GST', label: 'GST registration certificate' },
  { code: 'PF', label: 'PF establishment certificate' },
  { code: 'ESIC', label: 'ESIC registration certificate' },
  { code: 'LABOUR_LICENCE', label: 'Labour licence' },
  { code: 'PAN', label: 'PAN card' },
  { code: 'TAN', label: 'TAN allotment letter' },
  { code: 'AADHAAR', label: 'Aadhaar of the authorised signatory' },
  { code: 'CANCELLED_CHEQUE', label: 'Cancelled cheque' },
];

/**
 * The six project papers FR-007 names.
 *
 * Declared here beside the company set because they answer the same question in a
 * different scope, and splitting them across two files is how the two drift.
 */
export const REQUIRED_PROJECT_DOCUMENT_KINDS: RequiredDocumentKind[] = [
  { code: 'LOI', label: 'Letter of intent' },
  { code: 'WORK_ORDER', label: 'Work order' },
  { code: 'INSURANCE', label: 'Insurance' },
  { code: 'MINING_PERMISSION', label: 'Mining permission' },
  { code: 'LABOUR_INSURANCE', label: 'Labour insurance' },
  { code: 'BOQ', label: 'Bill of quantities' },
];

/** Codes only, for the `IN` clause that drives completeness in one query (FR-003). */
export const REQUIRED_COMPANY_DOCUMENT_CODES: string[] =
  REQUIRED_COMPANY_DOCUMENT_KINDS.map((k) => k.code);

export const REQUIRED_PROJECT_DOCUMENT_CODES: string[] =
  REQUIRED_PROJECT_DOCUMENT_KINDS.map((k) => k.code);
