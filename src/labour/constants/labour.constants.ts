/** Labour module constants (013). Principle III: policy values that belong to the
 * company sit in config/Company, not here — these are structural. */

/** Object-storage namespaces for labour blobs (encrypted at rest — FR-015). */
export const MUSTER_PHOTO_NAMESPACE = 'labour-muster';
export const ACKNOWLEDGEMENT_NAMESPACE = 'labour-acknowledgement';
export const WORKER_FACE_NAMESPACE = 'labour-face';
/** 031: the photo behind each accepted labour face punch. */
export const LABOUR_PUNCH_NAMESPACE = 'labour-punch';
/** 034: a supervisor's group photo of a site, kept for reference only. */
export const LABOUR_SITE_PHOTO_NAMESPACE = 'labour-site-photo';

/** Auto-generated labour-code prefix (e.g. LAB-0001). */
export const LABOUR_CODE_PREFIX = 'LAB';
export const LABOUR_CODE_PAD = 4;

/** 031: face photos taken when registering labour — the same range employee enrolment uses. */
export const ENROLMENT_PHOTOS = { min: 3, max: 5 } as const;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Characters kept visible when masking PII to its last 4 (FR-009). */
export const PII_VISIBLE_CHARS = 4;

/** 036: the largest advance one request may ask for, and the most instalments it may run over. */
export const MAX_ADVANCE_AMOUNT = 1_000_000;
export const MAX_RECOVERY_INSTALMENTS = 104;
