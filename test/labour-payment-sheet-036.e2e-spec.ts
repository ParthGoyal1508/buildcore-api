import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  euclideanDistance,
} from '../src/hr/biometrics/biometrics.service';

/**
 * 036 labour payment-sheet hardening, end to end: advance instalments deducted once across sheets
 * (O1), deleting and regenerating a draft and recomputing on reopen (O2), sheets that end before
 * today and one generate at a time (O3), carry-forward lines, the paid-amount cap and legacy musters
 * (O4), night shifts (O5), company checks for cross-company callers (O14), advance maker-checker
 * and the names the reports now return (O8). Fixtures are prefixed `E2E36` and removed in
 * `afterAll`.
 */
const PREFIX = 'E2E36';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

const JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const BUSINESS_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const [YEAR, MONTH, DAY] = TODAY.split('-').map(Number);
/** `n` days before today, as `YYYY-MM-DD`. */
const ago = (n: number) =>
  new Date(Date.UTC(YEAR, MONTH - 1, DAY - n)).toISOString().slice(0, 10);

class ScriptedBiometrics extends BiometricsService {
  async computeDescriptor(): Promise<Float32Array> {
    return Float32Array.from({ length: FACE_DESCRIPTOR_LENGTH }, () => 0.5);
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

describe('Labour payment sheets, 036 hardening (e2e)', () => {
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

  const SITE_LAT = 19.076;
  const SITE_LNG = 72.8777;

  const companyIds: string[] = [];
  let companyId: string;
  let otherCompanyId: string;
  let hr1: { userId: string; token: string };
  let hr2: { userId: string; token: string };
  let superUser: { userId: string; token: string };
  const madeUserIds: string[] = [];
  const madeRoleIds: string[] = [];
  let codeSeq = 0;

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

  const makeCompany = async (label: string) => {
    const company = await sys.company.create({
      data: {
        name: `Dummy ${label} Test Firm`,
        shortCode: unique(label).slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyIds.push(company.id);
    return company.id as string;
  };

  const makeSite = async (label: string, forCompany = companyId) =>
    (
      await sys.site.create({
        data: {
          companyId: forCompany,
          name: unique(`Site${label}`),
          latitude: SITE_LAT,
          longitude: SITE_LNG,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        },
      })
    ).id as string;

  const makeWorker = async (
    siteId: string,
    name: string,
    forCompany = companyId,
  ) =>
    (
      await sys.labourWorker.create({
        data: {
          companyId: forCompany,
          labourCode: `E2E36-${++codeSeq}`,
          fullName: `Dummy ${name}`,
          gender: 'male',
          siteId,
          bankAccount: '123456789012',
        },
      })
    ).id as string;

  const setRate = (siteId: string, maleRate: number, effectiveFrom = ago(30)) =>
    http()
      .post('/labour/site-rates')
      .set(auth(hr1.token))
      .send({ siteId, effectiveFrom, maleRate })
      .expect(201);

  const correct = (body: Record<string, unknown>) =>
    http()
      .post('/labour/muster-attendance/corrections')
      .set(auth(hr1.token))
      .send({ reason: 'Register entry', ...body });

  /** A full 8-hour day by correction. */
  const workDay = (workerId: string, date: string) =>
    correct({ workerId, date, punchIn: '09:00', punchOut: '17:00' }).expect(
      201,
    );

  const generate = (siteId: string, from: string, to = from) =>
    http()
      .post('/labour/payment-sheets')
      .set(auth(hr1.token))
      .send({ siteId, periodFrom: from, periodTo: to });

  const approveSheet = (id: string) =>
    http()
      .patch(`/labour/payment-sheets/${id}/approve`)
      .set(auth(hr2.token))
      .expect(200);

  const disburse = (lineId: string, body: Record<string, unknown> = {}) =>
    http()
      .patch(`/labour/payment-sheets/lines/${lineId}/disburse`)
      .set(auth(hr2.token))
      .send({ paymentMode: 'bank', paidOn: ago(1), ...body });

  const legacyMuster = async (
    siteId: string,
    date: string,
    workerId: string,
    supervisorId: string,
  ) =>
    (
      await sys.musterRoll.create({
        data: {
          companyId,
          siteId,
          date: new Date(`${date}T00:00:00.000Z`),
          supervisorId,
          latitude: SITE_LAT,
          longitude: SITE_LNG,
          accuracyMetres: 10,
          source: 'admin_entry',
          capturedAt: new Date(),
          status: 'submitted',
          lines: {
            create: [{ companyId, workerId, attendanceType: 'full_day' }],
          },
        },
      })
    ).id as string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BiometricsService)
      .useValue(new ScriptedBiometrics())
      .compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    companyId = await makeCompany('Labour036');
    otherCompanyId = await makeCompany('Other036');

    const labour = [
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
      Permission.LABOUR_PUNCH_CORRECT,
      Permission.REPORTS,
    ];
    hr1 = await makeUser('hrone', labour);
    hr2 = await makeUser('hrtwo', labour);
    superUser = await makeUser('super', [
      ...labour,
      Permission.CROSS_COMPANY_ACCESS,
    ]);
  });

  afterAll(async () => {
    for (const id of companyIds) {
      await sys.labourPunch.deleteMany({ where: { companyId: id } });
      await sys.labourPunchCorrection.deleteMany({ where: { companyId: id } });
      await sys.labourPunchRefusal.deleteMany({ where: { companyId: id } });
      await sys.labourPaymentSheet.deleteMany({ where: { companyId: id } });
      await sys.labourAdvance.deleteMany({ where: { companyId: id } });
      await sys.musterRoll.deleteMany({ where: { companyId: id } });
      await sys.siteWageRate.deleteMany({ where: { companyId: id } });
      await sys.supervisorSite.deleteMany({ where: { companyId: id } });
      await sys.labourCodeSequence.deleteMany({ where: { companyId: id } });
      await sys.labourWorker.deleteMany({ where: { companyId: id } });
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
    for (const id of companyIds) {
      await sys.company.deleteMany({ where: { id } });
    }
    await app.close();
  });

  describe('O1 advances deducted once, and maker-checker', () => {
    let site: string;
    let worker: string;
    let advanceId: string;

    beforeAll(async () => {
      site = await makeSite('Adv');
      worker = await makeWorker(site, 'Advance Ramesh');
      // A second worker keeps the sheet open (partly paid) after one line is paid, so the line
      // can still be reversed — a closed sheet refuses reversals.
      const mate = await makeWorker(site, 'Advance Mate');
      await setRate(site, 600);
      await workDay(worker, ago(5));
      await workDay(mate, ago(5));
      await workDay(worker, ago(4));
    });

    it('refuses fractional instalments and an oversized amount', async () => {
      const base = {
        workerId: worker,
        amount: 500,
        reason: 'Festival',
        recoveryInstalments: 1,
        recoveryStartPeriod: ago(10),
      };
      await http()
        .post('/labour/advances')
        .set(auth(hr1.token))
        .send({ ...base, recoveryInstalments: 2.5 })
        .expect(400);
      await http()
        .post('/labour/advances')
        .set(auth(hr1.token))
        .send({ ...base, amount: 5_000_000 })
        .expect(400);
      const created = await http()
        .post('/labour/advances')
        .set(auth(hr1.token))
        .send(base)
        .expect(201);
      advanceId = created.body.id;
      expect(created.body).toMatchObject({
        workerName: 'Dummy Advance Ramesh',
        createdBy: hr1.userId,
      });
    });

    it('will not let the person who raised an advance approve it', async () => {
      const res = await http()
        .patch(`/labour/advances/${advanceId}/approve`)
        .set(auth(hr1.token))
        .expect(403);
      expect(res.body.code).toBe('SELF_APPROVAL');
      const ok = await http()
        .patch(`/labour/advances/${advanceId}/approve`)
        .set(auth(hr2.token))
        .expect(200);
      expect(ok.body.approvedByName).toBe('hrtwo Tester');
      await http()
        .patch(`/labour/advances/${advanceId}/disburse`)
        .set(auth(hr2.token))
        .expect(200);
    });

    it('lists advances with the worker name', async () => {
      const res = await http()
        .get(`/labour/advances?workerId=${worker}`)
        .set(auth(hr1.token))
        .expect(200);
      expect(res.body[0]).toMatchObject({
        workerName: 'Dummy Advance Ramesh',
        labourCode: expect.stringMatching(/^E2E36-/),
        createdByName: 'hrone Tester',
      });
    });

    it('deducts the instalment on one sheet only, recovers it once and reverses what was recovered', async () => {
      const a = (await generate(site, ago(5)).expect(201)).body;
      const b = (await generate(site, ago(4)).expect(201)).body;
      const aLine = a.lines.find((l: any) => l.workerId === worker);
      expect(aLine.deductions).toEqual([
        expect.objectContaining({ advanceId, amount: 500 }),
      ]);
      expect(aLine.netPayable).toBe(100);
      // Before 036 the second sheet deducted the same 500 again.
      expect(b.lines[0].deductions).toEqual([]);
      expect(b.lines[0].netPayable).toBe(600);
      expect(b.lines[0].workerName).toBe('Dummy Advance Ramesh');

      await approveSheet(a.id);
      await approveSheet(b.id);
      await disburse(aLine.id, { paidAmount: 100 }).expect(200);
      await disburse(b.lines[0].id, { paidAmount: 600 }).expect(200);
      let advance = await sys.labourAdvance.findUnique({
        where: { id: advanceId },
      });
      expect(advance.outstandingBalance.toNumber()).toBe(0);
      expect(advance.status).toBe('closed');

      await http()
        .patch(`/labour/payment-sheets/lines/${aLine.id}/reverse`)
        .set(auth(hr2.token))
        .send({ reason: 'Wrong account' })
        .expect(200);
      advance = await sys.labourAdvance.findUnique({
        where: { id: advanceId },
      });
      expect(advance.outstandingBalance.toNumber()).toBe(500);
      expect(advance.status).toBe('disbursed');
    });
  });

  describe('O2 delete, regenerate and reopen', () => {
    let site: string;
    let worker: string;
    let sheetId: string;

    beforeAll(async () => {
      site = await makeSite('Del');
      worker = await makeWorker(site, 'Delete Suresh');
      await setRate(site, 600);
      await workDay(worker, ago(5));
    });

    it('locks the day under a draft, and says to delete the draft', async () => {
      sheetId = (await generate(site, ago(5)).expect(201)).body.id;
      const res = await correct({
        workerId: worker,
        date: ago(5),
        punchOut: '13:00',
      }).expect(409);
      expect(res.body.code).toBe('LABOUR_DAY_ON_PAYMENT_SHEET');
      expect(res.body.message).toContain('Delete that draft sheet');
    });

    it('deletes the draft softly, with an audit entry, and frees the day', async () => {
      const res = await http()
        .delete(`/labour/payment-sheets/${sheetId}`)
        .set(auth(hr1.token))
        .send({ reason: 'Wrong punch out' })
        .expect(200);
      expect(res.body).toEqual({ id: sheetId, deleted: true });
      await http()
        .get(`/labour/payment-sheets/${sheetId}`)
        .set(auth(hr1.token))
        .expect(404);
      const row = await sys.labourPaymentSheet.findUnique({
        where: { id: sheetId },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(hr1.userId);
      expect(
        await sys.auditLogEntry.count({
          where: { entityId: sheetId, action: 'DELETE' },
        }),
      ).toBe(1);

      await correct({
        workerId: worker,
        date: ago(5),
        punchOut: '13:00',
      }).expect(201);
      const again = (await generate(site, ago(5)).expect(201)).body;
      expect(again.lines[0].daysWorked).toBe(0.5);
      sheetId = again.id;
    });

    it('regenerates a draft with a rate set since', async () => {
      await setRate(site, 800, ago(6));
      const res = await http()
        .post(`/labour/payment-sheets/${sheetId}/regenerate`)
        .set(auth(hr1.token))
        .expect(201);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.lines[0]).toMatchObject({
        resolvedRate: 800,
        grossWage: 400,
      });
    });

    it('refuses to delete or regenerate an approved sheet, and reopen recomputes it', async () => {
      await approveSheet(sheetId);
      await http()
        .delete(`/labour/payment-sheets/${sheetId}`)
        .set(auth(hr1.token))
        .expect(409);
      await http()
        .post(`/labour/payment-sheets/${sheetId}/regenerate`)
        .set(auth(hr1.token))
        .expect(409);

      await setRate(site, 1000, ago(5));
      const res = await http()
        .patch(`/labour/payment-sheets/${sheetId}/reopen`)
        .set(auth(hr2.token))
        .send({ reason: 'Rate revised' })
        .expect(200);
      expect(res.body.status).toBe('draft');
      expect(res.body.lines[0]).toMatchObject({
        resolvedRate: 1000,
        grossWage: 500,
      });
    });
  });

  describe('O3 one generate at a time', () => {
    it('creates one sheet when two generates race', async () => {
      const site = await makeSite('Race');
      const worker = await makeWorker(site, 'Race Mahesh');
      await setRate(site, 600);
      await workDay(worker, ago(5));
      const results = await Promise.all([
        generate(site, ago(5)),
        generate(site, ago(5)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await sys.labourPaymentSheet.count({
          where: { siteId: site, deletedAt: null },
        }),
      ).toBe(1);
    });
  });

  describe('O4 carry-forward, the paid cap and legacy musters', () => {
    let site: string;
    let worker: string;
    let firstLineId: string;

    beforeAll(async () => {
      site = await makeSite('Carry');
      worker = await makeWorker(site, 'Carry Ganesh');
      const mate = await makeWorker(site, 'Carry Mate');
      await setRate(site, 600);
      await workDay(worker, ago(5));
      await workDay(mate, ago(5));
      await workDay(worker, ago(4));
    });

    it('refuses paying more than the net, and carries a short payment', async () => {
      // From ago(6), a day with no attendance, so a legacy muster can be placed under the sheet.
      const a = (await generate(site, ago(6), ago(5)).expect(201)).body;
      await approveSheet(a.id);
      firstLineId = a.lines.find((l: any) => l.workerId === worker).id;
      const over = await disburse(firstLineId, { paidAmount: 700 }).expect(400);
      expect(over.body.code).toBe('LABOUR_PAID_ABOVE_NET');
      const short = await disburse(firstLineId, {
        paidAmount: 400,
        shortPaymentReason: 'Cash ran short',
      }).expect(200);
      expect(
        short.body.lines.find((l: any) => l.id === firstLineId)
          .carriedForwardBalance,
      ).toBe(200);
    });

    it("puts the shortfall on the worker's next sheet as its own line", async () => {
      const b = (await generate(site, ago(4)).expect(201)).body;
      const carry = b.lines.find((l: any) => l.kind === 'carry_forward');
      const wage = b.lines.find((l: any) => l.kind === 'wage');
      expect(wage).toMatchObject({ workerId: worker, netPayable: 600 });
      expect(carry).toMatchObject({
        workerId: worker,
        carriedFromLineId: firstLineId,
        daysWorked: 0,
        grossWage: 0,
        netPayable: 200,
      });
      expect(b.netTotal).toBe(800);
      expect(b.grossTotal).toBe(600);
      expect(b.summary.carriedForwardAmount).toBe(200);

      const reverse = await http()
        .patch(`/labour/payment-sheets/lines/${firstLineId}/reverse`)
        .set(auth(hr2.token))
        .send({ reason: 'Oops' })
        .expect(409);
      expect(reverse.body.code).toBe('LABOUR_SHORTFALL_CARRIED');

      // Deleting the sheet that carried it frees the shortfall for the next one, once.
      await http()
        .delete(`/labour/payment-sheets/${b.id}`)
        .set(auth(hr1.token))
        .expect(200);
      const again = (await generate(site, ago(4)).expect(201)).body;
      expect(
        again.lines.filter((l: any) => l.kind === 'carry_forward'),
      ).toHaveLength(1);
    });

    it('refuses to approve a legacy muster on a day a sheet covers', async () => {
      const other = await makeWorker(site, 'Legacy Dinesh');
      const musterId = await legacyMuster(site, ago(6), other, hr1.userId);
      const res = await http()
        .patch(`/labour/musters/${musterId}/approve`)
        .set(auth(hr2.token))
        .expect(409);
      expect(res.body.code).toBe('LABOUR_DAY_ON_PAYMENT_SHEET');
    });

    it('refuses to generate while a muster in the period awaits approval, and names it', async () => {
      const other = await makeWorker(site, 'Legacy Naresh');
      const musterId = await legacyMuster(site, ago(3), other, hr1.userId);
      const res = await generate(site, ago(3)).expect(409);
      expect(res.body).toMatchObject({
        code: 'LABOUR_MUSTER_AWAITING_APPROVAL',
        musterId,
        date: ago(3),
      });

      const detail = await http()
        .get(`/labour/musters/${musterId}`)
        .set(auth(hr1.token))
        .expect(200);
      expect(detail.body.siteName).toMatch(/SiteCarry/);
      expect(detail.body.supervisorName).toBe('hrone Tester');
      expect(detail.body.lines[0].workerName).toBe('Dummy Legacy Naresh');
    });
  });

  describe('O5 night shifts', () => {
    let site: string;

    beforeAll(async () => {
      site = await makeSite('Night');
      await setRate(site, 600);
    });

    it('records a correction whose punch out is the next morning', async () => {
      const worker = await makeWorker(site, 'Night Ravi');
      const backwards = await correct({
        workerId: worker,
        date: ago(3),
        punchIn: '22:00',
        punchOut: '06:00',
      }).expect(400);
      expect(backwards.body.code).toBe('LABOUR_PUNCH_OUT_BEFORE_IN');

      const res = await correct({
        workerId: worker,
        date: ago(3),
        punchIn: '22:00',
        punchOut: '06:00',
        punchOutNextDay: true,
      }).expect(201);
      expect(res.body).toMatchObject({ status: 'full_day', hours: 8 });
      // 06:00 IST the next day.
      expect(res.body.punchOut.at).toBe(`${ago(2)}T00:30:00.000Z`);
    });

    it('refuses a next-day shift longer than 16 hours', async () => {
      const worker = await makeWorker(site, 'Night Long');
      const res = await correct({
        workerId: worker,
        date: ago(3),
        punchIn: '06:00',
        punchOut: '23:00',
        punchOutNextDay: true,
      }).expect(400);
      expect(res.body.code).toBe('LABOUR_SHIFT_TOO_LONG');
    });

    it("punches out today against yesterday's open punch-in", async () => {
      const reg = await http()
        .post('/labour/workers')
        .set(auth(hr1.token))
        .send({
          fullName: 'Dummy Night Shift',
          gender: 'male',
          siteId: site,
          photos: [JPEG, JPEG, JPEG],
        })
        .expect(201);
      const worker = reg.body.id;
      const yesterday = ago(1);
      await sys.labourPunch.create({
        data: {
          companyId,
          workerId: worker,
          siteId: site,
          punchDate: new Date(`${yesterday}T00:00:00.000Z`),
          type: 'in',
          punchedAt: new Date(Date.now() - 10 * 3_600_000),
          supervisorId: hr1.userId,
        },
      });

      const today = await http()
        .get(`/labour/attendance/today?siteId=${site}`)
        .set(auth(hr1.token))
        .expect(200);
      const row = today.body.items.find((i: any) => i.workerId === worker);
      expect(row.openShiftFrom).not.toBeNull();

      await http()
        .post('/labour/attendance/punch')
        .set(auth(hr1.token))
        .send({
          siteId: site,
          workerId: worker,
          type: 'out',
          photo: JPEG,
          latitude: SITE_LAT,
          longitude: SITE_LNG,
          accuracyMeters: 10,
        })
        .expect(201);
      const out = await sys.labourPunch.findFirst({
        where: { workerId: worker, type: 'out' },
      });
      expect(out.punchDate.toISOString().slice(0, 10)).toBe(yesterday);
    });
  });

  describe('O14 company checks for cross-company callers', () => {
    it("refuses registering labour at another company's site", async () => {
      const foreignSite = await makeSite('Foreign', otherCompanyId);
      await http()
        .post('/labour/workers')
        .set(auth(superUser.token))
        .send({
          companyId,
          fullName: 'Dummy Foreign',
          gender: 'male',
          siteId: foreignSite,
        })
        .expect(400);
      await http()
        .post('/labour/workers')
        .set(auth(hr1.token))
        .send({ fullName: 'Dummy Nowhere', gender: 'male', siteId: 'nope' })
        .expect(400);
    });

    it("refuses an advance for another company's worker", async () => {
      const foreignSite = await makeSite('Foreign2', otherCompanyId);
      const foreignWorker = await makeWorker(
        foreignSite,
        'Foreign Worker',
        otherCompanyId,
      );
      await http()
        .post('/labour/advances')
        .set(auth(superUser.token))
        .send({
          companyId,
          workerId: foreignWorker,
          amount: 500,
          reason: 'Test',
          recoveryInstalments: 1,
          recoveryStartPeriod: ago(10),
        })
        .expect(400);
    });
  });

  describe('O8 names in the reports', () => {
    it('returns worker and site names in the attendance report', async () => {
      const site = await makeSite('Report');
      const worker = await makeWorker(site, 'Report Kishore');
      await workDay(worker, ago(5));
      const res = await http()
        .get(
          `/labour/reports/attendance?siteId=${site}&periodFrom=${ago(
            6,
          )}&periodTo=${ago(1)}`,
        )
        .set(auth(hr1.token))
        .expect(200);
      expect(res.body.siteName).toMatch(/SiteReport/);
      expect(res.body.workers[0]).toMatchObject({
        workerId: worker,
        workerName: 'Dummy Report Kishore',
      });
    });
  });
});
