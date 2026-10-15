import type * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from '../bill-workbook.types';
import { writeDebitNoteSheet as writeNote } from '../debit-note-document';
import { writeHeaderBlock } from './header-block';

/**
 * The last sheet — the debit notes this bill recovers (2026-10-15), each in the client's own
 * format, one under the other. A bill that recovers none still carries the sheet, saying so, so
 * all four sections are always there to be checked.
 */
export function writeDebitNoteSheet(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  view: BillWorkbookView,
): void {
  if (view.debitNotes.length === 0) {
    writeHeaderBlock(sheet, view.header, 'DEBIT NOTE');
    sheet.addRow([]);
    sheet.addRow(['', 'No debit note is recovered on this bill.']);
    sheet.getColumn(1).width = 6;
    sheet.getColumn(2).width = 60;
    return;
  }
  let row = 1;
  for (const note of view.debitNotes) {
    // Two blank rows between notes, so each prints as its own document.
    row = writeNote(workbook, sheet, note, row) + 2;
  }
}
