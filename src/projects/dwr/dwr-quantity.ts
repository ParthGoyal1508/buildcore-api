import { Prisma } from '@prisma/client';

/**
 * Which quantity governs a measurement line, and the arithmetic behind each (022 FR-003, FR-004,
 * FR-030a, FR-030b, FR-030d, FR-030e).
 *
 * ## Why this is a file of its own rather than four lines inside the service
 *
 * A maintenance contract pays for two different things and the BOQ does not distinguish them. Some
 * lines are *measured* — so much earthwork, so many square metres of seal — and their quantity is
 * the product of six dimensions. Eleven of the seventeen lines in the client's real tender are not
 * measured at all: an ambulance on a monthly rate, a patrolling vehicle, forty security guards a
 * day. What the site records against those is that the asset and its crew were **there and
 * performing**, and the month's claim is a fraction of a month.
 *
 * So there are two quantities, one basis decides which is in force, and **exactly one place knows
 * the rule**. Every path calls `quantityInForce` — create, read, approval, reversal, and the period
 * figures feature 023 bills from — because the alternative is the same `if` written five times and
 * eventually four.
 *
 * ## The number that would otherwise be right by coincidence
 *
 * `DWRTask`'s six factors each default to **1**, so their product is **1** — which is exactly what
 * one day served looks like. A design that stored presence in `actualQty` and computed it from the
 * factors would be correct for every row anybody entered by hand, pass every test written the
 * obvious way, and become silently wrong the first time somebody set a factor on a presence line.
 *
 * That is why the rule here is structural rather than careful:
 *
 * - `PresenceLine` **has no factor fields**, so the `day_basis` branch cannot read one by accident;
 * - the DTO refuses factors on a presence line, so they cannot arrive;
 * - the `DWRTask_quantity_matches_basis` CHECK refuses a row carrying both quantities or neither,
 *   so they cannot be written by any path at all;
 * - and FR-030d states the expected *answer* when the columns are non-default anyway — set by a
 *   seed, a migration or a hand-edit — which is what `dwr-quantity.spec.ts` asserts by setting all
 *   six factors to 7 and demanding the served quantity back unchanged.
 *
 * A prohibition a reviewer has to take on trust is not the same thing as a property a test can
 * fail on. This repository has twice shipped an artefact that was right for a reason unrelated to
 * the reason it was supposed to be right — a guard that passed because a commented-out call still
 * contained the text it searched for, and a PDF import that was correct under the compiler which
 * tested it and wrong under the compiler which shipped it. This is the same shape, caught early.
 *
 * ## Decimal, never number
 *
 * Quantities are `Decimal(18, 3)` in the database and `Prisma.Decimal` here. Six multiplications in
 * binary floating point would introduce an error in the third place of exactly the figure a client
 * is invoiced from, and FR-039a requires reconciliation at an **exact** tolerance — which is only
 * meaningful if nothing upstream has already rounded.
 */

/** The six dimensions of a measured line. Any omitted factor is multiplicatively neutral. */
export interface MeasurementFactors {
  nos1?: Prisma.Decimal.Value | null;
  nos2?: Prisma.Decimal.Value | null;
  length?: Prisma.Decimal.Value | null;
  breadth?: Prisma.Decimal.Value | null;
  depth?: Prisma.Decimal.Value | null;
  density?: Prisma.Decimal.Value | null;
}

/** The six factor names, in the order they multiply, for iteration and for refusal messages. */
export const FACTOR_NAMES = [
  'nos1',
  'nos2',
  'length',
  'breadth',
  'depth',
  'density',
] as const satisfies readonly (keyof MeasurementFactors)[];

export type FactorName = (typeof FACTOR_NAMES)[number];

/** A line whose quantity is measured: the factors govern, there is no served quantity. */
export interface WorkMeasuredLine extends MeasurementFactors {
  paymentMode: 'work_basis';
}

/**
 * A line paid for presence: the served day governs.
 *
 * **Deliberately carries no factor fields.** This is FR-030b expressed as a type rather than as a
 * rule — the `day_basis` branch of `quantityInForce` has nothing to read even if a future edit
 * reached for one.
 */
export interface PresenceLine {
  paymentMode: 'day_basis';
  /** 1 is one full day (FR-030e). 0 means present and performing nothing — not "no record". */
  servedQty: Prisma.Decimal.Value;
}

