import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';

import { AgreedRatesService } from './agreed-rates.service';

const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;

const workbook = async (rows: ExcelJS.CellValue[][]) => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Vendor Rates');
  sheet.addRow(['Vendor Name', 'Item Name', 'Rate (₹ per Unit)', 'Valid From']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
};

function make() {
  const inForce = [
    {
      vendorId: 'shree',
      itemId: 'cement',
      rate: new Prisma.Decimal(412),
      effectiveFrom: new Date('2026-08-12T00:00:00Z'),
    },
  ];
  const tx = {
    $executeRaw: jest.fn(),
    vendorItemRate: { findMany: jest.fn().mockResolvedValue(inForce) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const item = (id: string, name: string, dailyRate = false) => ({
    id,
    name,
    unit: 'BAG',
    active: true,
    dailyRate,
    companyId: 'c1',
  });
  const refs = {
    targetCompanyOf: () => 'c1',
    companyVendors: jest.fn().mockResolvedValue([
      { id: 'shree', name: 'Shree Traders Pvt. Ltd.', active: true },
      { id: 'pump', name: 'City Fuels', active: true },
    ]),
    companyItems: jest
      .fn()
      .mockResolvedValue([
        item('cement', 'Cement OPC-53'),
        item('sand', 'River Sand'),
        item('diesel', 'HSD Diesel', true),
      ]),
  };
  const config = { get: () => ({ timezone: 'Asia/Kolkata' }) };
  return new AgreedRatesService(
    prisma as never,
    {} as never,
    refs as never,
    { record: jest.fn() } as never,
    config as never,
  );
}

describe('AgreedRatesService.validateImport (051)', () => {
  it('matches vendor and item names ignoring case, spaces and punctuation', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([
        ['SHREE TRADERS PVT LTD', 'river sand', 1450, '01-04-2026'],
      ]),
    );
    expect(report.rows[0]).toMatchObject({
      vendorId: 'shree',
      itemId: 'sand',
      rate: 1450,
      validFrom: '2026-04-01',
      status: 'create',
      current: null,
    });
  });

  it('never overwrites a rate in force: the same rate is unchanged, another a conflict', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([
        ['Shree Traders Pvt Ltd', 'Cement OPC 53', 412, null],
        ['City Fuels', 'HSD Diesel', 92.4, null],
      ]),
    );
    expect(report.rows[0]).toMatchObject({
      status: 'unchanged',
      current: { rate: 412, effectiveFrom: '2026-08-12' },
    });
    expect(report.rows[1].status).toBe('daily');

    const other = await make().validateImport(
      caller,
      await workbook([['Shree Traders Pvt Ltd', 'Cement OPC 53', 415, null]]),
    );
    expect(other.rows[0]).toMatchObject({
      status: 'conflict',
      rate: 415,
      current: { rate: 412 },
    });
    expect(other.canConfirm).toBe(true);
  });

  it('reports unmatched names, bad rates and duplicates as errors', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([
        ['Nobody & Sons', 'River Sand', 10, null],
        ['City Fuels', 'River Sand', 0, null],
        ['City Fuels', 'River Sand', 'abc', '2026-13-01'],
      ]),
    );
    expect(report.rows.map((r) => r.status)).toEqual([
      'error',
      'error',
      'error',
    ]);
    expect(report.rows[1].errors).toEqual([
      'Rate must be a number more than 0.',
    ]);
    expect(report.rows[2].errors).toEqual([
      'Rate must be a number more than 0.',
      'Valid From is not a date. Use DD-MM-YYYY.',
      'Same vendor and item as row 3.',
    ]);
    expect(report.unmatched).toEqual({ vendors: ['Nobody & Sons'], items: [] });
    expect(report.summary).toMatchObject({ rows: 3, error: 3 });
    expect(report.canConfirm).toBe(false);
  });
});
