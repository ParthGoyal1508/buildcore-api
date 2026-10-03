import { WorkbookRow, WorkbookSheet } from './boq-workbook.reader';

/**
 * Which columns of which sheet hold the schedule (008 FR-054).
 *
 * **Identified by header text, never by column position.** The client's sheet is 243 columns wide
 * and carries a second item-shaped block at columns 238–242 — artefacts of the e-tender template's
 * other BOQ types, which the workbook names in its own defined names (Percentage, Item Rate,
 * Discount, Negative, Turnkey). Excluding that block *by its position* would be a rule about one
 * file; excluding it for being **outside the identified span** is a rule that still holds for the
 * next tender, which will put its own second block somewhere else. The same span rule disposes of
 * stray values in column 57 on two heading rows without having to know they exist.
 */
export interface ScheduleColumns {
  description: number;
  quantity: number;
  unit: number;
  /** The schedule's reference rate — what a Percentage BoQ prices against. */
  rate: number;
  /** The bidder's own per-line rate, where the workbook has one and it is used (FR-039). */
  bidderRate: number | null;
  /** The source's stated line amount, kept only to reconcile against (FR-044). */
  amount: number | null;
  /** First and last column of the block; everything outside is not ours to read (FR-042). */
  firstColumn: number;
  lastColumn: number;
}

export interface IdentifiedSchedule {
  sheetName: string;
  headerRowNumber: number;
  columns: ScheduleColumns;
  /** Rows after the header, inside the block — candidates, not yet validated (FR-055). */
  candidates: WorkbookRow[];
  /**
   * The rows after the header that carry **no description** — which is where the totals live.
   *
   * Kept apart from the candidates rather than discarded: `Total in Figures` and `Quoted Rate in
   * Figures` sit in the first column with the figure in the amount column, so they are not schedule
   * lines and they are not noise either. FR-045's reconciliation has nothing to reconcile against
   * without them.
   */
  footer: WorkbookRow[];
}

const DESCRIPTION_PATTERNS = [
  /item\s*description/i,
  /description\s*of\s*(item|work)/i,
  /^particulars/i,
];
const QUANTITY_PATTERNS = [/^qu?ant/i, /^qty/i];
const UNIT_PATTERNS = [/^units?$/i, /^uom$/i];
const RATE_PATTERNS = [/^rate$/i, /^estimated\s*rate/i, /^bsr\s*rate/i];
const BIDDER_RATE_PATTERNS = [
  /basic\s*rate/i,
  /rate.*entered\s*by\s*the\s*bidder/i,
];
const AMOUNT_PATTERNS = [/^total\s*amount/i, /^amount$/i];

function matchColumn(
  cells: (string | number | null)[],
  patterns: RegExp[],
): number | null {
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (typeof cell !== 'string') continue;
    // Header cells carry embedded newlines ("Sl.\nNo.", "BASIC RATE In Figures...\nRs.   P") —
    // collapsed before matching, because the line break is a layout decision in the source.
    const text = cell.replace(/\s+/g, ' ').trim();
    if (patterns.some((pattern) => pattern.test(text))) return index;
  }
  return null;
}

/**
 * @returns null when no sheet carries a header row with both a description and a quantity column,
 *   which the caller turns into `BOQ_NO_SCHEDULE_BLOCK`. Never a guess: a schedule read from the
 *   wrong columns produces a plausible, wrong tender.
 */
export function identifySchedule(
  sheets: WorkbookSheet[],
): IdentifiedSchedule | null {
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const description = matchColumn(row.cells, DESCRIPTION_PATTERNS);
      const quantity = matchColumn(row.cells, QUANTITY_PATTERNS);
      // Both, because either alone matches too much: "Description" appears in covering notes and
      // "Quantity" appears in summary blocks that carry no items.
      if (description === null || quantity === null) continue;

      const unit = matchColumn(row.cells, UNIT_PATTERNS);
      const rate = matchColumn(row.cells, RATE_PATTERNS);
      if (unit === null || rate === null) continue;

      const populated = row.cells
        .map((cell, index) => (cell === null || cell === '' ? null : index))
        .filter((index): index is number => index !== null);
      const columns: ScheduleColumns = {
        description,
        quantity,
        unit,
        rate,
        bidderRate: matchColumn(row.cells, BIDDER_RATE_PATTERNS),
        amount: matchColumn(row.cells, AMOUNT_PATTERNS),
        firstColumn: Math.min(...populated),
        lastColumn: Math.max(...populated),
      };

      const after = sheet.rows
        .filter((candidate) => candidate.rowNumber > row.rowNumber)
        .map((candidate) => ({
          rowNumber: candidate.rowNumber,
          // Clipped to the block. Everything past `lastColumn` is another BOQ type's leftovers
          // (FR-042) — excluded for being outside the span, not for sitting at a known position.
          cells: candidate.cells.slice(0, columns.lastColumn + 1),
        }));
      const hasDescription = (candidate: WorkbookRow) => {
        const description = candidate.cells[columns.description];
        return typeof description === 'string' && description.trim().length > 0;
      };

      return {
        sheetName: sheet.name,
        headerRowNumber: row.rowNumber,
        columns,
        candidates: after.filter(hasDescription),
        footer: after.filter((candidate) => !hasDescription(candidate)),
      };
    }
  }
  return null;
}

/**
 * **Headings are counted as candidates.** They are rows of the schedule — 80 of the client's 311 —
 * and a cap applied to a figure that excluded them would be a different cap than FR-055 specifies.
 * Rows that will later be rejected are counted too, for the same reason: the cap bounds the work
 * the request does, and rejecting a row is work.
 */
