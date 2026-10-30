import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';

/**
 * 050: daily-changing item rates (diesel, cement). A daily-rate item has a market rate and vendor
 * overrides by date; purchases and fuel entries are offered the rate of their date, keep what was
 * paid, and are not locked to a vendor's agreed rate; nothing recorded is rewritten. Fixtures are
 * prefixed `E2E050` and removed by id in `afterAll`.
 */
const PREFIX = 'E2E050';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const DAY = 24 * 60 * 60 * 1000;
const isoDay = (offset = 0) =>
  new Date(Date.now() + offset * DAY + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

describe('050 daily item rates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let fuelToken: string;
  let companyId: string;
  let siteId: string;
  let categoryId: string;
  let dieselId: string;
  let sandId: string;
  let pumpA: string;
  let pumpB: string;
  let machineId: string;
  let equipmentCategoryId: string;
  let fuelUserId: string;
  let fuelRoleId: string;
  const purchaseIds: string[] = [];

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

  const purchase = (
    itemId: string,
    vendorId: string,
    rate: number,
    date = isoDay(),
  ) =>
    http()
      .post(`/inventory/purchases?${q()}`)
      .set(auth())
      .send({ siteId, itemId, vendorId, date, quantity: 10, rate });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;
    companyId = await effectiveCompanyIdFor(sysProxy);

    siteId = (
      await http()
        .post(`/projects/sites?${q()}`)
        .set(auth())
        .send({
          name: unique('Store'),
          latitude: 19.076,
          longitude: 72.8777,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        })
        .expect(201)
    ).body.id;
    for (const name of ['PumpA', 'PumpB']) {
      const vendor = await http()
        .post(`/partners/vendors?${q()}`)
        .set(auth())
        .send({ name: unique(name), type: 'material' })
        .expect(201);
      if (name === 'PumpA') pumpA = vendor.body.id;
      else pumpB = vendor.body.id;
    }
    categoryId = (
      await http()
        .post(`/inventory/categories?${q()}`)
        .set(auth())
        .send({ name: unique('Fuel') })
        .expect(201)
    ).body.id;
    const diesel = await http()
      .post(`/inventory/items?${q()}`)
      .set(auth())
      .send({
        name: unique('Diesel'),
        categoryId,
        unit: 'LTR',
        machineFuel: true,
      })
      .expect(201);
    dieselId = diesel.body.id;
    // A machine fuel is always a daily-rate item.
    expect(diesel.body.dailyRate).toBe(true);
    expect(diesel.body.machineFuel).toBe(true);
    sandId = (
      await http()
        .post(`/inventory/items?${q()}`)
        .set(auth())
        .send({ name: unique('Sand'), categoryId, unit: 'CUM' })
        .expect(201)
    ).body.id;

    equipmentCategoryId = (
      await sys((tx) =>
        tx.equipmentCategory.create({
          data: { companyId, name: unique('Excavators'), meterType: 'hours' },
        }),
      )
    ).id;
    machineId = (
      await sys((tx) =>
        tx.equipment.create({
          data: {
            companyId,
            code: unique('EX').slice(0, 16),
            name: 'Dummy Excavator',
            categoryId: equipmentCategoryId,
            ownership: 'owned',
            powerSource: 'diesel',
            meterType: 'hours',
          },
        }),
      )
    ).id;

    // A Machinery clerk: FUEL only, no INVENTORY.
    const password = await hash('secret42');
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique('fuel')}@example.test`,
          username: unique('fuel'),
          password,
          firstname: 'Fuel',
          lastname: 'Clerk',
          companyId,
        },
      }),
    );
    fuelUserId = user.id;
    fuelRoleId = (
      await sys((tx) =>
        tx.role.create({
          data: { name: unique('FuelRole'), permissions: [Permission.FUEL] },
        }),
      )
    ).id;
    await sys((tx) =>
      tx.userRole.create({ data: { userId: fuelUserId, roleId: fuelRoleId } }),
    );
    fuelToken = (
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
      const items = { in: [dieselId, sandId].filter(Boolean) };
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
        await tx.stockLedgerEntry.deleteMany({ where: { itemId: items } });
        await tx.stockBalance.deleteMany({ where: { itemId: items } });
        await tx.vendorItemRate.deleteMany({ where: { itemId: items } });
        await tx.itemDailyRate.deleteMany({ where: { itemId: items } });
        await tx.item.deleteMany({ where: { id: items } });
        await tx.itemCategory.deleteMany({ where: { id: categoryId } });
        await tx.vendor.deleteMany({ where: { id: { in: [pumpA, pumpB] } } });
        await tx.equipment.deleteMany({ where: { id: machineId } });
        await tx.equipmentCategory.deleteMany({
          where: { id: equipmentCategoryId },
        });
        await tx.site.deleteMany({ where: { id: siteId } });
        await tx.userRole.deleteMany({ where: { userId: fuelUserId } });
        await tx.refreshToken.deleteMany({ where: { accountId: fuelUserId } });
        await tx.auditLogEntry.updateMany({
          where: { accountId: fuelUserId },
          data: { accountId: null },
        });
        await tx.user.deleteMany({ where: { id: fuelUserId } });
        await tx.role.deleteMany({ where: { id: fuelRoleId } });
      });
    }
    if (app) await app.close();
  });

  it('a pump that supplied diesel is listed on the board, with nothing set yet', async () => {
    // Bought yesterday at 90 — before any daily rate. Not locked to it: the item changes daily.
    const first = await purchase(dieselId, pumpA, 90, isoDay(-1)).expect(201);
    purchaseIds.push(first.body.id);
    const rates = await sys((tx) =>
      tx.vendorItemRate.count({ where: { itemId: dieselId } }),
    );
    expect(rates).toBe(0);

    const board = await http()
      .get(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .expect(200);
    const row = board.body.items.find((i: any) => i.itemId === dieselId);
    expect(row.machineFuel).toBe(true);
    expect(row.market).toBeNull();
    expect(row.vendors.map((v: any) => v.vendorId)).toEqual([pumpA]);
    expect(board.body.items.some((i: any) => i.itemId === sandId)).toBe(false);
  });

  it("sets yesterday's and today's market rate, and a pump's override, by date", async () => {
    await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({ date: isoDay(-1), rates: [{ itemId: dieselId, rate: 92.4 }] })
      .expect(200);

    // The board for today opens on yesterday's figure.
    const before = await http()
      .get(`/inventory/daily-rates?${q()}&date=${isoDay()}`)
      .set(auth())
      .expect(200);
    const dieselBefore = before.body.items.find(
      (i: any) => i.itemId === dieselId,
    );
    expect(dieselBefore.market).toEqual({
      rate: 92.4,
      effectiveFrom: isoDay(-1),
    });
    expect(dieselBefore.vendors[0].effective).toMatchObject({
      rate: 92.4,
      source: 'market',
    });

    const saved = await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({
        date: isoDay(),
        rates: [
          { itemId: dieselId, rate: 93.1 },
          { itemId: dieselId, vendorId: pumpB, rate: 92.75 },
        ],
      })
      .expect(200);
    const today = saved.body.items.find((i: any) => i.itemId === dieselId);
    expect(today.market).toEqual({ rate: 93.1, effectiveFrom: isoDay() });
    const byVendor = Object.fromEntries(
      today.vendors.map((v: any) => [v.vendorId, v.effective]),
    );
    expect(byVendor[pumpA]).toMatchObject({ rate: 93.1, source: 'market' });
    expect(byVendor[pumpB]).toMatchObject({ rate: 92.75, source: 'vendor' });

    // Typing again the same day replaces that day's rate rather than adding a second one.
    await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({ date: isoDay(), rates: [{ itemId: dieselId, rate: 93.2 }] })
      .expect(200);
    const marketRows = await sys((tx) =>
      tx.itemDailyRate.count({ where: { itemId: dieselId, vendorId: null } }),
    );
    expect(marketRows).toBe(2);
  });

  it('offers each document the rate of its own date', async () => {
    const offered = (date: string, vendorId?: string) =>
      http()
        .get(
          `/inventory/daily-rates/effective?${q()}&itemId=${dieselId}&date=${date}` +
            (vendorId ? `&vendorId=${vendorId}` : ''),
        )
        .set(auth())
        .expect(200)
        .then((res) => res.body);

    expect(await offered(isoDay(-1))).toMatchObject({
      dailyRate: true,
      rate: 92.4,
    });
    expect(await offered(isoDay())).toMatchObject({
      rate: 93.2,
      source: 'market',
    });
    expect(await offered(isoDay(), pumpB)).toMatchObject({
      rate: 92.75,
      source: 'vendor',
    });
    // Before any rate was set there is nothing to offer.
    expect(await offered(isoDay(-30))).toEqual({ dailyRate: false });
    // A normal item is never offered a daily rate.
    const sand = await http()
      .get(
        `/inventory/daily-rates/effective?${q()}&itemId=${sandId}&date=${isoDay()}`,
      )
      .set(auth())
      .expect(200);
    expect(sand.body).toEqual({ dailyRate: false });
  });

  it('a purchase keeps what was paid, and earlier purchases are not rewritten', async () => {
    // Offered 93.20, paid 93.50: accepted as typed.
    const paid = await purchase(dieselId, pumpA, 93.5).expect(201);
    expect(paid.body.rate).toBe(93.5);
    // Yesterday's purchase at 90 still reads 90.
    const old = await sys((tx) =>
      tx.purchase.findUnique({ where: { id: purchaseIds[0] } }),
    );
    expect(Number(old.rate)).toBe(90);
  });

  it('an ordinary item is still locked to its agreed rate (028)', async () => {
    await purchase(sandId, pumpA, 1500).expect(201);
    const refused = await purchase(sandId, pumpA, 1600).expect(409);
    expect(refused.body.code).toBe('PURCHASE_RATE_FIXED');
  });

  it("offers a fuel entry the diesel rate of its date, the pump's override first", async () => {
    const rate = (date: string, vendorId?: string) =>
      http()
        .get(
          `/plant/fuel/rate?date=${date}&equipmentId=${machineId}` +
            (vendorId ? `&vendorId=${vendorId}` : ''),
        )
        .set(auth(fuelToken))
        .expect(200)
        .then((res) => res.body);
    expect(await rate(isoDay())).toMatchObject({
      itemId: dieselId,
      rate: 93.2,
      source: 'market',
    });
    expect(await rate(isoDay(), pumpB)).toMatchObject({ rate: 92.75 });
    expect(await rate(isoDay(-1))).toMatchObject({ rate: 92.4 });
  });

  it("keeps the history, and removing a day's override falls back to the market", async () => {
    await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({
        date: isoDay(),
        rates: [{ itemId: dieselId, vendorId: pumpB, rate: null }],
      })
      .expect(200);
    const history = await http()
      .get(
        `/inventory/daily-rates/history?itemId=${dieselId}&companyId=${companyId}`,
      )
      .set(auth())
      .expect(200);
    expect(
      history.body.map((r: any) => [r.effectiveFrom, r.vendorName, r.rate]),
    ).toEqual([
      [isoDay(), 'Market rate', 93.2],
      [isoDay(-1), 'Market rate', 92.4],
    ]);
  });

  it('refuses a future date, a non-daily item, and a caller without INVENTORY', async () => {
    await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({ date: isoDay(2), rates: [{ itemId: dieselId, rate: 95 }] })
      .expect(400);
    await http()
      .put(`/inventory/daily-rates?${q()}`)
      .set(auth())
      .send({ date: isoDay(), rates: [{ itemId: sandId, rate: 95 }] })
      .expect(400);
    await http().get(`/inventory/daily-rates`).set(auth(fuelToken)).expect(403);
  });
});
