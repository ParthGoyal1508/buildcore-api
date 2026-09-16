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

/**
 * One required kind: the code to match on, the words a person reads, and the shape of
 * the `DocumentType` that represents it.
 *
 * The three flags were added by the 2026-09-16 amendment (FR-003a). They live here
 * rather than in the route that creates the type because that route must not take them
 * from the request: a caller holding `COMPANY_SETTINGS` names *which* declared kind to
 * materialise and nothing else, which is what stops it being a way around the
 * `EMPLOYEES` permission that guards general document-type creation.
 */
export interface RequiredDocumentKind {
  code: string;
  label: string;
  /** Whether the paper lapses. Drives FR-004's refusal of an upload with no date. */
  hasExpiry: boolean;
  /** Whether it carries a reference number worth recording beside the file. */
  needsNumber: boolean;
  /** Regulated personal data (FR-024). True for Aadhaar and nothing else. */
  isRestricted?: boolean;
}

/**
 * The eight statutory papers FR-002 names.
 *
 * Aadhaar is here because the client asked for it and confirmed it on 2026-09-15. It is
 * regulated personal data and carries handling the other seven do not — see FR-024 and
 * `DocumentType.isRestricted`, which is where that is enforced rather than described.
 */
export const REQUIRED_COMPANY_DOCUMENT_KINDS: RequiredDocumentKind[] = [
  {
    code: 'GST',
    label: 'GST registration certificate',
    hasExpiry: false,
    needsNumber: true,
  },
  {
    code: 'PF',
    label: 'PF establishment certificate',
    hasExpiry: false,
    needsNumber: true,
  },
  {
    code: 'ESIC',
    label: 'ESIC registration certificate',
    hasExpiry: false,
    needsNumber: true,
  },
  // The only one of the eight that lapses. A labour licence is renewed annually, which
  // is exactly what FR-005's reminder exists for.
  {
    code: 'LABOUR_LICENCE',
    label: 'Labour licence',
    hasExpiry: true,
    needsNumber: true,
  },
  { code: 'PAN', label: 'PAN card', hasExpiry: false, needsNumber: true },
  {
    code: 'TAN',
    label: 'TAN allotment letter',
    hasExpiry: false,
    needsNumber: true,
  },
  {
    code: 'AADHAAR',
    label: 'Aadhaar of the authorised signatory',
    hasExpiry: false,
    needsNumber: true,
    isRestricted: true,
  },
  {
    code: 'CANCELLED_CHEQUE',
    label: 'Cancelled cheque',
    hasExpiry: false,
    needsNumber: false,
  },
];

/**
 * The six project papers FR-007 names.
 *
 * Declared here beside the company set because they answer the same question in a
 * different scope, and splitting them across two files is how the two drift.
 */
export const REQUIRED_PROJECT_DOCUMENT_KINDS: RequiredDocumentKind[] = [
  {
    code: 'LOI',
    label: 'Letter of intent',
    hasExpiry: false,
    needsNumber: true,
  },
  {
    code: 'WORK_ORDER',
    label: 'Work order',
    hasExpiry: false,
    needsNumber: true,
  },
  { code: 'INSURANCE', label: 'Insurance', hasExpiry: true, needsNumber: true },
  {
    code: 'MINING_PERMISSION',
    label: 'Mining permission',
    hasExpiry: true,
    needsNumber: true,
  },
  {
    code: 'LABOUR_INSURANCE',
    label: 'Labour insurance',
    hasExpiry: true,
    needsNumber: true,
  },
  {
    code: 'BOQ',
    label: 'Bill of quantities',
    hasExpiry: false,
    needsNumber: false,
  },
];

/** Codes only, for the `IN` clause that drives completeness in one query (FR-003). */
export const REQUIRED_COMPANY_DOCUMENT_CODES: string[] =
  REQUIRED_COMPANY_DOCUMENT_KINDS.map((k) => k.code);

export const REQUIRED_PROJECT_DOCUMENT_CODES: string[] =
  REQUIRED_PROJECT_DOCUMENT_KINDS.map((k) => k.code);
