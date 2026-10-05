import type * as ExcelJS from 'exceljs';

import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
} from '../bill-workbook.types';

/**
 * One measurement sheet, per schedule line (023 FR-030 to FR-035).
 *
 * Two layers, as the client's own sheets have them: the monthly claim table with its remarks and
 * the bill each claim went out on, and beneath it the daily record where the line's work is a
 * machine running.
 *
 * **The item is identified inside the sheet** (FR-024a), because the sheet's *name* is positional —
 * `M-001` — and positional names are what make 312 sheets impossible to lose. A name drawn from a
 * BOQ number or a description collides or truncates, and a workbook with a missing sheet opens
 * perfectly.
 *
 * **A date with no logbook entry prints "no record", not zero** (FR-034). A run of zeroes states
 * that the machine did not move, which is an argument for a deduction; "no record" states that
 * nobody wrote it down, which is an argument for finding out.
 */
export function writeMeasurementSheet(
  sheet: ExcelJS.Worksheet,
  item: WorkbookMeasurementSheet,
  view: BillWorkbookView,
): void {
  const title = sheet.addRow([`MEASUREMENT SHEET — ${view.header.billLabel}`]);
  title.font = { bold: true, size: 12 };
  sheet.mergeCells(title.number, 1, title.number, 6);

  // The item, inside the sheet. This is the line FR-024a's naming rule depends on: the name says
  // where the sheet sits, and this says what it is about.
  const identity = sheet.addRow(['BOQ No.', item.boqNo, 'UOM', item.unit]);
  identity.getCell(1).font = { bold: true };
  identity.getCell(3).font = { bold: true };
  const description = sheet.addRow(['Description', item.description]);
  description.getCell(1).font = { bold: true };
  sheet.mergeCells(description.number, 2, description.number, 6);
  description.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  sheet.addRow([]);

  const head = sheet.addRow([
    'S.No',
    'Month',
    'Period',
    `Qty (${item.unit})`,
    'Remarks',
    'RA Bill',
  ]);
  head.font = { bold: true };

  item.history.forEach((claim, index) => {
    const row = sheet.addRow([
      index + 1,
      claim.month,
      claim.period,
      claim.quantity,
      // Verbatim (FR-032). The remark is the argument the document exists to settle.
      claim.remarks ?? '',
      claim.billLabel,
    ]);
    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    // An over-claim is visible where it was made (FR-006a), not only in an aggregate report.
    if (claim.overClaimed) row.getCell(4).font = { bold: true, italic: true };
  });

  const footer = sheet.addRow([
    '',
    '',
    'This Bill Qty',
    item.footer.thisBillQty,
  ]);
  footer.font = { bold: true };
  sheet.addRow([
    '',
    '',
    'Upto Previous Qty',
    item.footer.uptoPreviousQty,
  ]).font = {
    bold: true,
  };
  sheet.addRow(['', '', 'Up to date Qty', item.footer.uptoDateQty]).font = {
    bold: true,
  };

  if (item.dailyRecord.length > 0) {
    sheet.addRow([]);
    const dailyHead = sheet.addRow([
      'Sr',
      'Date',
      'Start KM',
      'End KM',
      'Total Run',
      'Remarks',
    ]);
    dailyHead.font = { bold: true };

    item.dailyRecord.forEach((day, index) => {
      const row = sheet.addRow([
        index + 1,
        day.date,
        day.missing ? 'no record' : day.openingReading ?? '',
        day.missing ? 'no record' : day.closingReading ?? '',
        day.missing ? 'no record' : day.totalRun ?? '',
        day.missing ? 'No logbook entry for this date' : day.remarks ?? '',
      ]);
      row.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    });
  }

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 28;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 60;
  sheet.getColumn(6).width = 18;
}
