/**
 * Naming the sheets of a workbook so that **none of them can be lost** (023 FR-024a).
 *
 * ## The failure this exists for
 *
 * A spreadsheet sheet name is limited to **31 characters**, may not contain `: \ / ? * [ ]`, and
 * must be unique within the workbook. A 312-item schedule named from BOQ numbers or descriptions
 * breaks all three at once — and what the writer does about it decides whether an item's sheet
 * silently disappears, is renamed to something nobody can find, or throws half way through
 * producing a document somebody is waiting for.
 *
 * `checklists/silent-failure.md` CHK040 found that no requirement addressed naming at all. The
 * reason it matters more here than it sounds: **a workbook with a missing sheet opens perfectly.**
 * Nothing about it looks wrong. A reviewer paging through 312 measurement sheets does not notice
 * that there are 311, and the item that lost its sheet is the item nobody checks.
 *
 * ## The rule
 *
 * Measurement sheets are named by **position**, not by content: `M-001`, `M-002`, … That cannot
 * collide, cannot exceed the cap, and cannot contain a reserved character — and the item each sheet
 * belongs to is printed **inside** the sheet, where a reader can see it and where no character
 * limit applies. Naming by content is the thing that fails; naming by position is the thing that
 * cannot.
 *
 * The five fixed sheets keep readable names, which are short by construction and checked here
 * anyway, because a constant somebody edits later is a constant nobody re-checks.
 */

/** A spreadsheet's hard limit. Not a style choice. */
export const SHEET_NAME_MAX = 31;

/** Characters a sheet name may not contain, because a path separator means something to the format. */
export const SHEET_NAME_FORBIDDEN = /[:\\/?*[\]]/;

export const FIXED_SHEET_NAMES = {
  checkList: 'Check List',
  abstract: 'Abstract',
  schedule: 'BOQ Annexure-I',
  debitRegister: 'Debit Note',
} as const;

/** A sheet name that is too long, reserved-charactered, or empty. Thrown rather than trimmed. */
export class InvalidSheetNameError extends Error {
  constructor(
    readonly name: string,
    readonly why: 'too_long' | 'forbidden_character' | 'empty' | 'duplicate',
  ) {
    super(`Sheet name ${JSON.stringify(name)} is invalid: ${why}.`);
    // Thrown rather than silently corrected. A corrected name is a sheet a reader cannot find by
    // the name they were given, and a silent correction is how one of 312 sheets goes missing
    // without the workbook looking wrong.
    this.name = 'InvalidSheetNameError';
  }
}

/**
 * The name of the nth measurement sheet, 1-based.
 *
 * `M-001`. Positional and therefore collision-free: two items with identical descriptions, or
 * descriptions differing only after the 31st character, still get two sheets.
 */
export function measurementSheetName(position: number): string {
  return `M-${String(position).padStart(3, '0')}`;
}

/**
 * Checks a name against all three limits, and against the names already used.
 *
 * Called for **every** sheet the renderer adds, including the fixed ones. The cost is nothing and
 * the alternative is trusting a constant nobody will look at again.
 */
export function assertSheetName(name: string, used: Set<string>): string {
  if (name.trim().length === 0) throw new InvalidSheetNameError(name, 'empty');
  if (name.length > SHEET_NAME_MAX) {
    throw new InvalidSheetNameError(name, 'too_long');
  }
  if (SHEET_NAME_FORBIDDEN.test(name)) {
    throw new InvalidSheetNameError(name, 'forbidden_character');
  }
  if (used.has(name)) throw new InvalidSheetNameError(name, 'duplicate');
  used.add(name);
  return name;
}
