/**
 * Chainage, in the notation a highway contract is written in (028, reported 2026-10-07).
 *
 * ## `21+300` is one number, not two
 *
 * A road is measured from its start in kilometres and metres: `21+300` is 21 km and 300 m, and the
 * client's own measurement sheet writes every position that way. Stored as `Decimal(18, 3)`
 * kilometres — `21.300` — for a reason that matters more than the notation: a bill measures a
 * **range**, so chainage has to be comparable and sortable. Two text fields reading `21+300` and
 * `9+750` cannot be ordered, and the one that looks larger is smaller.
 *
 * So the number is the storage and the notation is the rendering, which is what these two
 * functions are for.
 */

/** A `Decimal`, as Prisma hands one back. */
interface DecimalLike {
  toFixed(places: number): string;
}

/**
 * `21.300` → `21+300`, for a document a client reads.
 *
 * The metres are **always three digits**: `6+820` and `6+082` are 738 metres apart, and dropping a
 * leading zero on the second prints the first. `0+400` keeps its zero kilometre for the same
 * reason — `+400` is not a chainage anybody writes.
 */
export function formatChainage(
  value: DecimalLike | string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const km =
    typeof value === 'object' ? Number(value.toFixed(3)) : Number(value);
  if (Number.isNaN(km)) return null;

  const sign = km < 0 ? '-' : '';
  const absolute = Math.abs(km);
  // Rounded before splitting, not after: 21.2999999 must print 21+300 rather than 21+299, and the
  // stored column is three decimal places so there is nothing beyond them to lose.
  const metresTotal = Math.round(absolute * 1000);
  const whole = Math.floor(metresTotal / 1000);
  const metres = metresTotal % 1000;
  return `${sign}${whole}+${String(metres).padStart(3, '0')}`;
}

/**
 * `21+300` → `21.300`, for storage. Also accepts a plain decimal, unchanged.
 *
 * Both, because both are typed: somebody reading off the client's sheet types `21+300` and
 * somebody reading off a survey types `21.3`. Refusing either would be a form rejecting the
 * notation its own document is printed in.
 *
 * Returns `null` for anything else, so a caller can refuse rather than storing a guess.
 */
export function parseChainage(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;

  const plus = /^(-?)(\d+)\+(\d{1,3})$/.exec(text);
  if (plus) {
    const [, sign, km, metres] = plus;
    // Padded on the right: `6+82` is 6 km 820 m, which is how a partial entry is meant — the
    // metres are a position within the kilometre, not a count.
    const thousandths = Number(metres.padEnd(3, '0'));
    return `${sign}${Number(km) + thousandths / 1000}`;
  }

  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return null;
}
