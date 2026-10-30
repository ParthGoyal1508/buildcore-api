import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';

/**
 * 051: opening stock and agreed vendor rates entered up front, and the KL unit. Opening stock moves
 * the store's balance and weighted average with no purchase, bill or agreed rate behind it; it can
 * be replaced or deleted only until stock moves after it. An imported agreed rate holds purchases
 * exactly like one a first purchase set. Fixtures are prefixed `E2E051` and removed by id in
 * `afterAll`.
 */
const PREFIX = 'E2E051';
const stamp = Date.now() % 100000;
const unique = (s: string) => `${PREFIX}${s}${stamp}`;
const DAY = 24 * 60 * 60 * 1000;
const isoDay = (offset = 0) =>
  new Date(Date.now() + offset * DAY + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('-');

/** A one-sheet workbook as base64, the way the web sends it. */
async function sheet(
  name: string,
  header: string[],
  rows: ExcelJS.CellValue[][],
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // A first tab without the header, as the client's four-tab workbook has: it must be skipped.
  workbook.addWorksheet('Item Categories').addRow(['Category Name']);
  const ws = workbook.addWorksheet(name);
  ws.addRow(header);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
}

const OPENING_HEADER = [
  'Store / Site',
  'Item Name',
  'Quantity',
  'Rate (₹ per Unit)',
  'As On Date',
];
const RATES_HEADER = [
  'Vendor Name',
  'Item Name',
  'Rate (₹ per Unit)',
  'Valid From',
];

describe('051 opening stock and vendor rates import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let readerToken: string;
  let companyId: string;
  let storeA: string;
  let storeB: string;
  let categoryId: string;
  let cementId: string;
  let bitumenId: string;
  let sandId: string;
  let dieselId: string;
  let vendorId: string;
  let otherVendorId: string;
  let readerId: string;
  let readerRoleId: string;
  const storeAName = unique('Store A');
  const cementName = unique('Cement OPC');

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = (fn: (tx: any) => Promise<any>) =>
    withRlsContext(prisma, { isSuperAdmin: true }, fn);
  const sysProxy: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_u, op: string) => (args?: unknown) =>
              sys((tx) => tx[model][op](args)),
          },
        ),
    },
  );
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const q = () => `companyId=${companyId}`;
  const hint = async (itemId: string, siteId: string) =>
    (
      await http()
        .get(`/inventory/stock/${itemId}/${siteId}?${q()}`)
        .set(auth())
        .expect(200)
    ).body;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    token = (
      await http()
        .post('/auth/login')
        .send({
          identifier: 'admin@buildcore.dev',
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;
    companyId = await effectiveCompanyIdFor(sysProxy);

    const site = async (name: string) =>
      (
        await http()
          .post(`/projects/sites?${q()}`)
          .set(auth())
          .send({
            name,
            latitude: 19.076,
            longitude: 72.8777,
            geofenceRadiusMeters: 200,
            weeklyOffDay: 0,
          })
          .expect(201)
      ).body.id;
    storeA = await site(storeAName);
    storeB = await site(unique('Store B'));

    const vendor = async (name: string) =>
      (
        await http()
          .post(`/partners/vendors?${q()}`)
          .set(auth())
          .send({ name, type: 'material' })
          .expect(201)
      ).body.id;
    vendorId = await vendor(unique('Shree Traders Pvt. Ltd.'));
    otherVendorId = await vendor(unique('Other Supplier'));

    categoryId = (
      await http()
        .post(`/inventory/categories?${q()}`)
        .set(auth())
        .send({ name: unique('Material') })
        .expect(201)
    ).body.id;
    const item = async (name: string, unit: string, extra = {}) =>
      (
        await http()
          .post(`/inventory/items?${q()}`)
          .set(auth())
          .send({ name, categoryId, unit, ...extra })
          .expect(201)
      ).body;
    cementId = (await item(cementName, 'BAG')).id;
    sandId = (await item(unique('Sand'), 'CUM')).id;
    dieselId = (await item(unique('Diesel'), 'LTR', { dailyRate: true })).id;
    const bitumen = await item(unique('Bitumen VG30'), 'KL');
    bitumenId = bitumen.id;
    expect(bitumen.unit).toBe('KL');

    // A read-only caller without INVENTORY: the opening stock routes refuse them.
    const password = await hash('secret42');
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique('reader')}@example.test`,
          username: unique('reader'),
          password,
          firstname: 'Dummy',
          lastname: 'Reader',
          companyId,
        },
      }),
    );
    readerId = user.id;
    readerRoleId = (
      await sys((tx) =>
        tx.role.create({
          data: { name: unique('Reader'), permissions: [Permission.FUEL] },
        }),
      )
    ).id;
    await sys((tx) =>
      tx.userRole.create({ data: { userId: readerId, roleId: readerRoleId } }),
    );
    readerToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: user.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      const items = {
        in: [cementId, bitumenId, sandId, dieselId].filter(Boolean),
      };
      await sys(async (tx) => {
        await tx.paymentAllocation.deleteMany({
          where: { bill: { purchase: { itemId: items } } },
        });
        await tx.purchaseBill.deleteMany({
          where: { purchase: { itemId: items } },
        });
        await tx.goodsReceiptNote.deleteMany({
          where: { purchase: { itemId: items } },
        });
        await tx.purchase.deleteMany({ where: { itemId: items } });
        await tx.issue.deleteMany({ where: { itemId: items } });
        await tx.openingStock.deleteMany({ where: { itemId: items } });
        await tx.stockLedgerEntry.deleteMany({ where: { itemId: items } });
        await tx.stockBalance.deleteMany({ where: { itemId: items } });
        await tx.vendorItemRate.deleteMany({ where: { itemId: items } });
        await tx.item.deleteMany({ where: { id: items } });
        await tx.itemCategory.deleteMany({ where: { id: categoryId } });
        await tx.vendor.deleteMany({
          where: { id: { in: [vendorId, otherVendorId].filter(Boolean) } },
        });
        await tx.site.deleteMany({
          where: { id: { in: [storeA, storeB].filter(Boolean) } },
        });
        await tx.userRole.deleteMany({ where: { userId: readerId } });
        await tx.refreshToken.deleteMany({ where: { accountId: readerId } });
        await tx.auditLogEntry.updateMany({
          where: { accountId: readerId },
          data: { accountId: null },
        });
        await tx.user.deleteMany({ where: { id: readerId } });
        await tx.role.deleteMany({ where: { id: readerRoleId } });
      });
    }
    if (app) await app.close();
  });

  describe('opening stock', () => {
    let openingId: string;

    it('adds stock and its rate with no purchase, bill or agreed rate', async () => {
      const res = await http()
        .post(`/inventory/opening-stock?${q()}`)
        .set(auth())
        .send({
          siteId: storeA,
          itemId: cementId,
          quantity: 100,
          rate: 400,
          asOnDate: isoDay(-10),
        })
        .expect(201);
      openingId = res.body.id;
      expect(res.body).toMatchObject({
        siteName: storeAName,
        itemName: cementName,
        unit: 'BAG',
        quantity: 100,
        rate: 400,
        noRate: false,
        value: 40000,
        asOnDate: isoDay(-10),
        editable: true,
      });

      expect(await hint(cementId, storeA)).toMatchObject({
        inStock: 100,
        avgRate: 400,
      });
      const [purchases, rates] = await sys((tx) =>
        Promise.all([
          tx.purchase.count({ where: { itemId: cementId } }),
          tx.vendorItemRate.count({ where: { itemId: cementId } }),
        ]),
      );
      expect(purchases).toBe(0);
      expect(rates).toBe(0);
    });

    it('shows as an "Opening stock" line on the item ledger', async () => {
      const ledger = await http()
        .get(`/inventory/stock/${cementId}/${storeA}/ledger?${q()}`)
        .set(auth())
        .expect(200);
      expect(ledger.body.entries).toHaveLength(1);
      expect(ledger.body.entries[0]).toMatchObject({
        type: 'opening',
        label: 'Opening stock',
        quantityIn: 100,
        rate: 400,
        balance: 100,
      });
      expect(ledger.body.closingValue).toBe(40000);
    });

    it('refuses a second entry for the same item and store, and a future date', async () => {
      const again = await http()
        .post(`/inventory/opening-stock?${q()}`)
        .set(auth())
        .send({ siteId: storeA, itemId: cementId, quantity: 5, rate: 1 })
        .expect(409);
      expect(again.body.code).toBe('OPENING_STOCK_EXISTS');
      expect(again.body.openingStockId).toBe(openingId);

      const future = await http()
        .post(`/inventory/opening-stock?${q()}`)
        .set(auth())
        .send({
          siteId: storeB,
          itemId: cementId,
          quantity: 5,
          asOnDate: isoDay(2),
        })
        .expect(400);
      expect(future.body.code).toBe('OPENING_STOCK_FUTURE_DATE');
    });

    it('is replaced while nothing has moved since', async () => {
      const res = await http()
        .put(`/inventory/opening-stock/${openingId}`)
        .set(auth())
        .send({ quantity: 120, rate: 410, asOnDate: isoDay(-10) })
        .expect(200);
      expect(res.body).toMatchObject({ quantity: 120, rate: 410 });
      expect(await hint(cementId, storeA)).toMatchObject({
        inStock: 120,
        avgRate: 410,
      });
      const ledger = await sys((tx) =>
        tx.stockLedgerEntry.count({
          where: { itemId: cementId, siteId: storeA },
        }),
      );
      expect(ledger).toBe(1);
    });

    it('a later purchase averages with it, and then it can no longer change', async () => {
      // 120 @ 410 + 80 @ 460 = 200 @ 430.
      await http()
        .post(`/inventory/purchases?${q()}`)
        .set(auth())
        .send({
          siteId: storeA,
          itemId: cementId,
          vendorId,
          date: isoDay(),
          quantity: 80,
          rate: 460,
        })
        .expect(201);
      expect(await hint(cementId, storeA)).toMatchObject({
        inStock: 200,
        avgRate: 430,
      });

      const list = await http()
        .get(`/inventory/opening-stock?${q()}&siteId=${storeA}`)
        .set(auth())
        .expect(200);
      const row = list.body.rows.find((r: any) => r.id === openingId);
      expect(row.editable).toBe(false);

      const replace = await http()
        .put(`/inventory/opening-stock/${openingId}`)
        .set(auth())
        .send({ quantity: 1, rate: 1 })
        .expect(409);
      expect(replace.body.code).toBe('OPENING_STOCK_HAS_MOVEMENTS');
      const remove = await http()
        .delete(`/inventory/opening-stock/${openingId}`)
        .set(auth())
        .expect(409);
      expect(remove.body.code).toBe('OPENING_STOCK_HAS_MOVEMENTS');
    });

    it('without a rate is valued at 0 and flagged; deleting it leaves no balance', async () => {
      const res = await http()
        .post(`/inventory/opening-stock?${q()}`)
        .set(auth())
        .send({ siteId: storeB, itemId: bitumenId, quantity: 2.5 })
        .expect(201);
      expect(res.body).toMatchObject({
        unit: 'KL',
        rate: 0,
        noRate: true,
        value: 0,
        asOnDate: isoDay(),
      });
      await http()
        .delete(`/inventory/opening-stock/${res.body.id}`)
        .set(auth())
        .expect(200);
      const [balance, ledger] = await sys((tx) =>
        Promise.all([
          tx.stockBalance.count({ where: { itemId: bitumenId } }),
          tx.stockLedgerEntry.count({ where: { itemId: bitumenId } }),
        ]),
      );
      expect(balance).toBe(0);
      expect(ledger).toBe(0);
    });

    it('an issue after it also locks it', async () => {
      const res = await http()
        .post(`/inventory/opening-stock?${q()}`)
        .set(auth())
        .send({ siteId: storeB, itemId: sandId, quantity: 30, rate: 1500 })
        .expect(201);
      await http()
        .post(`/inventory/issues?${q()}`)
        .set(auth())
        .send({
          siteId: storeB,
          itemId: sandId,
          date: isoDay(),
          quantity: 10,
          issuedTo: 'Gang 1',
        })
        .expect(201);
      expect(await hint(sandId, storeB)).toMatchObject({
        inStock: 20,
        avgRate: 1500,
      });
      await http()
        .delete(`/inventory/opening-stock/${res.body.id}`)
        .set(auth())
        .expect(409);
    });

    it('is refused to a caller without INVENTORY', async () => {
      await http()
        .get(`/inventory/opening-stock?${q()}`)
        .set(auth(readerToken))
        .expect(403);
    });
  });

  describe('opening stock import', () => {
    it('reports unmatched names, duplicates, bad numbers and dates, and writes nothing', async () => {
      const file = await sheet('Opening Stock', OPENING_HEADER, [
        // Matched despite case and spacing; a real Excel date cell.
        [
          `  ${storeAName.toLowerCase()} `,
          cementName.toUpperCase(),
          10,
          400,
          new Date(`${isoDay(-3)}T00:00:00Z`),
        ],
        [storeAName, cementName, 5, 400, ddmmyyyy(isoDay(-3))],
        ['No Such Store', cementName, 5, 400, null],
        [storeAName, 'No Such Item', 'ten', 400, null],
        [storeAName, unique('Sand'), 5, -1, '31-02-2026'],
      ]);
      const res = await http()
        .post(`/inventory/opening-stock/import/validate?${q()}`)
        .set(auth())
        .send({ file })
        .expect(201);
      const [first, dup, store, item, bad] = res.body.rows;
      // The cement at store A already has an opening entry, locked by the purchase above.
      expect(first.replaces).toBe(true);
      expect(first.asOnDate).toBe(isoDay(-3));
      expect(first.errors.join(' ')).toMatch(/cannot be replaced/);
      expect(dup.errors).toContain(`Same store and item as row 2.`);
      expect(store.errors[0]).toMatch(/No store named "No Such Store"/);
      expect(item.errors.join(' ')).toMatch(/No item named "No Such Item"/);
      expect(item.errors.join(' ')).toMatch(/Quantity must be a number/);
      expect(bad.errors.join(' ')).toMatch(/Rate must be a number/);
      expect(bad.errors.join(' ')).toMatch(/As On Date is not a date/);
      expect(res.body.unmatched).toEqual({
        stores: ['No Such Store'],
        items: ['No Such Item'],
      });
      expect(res.body.canConfirm).toBe(false);

      const confirm = await http()
        .post(`/inventory/opening-stock/import/confirm?${q()}`)
        .set(auth())
        .send({ file })
        .expect(400);
      expect(confirm.body.code).toBe('OPENING_STOCK_IMPORT_INVALID');
    });

    it('confirms every row in one go, and replaces only when asked', async () => {
      const file = await sheet('Opening Stock', OPENING_HEADER, [
        [storeAName, unique('Sand'), 12.5, 1400, ddmmyyyy(isoDay(-5))],
        [storeAName, unique('Bitumen VG30'), 3, null, null],
      ]);
      const validate = await http()
        .post(`/inventory/opening-stock/import/validate?${q()}`)
        .set(auth())
        .send({ file })
        .expect(201);
      expect(validate.body.summary).toMatchObject({
        rows: 2,
        valid: 2,
        invalid: 0,
        noRate: 1,
        replacing: 0,
        value: 17500,
      });
      const done = await http()
        .post(`/inventory/opening-stock/import/confirm?${q()}`)
        .set(auth())
        .send({ file })
        .expect(201);
      expect(done.body).toMatchObject({ created: 2, replaced: 0 });
      expect(await hint(sandId, storeA)).toMatchObject({
        inStock: 12.5,
        avgRate: 1400,
      });
      expect(await hint(bitumenId, storeA)).toMatchObject({
        inStock: 3,
        avgRate: 0,
      });

      // The same pairs again: they exist, so confirming needs `replaceExisting`.
      const again = await sheet('Opening Stock', OPENING_HEADER, [
        [storeAName, unique('Sand'), 14, 1450, ddmmyyyy(isoDay(-5))],
      ]);
      const refused = await http()
        .post(`/inventory/opening-stock/import/confirm?${q()}`)
        .set(auth())
        .send({ file: again })
        .expect(409);
      expect(refused.body.code).toBe('OPENING_STOCK_EXISTS');
      const replaced = await http()
        .post(`/inventory/opening-stock/import/confirm?${q()}`)
        .set(auth())
        .send({ file: again, replaceExisting: true })
        .expect(201);
      expect(replaced.body).toMatchObject({ created: 0, replaced: 1 });
      expect(await hint(sandId, storeA)).toMatchObject({
        inStock: 14,
        avgRate: 1450,
      });
    });

    it('serves the template with the client’s columns', async () => {
      const res = await http()
        .get(`/inventory/opening-stock/import/template?${q()}`)
        .set(auth())
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      const header = workbook.worksheets[0].getRow(1).values as string[];
      expect(header.slice(1)).toEqual(OPENING_HEADER);
    });
  });

  describe('agreed vendor rates import', () => {
    it('reports create, unchanged, conflict, daily and error rows', async () => {
      // Cement from `vendorId` was bought at 460 above, which established that rate.
      const file = await sheet('Vendor Rates', RATES_HEADER, [
        // Punctuation, case and spacing differ from the vendor master.
        [
          unique('SHREE TRADERS PVT LTD').replace('LTD', 'LTD.'),
          unique('Sand'),
          1450,
          ddmmyyyy(isoDay(-30)),
        ],
        [unique('Shree Traders Pvt. Ltd.'), cementName, 460, null],
        [
          unique('Shree Traders Pvt. Ltd.'),
          cementName.toLowerCase(),
          455,
          null,
        ],
        [unique('Other Supplier'), unique('Diesel'), 92, null],
        ['Nobody & Sons', unique('Sand'), 1, null],
        [unique('Other Supplier'), unique('Bitumen VG30'), 52000, null],
      ]);
      const res = await http()
        .post(`/inventory/vendor-rates/import/validate?${q()}`)
        .set(auth())
        .send({ file })
        .expect(201);
      const statuses = res.body.rows.map((r: any) => r.status);
      expect(statuses).toEqual([
        'create',
        'unchanged',
        'error',
        'daily',
        'error',
        'create',
      ]);
      // The duplicate pair is an error even though its rate would also conflict.
      expect(res.body.rows[2].errors).toContain(
        'Same vendor and item as row 3.',
      );
      expect(res.body.rows[1].current).toEqual({
        rate: 460,
        effectiveFrom: isoDay(),
      });
      expect(res.body.unmatched.vendors).toEqual(['Nobody & Sons']);
      expect(res.body.canConfirm).toBe(false);

      await http()
        .post(`/inventory/vendor-rates/import/confirm?${q()}`)
        .set(auth())
        .send({ file })
        .expect(400);
      const count = await sys((tx) =>
        tx.vendorItemRate.count({
          where: { itemId: { in: [sandId, bitumenId] } },
        }),
      );
      expect(count).toBe(0);
    });

    it('records new rates, never overwrites one in force, and purchases are held to them', async () => {
      const file = await sheet('Vendor Rates', RATES_HEADER, [
        [
          unique('Shree Traders Pvt Ltd'),
          unique('Sand'),
          1450,
          ddmmyyyy(isoDay(-30)),
        ],
        [unique('Shree Traders Pvt. Ltd.'), cementName, 455, null],
        [unique('Other Supplier'), unique('Bitumen VG30'), 52000, null],
      ]);
      const res = await http()
        .post(`/inventory/vendor-rates/import/confirm?${q()}`)
        .set(auth())
        .send({ file })
        .expect(201);
      expect(res.body).toMatchObject({
        created: 2,
        conflicts: 1,
        unchanged: 0,
      });
      const conflict = res.body.report.rows[1];
      expect(conflict).toMatchObject({
        status: 'conflict',
        rate: 455,
        current: { rate: 460 },
      });

      const rates = await sys((tx) =>
        tx.vendorItemRate.findMany({
          where: { itemId: { in: [sandId, bitumenId, cementId] } },
        }),
      );
      expect(rates).toHaveLength(3);
      const sand = rates.find((r: any) => r.itemId === sandId);
      expect(sand.establishedByPurchaseId).toBeNull();
      expect(sand.effectiveFrom.toISOString().slice(0, 10)).toBe(isoDay(-30));
      expect(
        rates.find((r: any) => r.itemId === cementId).rate.toNumber(),
      ).toBe(460);

      // Held exactly like a rate a first purchase set.
      const refused = await http()
        .post(`/inventory/purchases?${q()}`)
        .set(auth())
        .send({
          siteId: storeB,
          itemId: sandId,
          vendorId,
          date: isoDay(),
          quantity: 1,
          rate: 1500,
        })
        .expect(409);
      expect(refused.body.code).toBe('PURCHASE_RATE_FIXED');
      await http()
        .post(`/inventory/purchases?${q()}`)
        .set(auth())
        .send({
          siteId: storeB,
          itemId: sandId,
          vendorId,
          date: isoDay(),
          quantity: 1,
          rate: 1450,
        })
        .expect(201);
      // And the purchase did not open a second rate.
      expect(
        await sys((tx) =>
          tx.vendorItemRate.count({ where: { itemId: sandId } }),
        ),
      ).toBe(1);
    });

    it('lists agreed rates with where each came from', async () => {
      const res = await http()
        .get(`/inventory/vendor-rates?${q()}&vendorId=${vendorId}`)
        .set(auth())
        .expect(200);
      const byItem = new Map(res.body.rows.map((r: any) => [r.itemId, r]));
      expect(byItem.get(cementId)).toMatchObject({
        rate: 460,
        source: 'purchase',
        unit: 'BAG',
      });
      expect(byItem.get(sandId)).toMatchObject({
        rate: 1450,
        source: 'import',
        effectiveFrom: isoDay(-30),
      });
    });
  });
});
