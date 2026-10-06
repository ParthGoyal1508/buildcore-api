import type * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from '../bill-workbook.types';
import { writeHeaderBlock } from './header-block';

/**
 * Sheet 3 — the priced schedule (023 FR-024, FR-029, FR-012b).
 *
 * The scope, then the quantity and amount each split three ways. Descriptions are
 * **multi-paragraph and carried whole** (FR-029): the client's own items run to several hundred
 * characters of sub-specification, and a truncated description is a line somebody disputes.
 *
 * **Every sheet names the bill it belongs to, from one source.** The real workbook's own schedule
 * sheet is headed "RA Bill - 09" inside package RA-12 — an error from copying a sheet between
 * months, and one of the few places this system deliberately does not reproduce the document it
 * is modelled on.
 */
export function writeScheduleSheet(
  sheet: ExcelJS.Worksheet,
  view: BillWorkbookView,
): void {
  writeHeaderBlock(
    sheet,
    view.header,
    `BOQ ANNEXURE-I — ${view.header.billLabel}`,
  );

  const group = sheet.addRow([
    '',
    '',
    '',
    'Scope BOQ',
    '',
    '',
    '',
    'Quantity',
    '',
    '',
    'Amount',
    '',
    '',
  ]);
  group.font = { bold: true };

  const head = sheet.addRow([
    'Sr',
    'BOQ No.',
    'Description',
    'UOM',
    'Qty',
    'Rate',
    'Amount',
    'Balance Qty',
    'Upto Date',
    'Upto Prev',
    'This Bill',
    'Upto Date',
    'Upto Prev',
    'This Bill',
  ]);
  head.font = { bold: true };

  for (const line of view.schedule.lines) {
    const row = sheet.addRow([
      line.srNo,
      line.boqNo,
      line.description,
      line.unit,
      line.scopeQty,
      line.rate,
      line.scopeAmount,
      // Negative where cumulative measurement has passed scope (FR-012b). Shown as the negative it
      // is: "0 remaining" and "12 over" are different facts and a magnitude hides the second.
      line.balanceQty,
      line.qtyUptoDate,
      line.qtyUptoPrevious,
      line.qtyThisBill,
      line.amountUptoDate,
      line.amountUptoPrevious,
      line.amountThisBill,
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  }

  const total = sheet.addRow([
    '',
    '',
    'Total Work Done',
    '',
    '',
    '',
    view.schedule.totals.scopeAmount,
    '',
    '',
    '',
    '',
    view.schedule.totals.amountUptoDate,
    view.schedule.totals.amountUptoPrevious,
    view.schedule.totals.amountThisBill,
  ]);
  total.font = { bold: true };

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 12;
  // Wide, and wrapped. The client's descriptions are paragraphs.
  sheet.getColumn(3).width = 80;
  for (const column of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    sheet.getColumn(column).width = 15;
  }
}
