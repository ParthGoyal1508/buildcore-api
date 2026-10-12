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
};

/** Renders the `n`th allocation of a series. */
export function formatCode(format: CodeSeriesFormat, n: number): string {
  return (
    format.prefix +
    String(format.base + n * format.step).padStart(format.width, '0')
  );
}
