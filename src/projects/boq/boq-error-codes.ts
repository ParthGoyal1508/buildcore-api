/**
 * Every way a BOQ import can be refused (008 contract, Amendment 2026-10-03).
 *
 * **Each names its own condition, and that is the requirement rather than a courtesy** (FR-036).
 * The person who hit one needs a different action for each: re-export, re-save, split the file,
 * wait, or look at the project they already imported into. One "import failed" sends all of them
 * to the same place, which is nowhere — and the worst of them, an empty workbook, would otherwise
 * present as a *successful* import of an empty project.
 */
export const BOQ_ERRORS = {
  /** Over the byte cap, refused before parsing (FR-056). */
  fileTooLarge: 'BOQ_FILE_TOO_LARGE',
  /** The bytes are not a workbook either parser recognises. */
  workbookUnreadable: 'BOQ_WORKBOOK_UNREADABLE',
  /** Parsed, no sheets with content — the shape `exceljs` silently returns for a `.xls`. */
  workbookEmpty: 'BOQ_WORKBOOK_EMPTY',
  /** No header row carrying both a description and a quantity column (FR-054). */
  noScheduleBlock: 'BOQ_NO_SCHEDULE_BLOCK',
  /** Block identified, nothing under it. */
  noScheduleRows: 'BOQ_NO_SCHEDULE_ROWS',
  /** Candidate rows found, none importable — no batch is issued (FR-051). */
  noImportableRows: 'BOQ_NO_IMPORTABLE_ROWS',
  /** Over the candidate-row cap (FR-055). */
  tooManyRows: 'BOQ_TOO_MANY_ROWS',
  /** The company or the server is already holding its limit of unconfirmed batches (FR-053). */
  tooManyBatches: 'BOQ_TOO_MANY_BATCHES',
  /** The project already has BOQ lines; appending would double a tender (FR-049). */
  alreadyPopulated: 'BOQ_ALREADY_POPULATED',
  batchNotFound: 'BOQ_BATCH_NOT_FOUND',
  /** Validated more than the TTL ago (FR-053) — distinct from never having existed (FR-052). */
  batchExpired: 'BOQ_BATCH_EXPIRED',
  /** Another confirm of this batch is inside its transaction right now (FR-052). */
  batchInProgress: 'BOQ_BATCH_IN_PROGRESS',
  /** This batch has already been imported. Shown as "already imported", not as a failure. */
  batchAlreadyConfirmed: 'BOQ_BATCH_ALREADY_CONFIRMED',
  /** A different user, or a different project, than the one that validated it (FR-050). */
  batchNotYours: 'BOQ_BATCH_NOT_YOURS',
  /**
   * The database gave up part-way through the write — nothing was committed (2026-10-04).
   *
   * Added because the condition already existed and had no name: a confirm that outran its
   * transaction budget reached the browser as `{"statusCode":500,"message":"Internal server
   * error"}`, which tells the operator neither what happened nor whether half their schedule is
   * now on the project. It is not: the transaction rolls back and the batch is released, so the
   * honest message is "nothing was written, press it again" — and that is a sentence only a
   * named code can carry.
   */
  writeInterrupted: 'BOQ_IMPORT_WRITE_INTERRUPTED',
} as const;

export type BoqErrorCode = (typeof BOQ_ERRORS)[keyof typeof BOQ_ERRORS];
