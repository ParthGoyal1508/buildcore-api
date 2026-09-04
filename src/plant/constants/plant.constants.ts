/**
 * Every tunable this module would otherwise inline (Constitution Principle III).
 *
 * The two numbers people reach for first — the fuel variance threshold and a
 * document's alert window — are deliberately *not* here: they are per-category and
 * per-doc-type columns, because a tower crane and a tipper do not deserve the same
 * fuel tolerance and an insurance policy and a pollution certificate are not renewed
 * on the same notice. The original spec had both as hardcoded literals (`> 15`, 30
 * days); research.md §10 corrected that, and putting them in this file would have
 * been the same mistake one layer further out.
 */

/** Page size for every plant list, matching `inventory` and `projects`. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Infix for equipment codes allocated from the company's EQUIPMENT series:
 * `{shortCode}-EQP-0001`. */
export const EQUIPMENT_CODE_INFIX = 'EQP';

/**
 * How close to `nextDueReading` a service schedule reads as `due_soon`
 * (research.md §4).
 *
 * In meter units, so 50 means 50 hours for an hours-metered machine and 50 km for a
 * km-metered one. A single figure rather than one per meter type because the number
 * is a warning margin, not a physical quantity: both say "you have a little time,
 * book the service".
 */
export const SERVICE_DUE_SOON_MARGIN = 50;

/**
 * Fallback denominator for utilisation % when a category does not set one.
 *
 * 22 working days × 8 hours. Mirrors `EquipmentCategory.targetHoursPerMonth`'s
 * column default so a category row written before that default existed still
 * computes rather than dividing by zero.
 */
export const DEFAULT_TARGET_HOURS_PER_MONTH = 176;

/** Months per year, for the straight-line depreciation the P&L apportions
 * (research.md §5): `purchaseCost × depreciationRate / 100 / 12` per month. */
export const MONTHS_PER_YEAR = 12;

/**
 * The ten categories a new company starts with.
 *
 * Same reasoning as 009's `DEFAULT_ITEM_CATEGORIES`: an empty master blocks the
 * first machine anyone tries to register, and User Stories 2–8 are meant to be
 * independently testable without an admin visiting User Story 1's screen first.
 *
 * `meterType` follows the machine — a crane's life is measured in running hours, a
 * tipper's in kilometres. `fuelBenchmark` is deliberately left unset rather than
 * guessed: a wrong benchmark flags variance on every entry from day one, which
 * teaches people to ignore the flag.
 */
export const DEFAULT_EQUIPMENT_CATEGORIES = [
  { name: 'EXCAVATOR', meterType: 'hours' },
  { name: 'LOADER', meterType: 'hours' },
  { name: 'CRANE', meterType: 'hours' },
  { name: 'TIPPER', meterType: 'km' },
  { name: 'TRANSIT MIXER', meterType: 'km' },
  { name: 'CONCRETE PUMP', meterType: 'hours' },
  { name: 'BATCHING PLANT', meterType: 'hours' },
  { name: 'COMPACTOR', meterType: 'hours' },
  { name: 'GENERATOR', meterType: 'hours' },
  { name: 'DEWATERING PUMP', meterType: 'hours' },
] as const;

/** The six document types a new company starts with, with the notice each one
 * realistically needs. */
export const DEFAULT_EQUIPMENT_DOC_TYPES = [
  { name: 'REGISTRATION CERTIFICATE', alertDays: 60 },
  { name: 'INSURANCE', alertDays: 45 },
  { name: 'FITNESS CERTIFICATE', alertDays: 45 },
  { name: 'POLLUTION CERTIFICATE', alertDays: 15 },
  { name: 'PERMIT', alertDays: 30 },
  { name: 'OPERATOR LICENCE', alertDays: 30 },
] as const;

/** Largest document this module accepts, in bytes. Matches 007's contractor
 * documents — the same base64-in-JSON upload path, so the same ceiling. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
