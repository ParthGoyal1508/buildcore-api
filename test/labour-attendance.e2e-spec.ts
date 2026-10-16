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
    ]);
    supervisor = await makeUser('supervisor', [
      Permission.DAILY_WORKER_REGISTRY,
    ]);
  });

  afterAll(async () => {
    if (companyId) {
      await sys.labourPunch.deleteMany({ where: { companyId } });
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

    it('marks a half day on punch-in and refuses a second punch-in', async () => {
      const res = await punch({ workerId: male }).expect(201);
      expect(res.body).toMatchObject({
        type: 'in',
        attendance: 'half_day',
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

    it('marks a full day on punch-out and builds an approved muster', async () => {
      const res = await punch({ workerId: male, type: 'out' }).expect(201);
      expect(res.body.attendance).toBe('full_day');

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
      const types = Object.fromEntries(
        rolls[0].lines.map((l: any) => [l.workerId, l.attendanceType]),
      );
      expect(types[male]).toBe('full_day');
      expect(types[female]).toBe('half_day');
    });

    it('refuses to list a site the supervisor is not assigned to', async () => {
      await http()
        .get(`/labour/attendance/today?siteId=${siteB}`)
        .set(auth(supervisor.token))
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

    it('prices full and half days at the male and female site rates', async () => {
      const monthStart = `${YEAR}-${String(MONTH).padStart(2, '0')}-01`;
      await http()
        .post('/labour/site-rates')
        .set(auth(hr.token))
        .send({
          siteId: siteA,
          effectiveFrom: monthStart,
          maleRate: 600,
          femaleRate: 500,
        })
        .expect(201);

      const res = await http()
        .post('/labour/payment-sheets')
        .set(auth(hr.token))
        .send({ siteId: siteA, periodFrom: monthStart, periodTo: TODAY })
        .expect(201);
      expect(res.body.siteId).toBe(siteA);
      expect(res.body.grossTotal).toBe(850);
      const byRate = res.body.lines
        .map((l: any) => [
          l.daysWorked,
          l.resolvedRate,
          l.grossWage,
          l.rateSource,
        ])
        .sort();
      expect(byRate).toEqual([
        [0.5, 500, 250, 'site_rate'],
        [1, 600, 600, 'site_rate'],
      ]);

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
    it('marks P for in+out and H for in only', async () => {
      const res = await http()
        .get(
          `/labour/sheets/attendance?siteId=${siteA}&year=${YEAR}&month=${MONTH}`,
        )
        .set(auth(supervisor.token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const ws = (await readWorkbook(res.body)).getWorksheet('Attendance');
      const rows: any[] = [];
      ws.eachRow((row) => rows.push(row.values));
      // Columns: [unused, Code, Name, Father, Gender, day1..dayN, Full, Half, Total]
      const dayCol = 4 + DAY;
      const ramesh = rows.find((r) => r[2] === 'Dummy Ramesh');
      expect(ramesh[dayCol]).toBe('P');
      const halfRow = rows.find(
        (r) => r[1] === 'LAB-0002' && r[dayCol] === 'H',
      );
      expect(halfRow).toBeTruthy();
      // Everyone active at the site is listed, worked or not.
      expect(rows.filter((r) => String(r[1]).startsWith('LAB-'))).toHaveLength(
        5,
      );
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
