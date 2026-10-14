import { Workbook } from 'exceljs';

import { BoqWorkbookReader } from '../../boq/boq-workbook.reader';
import {
  CertifiedCopyLine,
  readCertifiedCopy,
  unreadableCopy,
} from './certified-copy.reader';

/**
 * Reading a client's certified copy for the quantity passed on each line (2026-10-15).
 *
 * The workbooks are built in memory with exceljs and read back through `BoqWorkbookReader`, so the
 * test sees exactly the plain rows production does — merged-cell gaps, numeric item numbers and all.
 */

const LINES: CertifiedCopyLine[] = [
  {
    lineId: 'l-1',
    boqNo: '1.1',
    description: 'Filling pot-holes and patch repairs',
    unit: 'Sqm',
    billedQty: 100,
    rate: 250,
  },
  {
    lineId: 'l-2',
    boqNo: '1.2',
    description: 'Crack sealing',
    unit: 'Rmt',
    billedQty: 40,
    rate: 90,
  },
  {
    lineId: 'l-3',
    boqNo: '2.10',
    description: 'Cleaning of drains',
    unit: 'Km',
    billedQty: 12,
    rate: 5000,
  },
];

async function sheetsOf(
  build: (workbook: Workbook) => void,
): Promise<Awaited<ReturnType<BoqWorkbookReader['read']>>> {
  const workbook = new Workbook();
  build(workbook);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return new BoqWorkbookReader().read(buffer);
}

