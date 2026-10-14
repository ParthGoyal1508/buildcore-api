/**
 * The number a subcontractor's non-BOQ award line prints as (2026-10-14).
 *
 * An award line tied to a BOQ line takes that line's number. One tied to none — work the BOQ does
 * not list, awarded on the work order — has no number of its own, and printed blank on the bill and
 * its documents. It is numbered here as the client's non-BOQ items are, `NB-1`, `NB-2`…, counting
 * only the untied lines, **in award order**: `createdAt`, then `id`, because the award editor saves
 * its lines in one statement and they share a timestamp.
 */
export function nonBoqAwardNo(ordinal: number): string {
  return `NB-${ordinal}`;
}

/** The order award lines are listed and numbered in, everywhere. */
export const AWARD_LINE_ORDER = [
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/** Compares two award lines in award order, for `Array.prototype.sort`. */
export function compareAwardLines(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
