import type * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from '../bill-workbook.types';
import { writeHeaderBlock } from './header-block';

/**
 * Sheet 2 — the abstract (023 FR-012 to FR-023).
 *
 * Four blocks, three money columns each, in the client's own order: Upto Date, Upto Previous, This
 * Month. Every figure arrives already rounded (FR-012a); this file does no arithmetic at all, which
 * is what makes "produced twice is identical" true of it.
 *
 * **A fully-recovered one-time deduction prints blank in This Month and keeps its cumulative
 * figures** (FR-020a) — which is exactly what the real package's performance security does at
 * 10,57,832 / 10,57,832 / blank. The view carries a flag for it rather than letting this sheet
 * infer it from a zero, because "nothing was recovered this month" and "there is nothing left to
 * recover" print the same character.
 */
export function writeAbstractSheet(
  sheet: ExcelJS.Worksheet,
  view: BillWorkbookView,
): void {
  writeHeaderBlock(sheet, view.header, 'ABSTRACT SHEET');

  const head = sheet.addRow([
    '',
    'Particulars',
    '',
    'Upto Date',
    'Upto Previous',
    'This Month',
  ]);
  head.font = { bold: true };

  for (const block of view.abstract.blocks) {
    const title = sheet.addRow([block.title]);
    title.font = { bold: true };

    block.rows.forEach((row, index) => {
      const written = sheet.addRow([
        row.isTotal ? '' : index + 1,
        row.label,
        'Rs.',
        row.uptoDate,
        row.uptoPrevious,
        // A fully-recovered one-time deduction is blank here, not zero.
        row.fullyRecovered ? '' : row.thisMonth,
      ]);
      if (row.isTotal) written.font = { bold: true };
    });
  }

  sheet.addRow([]);
  const payable = sheet.addRow([
    '',
    view.abstract.payable.label,
    'Rs.',
    view.abstract.payable.uptoDate,
    view.abstract.payable.uptoPrevious,
    view.abstract.payable.thisMonth,
  ]);
  payable.font = { bold: true };

  const net = sheet.addRow([
    '',
    view.abstract.netPayable.label,
    'Rs.',
    view.abstract.netPayable.uptoDate,
    view.abstract.netPayable.uptoPrevious,
    view.abstract.netPayable.thisMonth,
  ]);
  net.font = { bold: true, size: 12 };

  // Which tax applied and how that was decided, on the face of the document (FR-016a). A client
  // record carries no state today, so the fallback is the ordinary path on a bill to a client — and
  // a tax decision nobody can see is a tax decision nobody made.
  sheet.addRow([]);
  sheet.addRow([
    '',
    `Tax basis: ${view.abstract.taxBasis} (${view.abstract.taxBasisSource})`,
  ]);

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 56;
  sheet.getColumn(3).width = 6;
  for (const column of [4, 5, 6]) sheet.getColumn(column).width = 18;
}
