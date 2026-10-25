import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessLevel, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { randomUUID } from 'crypto';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';

/**
 * Site-initiated purchase entries against a real database (043).
 *
 * What a mocked client cannot show: that a site entry leaves the stock ledger and balance untouched,
 * that completing it moves them exactly once, that the second of two completions is refused, and
 * that the site's permission reaches nothing of `inventory/purchases`.
 *
 * Every fixture is prefixed `E2ESE` and removed in `afterAll`, scoped to what this suite made.
 */
const PREFIX = 'E2ESE';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SITE = { latitude: 19.076, longitude: 72.8777 };

jest.setTimeout(120_000);

describe('Site purchase entries (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let adminToken: string;
  let siteToken: string;
  let unassignedToken: string;
  let companyId: string;
  let siteId: string;
  let itemId: string;
  let vendorId: string;
  let categoryId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_x, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A user whose one role holds only the site page (and My Workspace) — Site Incharge's slice. */
  const makeSiteUser = async (label: string) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`.toLowerCase(),
        username: unique(label),
        password: await hash('secret42'),
        displayName: `${PREFIX} ${label}`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(user.id);
    const permissions = [
      Permission.INVENTORY_SITE_ENTRY,
      Permission.MY_WORKSPACE,
    ];
    const role = await sys.role.create({
      data: {
        name: unique(`${label}Role`),
        permissions,
        rolePermissions: {
          create: permissions.flatMap((permission) => [
            { permission, level: AccessLevel.read },
            { permission, level: AccessLevel.write },
          ]),
        },
      },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken as string };
  };

  const entry = (over: Record<string, unknown> = {}) => ({
    itemId,
    deliveredAt: new Date().toISOString(),
    vehicleNo: 'mh 12 ab 1234',
    photos: [PNG_1PX],
    ...SITE,
    accuracyMeters: 15,
    capturedAt: new Date().toISOString(),
    clientRequestId: randomUUID(),
    ...over,
  });

  const balance = () =>
    sys.stockBalance.findFirst({ where: { itemId, siteId } });

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
    adminToken = login.body.accessToken;
    companyId = await effectiveCompanyIdFor(sys);

    const site = await http()
      .post(`/projects/sites?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({
        name: unique('Store'),
        ...SITE,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      })
      .expect(201);
    siteId = site.body.id;

    const vendor = await http()
      .post(`/partners/vendors?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: unique('Supplier'), type: 'material' })
      .expect(201);
    vendorId = vendor.body.id;

    const category = await http()
      .post(`/inventory/categories?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: unique('Cat') })
      .expect(201);
    categoryId = category.body.id;

    const item = await http()
      .post(`/inventory/items?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: unique('Cement'), categoryId, unit: 'BAG' })
      .expect(201);
    itemId = item.body.id;

    const siteUser = await makeSiteUser('incharge');
    siteToken = siteUser.token;
    await sys.supervisorSite.create({
      data: { companyId, userId: siteUser.userId, siteId },
    });
    unassignedToken = (await makeSiteUser('nostore')).token;
  });

  afterAll(async () => {
    const mine = { itemId };
    await sys.purchaseBill.deleteMany({ where: { purchase: mine } });
    await sys.goodsReceiptNote.deleteMany({ where: { purchase: mine } });
    await sys.vendorItemRate.deleteMany({ where: { itemId } });
    await sys.purchase.deleteMany({ where: mine });
    await sys.stockLedgerEntry.deleteMany({ where: mine });
    await sys.stockBalance.deleteMany({ where: mine });
    await sys.item.deleteMany({ where: { id: itemId } });
    await sys.itemCategory.deleteMany({ where: { id: categoryId } });
    await sys.vendor.deleteMany({ where: { id: vendorId } });
    await sys.supervisorSite.deleteMany({
      where: { userId: { in: userIds } },
    });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await app.close();
  });

  it('keeps the purchase list and everything else of Inventory from the site', async () => {
    await http().get('/inventory/purchases').set(auth(siteToken)).expect(403);
    await http().get('/inventory/stock').set(auth(siteToken)).expect(403);
  });

  it("names the site user's one store, and the item picker reads the item master", async () => {
    const stores = await http()
      .get('/inventory/site-entries/stores')
      .set(auth(siteToken))
      .expect(200);
    expect(stores.body).toEqual([expect.objectContaining({ id: siteId })]);
    const items = await http()
      .get('/inventory/site-entries/items')
      .query({ search: PREFIX })
      .set(auth(siteToken))
      .expect(200);
    expect(items.body.map((i: { id: string }) => i.id)).toContain(itemId);
  });

  it('blocks a user with no store assigned', async () => {
    const res = await http()
      .post('/inventory/site-entries')
      .set(auth(unassignedToken))
      .send(entry())
      .expect(403);
    expect(res.body.code).toBe('SITE_ENTRY_NO_STORE');
  });

  it('refuses a photo taken outside the site radius', async () => {
    const res = await http()
      .post('/inventory/site-entries')
      .set(auth(siteToken))
      .send(entry({ latitude: 19.09 }))
      .expect(422);
    expect(res.body.code).toBe('SITE_ENTRY_REFUSED_LOCATION');
  });

  describe('a delivery recorded at the site, then completed at Head Office', () => {
    let id: string;
    const requestId = randomUUID();

    it('saves a partial entry that moves no stock', async () => {
      const res = await http()
        .post('/inventory/site-entries')
        .set(auth(siteToken))
        .send(
          entry({
            clientRequestId: requestId,
            siteId: 'not-mine',
            photos: [PNG_1PX, PNG_1PX],
          }),
        )
        .expect(201);
      id = res.body.id;
      expect(res.body).toMatchObject({
        status: 'partial_site',
        siteId,
        vehicleNo: 'MH12AB1234',
      });
      expect(await balance()).toBeNull();
      expect(
        await sys.stockLedgerEntry.count({ where: { referenceId: id } }),
      ).toBe(0);
    });

    it('answers a double tap with the same entry', async () => {
      const res = await http()
        .post('/inventory/site-entries')
        .set(auth(siteToken))
        .send(entry({ clientRequestId: requestId }))
        .expect(201);
      expect(res.body.id).toBe(id);
      expect(await sys.purchase.count({ where: { itemId } })).toBe(1);
    });

    it('lets the site neither edit nor delete it', async () => {
      await http()
        .patch(`/inventory/purchases/${id}`)
        .set(auth(siteToken))
        .send({ vehicleNo: 'X' })
        .expect(403);
      await http()
        .delete(`/inventory/purchases/${id}`)
        .set(auth(siteToken))
        .expect(403);
    });

    it('shows Head Office the entry as partially filled, with what the site captured', async () => {
      const res = await http()
        .get('/inventory/purchases')
        .query({ status: 'partial_site', itemId })
        .set(auth(adminToken))
        .expect(200);
      expect(res.body.purchases).toEqual([
        expect.objectContaining({
          id,
          status: 'partial_site',
          source: 'site',
          vendorName: null,
          quantity: null,
          hasPhoto: true,
          vehicleNo: 'MH12AB1234',
          createdByName: `${PREFIX} incharge`,
          gps: expect.objectContaining({ latitude: SITE.latitude }),
        }),
      ]);
    });

    it("serves each of the site's photos to Head Office", async () => {
      const list = await http()
        .get('/inventory/purchases')
        .query({ status: 'partial_site', itemId })
        .set(auth(adminToken))
        .expect(200);
      expect(list.body.purchases[0].photoCount).toBe(2);
      const second = await http()
        .get(`/inventory/purchases/${id}/photo?n=2`)
        .set(auth(adminToken))
        .expect(200);
      expect(second.headers['content-type']).toMatch(/^image\//);
      await http()
        .get(`/inventory/purchases/${id}/photo?n=3`)
        .set(auth(adminToken))
        .expect(404);
    });

    it('lets Head Office correct the vehicle, keeping what it was in the history', async () => {
      await http()
        .patch(`/inventory/purchases/${id}`)
        .set(auth(adminToken))
        .send({ vehicleNo: 'mh 12 ab 9999' })
        .expect(200);
      const history = await http()
        .get(`/inventory/purchases/${id}/history`)
        .set(auth(adminToken))
        .expect(200);
      expect(history.body.at(-1).changes).toMatchObject({
        before: { vehicleNo: 'MH12AB1234' },
        after: { vehicleNo: 'MH12AB9999' },
      });
    });

    it('moves stock once Head Office completes it, and only then', async () => {
      const res = await http()
        .post(`/inventory/purchases/${id}/complete`)
        .set(auth(adminToken))
        .send({
          itemId,
          vendorId,
          date: new Date().toISOString().slice(0, 10),
          quantity: 40,
          rate: 350,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'completed',
        quantity: 40,
        amount: 14000,
        vehicleNo: 'MH12AB9999',
      });
      expect(res.body.grnNumber).toBeTruthy();
      expect(Number((await balance()).received)).toBe(40);
      const grn = await sys.goodsReceiptNote.findFirst({
        where: { purchaseId: id },
      });
      expect(grn.vehicleNo).toBe('MH12AB9999');
    });

    it('refuses a second completion and moves nothing more', async () => {
      await http()
        .post(`/inventory/purchases/${id}/complete`)
        .set(auth(adminToken))
        .send({
          itemId,
          vendorId,
          date: new Date().toISOString().slice(0, 10),
          quantity: 40,
          rate: 350,
        })
        .expect(409);
      expect(Number((await balance()).received)).toBe(40);
      expect(
        await sys.stockLedgerEntry.count({ where: { referenceId: id } }),
      ).toBe(1);
    });
  });

  it('leaves the Head Office create-from-scratch flow as it was', async () => {
    const res = await http()
      .post(`/inventory/purchases?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({
        siteId,
        itemId,
        vendorId,
        date: new Date().toISOString().slice(0, 10),
        quantity: 10,
        rate: 350,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'completed',
      source: 'head_office',
    });
    expect(Number((await balance()).received)).toBe(50);
  });

  it('refuses a completed purchase without its terms at the database too', async () => {
    await expect(
      sys.purchase.create({
        data: {
          companyId,
          siteId,
          itemId,
          date: new Date(),
          status: 'completed',
        },
      }),
    ).rejects.toThrow(/Purchase_completed_has_terms_check/);
  });
});
