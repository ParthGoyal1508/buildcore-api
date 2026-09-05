/**
 * Every tunable this module would otherwise inline (Constitution Principle III).
 *
 * The numbers people reach for first are deliberately *not* here, for the reason
 * `plant.constants.ts` gives about fuel tolerance: a document's alert window is a
 * per-doc-type column, the depreciation rate and inspection interval are per-category
 * columns, and the repair-cost threshold is per category too. Putting them here would
 * have been the same hardcoding one layer further out.
 */

/** Page size for every asset list, matching `plant`, `inventory` and `projects`. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Infix for asset codes from the company's ASSETS series: `{shortCode}-AST-0001`. */
export const ASSET_CODE_INFIX = 'AST';
/** Infix for request numbers from the ASSET_REQUEST series: `{shortCode}-ARQ-0001`. */
export const ASSET_REQUEST_INFIX = 'ARQ';

/** Months per year, for the straight-line depreciation of spec FR-019. */
export const MONTHS_PER_YEAR = 12;

/**
 * Upload ceiling for an asset document, matching 006's equipment documents.
 *
 * Base64 inflates by a third, so the decoded ceiling is what is checked — a client
 * that sends a 10MB file sees the same limit it was told about.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Object-storage prefix for asset documents. */
export const ASSET_DOCUMENT_PREFIX = 'asset-documents';

/** Whole days in a day, for the date arithmetic below. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The seven categories a new company starts with (spec US1).
 *
 * Same reasoning as 006's `DEFAULT_EQUIPMENT_CATEGORIES` and 009's
 * `DEFAULT_ITEM_CATEGORIES`: an empty master blocks the first asset anyone tries to
 * register, and User Stories 2–7 are meant to be independently testable without an
 * admin visiting User Story 1's screen first.
 *
 * Every name here comes from the spec's own scope note. `trackingMode` follows the
 * item: nobody signs for an individual scaffolding pipe, and nobody treats two
 * laptops as fungible. Custody is required only where one person can reasonably be
 * held accountable for one unit, and an inspection interval is set only where a
 * periodic check is a real practice — a due date nobody intends to honour trains
 * people to ignore the reminder.
 *
 * Kept in step with the backfill in
 * `20260904200002_project_assets_permissions_and_masters`, which seeds the same seven
 * for companies that already existed when this feature shipped.
 */
export const DEFAULT_ASSET_CATEGORIES = [
  {
    name: 'SCAFFOLDING',
    trackingMode: 'bulk',
    depreciationRatePercent: 15,
    usefulLifeYears: 7,
    custodyRequired: false,
    inspectionRequired: false,
    inspectionIntervalDays: null,
  },
  {
    name: 'SHUTTERING',
    trackingMode: 'bulk',
    depreciationRatePercent: 20,
    usefulLifeYears: 5,
    custodyRequired: false,
    inspectionRequired: false,
    inspectionIntervalDays: null,
  },
  {
    name: 'FORMWORK',
    trackingMode: 'bulk',
    depreciationRatePercent: 20,
    usefulLifeYears: 5,
    custodyRequired: false,
    inspectionRequired: false,
    inspectionIntervalDays: null,
  },
  {
    name: 'POWER TOOLS',
    trackingMode: 'serialised',
    depreciationRatePercent: 25,
    usefulLifeYears: 4,
    custodyRequired: true,
    inspectionRequired: true,
    inspectionIntervalDays: 180,
  },
  {
    name: 'SAFETY EQUIPMENT',
    trackingMode: 'bulk',
    depreciationRatePercent: 33,
    usefulLifeYears: 3,
    custodyRequired: false,
    inspectionRequired: true,
    inspectionIntervalDays: 90,
  },
  {
    name: 'IT ASSETS',
    trackingMode: 'serialised',
    depreciationRatePercent: 33,
    usefulLifeYears: 3,
    custodyRequired: true,
    inspectionRequired: false,
    inspectionIntervalDays: null,
  },
  {
    name: 'SITE FURNITURE',
    trackingMode: 'bulk',
    depreciationRatePercent: 15,
    usefulLifeYears: 7,
    custodyRequired: false,
    inspectionRequired: false,
    inspectionIntervalDays: null,
  },
] as const;

/** The six document types a new company starts with, each with its own notice. */
export const DEFAULT_ASSET_DOC_TYPES = [
  { name: 'INSURANCE', alertDays: 45 },
  { name: 'WARRANTY', alertDays: 30 },
  { name: 'CALIBRATION CERTIFICATE', alertDays: 30 },
  { name: 'TEST CERTIFICATE', alertDays: 30 },
  { name: 'AMC CONTRACT', alertDays: 45 },
  { name: 'PURCHASE INVOICE', alertDays: 30 },
] as const;

/**
 * The condition ladder a new company starts with, best first.
 *
 * These matter more than the other two defaults: a return maps its grade to the
 * asset's next status through `isDamaged` / `isScrap` (spec FR-015), so an empty
 * grade list does not merely inconvenience the register — it makes returning an asset
 * impossible.
 *
 * POOR deliberately carries neither flag. A worn but working item is still usable,
 * and forcing it into the repair queue would make the queue meaningless.
 */
export const DEFAULT_CONDITION_GRADES = [
  { name: 'NEW', sequence: 1, isDamaged: false, isScrap: false },
  { name: 'GOOD', sequence: 2, isDamaged: false, isScrap: false },
  { name: 'FAIR', sequence: 3, isDamaged: false, isScrap: false },
  { name: 'POOR', sequence: 4, isDamaged: false, isScrap: false },
  { name: 'DAMAGED', sequence: 5, isDamaged: true, isScrap: false },
  { name: 'SCRAP', sequence: 6, isDamaged: false, isScrap: true },
] as const;
