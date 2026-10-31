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

/** 052: error codes for editing and transferring a worker. */
export const LABOUR_WORKER_ERRORS = {
  /** Setting, changing or clearing a special daily rate needs LABOUR_APPROVE, as site rates do. */
  RATE_NEEDS_APPROVE: 'LABOUR_RATE_NEEDS_APPROVE',
  CONTRACTOR_REQUIRED: 'LABOUR_CONTRACTOR_REQUIRED',
  AADHAAR_EXISTS: 'LABOUR_AADHAAR_EXISTS',
  TRANSFER_SAME_SITE: 'LABOUR_TRANSFER_SAME_SITE',
  TRANSFER_SITE_NOT_FOUND: 'LABOUR_TRANSFER_SITE_NOT_FOUND',
  TRANSFER_SITE_INACTIVE: 'LABOUR_TRANSFER_SITE_INACTIVE',
  TRANSFER_WORKER_INACTIVE: 'LABOUR_TRANSFER_WORKER_INACTIVE',
  /** Punched in and not yet out: the day must close at the site it started at. */
  TRANSFER_ON_SITE: 'LABOUR_TRANSFER_ON_SITE',
} as const;

/** 052: the worker fields an edit may change, in the order the audit log lists them. */
export const WORKER_EDITABLE_FIELDS = [
  'fullName',
  'gender',
  'fatherName',
  'phone',
  'dateOfBirth',
  'skillCategoryId',
  'engagementType',
  'contractorId',
  'aadhaarNumber',
  'bankAccount',
  'rateOverride',
] as const;