describe('reading a certified copy', () => {
  it('reads the client’s abstract format: This Bill Qty under a two-row header', async () => {
    // The shape of the client's own bill format — a group label over Qty. | Amount, merged, so
    // the group text sits in its first cell only.
    const sheets = await sheetsOf((workbook) => {
      const summary = workbook.addWorksheet('Summary');
      summary.addRow(['BILL NO.', 'DESCRIPTION', 'UPTO DATE BILL AMOUNT']);
      summary.addRow([1, 'Road Work', 2500000]);

      const sheet = workbook.addWorksheet('Abstract');
      sheet.addRow(['Name of Work: Ring road O&M']);
      sheet.addRow(['RA Bill - 4']);
      sheet.addRow([
        'Sr.No.',
        'Description of Items',
        'Unit',
        'BOQ.',
        null,
        null,
        'Upto Date Bill',
        null,
        'Previous Bill',
        null,
        'This Bill',
        null,
        'Remark',
      ]);
      sheet.addRow([
        null,
        null,
        null,
        'Qty.',
        'Rate',
        'Amount',
        'Qty.',
        'Amount',
        'Qty.',
        'Amount',
        'Qty.',
        'Amount',
      ]);
      sheet.addRow(['BILL-I ROAD MAINTENANCE']);
      sheet.addRow([
        1.1,
        'Filling pot-holes',
        'Sqm',
        500,
        250,
        0,
        295,
        0,
        200,
        0,
        95,
        0,
      ]);
      sheet.addRow([
        1.2,
        'Crack sealing',
        'Rmt',
        90,
        90,
        0,
        80,
        0,
        40,
        0,
        40,
        0,
      ]);
      sheet.addRow([
        'Total Amount',
        null,
        null,
        null,
        null,
        0,
        null,
        0,
        null,
        0,
        135,
        0,
      ]);
      sheet.addRow([
        9.9,
        'Something not on this bill',
        'Nos',
        1,
        1,
        0,
        3,
        0,
        0,
        0,
        3,
        0,
      ]);

      // A measurement sheet, whose running serial numbers must not be read as items.
      const measurement = workbook.addWorksheet('Measurement item 01');
      measurement.addRow(['Sr. No.', 'Chainage', null, 'Qty.(Sqm.)']);
      measurement.addRow([1, 'From', 'To']);
      measurement.addRow([1, 10, 20, 7]);
    });

    const reading = readCertifiedCopy(sheets, LINES);

    expect(reading.readable).toBe(true);
    expect(reading.columnsUsed).toEqual([
      expect.objectContaining({
        sheet: 'Abstract',
        itemColumn: 'Sr.No.',
        quantityColumn: 'This Bill Qty.',
        basis: 'this_bill',
      }),
    ]);
    const byId = Object.fromEntries(reading.lines.map((l) => [l.lineId, l]));
    expect(byId['l-1']).toMatchObject({
      certifiedQty: 95,
      source: { sheet: 'Abstract', row: 6 },
      matchedBy: 'item_number',
    });
    expect(byId['l-2'].certifiedQty).toBe(40);
    // Not in the file: not found, never assumed passed in full.
    expect(byId['l-3']).toMatchObject({ certifiedQty: null, source: null });
    expect(reading.matchedCount).toBe(2);
    // The total row is skipped; the stray item is reported rather than dropped.
    expect(reading.unmatchedRows).toEqual([
      expect.objectContaining({ itemNo: '9.9', qty: 3, reason: 'no_line' }),
    ]);
  });

  it('prefers a column headed certified over this bill’s', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('RA-04');
      sheet.addRow([
        'Item No',
        'Description',
        'This Bill Qty',
        'Certified Qty',
      ]);
      sheet.addRow(['1.1', 'Filling pot-holes', 100, 95]);
      sheet.addRow(['2.10', 'Cleaning of drains', 12, 0]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.columnsUsed[0]).toMatchObject({
      quantityColumn: 'Certified Qty',
      basis: 'certified',
    });
    const byId = Object.fromEntries(reading.lines.map((l) => [l.lineId, l]));
    expect(byId['l-1'].certifiedQty).toBe(95);
    // Zero is a reading, not an absence.
    expect(byId['l-3'].certifiedQty).toBe(0);
  });

  it('derives this bill as up to date less previous when that is all there is', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Abstract');
      sheet.addRow([
        'S.No',
        'Particulars',
        'Qty upto date',
        'Qty upto previous bill',
      ]);
      sheet.addRow([1.2, 'Crack sealing', 120, 85]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.columnsUsed[0].basis).toBe('upto_date_less_previous');
    expect(
      reading.lines.find((line) => line.lineId === 'l-2')?.certifiedQty,
    ).toBe(35);
  });

  it('matches on the description where the item number is missing', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['Item No.', 'Description of work', 'Passed Qty']);
      sheet.addRow([null, '  Crack   sealing ', '38.5']);
    });
    const line = readCertifiedCopy(sheets, LINES).lines.find(
      (l) => l.lineId === 'l-2',
    );
    expect(line).toMatchObject({
      certifiedQty: 38.5,
      matchedBy: 'description',
    });
  });

  it('matches a numeric item cell to a BOQ number imported as text with a trailing zero', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['BOQ No', 'Quantity']);
      sheet.addRow([2.1, 11]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.columnsUsed[0].basis).toBe('quantity');
    expect(reading.lines.find((l) => l.lineId === 'l-3')?.certifiedQty).toBe(
      11,
    );
  });

  it('reports a line read twice instead of letting the later row win', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['Item No', 'Certified Qty']);
      sheet.addRow(['1.1', 90]);
      sheet.addRow(['1.1', 5]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.lines[0].certifiedQty).toBe(90);
    expect(reading.unmatchedRows).toEqual([
      expect.objectContaining({ row: 3, reason: 'duplicate' }),
    ]);
  });

  it('will not choose between two unlabelled quantity columns', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['Item No', 'Qty (measured)', 'Qty (site)']);
      sheet.addRow(['1.1', 100, 95]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.readable).toBe(false);
    expect(reading.reason).toMatch(/more than one quantity column/);
    expect(reading.lines.every((l) => l.certifiedQty === null)).toBe(true);
  });

  it('never takes the BOQ quantity for a certified one', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['Item No', 'BOQ Qty', 'Rate', 'Amount']);
      sheet.addRow(['1.1', 500, 250, 125000]);
    });
    const reading = readCertifiedCopy(sheets, LINES);
    expect(reading.readable).toBe(false);
    expect(reading.reason).toMatch(/No column of item numbers/);
  });

  it('is unreadable when nothing in the file matches a line on the bill', async () => {
    const sheets = await sheetsOf((workbook) => {
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(['Item No', 'Certified Qty']);
      sheet.addRow(['7.7', 90]);
    });
    expect(readCertifiedCopy(sheets, LINES).readable).toBe(false);
  });

  it('an unreadable copy lists every line for manual entry', () => {
    const reading = unreadableCopy(LINES, 'A PDF cannot be read.');
    expect(reading).toMatchObject({
      readable: false,
      reason: 'A PDF cannot be read.',
      matchedCount: 0,
    });
    expect(reading.lines).toHaveLength(3);
    expect(reading.lines[0]).toMatchObject({
      billedQty: 100,
      certifiedQty: null,
    });
  });
});
