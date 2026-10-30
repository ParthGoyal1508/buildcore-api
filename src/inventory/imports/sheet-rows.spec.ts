import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import {
  cellDate,
  cellNumber,
  looseNameKey,
  nameKey,
  readSheetRows,
} from './sheet-rows';

const toBase64 = async (workbook: ExcelJS.Workbook) =>
  Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');

describe('sheet-rows (051)', () => {
  describe('cellDate', () => {
    it('reads the sheet’s DD-MM-YYYY, with -, / or . separators', () => {
      expect(cellDate('01-04-2026')).toBe('2026-04-01');
      expect(cellDate('1/4/2026')).toBe('2026-04-01');
      expect(cellDate('01.04.2026')).toBe('2026-04-01');
    });

    it('reads an Excel date cell and a date serial', () => {
      expect(cellDate(new Date('2026-04-01T00:00:00Z'))).toBe('2026-04-01');
      // 46113 is 01-04-2026 in Excel's 1900 date system.
      expect(cellDate(46113)).toBe('2026-04-01');
    });

    it('is null when empty and invalid for an impossible or unreadable date', () => {
      expect(cellDate(null)).toBeNull();
      expect(cellDate('31-02-2026')).toBe('invalid');
      expect(cellDate('April 1')).toBe('invalid');
    });
  });

  describe('cellNumber', () => {
    it('reads numbers, grouped text and a rupee sign', () => {
      expect(cellNumber(12.5)).toBe(12.5);
      expect(cellNumber('1,25,000.50')).toBe(125000.5);
      expect(cellNumber('₹ 412')).toBe(412);
      expect(cellNumber({ formula: 'A1*2', result: 8 } as never)).toBe(8);
    });

    it('is null when empty and NaN for text', () => {
      expect(cellNumber(null)).toBeNull();
      expect(cellNumber('  ')).toBeNull();
      expect(cellNumber('ten')).toBeNaN();
    });
  });

  it('compares names on case and spacing, or on letters and digits alone', () => {
    expect(nameKey('  acc   Cement ')).toBe(nameKey('ACC CEMENT'));
    expect(nameKey('ACC-Cement')).not.toBe(nameKey('ACC Cement'));
    expect(looseNameKey('Shree Traders Pvt. Ltd.')).toBe(
      looseNameKey('SHREE TRADERS PVT LTD'),
    );
  });

  describe('readSheetRows', () => {
    const columns = [
      { key: 'item' as const, label: 'Item Name', headers: [], required: true },
      {
        key: 'qty' as const,
        label: 'Quantity',
        headers: ['qty'],
        required: true,
      },
      { key: 'note' as const, label: 'Note', headers: [], required: false },
    ];

    it('finds the sheet by its header row, below a title, and skips blank rows', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Items').addRow(['Item Code', 'Unit']);
      const sheet = workbook.addWorksheet('Opening Stock');
      sheet.addRow(['Tirupati Enterprises — opening stock']);
      sheet.addRow(['ITEM NAME', 'Qty']);
      sheet.addRow(['Cement', 10]);
      sheet.addRow([]);
      sheet.addRow(['Sand', 4]);

      const rows = await readSheetRows(
        await toBase64(workbook),
        columns,
        'the test sheet',
      );
      expect(rows).toEqual([
        { line: 3, cells: { item: 'Cement', qty: 10, note: null } },
        { line: 5, cells: { item: 'Sand', qty: 4, note: null } },
      ]);
    });

    it('names the missing columns when no sheet has the header', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Other').addRow(['Item Name', 'Unit']);
      await expect(
        readSheetRows(await toBase64(workbook), columns, 'the test sheet'),
      ).rejects.toThrow(/"Item Name", "Quantity"/);
    });

    it('refuses a file that is not a workbook', async () => {
      await expect(
        readSheetRows(
          Buffer.from('not a workbook').toString('base64'),
          columns,
          'the test sheet',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
