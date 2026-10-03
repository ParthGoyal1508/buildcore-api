/**
 * The form two unit spellings are compared on (008 FR-041).
 *
 * **Case, punctuation and whitespace — nothing else.** The client's file spells 12 units 25 ways,
 * and stripping periods alone is not enough: it leaves `R.Mtr.` as `rmtr` and `R. Mtr.` as
 * `r mtr`, so the running-metre family fails to unify. That was the first implementation's actual
 * result, measured, which is why whitespace is in the list.
 *
 * **It deliberately does not merge different words.** `Rm`, `R Mtr.` and `Mtr.` normalise to three
 * different forms and stay three units. Deciding that a running metre and a metre are the same
 * thing is a judgement about *meaning*; this function is about *spelling*, and a function that
 * quietly did both would merge units nobody asked it to the first time a tender used an
 * abbreviation we had not seen.
 */
export function normaliseUnit(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`()]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Labels that appear **in the units column** but are not units (FR-041).
 *
 * `Excess (+)` is the one the client's file carries: on the quoted-rate footer row it sits in the
 * units column with the percentage beside it in the rate column. A normaliser that did not know
 * this would invent a unit called `excess+` out of a footer and attach it to nothing.
 */
const NOT_UNITS = new Set(['excess+', 'excess-', 'less-', 'atpar', 'select']);

/**
 * The unit as the source spelled it, or null where the cell is a footer label or blank.
 *
 * **Surrounding whitespace is trimmed, and that is the one deviation from FR-041's "verbatim".**
 * Measured on the client's file: 25 raw spellings, of which four differ from another only by a
 * trailing space (`Cum ` / `Cum`, `Sqm ` / `Sqm`, `Kg. ` / `Kg.`, `Each ` / `Each`). Keeping them
 * apart would list the same visible spelling twice in the units summary, which reads as a defect in
 * the report rather than as a faithful record. 21 visibly distinct spellings resolve to 12 units.
 * Nothing else is touched: internal spacing, case and punctuation are all kept.
 */
export function unitOrNull(raw: string | number | null): string | null {
  if (raw === null) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  return NOT_UNITS.has(normaliseUnit(text)) ? null : text;
}
