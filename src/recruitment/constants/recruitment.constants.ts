/** Recruitment module constants (011). Company-configurable policy values live in
 * config, not here — these are structural. */

/** Object-storage namespaces for recruitment blobs (encrypted at rest — FR-024). */
export const RESUME_NAMESPACE = 'recruitment-resume';
export const LETTER_NAMESPACE = 'recruitment-letter';

/** Requisition code series infix (`{shortCode}-REQ-0001`). */
export const REQUISITION_CODE_INFIX = 'REQ';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Characters kept visible when masking PII to its last 4 (FR-006). */
export const PII_VISIBLE_CHARS = 4;
