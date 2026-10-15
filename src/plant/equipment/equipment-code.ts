/**
 * How a machine's code is built: `JCB01/2027`, `TM01/2024` (2026-10-11).
 *
 * Three parts — a short prefix naming the kind of machine, a serial that counts
 * within that prefix, and the manufacturing year. The yard reads these aloud and
 * paints them on the machine, which is why the year is in the code at all: two
 * identical backhoes are told apart by the year far more reliably than by a running
 * number nobody can see from across a site.
 *
 * The serial counts **per prefix, not per company** — JCB01, JCB02, TM01 — so this
 * does not come from `CodeSeriesService`, whose counter is keyed by company and
 * series. That is the whole reason equipment has its own allocator.
 */

import {
  NAMED_SERIES_DEFAULT,
  namedCode,
  namedPrefixFor,
  namedSerialOf,
} from '../../settings/code-series/code-series.formats';

/**
 * Kept as the names this module and its spec have always used; the rules now live in
 * `code-series.formats.ts`, shared with assets, and the serial width and separator a company sets
 * in Settings → Numbering are applied by `EquipmentService` (2026-10-15). These three use the
 * built-in format.
 */
export const equipmentPrefixFor = namedPrefixFor;

/** `JCB` + 1 + 2027 → `JCB01/2027`. */
export function equipmentCode(
  prefix: string,
  serial: number,
  year: number,
): string {
  return namedCode(NAMED_SERIES_DEFAULT, prefix, serial, year);
}

/** The serial `code` uses under `prefix`, or null if it is not one of these codes. */
export function serialOf(code: string, prefix: string): number | null {
  return namedSerialOf(NAMED_SERIES_DEFAULT, code, prefix);
}
