/**
 * The order a BOQ reads in.
 *
 * ## The defect
 *
 * `boqNo` is a text column, so `ORDER BY "boqNo"` sorts it as text: **1, 10, 100, 101, 11, 2, 3**.
 * The client's own schedule is numbered 1 to 231 and every screen showing it — the BOQ tree, the
 * bill sheet, a composed bill's lines, the daily-work period figures, the package proposal — was
 * showing that. Finding line 12 meant scrolling past a hundred rows that sort between 1 and 2.
 *
 * ## Why not parse it as a number
 *
 * Because `boqNo` is not one, and treating it as one is wrong in a way that looks right. Real
 * schedules number sub-items `4.1`, `4.2` … `4.10`, and as a float `4.10 === 4.1` — so the tenth
 * sub-item collides with the first and sorts before the second. They also carry suffixes (`12A`,
 * `7(b)`), which `parseFloat` silently truncates to `12` and `7`, putting two different lines in
 * one place with nothing to say which came first.
 *
 * `Intl.Collator` with `numeric: true` compares each run of digits **as a number** and everything
 * else as text, which is the rule people actually mean by "sort it like a BOQ": `1 < 2 < 10`,
 * `4.2 < 4.10`, and `12 < 12A < 13`. Stdlib, one line, and no column to keep in step.
 *
 * ## Applied after the query, not in it
 *
 * Postgres cannot express this without a computed expression Prisma has no syntax for, and none of
 * the eight reads involved pages or limits at the database — each fetches a project's whole
 * schedule, a few hundred rows. Sorting in memory is therefore equivalent and needs no migration.
 * **If one of those reads ever grows a `take`, this stops being equivalent**: the database would
 * choose the page by the old text order and this would only reorder what came back.
 */
const COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

/** Compares two BOQ numbers the way a reader expects them ordered. */
export function compareBoqNo(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

/** Sorts a list of anything carrying a `boqNo`, in place, and returns it. */
export function sortByBoqNo<T extends { boqNo: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => compareBoqNo(a.boqNo, b.boqNo));
}
