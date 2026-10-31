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
 * 052 end to end against a real database: editing a worker (validation, the special-rate
 * permission, the audit entry), the contractor on a generated payment sheet surviving a later edit
 * and printed on the download, the double-pay guard after an engagement change, and transferring a
 * worker between sites. Fixtures are prefixed `E2EWE` and removed in `afterAll`.
 */
const PREFIX = 'E2EWE';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

const BUSINESS_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const [YEAR, MONTH, DAY] = TODAY.split('-').map(Number);
const YESTERDAY = new Date(Date.UTC(YEAR, MONTH - 1, DAY - 1))
  .toISOString()
  .slice(0, 10);
const DAY_BEFORE = new Date(Date.UTC(YEAR, MONTH - 1, DAY - 2))
  .toISOString()
  .slice(0, 10);
/** A day no payment sheet covers, for a correction after the transfer. */
const THREE_DAYS_AGO = new Date(Date.UTC(YEAR, MONTH - 1, DAY - 3))
  .toISOString()
  .slice(0, 10);

describe('Labour worker edit and transfer (052, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;

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
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyId: string;
  let otherCompanyId: string;
  let siteA: string;
  let siteB: string;
  let siteInactive: string;
  let otherSite: string;
  let vendor1: string;
  let vendor2: string;
  let vendorInactive: string;
  let otherVendor: string;
  let hr: { userId: string; token: string };
  let supervisor: { userId: string; token: string };
  const madeUserIds: string[] = [];
  const madeRoleIds: string[] = [];

  const makeUser = async (label: string, permissions: Permission[]) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`,
        username: unique(label),
        password: await hash('secret42'),
        firstname: label,
        lastname: 'Tester',
        companyId,
      },
    });
    const role = await sys.role.create({
      data: { name: unique(`${label}Role`), permissions },
    });
    await sys.userRole.create({ data: { userId: user.id, roleId: role.id } });
    madeUserIds.push(user.id);
    madeRoleIds.push(role.id);
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken as string };
  };

  const register = (body: Record<string, unknown>, token = hr.token) =>
    http()
      .post('/labour/workers')
      .set(auth(token))
      .send({
        fullName: 'Dummy Labour',
        gender: 'male',
        siteId: siteA,
        ...body,
      });

  const edit = (id: string, body: Record<string, unknown>, token = hr.token) =>
    http().patch(`/labour/workers/${id}`).set(auth(token)).send(body);

  const transfer = (
    id: string,
    body: Record<string, unknown>,
    token = hr.token,
  ) =>
    http().post(`/labour/workers/${id}/transfer`).set(auth(token)).send(body);

  const correct = (workerId: string, date: string) =>
    http()
      .post('/labour/muster-attendance/corrections')
      .set(auth(hr.token))
      .send({
        workerId,
        date,
        punchIn: '09:00',
        punchOut: '17:00',
        reason: 'Register was on paper',
      });

  const download = async (sheetId: string) => {
    const res = await http()
      .get(`/labour/sheets/payment/${sheetId}`)
      .set(auth(hr.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    return wb.getWorksheet('Payment sheet');
  };

  const makeVendor = (company: string, name: string, active = true) =>
    sys.vendor.create({
      data: {
        companyId: company,
        code: unique(name).slice(-12),
        name: unique(name),
        type: 'labour_contractor',
        active,
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const companyData = (code: string) => ({
      name: `Dummy ${code} Test Firm`,
      shortCode: unique(code).slice(0, 10),
      payrollLockDay: 7,
      pfEmployerRate: 12,
      esicEmployerRate: 3.25,
      gratuityRate: 4.81,
      bonusRate: 8.33,
    });
    companyId = (await sys.company.create({ data: companyData('WE') })).id;
    otherCompanyId = (await sys.company.create({ data: companyData('WO') })).id;
    const site = (company: string, label: string, status = 'active') =>
      sys.site.create({
        data: {
          companyId: company,
          name: unique(`Site${label}`),
          latitude: 19.076,
          longitude: 72.8777,
          geofenceRadiusMeters: 200,
          weeklyOffDay: null,
          status,
        },
      });
    siteA = (await site(companyId, 'A')).id;
    siteB = (await site(companyId, 'B')).id;
    siteInactive = (await site(companyId, 'C', 'inactive')).id;
    otherSite = (await site(otherCompanyId, 'D')).id;

    vendor1 = (await makeVendor(companyId, 'Con1')).id;
    vendor2 = (await makeVendor(companyId, 'Con2')).id;
    vendorInactive = (await makeVendor(companyId, 'Con3', false)).id;
    otherVendor = (await makeVendor(otherCompanyId, 'Con4')).id;

    hr = await makeUser('hr', [
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
      Permission.LABOUR_PUNCH_CORRECT,
    ]);
    supervisor = await makeUser('supervisor', [
      Permission.DAILY_WORKER_REGISTRY,
    ]);
    await sys.supervisorSite.create({
      data: { companyId, userId: supervisor.userId, siteId: siteA },
    });
    await sys.siteWageRate.createMany({
      data: [
        {
          companyId,
          siteId: siteA,
          gender: 'male',
          dailyRate: 600,
          effectiveFrom: new Date(`${DAY_BEFORE}T00:00:00.000Z`),
        },
        {
          companyId,
          siteId: siteA,
          gender: 'female',
          dailyRate: 500,
          effectiveFrom: new Date(`${DAY_BEFORE}T00:00:00.000Z`),
        },
      ],
    });
  });

  afterAll(async () => {
    for (const id of [companyId, otherCompanyId].filter(Boolean)) {
      await sys.labourPunch.deleteMany({ where: { companyId: id } });
      await sys.labourPunchCorrection.deleteMany({ where: { companyId: id } });
      await sys.labourPaymentSheet.deleteMany({ where: { companyId: id } });
      await sys.musterRoll.deleteMany({ where: { companyId: id } });
      await sys.siteWageRate.deleteMany({ where: { companyId: id } });
      await sys.supervisorSite.deleteMany({ where: { companyId: id } });
      await sys.labourCodeSequence.deleteMany({ where: { companyId: id } });
      await sys.labourWorkerTransfer.deleteMany({ where: { companyId: id } });
      await sys.labourWorker.deleteMany({ where: { companyId: id } });
      await sys.vendor.deleteMany({ where: { companyId: id } });
      await sys.site.deleteMany({ where: { companyId: id } });
    }
    for (const id of madeUserIds) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.user.deleteMany({ where: { id } });
    }
    for (const id of madeRoleIds) {
      await sys.role.deleteMany({ where: { id } });
    }
    for (const id of [companyId, otherCompanyId].filter(Boolean)) {
      await sys.company.deleteMany({ where: { id } });
    }
    await app.close();
  });

  let ramesh: string;
  let sita: string;

  describe('Registration', () => {
    it('lists active vendors for the contractor picker, to a supervisor too', async () => {
      const res = await http()
        .get('/labour/workers/contractor-options')
        .set(auth(supervisor.token))
        .expect(200);
      const ids = res.body.map((v: any) => v.id);
      expect(ids).toEqual(expect.arrayContaining([vendor1, vendor2]));
      expect(ids).not.toContain(vendorInactive);
      expect(ids).not.toContain(otherVendor);
    });

    it('refuses a special rate from someone who cannot approve labour', async () => {
      const res = await register(
        { fullName: 'Dummy Priced', rateOverride: 700 },
        supervisor.token,
      ).expect(403);
      expect(res.body.code).toBe('LABOUR_RATE_NEEDS_APPROVE');
    });

    it('registers name-only labour', async () => {
      const a = await register(
        { fullName: 'Dummy Ramesh' },
        supervisor.token,
      ).expect(201);
      ramesh = a.body.id;
      expect(a.body.contractorName).toBeNull();
      const b = await register({
        fullName: 'Dummy Sita',
        gender: 'female',
        aadhaarNumber: '444455556666',
      }).expect(201);
      sita = b.body.id;
    });
  });

  describe('Edit', () => {
    it('validates like registration', async () => {
      await edit(ramesh, { phone: '12345' }).expect(400);
      await edit(ramesh, { fullName: '' }).expect(400);
      await edit(ramesh, { fullName: null }).expect(400);
      await edit(ramesh, { gender: 'other' }).expect(400);
      await edit(ramesh, { siteId: siteB }).expect(400);
      const noContractor = await edit(ramesh, {
        engagementType: 'contractor',
      }).expect(400);
      expect(noContractor.body.code).toBe('LABOUR_CONTRACTOR_REQUIRED');
      await edit(ramesh, {
        engagementType: 'contractor',
        contractorId: vendorInactive,
      }).expect(400);
      await edit(ramesh, {
        engagementType: 'contractor',
        contractorId: otherVendor,
      }).expect(400);
      const dup = await edit(ramesh, { aadhaarNumber: '444455556666' }).expect(
        409,
      );
      expect(dup.body.code).toBe('LABOUR_AADHAAR_EXISTS');
      expect(dup.body.existingWorkerId).toBe(sita);
    });

    it('lets a supervisor fill in the details, keeping the code', async () => {
      const before = await sys.labourWorker.findUnique({
        where: { id: ramesh },
      });
      const res = await edit(
        ramesh,
        {
          fullName: 'Dummy Ramesh Kumar',
          fatherName: 'Dummy Suresh',
          phone: '9876543210',
          dateOfBirth: '1990-05-20',
          aadhaarNumber: '111122223333',
          bankAccount: '000111222333',
          engagementType: 'contractor',
          contractorId: vendor1,
        },
        supervisor.token,
      ).expect(200);
      expect(res.body).toMatchObject({
        labourCode: before.labourCode,
        fullName: 'Dummy Ramesh Kumar',
        fatherName: 'Dummy Suresh',
        dateOfBirth: '1990-05-20',
        engagementType: 'contractor',
        contractorId: vendor1,
        siteId: siteA,
        aadhaarNumber: '••••••••3333',
        bankAccount: '••••••••2333',
      });
      expect(res.body.contractorName).toMatch(/Con1/);

      const audit = await sys.auditLogEntry.findFirst({
        where: { entityId: ramesh, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.changes.fields).toEqual([
        'fullName',
        'fatherName',
        'phone',
        'dateOfBirth',
        'engagementType',
        'contractorId',
        'aadhaarNumber',
        'bankAccount',
      ]);
      expect(JSON.stringify(audit.changes)).not.toContain('1111');
      expect(JSON.stringify(audit.changes)).not.toContain('000111');
    });

    it('keeps the special rate for someone who can approve labour, and clears it', async () => {
      const refused = await edit(
        ramesh,
        { rateOverride: 700 },
        supervisor.token,
      ).expect(403);
      expect(refused.body.code).toBe('LABOUR_RATE_NEEDS_APPROVE');
      const set = await edit(ramesh, { rateOverride: 700 }).expect(200);
      expect(set.body.rateOverride).toBe(700);
      const cleared = await edit(ramesh, { rateOverride: null }).expect(200);
      expect(cleared.body.rateOverride).toBeNull();
    });

    it('clears an optional field with null', async () => {
      const res = await edit(ramesh, { phone: null }).expect(200);
      expect(res.body.phone).toBeNull();
    });

    it('shows the contractor in the list', async () => {
      const res = await http()
        .get(`/labour/workers?siteId=${siteA}`)
        .set(auth(supervisor.token))
        .expect(200);
      const row = res.body.items.find((w: any) => w.id === ramesh);
      expect(row.contractorName).toMatch(/Con1/);
    });
  });

  describe('Payment sheet after an edit', () => {
    let sheetId: string;

    it('prints the contractor the line was priced under, even after the worker changes contractor', async () => {
      await correct(ramesh, YESTERDAY).expect(201);
      const sheet = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({
          siteId: siteA,
          periodFrom: YESTERDAY,
          periodTo: YESTERDAY,
          engagementType: 'contractor',
        })
        .expect(201);
      sheetId = sheet.body.id;
      expect(sheet.body.lines).toHaveLength(1);
      expect(sheet.body.lines[0]).toMatchObject({
        workerId: ramesh,
        contractorId: vendor1,
        resolvedRate: 600,
      });

      // Edits after generation: contractor, gender and a special rate.
      await edit(ramesh, {
        contractorId: vendor2,
        gender: 'female',
        rateOverride: 900,
      }).expect(200);

      const after = await http()
        .get(`/labour/payment-sheets/${sheetId}`)
        .set(auth(hr.token))
        .expect(200);
      expect(after.body.lines[0]).toMatchObject({
        contractorId: vendor1,
        resolvedRate: 600,
        grossWage: 600,
      });
      expect(after.body.lines[0].contractorName).toMatch(/Con1/);

      const ws = await download(sheetId);
      expect(ws.getRow(4).values).toEqual([
        undefined,
        'S.No',
        'Code',
        'Name',
        "Father's name",
        'Gender',
        'Contractor',
        'Days',
        'Daily rate',
        'Gross',
        'Deductions',
        'Net payable',
        'Signature / thumb',
      ]);
      const line = ws.getRow(5);
      expect(line.getCell(3).value).toBe('Dummy Ramesh Kumar');
      expect(String(line.getCell(6).value)).toMatch(/Con1/);
      expect(line.getCell(9).value).toBe(600);
      const total = ws.getRow(6);
      expect(total.getCell(3).value).toBe('Total');
      expect(total.getCell(7).value).toBe(1);
      expect(total.getCell(9).value).toBe(600);
    });

    it('does not pay a day twice when the worker becomes direct', async () => {
      await edit(ramesh, { engagementType: 'direct' }).expect(200);
      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({
          siteId: siteA,
          periodFrom: YESTERDAY,
          periodTo: YESTERDAY,
          engagementType: 'direct',
        })
        .expect(409);
      expect(res.body.message).toMatch(/No directly engaged labour/);
    });

    it('prints a blank contractor for direct labour', async () => {
      await correct(sita, DAY_BEFORE).expect(201);
      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({
          siteId: siteA,
          periodFrom: DAY_BEFORE,
          periodTo: DAY_BEFORE,
          engagementType: 'direct',
        })
        .expect(201);
      expect(res.body.lines[0]).toMatchObject({
        workerId: sita,
        contractorId: null,
        contractorName: null,
      });
      const ws = await download(res.body.id);
      expect(ws.getRow(5).getCell(6).value ?? '').toBe('');
      expect(ws.getRow(6).getCell(9).value).toBe(500);
    });
  });

  describe('Transfer', () => {
    it('refuses a site the caller does not work at, an inactive one, another company’s, and the same one', async () => {
      const notAssigned = await transfer(
        ramesh,
        { siteId: siteB },
        supervisor.token,
      ).expect(403);
      expect(notAssigned.body.code).toBe('LABOUR_SITE_NOT_ASSIGNED');
      const inactive = await transfer(ramesh, {
        siteId: siteInactive,
      }).expect(400);
      expect(inactive.body.code).toBe('LABOUR_TRANSFER_SITE_INACTIVE');
      const foreign = await transfer(ramesh, { siteId: otherSite }).expect(400);
      expect(foreign.body.code).toBe('LABOUR_TRANSFER_SITE_NOT_FOUND');
      const same = await transfer(ramesh, { siteId: siteA }).expect(400);
      expect(same.body.code).toBe('LABOUR_TRANSFER_SAME_SITE');
    });

    it('refuses while the worker is punched in', async () => {
      await sys.labourPunch.create({
        data: {
          companyId,
          workerId: sita,
          siteId: siteA,
          punchDate: new Date(`${TODAY}T00:00:00.000Z`),
          type: 'in',
          supervisorId: hr.userId,
          source: 'correction',
        },
      });
      const res = await transfer(sita, { siteId: siteB }).expect(409);
      expect(res.body.code).toBe('LABOUR_TRANSFER_ON_SITE');
      await sys.labourPunch.deleteMany({ where: { workerId: sita } });
    });

    it('moves the worker, keeps the history and leaves earlier days at the old site', async () => {
      const res = await transfer(ramesh, {
        siteId: siteB,
        reason: 'Needed at the bridge',
      }).expect(201);
      expect(res.body.siteId).toBe(siteB);
      expect(res.body.transfers).toEqual([
        {
          fromSiteId: siteA,
          toSiteId: siteB,
          transferredOn: TODAY,
          reason: 'Needed at the bridge',
        },
      ]);

      // The site A supervisor no longer sees them.
      await http()
        .get(`/labour/workers/${ramesh}`)
        .set(auth(supervisor.token))
        .expect(404);

      // A forgotten day from before the move is added at the site they were at then.
      await correct(ramesh, THREE_DAYS_AGO).expect(201);
      const punches = await sys.labourPunch.findMany({
        where: {
          workerId: ramesh,
          punchDate: new Date(`${THREE_DAYS_AGO}T00:00:00.000Z`),
        },
      });
      expect(punches.map((p: any) => p.siteId)).toEqual([siteA, siteA]);

      // The sheet already generated for the old site is unchanged.
      const sheets = await http()
        .get(`/labour/payment-sheets?siteId=${siteA}`)
        .set(auth(hr.token))
        .expect(200);
      expect(sheets.body.length).toBeGreaterThanOrEqual(2);
    });
  });
});
