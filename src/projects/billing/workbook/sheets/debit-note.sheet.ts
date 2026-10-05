import type * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from '../bill-workbook.types';
import { writeHeaderBlock } from './header-block';

/**
 * The last sheet — the debit-note register (023 FR-036 to FR-040a).
 *
 * A register spanning bills rather than a per-bill sheet: every debit on the project appears, with
 * the bill each was debited in, because the running total is the point of it. On an **issued**
 * package this is the register *as at issue* — the view has already applied that cut (FR-039a), and
 * the alternative is a signed document that changes when somebody records a debit next month.
 */
export function writeDebitNoteSheet(
  sheet: ExcelJS.Worksheet,
  view: BillWorkbookView,
): void {
  writeHeaderBlock(sheet, view.header, 'DEBIT NOTE');

  const head = sheet.addRow([
    'Sr',
    'Description',
    'Location',
    'Nos',
    'Length',
    'Width',
    'Quantity',
    'Rate',
    'UOM',
    'Amount',
    'Amount with GST',
    'Remark',
  ]);
  head.font = { bold: true };

  for (const group of view.debitRegister.groups) {
    if (group.heading) {
      const heading = sheet.addRow([group.heading]);
      heading.font = { bold: true };
      sheet.mergeCells(heading.number, 1, heading.number, 12);
    }
    for (const row of group.rows) {
      sheet
        .addRow([
          row.srNo,
          row.description,
          row.location ?? '',
          row.nos ?? '',
          row.length ?? '',
          row.width ?? '',
          row.quantity ?? '',
          row.rate,
          row.unit ?? '',
          row.amount,
          row.amountWithTax,
          // Which RA bill it was debited in. The column that makes the register a register rather
          // than a list.
          row.remark ?? '',
        ])
        .getCell(2).alignment = { wrapText: true, vertical: 'top' };
    }
  }

  const total = sheet.addRow([
    '',
    'Total',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    view.debitRegister.total,
    '',
  ]);
  total.font = { bold: true };

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 60;
  sheet.getColumn(3).width = 18;
  for (const column of [4, 5, 6, 7, 8, 9, 10, 11])
    sheet.getColumn(column).width = 14;
  sheet.getColumn(12).width = 14;
}
