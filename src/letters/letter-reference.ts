/**
 * The reference a letter is filed under (2026-10-11).
 *
 * ## The shape, and why this one
 *
 * The client's own documents carry two: `PRPL/HR/2026-27/` on Parth Realcon's relieving
 * letter and `TE/2026-27/HR/` on Tirupati's appointment letter — the same four parts in a
 * different order, which is what happens when a reference is typed by hand. One form is
 * picked rather than made configurable: a per-company reference format is a setting
 * somebody has to fill in before any letter can be issued, to express a difference neither
 * company meant to have.
 *
 * `HR` appears only on a letter addressed to a person. A work order carries
 * `PRPL/2026-27/0007`, because filing an award to a subcontractor under HR is wrong in a
 * way that would be noticed exactly once, by an auditor.
 *
 * ## The year is the Indian financial year
 *
 * `2026-27` runs 1 April 2026 to 31 March 2027. Not the calendar year: every reference
 * series in the client's documents is stated this way, and a company's letter numbering
 * restarting in January would not match any other record they keep.
 */

/** Where the running number starts each April, and how wide it prints. */
const FIRST = 1;
const WIDTH = 4;

/** April. The month the Indian financial year turns, zero-indexed. */
const FY_START_MONTH = 3;

/**
 * The financial year a date falls in, as `2026-27`.
 *
 * Takes a `Date` rather than reading the clock so the caller owns the time zone question.
 * Letters are issued against the server's day, which is what `formatLetterDate` prints.
 */
export function financialYear(when: Date): string {
  const year =
    when.getMonth() >= FY_START_MONTH
      ? when.getFullYear()
      : when.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/**
 * Everything before the running number, including the trailing slash.
 *
 * Separated from the number so the allocator can ask "what is the highest already issued
 * under this prefix?" — which is also what makes the series reset itself each April with
 * no scheduled job and no counter to reset.
 */
export function referencePrefix(
  companyShortCode: string,
  forAPerson: boolean,
  when: Date,
): string {
  const parts = [companyShortCode];
  if (forAPerson) parts.push('HR');
  parts.push(financialYear(when));
  return `${parts.join('/')}/`;
}

/** `PRPL/HR/2026-27/0001`. */
export function formatReference(prefix: string, serial: number): string {
  return `${prefix}${String(serial).padStart(WIDTH, '0')}`;
}

/**
 * The running number in a reference, or null if it does not belong to this prefix.
 *
 * Used to find the highest already allocated. Null rather than 0 for a non-match, because
 * 0 is a number this would otherwise have to pretend it had seen.
 */
export function serialOf(reference: string, prefix: string): number | null {
  if (!reference.startsWith(prefix)) return null;
  const tail = reference.slice(prefix.length);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

/**
 * The next reference under a prefix, given every reference already issued under it.
 *
 * ponytail: a MAX over the company's existing references rather than a counter row, the
 * same shape `equipment-code.ts` uses. It costs one indexed read per issue and it resets
 * each April on its own, where a counter would need a row per company per year and a job
 * to roll it over. The ceiling is two letters issued in the same millisecond taking the
 * same number — which `@@unique([companyId, referenceNo])` turns into a 409 to retry
 * rather than two letters filed as one. Move to a counter if that is ever seen.
 */
export function nextReference(prefix: string, existing: string[]): string {
  const highest = existing.reduce(
    (max, reference) => Math.max(max, serialOf(reference, prefix) ?? 0),
    FIRST - 1,
  );
  return formatReference(prefix, highest + 1);
}
