import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import * as ExcelJS from 'exceljs';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Scrapping and selling machines (2026-10-17): who may, what a sale records, auto-release from the
 * site, removal from working lists, the history, reversal, and the Scrapped & Sold dashboard and
 * its Excel. Fixtures prefixed `E2EDSP`, removed in `afterAll`.
 */
const PREFIX = 'E2EDSP';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const PDF = Buffer.from('%PDF-1.4\n%dummy invoice\n').toString('base64');

describe('Machine disposal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let companyId: string;
  let siteId: string;
  let categoryId: string;
  let excavator: string;
  let roller: string;
  let adminToken: string;
  let plantToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = (fn: (tx: any) => Promise<any>) =>
    withRlsContext(prisma, { isSuperAdmin: true }, fn);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const makeUser = async (label: string, permissions: Permission[]) => {
    const password = await hash('secret42');
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique(label)}@example.test`,
          username: unique(label),
          password,
          firstname: label,
          lastname: 'Tester',
          companyId,
        },
      }),
    );
    const role = await sys((tx) =>
      tx.role.create({ data: { name: unique(`${label}Role`), permissions } }),
    );
    await sys((tx) =>
      tx.userRole.create({ data: { userId: user.id, roleId: role.id } }),
    );
    userIds.push(user.id);
    roleIds.push(role.id);
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return login.body.accessToken as string;
  };

  const machine = (code: string, extra: Record<string, unknown> = {}) =>
    sys((tx) =>
      tx.equipment.create({
        data: {
          companyId,
          code: unique(code).slice(0, 16),
          name: `Dummy ${code}`,
          categoryId,
          ownership: 'owned',
          powerSource: 'diesel',
          meterType: 'hours',
          make: 'Dummy Make',
          model: 'X1',
          ...extra,
        },
      }),
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    companyId = (
      await sys((tx) =>
        tx.company.create({
          data: {
            name: 'Dummy Plant Test Firm',
            shortCode: unique('DP').slice(0, 10),
            payrollLockDay: 7,
            pfEmployerRate: 12,
            esicEmployerRate: 3.25,
            gratuityRate: 4.81,
            bonusRate: 8.33,
          },
        }),
      )
    ).id;
    siteId = (
      await sys((tx) =>
        tx.site.create({
          data: {
            companyId,
            name: unique('Dummy Site'),
            latitude: 19.076,
            longitude: 72.8777,
            geofenceRadiusMeters: 200,
            weeklyOffDay: 0,
          },
        }),
      )
    ).id;
    categoryId = (
      await sys((tx) =>
        tx.equipmentCategory.create({
          data: { companyId, name: unique('Excavators'), meterType: 'hours' },
        }),
      )
    ).id;
    // Bought 1 Jan 2024 for 12,00,000 at 10% a year: on 1 Jan 2026, 24 months in, the book
    // value is 12,00,000 − 2 × 1,20,000 = 9,60,000.
    excavator = (
      await machine('EX', {
        purchaseDate: new Date('2024-01-01'),
        purchaseCost: 1200000,
        depreciationRate: 10,
        deployedSiteId: siteId,
      })
    ).id;
    roller = (await machine('RL')).id;

    adminToken = await makeUser('admin', [
      Permission.MACHINERY,
      Permission.MACHINERY_DISPOSE,
    ]);
    plantToken = await makeUser('plant', [Permission.MACHINERY]);
  });

  afterAll(async () => {
    if (companyId) {
      await sys((tx) => tx.equipmentEvent.deleteMany({ where: { companyId } }));
      await sys((tx) =>
        tx.equipmentDisposal.deleteMany({ where: { companyId } }),
      );
      await sys((tx) => tx.equipment.deleteMany({ where: { companyId } }));
      await sys((tx) =>
        tx.equipmentCategory.deleteMany({ where: { companyId } }),
      );
      await sys((tx) => tx.site.deleteMany({ where: { companyId } }));
    }
    for (const id of userIds) {
      await sys((tx) => tx.userRole.deleteMany({ where: { userId: id } }));
      await sys((tx) =>
        tx.refreshToken.deleteMany({ where: { accountId: id } }),
      );
      await sys((tx) =>
        tx.auditLogEntry.updateMany({
          where: { accountId: id },
          data: { accountId: null },
        }),
      );
      await sys((tx) => tx.user.deleteMany({ where: { id } }));
    }
    for (const id of roleIds)
      await sys((tx) => tx.role.deleteMany({ where: { id } }));
    if (companyId)
      await sys((tx) => tx.company.deleteMany({ where: { id: companyId } }));
    await app.close();
  });

  const sale = {
    type: 'sold',
    disposalDate: '2026-01-01',
    counterpartyName: 'Dummy Buyer Test Firm',
    buyerContact: '9876543210',
    valueRealised: 1000000,
    paymentMode: 'bank_transfer',
    invoiceNumber: 'INV-1',
    approvedBy: 'Dummy Approver',
    attachment: PDF,
    attachmentName: 'invoice.pdf',
    attachmentMime: 'application/pdf',
  };

  it('refuses anyone without the dispose permission', async () => {
    await http()
      .post(`/plant/equipment/${excavator}/dispose`)
      .set(auth(plantToken))
      .send(sale)
      .expect(403);
  });

  it('previews the book value from depreciation and the site it would release', async () => {
    const res = await http()
      .get(
        `/plant/equipment/${excavator}/disposal/preview?disposalDate=2026-01-01`,
      )
      .set(auth(adminToken))
      .expect(200);
    expect(res.body).toMatchObject({
      bookValue: 960000,
      deployedSiteId: siteId,
    });
  });

  it('needs the buyer and amount for a sale, and a reason for scrap', async () => {
    await http()
      .post(`/plant/equipment/${excavator}/dispose`)
      .set(auth(adminToken))
      .send({ ...sale, counterpartyName: '' })
      .expect(400);
    await http()
      .post(`/plant/equipment/${roller}/dispose`)
      .set(auth(adminToken))
      .send({ type: 'scrapped', disposalDate: '2026-01-01', approvedBy: 'X' })
      .expect(400);
  });

  it('sells a deployed machine: releases the site, prices profit, writes history', async () => {
    const res = await http()
      .post(`/plant/equipment/${excavator}/dispose`)
      .set(auth(adminToken))
      .send(sale)
      .expect(201);
    expect(res.body).toMatchObject({
      type: 'sold',
      bookValue: 960000,
      bookValueSource: 'depreciation',
      profitLoss: 40000,
      hasAttachment: true,
    });
    const row = await sys((tx) =>
      tx.equipment.findUnique({ where: { id: excavator } }),
    );
    expect(row.status).toBe('sold');
    expect(row.deployedSiteId).toBeNull();

    const history = await http()
      .get(`/plant/equipment/${excavator}/history`)
      .set(auth(plantToken))
      .expect(200);
    expect(history.body.map((e: any) => e.kind).sort()).toEqual([
      'disposed_sold',
      'site_released',
    ]);

    await http()
      .post(`/plant/equipment/${excavator}/dispose`)
      .set(auth(adminToken))
      .send(sale)
      .expect(409);
  });

  it('drops the sold machine from the working list, and refuses redeploying it', async () => {
    const list = await http()
      .get('/plant/equipment')
      .set(auth(plantToken))
      .expect(200);
    expect(list.body.items.map((i: any) => i.id)).not.toContain(excavator);
    const sold = await http()
      .get('/plant/equipment?status=sold')
      .set(auth(plantToken))
      .expect(200);
    expect(sold.body.items.map((i: any) => i.id)).toContain(excavator);

    await http()
      .patch(`/plant/equipment/${excavator}`)
      .set(auth(plantToken))
      .send({ deployedSiteId: siteId })
      .expect(409);
  });

  it('scraps a machine with no depreciation and shows both on the dashboard and its Excel', async () => {
    await http()
      .post(`/plant/equipment/${roller}/dispose`)
      .set(auth(adminToken))
      .send({
        type: 'scrapped',
        disposalDate: '2026-02-10',
        scrapReason: 'end_of_life',
        valueRealised: 25000,
        counterpartyName: 'Dummy Scrap Test Firm',
        approvedBy: 'Dummy Approver',
      })
      .expect(201);

    const dash = await http()
      .get('/plant/disposals')
      .set(auth(plantToken))
      .expect(200);
    expect(dash.body.summary).toEqual({
      totalScrapped: 1,
      totalSold: 1,
      saleValueRealised: 1000000,
      scrapValueRealised: 25000,
      netProfitLossOnSales: 40000,
    });
    const scrappedOnly = await http()
      .get('/plant/disposals?type=scrapped')
      .set(auth(plantToken))
      .expect(200);
    expect(scrappedOnly.body.items).toHaveLength(1);

    const xlsx = await http()
      .get('/plant/disposals/export')
      .set(auth(plantToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    expect(wb.worksheets[0].rowCount).toBe(4); // header, two machines, total
  });

  it('reverses a disposal: the machine is back in service, history says why', async () => {
    await http()
      .post(`/plant/equipment/${excavator}/disposal/reverse`)
      .set(auth(plantToken))
      .send({ reason: 'Entered against the wrong machine' })
      .expect(403);
    await http()
      .post(`/plant/equipment/${excavator}/disposal/reverse`)
      .set(auth(adminToken))
      .send({ reason: 'Entered against the wrong machine' })
      .expect(201);
    const row = await sys((tx) =>
      tx.equipment.findUnique({ where: { id: excavator } }),
    );
    expect(row.status).toBe('active');
    const dash = await http()
      .get('/plant/disposals')
      .set(auth(plantToken))
      .expect(200);
    expect(dash.body.summary.totalSold).toBe(0);
    const history = await http()
      .get(`/plant/equipment/${excavator}/history`)
      .set(auth(plantToken))
      .expect(200);
    expect(history.body[0].kind).toBe('disposal_reversed');
  });
});
