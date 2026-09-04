/** Labour module constants (013). Principle III: policy values that belong to the
 * company sit in config/Company, not here — these are structural. */

/** Object-storage namespaces for labour blobs (encrypted at rest — FR-015). */
export const MUSTER_PHOTO_NAMESPACE = 'labour-muster';
export const ACKNOWLEDGEMENT_NAMESPACE = 'labour-acknowledgement';
export const WORKER_FACE_NAMESPACE = 'labour-face';

/** Auto-generated labour-code prefix (e.g. LAB-0001). */
export const LABOUR_CODE_PREFIX = 'LAB';
export const LABOUR_CODE_PAD = 4;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Characters kept visible when masking PII to its last 4 (FR-009). */
export const PII_VISIBLE_CHARS = 4;
