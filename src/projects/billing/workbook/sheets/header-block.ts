import type * as ExcelJS from 'exceljs';

import type { WorkbookHeader } from '../bill-workbook.types';

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
  const rows: [string, string | null, string, string | null][] = [
    [
      'Company Name',
      header.issuer.name,
      'SAP WO No.',
      header.externalWorkOrderNo,
    ],
    [
      'Name of Sub-Contractor',
      header.receiver.name,
      'SAP Bill No.',
      header.externalBillNo,
    ],
    [
      'Nature of Work',
      header.natureOfWork,
      'Bill Period',
      `${header.periodFrom} to ${header.periodTo}`,
    ],
    ['Location', header.location, 'Bill Date', header.billDate],
    ['Vendor Code', header.receiver.code, 'Bill No.', header.billLabel],
    [
      'Vendor GSTN No.',
      header.receiver.gstin,
      'Company GSTN No.',
      header.issuer.gstin,
    ],
    ['Vendor PAN No.', header.receiver.pan, 'State', header.receiver.state],
  ];

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
