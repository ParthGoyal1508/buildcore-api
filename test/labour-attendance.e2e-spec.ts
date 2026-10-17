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
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  NoFaceDetectedError,
  euclideanDistance,
} from '../src/hr/biometrics/biometrics.service';

/**
 * 031 labour face attendance, end to end against a real database: supervisor site assignment,
 * registration with 3–5 photos and an incrementing code, face punch in/out with refusal on a
 * mismatch, the employee geofence rule, site × gender rates, the site payment sheet, and both
 * Excel downloads. Fixtures are prefixed `E2ELB` and removed in `afterAll`.
 */
const PREFIX = 'E2ELB';
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
/** 034: hours are tested on yesterday, through corrections — a punch uses the server's clock. */
const YESTERDAY = new Date(Date.UTC(YEAR, MONTH - 1, DAY - 1))
  .toISOString()
  .slice(0, 10);
const [Y_YEAR, Y_MONTH, Y_DAY] = YESTERDAY.split('-').map(Number);

/** The face-api stand-in: "same person" is whatever `nextValue` the test sets. */
class ScriptedBiometrics extends BiometricsService {
  public nextValue = 0.5;
  public failWithNoFace = false;
  async computeDescriptor(): Promise<Float32Array> {
    if (this.failWithNoFace) throw new NoFaceDetectedError(0);
    return Float32Array.from(
      { length: FACE_DESCRIPTOR_LENGTH },
      () => this.nextValue,
    );
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

describe('Labour face attendance (031, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  const biometrics = new ScriptedBiometrics();

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
  /** ~1.1 km north of the site, well outside its 200 m fence. */
  const FAR_LAT = 19.086;

  let companyId: string;
  let siteA: string;
  let siteB: string;
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

  const register = (body: Record<string, unknown>, token = supervisor.token) =>
    http()
      .post('/labour/workers')
      .set(auth(token))
      .send({
        fullName: 'Dummy Labour',
        gender: 'male',
        siteId: siteA,
        photos: [JPEG, JPEG, JPEG],
        ...body,
      });

  const punch = (body: Record<string, unknown>) =>
    http()
      .post('/labour/attendance/punch')
      .set(auth(supervisor.token))
      .send({
        siteId: siteA,
        type: 'in',
        photo: JPEG,
        latitude: SITE_LAT,
        longitude: SITE_LNG,
        accuracyMeters: 10,
        ...body,
      });

  const readWorkbook = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BiometricsService)
      .useValue(biometrics)
      .compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'Dummy Labour Test Firm',
        shortCode: unique('LB').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;
    for (const label of ['A', 'B']) {
      const site = await sys.site.create({
        data: {
          companyId,
          name: unique(`Site${label}`),
          latitude: SITE_LAT,
          longitude: SITE_LNG,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        },
      });
      if (label === 'A') siteA = site.id;
      else siteB = site.id;
    }

    hr = await makeUser('hr', [
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
      Permission.LABOUR_PUNCH_CORRECT,
    ]);
    supervisor = await makeUser('supervisor', [
      Permission.DAILY_WORKER_REGISTRY,
    ]);
  });

  afterAll(async () => {
    if (companyId) {
      await sys.labourPunch.deleteMany({ where: { companyId } });
      await sys.labourPunchCorrection.deleteMany({ where: { companyId } });
      await sys.labourSitePhoto.deleteMany({ where: { companyId } });
      await sys.labourPunchRefusal.deleteMany({ where: { companyId } });
      await sys.labourPaymentSheet.deleteMany({ where: { companyId } });
      await sys.musterRoll.deleteMany({ where: { companyId } });
      await sys.siteWageRate.deleteMany({ where: { companyId } });
      await sys.supervisorSite.deleteMany({ where: { companyId } });
      await sys.labourCodeSequence.deleteMany({ where: { companyId } });
      await sys.labourWorker.deleteMany({ where: { companyId } });
      await sys.site.deleteMany({ where: { companyId } });
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
    if (companyId) {
      await sys.company.deleteMany({ where: { id: companyId } });
    }
    await app.close();
  });

  describe('Supervisor site assignment', () => {
    it('gives an unassigned supervisor no sites', async () => {
      const res = await http()
        .get('/labour/my-sites')
        .set(auth(supervisor.token))
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('lets HR list supervisors and assign site A', async () => {
      const list = await http()
        .get('/labour/supervisor-sites')
        .set(auth(hr.token))
        .expect(200);
      const ids = list.body.supervisors.map((s: any) => s.userId);
      expect(ids).toEqual(
        expect.arrayContaining([supervisor.userId, hr.userId]),
      );

      await http()
        .put(`/labour/supervisor-sites/${supervisor.userId}`)
        .set(auth(hr.token))
        .send({ siteIds: [siteA] })
        .expect(200);

      const mine = await http()
        .get('/labour/my-sites')
        .set(auth(supervisor.token))
        .expect(200);
      expect(mine.body.map((s: any) => s.id)).toEqual([siteA]);
    });

    it('refuses a supervisor assigning sites', async () => {
      await http()
        .put(`/labour/supervisor-sites/${supervisor.userId}`)
        .set(auth(supervisor.token))
        .send({ siteIds: [siteA, siteB] })
        .expect(403);
    });

    it('shows HR every site without assignment', async () => {
      const res = await http()
        .get('/labour/my-sites')
        .set(auth(hr.token))
        .expect(200);
      expect(res.body.map((s: any) => s.id).sort()).toEqual(
        [siteA, siteB].sort(),
      );
    });
  });

  describe('Registration', () => {
    it('refuses a site the supervisor is not assigned to', async () => {
      const res = await register({ siteId: siteB }).expect(403);
      expect(res.body.code).toBe('LABOUR_SITE_NOT_ASSIGNED');
    });

    it('needs 3 to 5 photos', async () => {
      await register({ photos: [JPEG, JPEG] }).expect(400);
      await register({ photos: [JPEG, JPEG, JPEG, JPEG, JPEG, JPEG] }).expect(
        400,
      );
    });

    it('rejects a malformed mobile number', async () => {
      await register({ phone: '12345' }).expect(400);
    });

    it('fails the whole registration when a photo has no face', async () => {
      biometrics.failWithNoFace = true;
      try {
        const res = await register({ fullName: 'Dummy No Face' }).expect(400);
        expect(res.body.code).toBe('LABOUR_FACE_NOT_DETECTED');
      } finally {
        biometrics.failWithNoFace = false;
      }
      const count = await sys.labourWorker.count({
        where: { companyId, fullName: 'Dummy No Face' },
      });
      expect(count).toBe(0);
    });

    it('registers with name and gender only, and codes count up without gaps under concurrency', async () => {
      biometrics.nextValue = 0.5;
      const first = await register({
        fullName: 'Dummy Ramesh',
        fatherName: 'Dummy Suresh',
        phone: '9876543210',
      }).expect(201);
      expect(first.body.labourCode).toBe('LAB-0001');
      expect(first.body.faceEnrolled).toBe(true);
      expect(first.body.fatherName).toBe('Dummy Suresh');

      const many = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          register({ fullName: `Dummy Parallel ${i}`, gender: 'female' }),
        ),
      );
      many.forEach((r) => expect(r.status).toBe(201));
      const codes = many.map((r) => r.body.labourCode).sort();
      expect(codes).toEqual(['LAB-0002', 'LAB-0003', 'LAB-0004', 'LAB-0005']);
    });
  });

  describe('Face punch', () => {
    let male: string;
    let female: string;

    beforeAll(async () => {
      const workers = await sys.labourWorker.findMany({
        where: { companyId },
        orderBy: { labourCode: 'asc' },
      });
      male = workers.find((w: any) => w.labourCode === 'LAB-0001').id;
      female = workers.find((w: any) => w.labourCode === 'LAB-0002').id;
    });

    it('refuses punch-out before punch-in', async () => {
      const res = await punch({ workerId: male, type: 'out' }).expect(409);
      expect(res.body.code).toBe('LABOUR_NOT_PUNCHED_IN');
    });

    it('refuses a face that does not match and records the attempt', async () => {
      biometrics.nextValue = 0.9;
      const res = await punch({ workerId: male }).expect(422);
      expect(res.body.code).toBe('LABOUR_PUNCH_REFUSED_FACE');
      expect(res.body.reason).toBe('face_mismatch');
      biometrics.nextValue = 0.5;

      expect(await sys.labourPunch.count({ where: { workerId: male } })).toBe(
        0,
      );
      const refusals = await http()
        .get(`/labour/attendance/refusals?siteId=${siteA}`)
        .set(auth(supervisor.token))
        .expect(200);
      expect(refusals.body[0]).toMatchObject({
        workerId: male,
        reason: 'face_mismatch',
      });
    });

    it('refuses a photo with no face', async () => {
      biometrics.failWithNoFace = true;
      try {
        const res = await punch({ workerId: male }).expect(422);
        expect(res.body.reason).toBe('no_face_detected');
      } finally {
        biometrics.failWithNoFace = false;
      }
    });

    it('refuses outside the fence when the company enforces the punch block', async () => {
      await sys.company.update({
        where: { id: companyId },
        data: { punchBlockEnforced: true },
      });
      try {
        const res = await punch({ workerId: male, latitude: FAR_LAT }).expect(
          422,
        );
        expect(res.body.code).toBe('LABOUR_PUNCH_REFUSED_LOCATION');
      } finally {
        await sys.company.update({
          where: { id: companyId },
          data: { punchBlockEnforced: false },
        });
      }
    });

    it('is on site after punch-in and refuses a second punch-in', async () => {
      const res = await punch({ workerId: male }).expect(201);
      expect(res.body).toMatchObject({
        type: 'in',
        status: 'on_site',
        hours: null,
        geofenceViolation: false,
      });
      const again = await punch({ workerId: male }).expect(409);
      expect(again.body.code).toBe('LABOUR_ALREADY_PUNCHED');
    });

    it('accepts and flags a punch outside the fence while the block is off', async () => {
      const res = await punch({ workerId: female, latitude: FAR_LAT }).expect(
        201,
      );
      expect(res.body.geofenceViolation).toBe(true);
    });

    it('counts a punch-out minutes after the punch-in as short, by the hours', async () => {
      const res = await punch({ workerId: male, type: 'out' }).expect(201);
      expect(res.body.status).toBe('short');
      expect(res.body.hours).toBeLessThan(1);

      const today = await http()
        .get(`/labour/attendance/today?siteId=${siteA}`)
        .set(auth(supervisor.token))
        .expect(200);
      expect(today.body.date).toBe(TODAY);
      const row = today.body.items.find((i: any) => i.workerId === male);
      expect(row.punchInAt).toBeTruthy();
      expect(row.punchOutAt).toBeTruthy();

      const rolls = await sys.musterRoll.findMany({
        where: { companyId, siteId: siteA },
        include: { lines: true },
      });
      expect(rolls).toHaveLength(1);
      expect(rolls[0]).toMatchObject({
        source: 'face_punch',
        status: 'approved',
        geofenceViolation: true,
      });
      // Short is kept as an unpaid line; still on site has no line until the punch-out.
      const types = Object.fromEntries(
        rolls[0].lines.map((l: any) => [l.workerId, l.attendanceType]),
      );
      expect(types[male]).toBe('absent');
      expect(types[female]).toBeUndefined();
    });

    it('refuses to list a site the supervisor is not assigned to', async () => {
      await http()
        .get(`/labour/attendance/today?siteId=${siteB}`)
        .set(auth(supervisor.token))
        .expect(403);
    });
  });

  describe('Muster attendance and corrections (034)', () => {
    let male: string;
    let female: string;
    const correct = (body: Record<string, unknown>, token = hr.token) =>
      http()
        .post('/labour/muster-attendance/corrections')
        .set(auth(token))
        .send({ date: YESTERDAY, reason: 'Phone had no signal', ...body });

    beforeAll(async () => {
      const workers = await sys.labourWorker.findMany({ where: { companyId } });
      male = workers.find((w: any) => w.labourCode === 'LAB-0001').id;
      female = workers.find((w: any) => w.labourCode === 'LAB-0002').id;
    });

    it('lists today with on site, short and absent, and the summary counts', async () => {
      const res = await http()
        .get(`/labour/muster-attendance/daily?siteId=${siteA}`)
        .set(auth(supervisor.token))
        .expect(200);
      expect(res.body.date).toBe(TODAY);
      const byId = Object.fromEntries(
        res.body.items.map((i: any) => [i.workerId, i]),
      );
      expect(byId[male]).toMatchObject({ status: 'short', flag: null });
      expect(byId[male].punchIn.source).toBe('face');
      expect(byId[male].punchIn.recordedBy).toBe('supervisor Tester');
      expect(byId[female]).toMatchObject({ status: 'on_site', flag: null });
      expect(byId[female].punchIn.outsideFence).toBe(true);
      expect(res.body.summary).toMatchObject({
        workers: 5,
        short: 1,
        onSite: 1,
        absent: 3,
        missingPunchOut: 0,
      });
    });

    it('refuses a correction without the permission, a reason, or in order', async () => {
      await correct(
        { workerId: male, punchIn: '08:00' },
        supervisor.token,
      ).expect(403);
      await correct({ workerId: male, punchIn: '08:00', reason: '' }).expect(
        400,
      );
      const backwards = await correct({
        workerId: male,
        punchIn: '18:00',
        punchOut: '09:00',
      }).expect(400);
      expect(backwards.body.code).toBe('LABOUR_PUNCH_OUT_BEFORE_IN');
      expect(
        await sys.labourPunch.count({
          where: { workerId: male, punchDate: new Date(YESTERDAY) },
        }),
      ).toBe(0);
    });

    it('adds both punches by correction and counts overtime beyond the shift', async () => {
      const res = await correct({
        workerId: male,
        punchIn: '08:00',
        punchOut: '18:30',
      }).expect(201);
      expect(res.body).toMatchObject({
        status: 'full_day',
        hours: 10.5,
        overtimeHours: 2.5,
        flag: null,
      });
      expect(res.body.punchIn).toMatchObject({
        source: 'correction',
        corrected: true,
      });
    });

    it('flags a missing punch out on an earlier day and filters by it', async () => {
      await correct({ workerId: female, punchIn: '09:00' }).expect(201);
      const res = await http()
        .get(
          `/labour/muster-attendance/daily?siteId=${siteA}&date=${YESTERDAY}&filter=missing_punch_out`,
        )
        .set(auth(supervisor.token))
        .expect(200);
      expect(res.body.summary.missingPunchOut).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        workerId: female,
        status: 'unresolved',
        flag: 'missing_punch_out',
      });
    });

    it('will not make a payment sheet while a day has a missing punch', async () => {
      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({ siteId: siteA, periodFrom: YESTERDAY, periodTo: TODAY })
        .expect(409);
      expect(res.body.code).toBe('LABOUR_UNRESOLVED_PUNCHES');
      expect(res.body.unresolved).toEqual([
        { workerId: female, date: YESTERDAY },
      ]);
    });

    it('resolves it by correction and keeps the edit history', async () => {
      const res = await correct({
        workerId: female,
        punchOut: '14:00',
        reason: 'Left early, forgot to punch out',
      }).expect(201);
      expect(res.body).toMatchObject({ status: 'half_day', hours: 5 });

      await correct({
        workerId: female,
        punchOut: '14:30',
        reason: 'Gate register says 2:30',
      }).expect(201);
      const history = await http()
        .get(
          `/labour/muster-attendance/corrections?workerId=${female}&date=${YESTERDAY}`,
        )
        .set(auth(supervisor.token))
        .expect(200);
      expect(history.body).toHaveLength(3);
      expect(history.body[0]).toMatchObject({
        type: 'out',
        reason: 'Gate register says 2:30',
        correctedBy: 'hr Tester',
      });
      expect(history.body[0].oldPunchedAt).toBe(history.body[1].newPunchedAt);
      expect(history.body[2]).toMatchObject({ type: 'in', oldPunchedAt: null });
    });

    it('re-counts unpaid days when HR changes the day rules', async () => {
      await http()
        .put('/labour/muster-attendance/rules')
        .set(auth(supervisor.token))
        .send({ fullDayHours: 11, halfDayHours: 4, standardHours: 8 })
        .expect(403);
      await http()
        .put('/labour/muster-attendance/rules')
        .set(auth(hr.token))
        .send({ fullDayHours: 4, halfDayHours: 4, standardHours: 8 })
        .expect(400);

      const lineFor = async (workerId: string) =>
        (
          await sys.musterLine.findFirst({
            where: { workerId, muster: { date: new Date(YESTERDAY) } },
          })
        )?.attendanceType;
      const changed = await http()
        .put('/labour/muster-attendance/rules')
        .set(auth(hr.token))
        .send({ fullDayHours: 11, halfDayHours: 4, standardHours: 8 })
        .expect(200);
      expect(changed.body.recounted).toBeGreaterThanOrEqual(3);
      expect(await lineFor(male)).toBe('half_day');

      await http()
        .put('/labour/muster-attendance/rules')
        .set(auth(hr.token))
        .send({ fullDayHours: 8, halfDayHours: 4, standardHours: 8 })
        .expect(200);
      expect(await lineFor(male)).toBe('full_day');
      const rules = await http()
        .get('/labour/muster-attendance/rules')
        .set(auth(supervisor.token))
        .expect(200);
      expect(rules.body).toEqual({
        fullDayHours: 8,
        halfDayHours: 4,
        standardHours: 8,
      });
    });

    it("shows the month's times and hours per day", async () => {
      const res = await http()
        .get(
          `/labour/muster-attendance/monthly?siteId=${siteA}&year=${Y_YEAR}&month=${Y_MONTH}`,
        )
        .set(auth(supervisor.token))
        .expect(200);
      const m = res.body.items.find((i: any) => i.workerId === male);
      expect(m.days[YESTERDAY]).toMatchObject({
        status: 'full_day',
        hours: 10.5,
      });
      expect(m.totals).toMatchObject({ fullDays: 1, overtimeHours: 2.5 });
      expect(res.body.summary.unresolved).toBe(0);
    });

    it('keeps a group photo for reference without marking anyone', async () => {
      const before = await sys.labourPunch.count({ where: { companyId } });
      const added = await http()
        .post('/labour/muster-attendance/site-photos')
        .set(auth(supervisor.token))
        .send({ siteId: siteA, photo: JPEG, note: 'Morning gang' })
        .expect(201);
      expect(added.body).toMatchObject({ siteId: siteA, note: 'Morning gang' });
      const list = await http()
        .get(`/labour/muster-attendance/site-photos?siteId=${siteA}`)
        .set(auth(supervisor.token))
        .expect(200);
      expect(list.body).toHaveLength(1);
      await http()
        .get(`/labour/muster-attendance/site-photos/${added.body.id}/image`)
        .set(auth(supervisor.token))
        .expect(200)
        .expect('Content-Type', /image\/jpeg/);
      expect(await sys.labourPunch.count({ where: { companyId } })).toBe(
        before,
      );
      await http()
        .post('/labour/muster-attendance/site-photos')
        .set(auth(supervisor.token))
        .send({ siteId: siteB, photo: JPEG })
        .expect(403);
    });
  });

  describe('Site rates and payment sheet', () => {
    it('refuses a supervisor setting rates', async () => {
      await http()
        .post('/labour/site-rates')
        .set(auth(supervisor.token))
        .send({ siteId: siteA, effectiveFrom: TODAY, maleRate: 600 })
        .expect(403);
    });

    it('cannot generate before a rate exists, and names what is missing', async () => {
      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({ siteId: siteA, periodFrom: TODAY, periodTo: TODAY })
        .expect(409);
      expect(res.body.code).toBe('LABOUR_SITE_RATE_MISSING');
    });

    it('prices days and overtime from the punch hours, then locks those days', async () => {
      await http()
        .post('/labour/site-rates')
        .set(auth(hr.token))
        .send({
          siteId: siteA,
          effectiveFrom: YESTERDAY,
          maleRate: 600,
          femaleRate: 500,
        })
        .expect(201);
      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({ siteId: siteA, periodFrom: YESTERDAY, periodTo: TODAY })
        .expect(201);
      expect(res.body.siteId).toBe(siteA);
      // Male: a full day at 600 plus 2.5 h overtime at 600 / 8 × 2; today short, unpaid.
      // Female: a half day at 500 (5.5 h); today still on site, not counted.
      expect(res.body.grossTotal).toBe(600 + 375 + 250);
      const byRate = res.body.lines
        .map((l: any) => [
          l.daysWorked,
          l.overtimeHours,
          l.resolvedRate,
          l.grossWage,
        ])
        .sort();
      expect(byRate).toEqual([
        [0.5, 0, 500, 250],
        [1, 2.5, 600, 975],
      ]);

      const locked = await http()
        .post('/labour/muster-attendance/corrections')
        .set(auth(hr.token))
        .send({
          workerId: res.body.lines.find((l: any) => l.daysWorked === 1)
            .workerId,
          date: YESTERDAY,
          punchOut: '17:00',
          reason: 'Late change',
        })
        .expect(409);
      expect(locked.body.code).toBe('LABOUR_DAY_ON_PAYMENT_SHEET');

      const xlsx = await http()
        .get(`/labour/sheets/payment/${res.body.id}`)
        .set(auth(hr.token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      const wb = await readWorkbook(xlsx.body);
      const values = JSON.stringify(
        wb.getWorksheet('Payment sheet').getSheetValues(),
      );
      expect(values).toContain('Dummy Ramesh');
      expect(values).toContain('Dummy Suresh');
    });

    it('refuses an overlapping sheet for the same site', async () => {
      await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({ siteId: siteA, periodFrom: TODAY, periodTo: TODAY })
        .expect(409);
    });
  });

  describe('Month-end attendance sheet', () => {
    it('marks the day codes and lists the punch times', async () => {
      const res = await http()
        .get(
          `/labour/sheets/attendance?siteId=${siteA}&year=${Y_YEAR}&month=${Y_MONTH}`,
        )
        .set(auth(supervisor.token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = await readWorkbook(res.body);
      const ws = wb.getWorksheet('Attendance');
      const rows: any[] = [];
      ws.eachRow((row) => rows.push(row.values));
      // Columns: [unused, Code, Name, Father, Gender, Contractor/Gang, day1..dayN, …]
      const dayCol = 5 + Y_DAY;
      const ramesh = rows.find((r) => r[2] === 'Dummy Ramesh');
      expect(ramesh[dayCol]).toBe('P');
      const female = rows.find((r) => r[1] === 'LAB-0002');
      expect(female[dayCol]).toBe('H');
      // Everyone active at the site is listed, worked or not.
      expect(rows.filter((r) => String(r[1]).startsWith('LAB-'))).toHaveLength(
        5,
      );

      const punches = JSON.stringify(
        wb.getWorksheet('Punch times').getSheetValues(),
      );
      expect(punches).toContain(YESTERDAY);
      expect(punches).toContain('10.5');
      expect(punches).toContain('Full day');
    });

    it('refuses a site the supervisor is not assigned to', async () => {
      await http()
        .get(
          `/labour/sheets/attendance?siteId=${siteB}&year=${YEAR}&month=${MONTH}`,
        )
        .set(auth(supervisor.token))
        .expect(403);
    });
  });
});