export type MeasurementLine = WorkMeasuredLine | PresenceLine;

/** Thrown for a factor supplied as 0. Carries the factor's name because the fix is that field. */
export class ZeroFactorError extends Error {
  constructor(readonly factor: FactorName) {
    super(
      `The factor "${factor}" was given as 0, which would zero the whole line.`,
    );
    this.name = 'ZeroFactorError';
  }
}

/** One full day, for a presence-paid line (FR-030e). */
export const FULL_DAY = new Prisma.Decimal(1);

/**
 * `nos1 × nos2 × length × breadth × depth × density` (FR-003, FR-004).
 *
 * An **omitted** factor is 1: an unused dimension should be multiplicatively neutral, which is why
 * the columns default to 1 rather than to 0. A factor supplied **as 0** is refused by name instead,
 * because a product of zero is a data-entry error rather than a day on which nothing was done — the
 * latter is a presence line with a served quantity of 0, or simply no line at all.
 *
 * The distinction matters more than it looks: accepting a zero factor would store a line asserting
 * that measured work happened and amounted to nothing, which is indistinguishable in every later
 * report from work that was measured and came to nothing. One is a typo and the other is a fact.
 */
export function computeMeasuredQty(
  factors: MeasurementFactors,
): Prisma.Decimal {
  let product = new Prisma.Decimal(1);

  for (const name of FACTOR_NAMES) {
    const supplied = factors[name];
    if (supplied === undefined || supplied === null) continue;

    const value = new Prisma.Decimal(supplied);
    if (value.isZero()) throw new ZeroFactorError(name);

    product = product.times(value);
  }

  return product;
}

/**
 * The quantity that governs a line, decided by its payment basis (FR-030a).
 *
 * This figure — and only this figure — moves a BOQ line's done quantity on approval, comes back out
 * of it on reversal, and feeds the period figures a bill is composed from. Nothing else in the
 * feature decides which column to read.
 *
 * The `day_basis` branch does not reference a factor field, and `PresenceLine` does not have one
 * (FR-030b, FR-030d). If a later edit wants to consult the factors for a presence line, it has to
 * change this file's types to do it, which is the point.
 */
export function quantityInForce(line: MeasurementLine): Prisma.Decimal {
  switch (line.paymentMode) {
    case 'work_basis':
      return computeMeasuredQty(line);
    case 'day_basis':
      return new Prisma.Decimal(line.servedQty);
  }
}

/**
 * How a line's two quantity columns are stored, given the basis (FR-030a).
 *
 * Exactly one is non-null, which the `DWRTask_quantity_matches_basis` CHECK also enforces. Returned
 * as a pair rather than written here so the caller stays the only thing touching Prisma.
 */
export function quantityColumnsFor(line: MeasurementLine): {
  actualQty: Prisma.Decimal | null;
  servedQty: Prisma.Decimal | null;
} {
  switch (line.paymentMode) {
    case 'work_basis':
      return { actualQty: computeMeasuredQty(line), servedQty: null };
    case 'day_basis':
      return { actualQty: null, servedQty: new Prisma.Decimal(line.servedQty) };
  }
}

/**
 * The quantity in force for a line **as it came back from the database**, where both columns exist
 * and one is null.
 *
 * Separate from `quantityInForce` on purpose. That function takes *input* and recomputes; this one
 * takes a *stored row* and reads what was stored, because a stored measured quantity is the figure
 * an approval moved and must not be silently recomputed from factors that may since have been
 * edited. Reading and recomputing are different acts and they are different functions.
 */
export function storedQuantityInForce(row: {
  paymentMode: 'work_basis' | 'day_basis';
  actualQty: Prisma.Decimal | null;
  servedQty: Prisma.Decimal | null;
}): Prisma.Decimal {
  const stored =
    row.paymentMode === 'work_basis' ? row.actualQty : row.servedQty;

  if (stored === null) {
    // Unreachable while the CHECK constraint holds. Thrown rather than defaulted to 0, because a
    // missing quantity silently read as nothing is how a bill loses a line.
    throw new Error(
      `A ${row.paymentMode} line has no quantity stored in the column its basis governs. ` +
        'The DWRTask_quantity_matches_basis constraint should have made this impossible.',
    );
  }

  return stored;
}
