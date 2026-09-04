/**
 * Tunable values for the Inventory module.
 *
 * Constitution Principle III: a number or string that encodes a business rule
 * belongs in one named place, not inline at the point of use where nobody can find
 * every occurrence when the rule changes.
 */

/** Infix for item codes allocated from the company's ITEMS series: `ACME-ITM-0001`. */
export const ITEM_CODE_INFIX = 'ITM';

/** Infix for material indent numbers: `ACME-IND-0001`. */
export const INDENT_CODE_INFIX = 'IND';

/** Infix for goods receipt note numbers: `ACME-GRN-0001`. */
export const GRN_CODE_INFIX = 'GRN';

/** Rows per page when a list request does not say. Matches 007 and 008. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Ceiling on `pageSize`, so a client cannot turn a paginated endpoint into an
 * unbounded table scan by asking for everything at once. Same limit 008 applies.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * The ten categories every company starts with (FR-016, research.md §15).
 *
 * Seeded rather than fixed as an enum, for the reason `DEFAULT_VENDOR_CATEGORIES`
 * records: they are the common case, not the only case, and a company that buys
 * something these ten do not describe must be able to say so without a deploy.
 *
 * Stored uppercase, which is how the service normalises every category name.
 */
export const DEFAULT_ITEM_CATEGORIES = [
  'CEMENT',
  'AGGREGATE',
  'STEEL',
  'BRICKS',
  'SAND',
  'PAINT',
  'ELECTRICAL',
  'PLUMBING',
  'FUEL',
  'CONSUMABLES',
] as const;
