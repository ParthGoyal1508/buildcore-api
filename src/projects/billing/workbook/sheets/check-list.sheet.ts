import type * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from '../bill-workbook.types';
import { writeHeaderBlock } from './header-block';

/**
 * Sheet 1 — the check list (023 FR-041 to FR-043a).
 *
 * Six questions, in the client's order, with three answer columns and the responsibility footer.
 *
 * **An unanswered question is blank in all three columns, not a tick in "No"** (FR-042). "We checked
 * and it is not attached" and "nobody has looked" call for different actions from whoever is holding
 * the bill, and collapsing them is the whole failure the nullable answer exists to prevent.
 */
export function writeCheckListSheet(
  sheet: ExcelJS.Worksheet,
  view: BillWorkbookView,
): void {
  writeHeaderBlock(sheet, view.header, 'CHECK LIST for Subcontractor Bill');

  const head = sheet.addRow([
    'S. No.',
    'Check list',
    'Yes',
    'No',
    'Not required',
  ]);
  head.font = { bold: true };

  for (const row of view.checkList.rows) {
    sheet.addRow([
      row.position,
      row.text,
      row.answer === 'yes' ? 'Y' : '',
      row.answer === 'no' ? 'N' : '',
      row.answer === 'not_required' ? 'Not required' : '',
    ]);
  }

  sheet.addRow([]);
  const footer = sheet.addRow([view.checkList.footer]);
  sheet.mergeCells(footer.number, 1, footer.number, 5);
  footer.alignment = { wrapText: true, vertical: 'top' };

  sheet.addRow([]);
  sheet.addRow([...view.checkList.signatories]).font = { bold: true };
  sheet.addRow(['Name & Designation', 'Name & Designation']);
  sheet.addRow(['_________________________', '________________________']);

  // The gaps, named rather than left for somebody to spot among the blanks (FR-027, FR-043a). The
  // sheet reports them; it never refuses to exist because of them.
  if (view.header.missingFields.length > 0) {
    sheet.addRow([]);
    const gaps = sheet.addRow([
      `Not on file at the time this bill was produced: ${view.header.missingFields.join(
        ', ',
      )}`,
    ]);
    sheet.mergeCells(gaps.number, 1, gaps.number, 5);
    gaps.alignment = { wrapText: true };
  }

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 70;
  sheet.getColumn(3).width = 8;
  sheet.getColumn(4).width = 8;
  sheet.getColumn(5).width = 14;
}
