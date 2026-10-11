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

/** Separates the serial from the year. */
const YEAR_SEPARATOR = '/';
/** Serial width. `01`, not `1` — two digits is what the examples carry. */
const SERIAL_WIDTH = 2;
/** The longest prefix taken from a name. `JCB` fits; `TRANSIT` does not. */
const MAX_PREFIX = 3;

/**
 * The prefix for a machine named `name`.
 *
 * Two rules, in order, because the names people actually type fall into two shapes:
 *
 * 1. **A short make or type leads the name** — "JCB 3DX Backhoe Loader" → `JCB`. If
 *    the first alphabetic word is already 2–3 letters it *is* the abbreviation, and
 *    initialising it would throw away the thing everyone calls the machine. Two
 *    letters minimum: "L&T 9020 Excavator" splits to L / T / EXCAVATOR, and a bare
 *    `L` would be shared by every Liebherr, Leyland and loader in the yard.
 * 2. **Otherwise, initials** — "Transit Mixer" → `TM`, "Tower Crane" → `TC`. Capped
 *    at three, so "Self Loading Concrete Mixer" is `SLC` rather than `SLCM`.
 *
 * A single long word ("Tipper") initialises to one letter, which is no use as a
 * prefix, so it falls back to its first two letters: `TI`.
 *
 * It is a heuristic and will occasionally pick something the yard would not have.
 * That is survivable because the escape hatch predates it: `CreateEquipmentDto.code`
 * is honoured whenever it is supplied, and most machines arrive with a plate number
 * already.
 */
export function equipmentPrefixFor(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  if (words.length === 0) return 'EQ';

  const [first] = words;
  if (first.length >= 2 && first.length <= MAX_PREFIX) return first;

  const initials = words.map((word) => word[0]).join('');
  if (initials.length >= 2) return initials.slice(0, MAX_PREFIX);
  return first.slice(0, 2);
}

/** `JCB` + 1 + 2027 → `JCB01/2027`. */
export function equipmentCode(
  prefix: string,
  serial: number,
  year: number,
): string {
  return `${prefix}${String(serial).padStart(
    SERIAL_WIDTH,
    '0',
  )}${YEAR_SEPARATOR}${year}`;
}

/**
 * The serial already used by `code`, if it belongs to this prefix.
 *
 * Matched on the prefix **plus the shape of what follows**, so `TM01/2024` does not
 * count towards `T`'s series and a hand-entered plate number like `TMX-44` counts
 * towards nothing. Returns null for anything that is not one of our codes — the yard's
 * own numbers must not move the series.
 */
export function serialOf(code: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d+)\\${YEAR_SEPARATOR}\\d{4}$`).exec(
    code,
  );
  return match ? Number(match[1]) : null;
}
