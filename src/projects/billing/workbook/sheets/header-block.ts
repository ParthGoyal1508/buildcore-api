import type * as ExcelJS from 'exceljs';

import type { WorkbookHeader } from '../bill-workbook.types';
import { headerPairs } from '../header-pairs';

/**
 * The statutory header block every sheet in the client's package repeats (023 FR-025, FR-026).
 *
 * **This is where the feature's two bindings actually live**, and it is one function rather than
 * two. The user's first sentence about this feature was "one renderer, two bindings; the two party
 * names are the stated variables" — so the direction has already been resolved upstream into
 * `issuer` and `receiver`, and this function does not know which is the company. Two functions here
 * would be two layouts that drift apart, and the drift would show up as a government bill that
 * stopped matching the subcontractor one.
 *
 * A missing identifier prints blank (FR-027). A bill that cannot be produced because a permanent
 * account number is unrecorded is worse than one produced with a gap somebody fills in by hand —
 * and the gap is listed on the check-list sheet so nobody has to notice the blank.
 */
export function writeHeaderBlock(
  sheet: ExcelJS.Worksheet,
  header: WorkbookHeader,
  title: string,
): number {
  const [left, right] = headerPairs(header);
  const rows: [string, string | null, string, string | null][] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    rows.push([
      left[i]?.[0] ?? '',
      left[i]?.[1] ?? null,
      right[i]?.[0] ?? '',
      right[i]?.[1] ?? null,
    ]);
  }

  const titleRow = sheet.addRow([title]);
  titleRow.font = { bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 4);
  titleRow.alignment = { horizontal: 'center' };

  for (const [leftLabel, leftValue, rightLabel, rightValue] of rows) {
    const row = sheet.addRow([
      leftLabel,
      // Blank, not "null" and not "—": a blank cell is a gap somebody fills with a pen, and any
      // placeholder we invent is a value the client might read as one.
      leftValue ?? '',
      rightLabel,
      rightValue ?? '',
    ]);
    row.getCell(1).font = { bold: true };
    row.getCell(3).font = { bold: true };
  }

  sheet.addRow([]);
  return sheet.rowCount;
}
