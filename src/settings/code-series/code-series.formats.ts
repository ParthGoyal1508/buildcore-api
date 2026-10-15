import { CodeSeriesType } from '@prisma/client';

/**
 * How one series renders its sequence number (2026-10-11).
 *
 * Every series used to render the same way — `{shortCode}-{infix}-{0001}` — and three
 * of them now do not, because the business reads these codes aloud and types them into
 * other people's systems. A vendor is `2022001`, a work order is `1500001`, a project
 * is `1010`. None of those carries a company short code, and that is safe: all three
 * columns are `@@unique([companyId, code])`, so two companies numbering alike never
 * collide.
 *
 * Declared here as named constants rather than inline literals (Principle III), in one
 * table, so the formats can be read off against each other — which is the only way to
 * notice that two of them would one day overlap.
 */
export interface CodeSeriesFormat {
  /** Fixed leading text. `''` for a series that is a bare number. */
  prefix: string;
  /** What the first allocation counts from. The first code is `base + step`. */
  base: number;
  /** How far apart consecutive codes sit. */
  step: number;
  /** Zero-padding on the numeric part. `0` leaves it unpadded. */
  width: number;
}

/**
 * The series whose format the business has specified. Anything absent keeps the
 * original `{shortCode}-{infix}-{0001}`, which is still right for the internal series
 * nobody quotes outside the system (items, indents, GRNs, requisitions, assets).
 */
export const CODE_SERIES_FORMATS: Partial<
  Record<CodeSeriesType, CodeSeriesFormat>
> = {
  /**
   * Projects: `1010`, `1020`, `1030` — counting from 1000 in steps of 10.
   *
   * The gap is the point. A project inserted between two others later — a phase split,
   * a site that turns out to be its own job — can take 1015 without renumbering
   * anything downstream, which is what people actually do with a numbering plan like
   * this one.
   */
  [CodeSeriesType.PROJECTS]: { prefix: '', base: 1000, step: 10, width: 0 },
  /** Vendors: `2022001`, `2022002`. The 2022 is fixed, not a year that advances. */
  [CodeSeriesType.VENDORS]: { prefix: '2022', base: 0, step: 1, width: 3 },
  /** Work orders: `1500001`, `1500002`. The 150 is fixed. */
  [CodeSeriesType.WORK_ORDER]: { prefix: '150', base: 0, step: 1, width: 4 },
  /** NOCs: `2026001`, `2026002`. The 2026 is fixed, not a year that advances. */
  [CodeSeriesType.NOC]: { prefix: '2026', base: 0, step: 1, width: 3 },
};

/** Renders the `n`th allocation of a series. */
export function formatCode(format: CodeSeriesFormat, n: number): string {
  return (
    format.prefix +
    String(format.base + n * format.step).padStart(format.width, '0')
  );
}

/** The series a company configures in Settings → Numbering (2026-10-15). */
export const COUNTED_SERIES = [
  'PROJECTS',
  'VENDORS',
  'WORK_ORDER',
  'NOC',
] as const;
export const NAMED_SERIES = ['EQUIPMENT', 'ASSETS'] as const;
export type CountedSeries = (typeof COUNTED_SERIES)[number];
export type NamedSeries = (typeof NAMED_SERIES)[number];
export type NumberingSeries = CountedSeries | NamedSeries;

/**
 * A named series — machines and assets: letters taken from the item's name, a serial that counts
 * within those letters, a separator, and the manufacturing year. `JCB01/2027`, `TM01/2024`.
 */
export interface NamedSeriesFormat {
  /** Digits in the serial. `2` → `01`. */
  width: number;
  /** Between the serial and the year. */
  separator: string;
}

/** Parth Realcon's: two-digit serial, a slash, the year. */
export const NAMED_SERIES_DEFAULT: NamedSeriesFormat = {
  width: 2,
  separator: '/',
};

/** `JCB` + 1 + 2027 → `JCB01/2027`. */
export function namedCode(
  format: NamedSeriesFormat,
  prefix: string,
  serial: number,
  year: number,
): string {
  return `${prefix}${String(serial).padStart(format.width, '0')}${
    format.separator
  }${year}`;
}

/**
 * The serial `code` already uses under `prefix`, or null if it is not one of this format's codes —
 * so a plate number somebody typed (`TMX-44`) never moves a series, and `TM01/2024` does not count
 * towards `T`.
 */
export function namedSerialOf(
  format: NamedSeriesFormat,
  code: string,
  prefix: string,
): number | null {
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(
    `^${escape(prefix)}(\\d+)${escape(format.separator)}\\d{4}$`,
  ).exec(code);
  return match ? Number(match[1]) : null;
}

/**
 * The letters a code starts with, from the item's name: a short make or type leading the name is
 * kept whole ("JCB 3DX Backhoe" → `JCB`), otherwise the initials ("Transit Mixer" → `TM`), at most
 * three; a single long word gives its first two letters ("Tipper" → `TI`).
 */
export function namedPrefixFor(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  if (words.length === 0) return 'EQ';
  const [first] = words;
  if (first.length >= 2 && first.length <= 3) return first;
  const initials = words.map((word) => word[0]).join('');
  if (initials.length >= 2) return initials.slice(0, 3);
  return first.slice(0, 2);
}
