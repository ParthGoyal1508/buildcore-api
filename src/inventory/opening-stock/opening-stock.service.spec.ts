import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import {
  OPENING_STOCK_ERRORS,
  OpeningStockService,
} from './opening-stock.service';

const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;

const workbook = async (rows: ExcelJS.CellValue[][]) => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Opening Stock');
  sheet.addRow([
    'Store / Site',
    'Item Name',
    'Quantity',
    'Rate (₹ per Unit)',
    'As On Date',
  ]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
};

/** The service over a stubbed database: one existing entry, moved since when `moved`. */
function make(options: { moved?: boolean } = {}) {
  const tx = {
    $executeRaw: jest.fn(),
    openingStock: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'o1', companyId: 'c1', itemId: 'steel', siteId: 'main' },
        ]),
    },
    stockLedgerEntry: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { referenceId: 'o1', createdAt: new Date('2026-10-01T00:00:00Z') },
        ]),
      groupBy: jest.fn().mockResolvedValue(
        options.moved
          ? [
              {
                itemId: 'steel',
                siteId: 'main',
                _max: { createdAt: new Date('2026-10-02T00:00:00Z') },
              },
            ]
          : [],
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const item = (id: string, name: string, active = true) => ({
    id,
    name,
    unit: 'BAG',
    active,
    companyId: 'c1',
  });
  const refs = {
    targetCompanyOf: () => 'c1',
    companySites: jest.fn().mockResolvedValue([
      { id: 'main', name: 'Main Store' },
      { id: 'yard', name: 'Yard' },
      { id: 'yard2', name: 'YARD ' },
    ]),
    companyItems: jest
      .fn()
      .mockResolvedValue([
        item('cement', 'Cement OPC 53'),
        item('steel', 'TMT Steel 12mm'),
        item('old', 'Old Paint', false),
      ]),
  };
  const config = { get: () => ({ timezone: 'Asia/Kolkata' }) };
  const service = new OpeningStockService(
    prisma as never,
    {} as never,
    refs as never,
    { record: jest.fn() } as never,
    config as never,
  );
  jest.spyOn(service, 'today').mockReturnValue('2026-10-30');
  return service;
}

describe('OpeningStockService.validateImport (051)', () => {
  it('matches names case- and space-insensitively and defaults the date to today', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([[' main  store', 'cement opc 53', 10, 400, null]]),
    );
    expect(report.rows[0]).toMatchObject({
      siteId: 'main',
      itemId: 'cement',
      quantity: 10,
      rate: 400,
      value: 4000,
      asOnDate: '2026-10-30',
      noRate: false,
      replaces: false,
      errors: [],
    });
    expect(report.canConfirm).toBe(true);
  });

  it('flags a blank rate as "no rate" without failing the row', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([['Main Store', 'Cement OPC 53', 10, null, '01-04-2026']]),
    );
    expect(report.rows[0]).toMatchObject({
      rate: null,
      noRate: true,
      value: 0,
      asOnDate: '2026-04-01',
      errors: [],
    });
    expect(report.summary.noRate).toBe(1);
  });

  it('reports every problem on its row, and each unmatched name once', async () => {
    const report = await make().validateImport(
      caller,
      await workbook([
        ['Main Store', 'Cement OPC 53', 10, 400, null],
        ['Main Store', 'cement opc 53', 5, 400, null],
        ['Nowhere', 'Ghost Item', 0, -5, '01-11-2026'],
        ['Nowhere', 'Ghost Item', 1.2345, 1.234, 'soon'],
        ['Yard', 'Old Paint', 1, 1, null],
      ]),
    );
    const [, dup, bad, worse, clash] = report.rows.map((r) => r.errors);
    expect(dup).toEqual(['Same store and item as row 2.']);
    expect(bad).toEqual([
      'No store named "Nowhere" in this company.',
      'No item named "Ghost Item" in the item master.',
      'Quantity must be a number more than 0.',
      'Rate must be a number, 0 or more.',
      'As On Date is in the future.',
    ]);
    expect(worse).toContain('Quantity has more than 3 decimal places.');
    expect(worse).toContain('Rate has more than 2 decimal places.');
    expect(worse).toContain('As On Date is not a date. Use DD-MM-YYYY.');
    expect(clash).toEqual([
      'More than one store is named "Yard".',
      'Old Paint is inactive in the item master.',
    ]);
    expect(report.unmatched).toEqual({
      stores: ['Nowhere'],
      items: ['Ghost Item'],
    });
    expect(report.summary).toMatchObject({ rows: 5, valid: 1, invalid: 4 });
    expect(report.canConfirm).toBe(false);
  });

  it('marks a row that replaces an entry, and refuses one moved since', async () => {
    const row = [['Main Store', 'TMT Steel 12mm', 3, 60000, null]];
    const free = await make().validateImport(caller, await workbook(row));
    expect(free.rows[0]).toMatchObject({ replaces: true, errors: [] });
    expect(free.summary.replacing).toBe(1);

    const moved = await make({ moved: true }).validateImport(
      caller,
      await workbook(row),
    );
    expect(moved.rows[0].errors[0]).toMatch(/cannot be replaced/);
  });

  it('confirm writes nothing when a row is in error', async () => {
    const service = make();
    const post = jest.spyOn(service as never, 'post');
    await expect(
      service.confirmImport(
        caller,
        await workbook([['Nowhere', 'Cement OPC 53', 1, 1, null]]),
        false,
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: { code: OPENING_STOCK_ERRORS.importInvalid },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('confirm asks before replacing existing entries', async () => {
    await expect(
      make().confirmImport(
        caller,
        await workbook([['Main Store', 'TMT Steel 12mm', 3, 1, null]]),
        false,
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: { code: OPENING_STOCK_ERRORS.exists },
    });
  });
});

describe('OpeningStockService.create (051)', () => {
  it('refuses an as-on date in the future', async () => {
    const service = make();
    (service as unknown as { refs: Record<string, unknown> }).refs = {
      targetCompanyOf: () => 'c1',
      requireSiteName: jest.fn().mockResolvedValue('Main Store'),
      requireItem: jest
        .fn()
        .mockResolvedValue({ id: 'cement', name: 'Cement', active: true }),
    };
    await expect(
      service.create(
        caller,
        {
          siteId: 'main',
          itemId: 'cement',
          quantity: 1,
          asOnDate: '2026-10-31',
        },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
