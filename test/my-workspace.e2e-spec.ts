import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
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
 * End-to-end coverage of face enrolment (US1) and punch (US2) against a real
 * database — required by the constitution, which mandates e2e tests for endpoints
 * touching auth or PII, and biometric attendance is squarely both.
 *
 * Fixtures are prefixed `E2EMW` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2EMW';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** A 1x1 JPEG. Real enough to pass the magic-number check; the fake matcher below
 * is what decides identity, so no real photograph is needed. */
const JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const descriptorOf = (value: number) =>
  Float32Array.from({ length: FACE_DESCRIPTOR_LENGTH }, () => value);

/**
 * Dates are all derived from "now" rather than hard-coded.
 *
 * The payroll lock (FR-010) closes a period once the lock day of the following
 * month passes, so any fixed date in this file would start returning 423 the month
 * after it was written. Anchoring on the current month keeps the suite runnable
 * forever without anyone having to remember why it broke.
 */
const NOW = new Date();
const YEAR = NOW.getUTCFullYear();
const MONTH = NOW.getUTCMonth() + 1;

/** Day 0 of the next month is the last day of this one. */
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** `YYYY-MM-DD` for a day-of-month in the current month. */
const dayOf = (day: number) =>
  new Date(Date.UTC(YEAR, MONTH - 1, day)).toISOString().slice(0, 10);

/**
 * Today as the *employee* sees it, which is the day a punch is stamped with
 * (FR-018a) — not the UTC day the constants above are built from.
 *
 * The two diverge for five and a half hours every evening: at 23:00 on the 4th in
 * Kolkata it is still the 3rd in UTC. Anything asserting on a punch this suite
 * just created has to ask in the business timezone or it looks up an empty day.
 */
const BUSINESS_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const BUSINESS_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(NOW);

/** The Indian financial year containing today, matching `financialYearOf`. */
const FINANCIAL_YEAR = (() => {
  const startYear = NOW.getUTCMonth() >= 3 ? YEAR : YEAR - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
})();

// A five-day leave window starting on the 10th, with the 12th seeded as a site
// holiday. Whichever of those five dates fall on a Sunday (the site's weekly off)
// are not chargeable either, so the expected count is computed the same way the
// service computes it rather than being written down as a constant that would be
// wrong in months where the 10th lands differently.
const LEAVE_FROM = dayOf(10);
const LEAVE_TO = dayOf(14);
const HOLIDAY = dayOf(12);
const LEAVE_WORKING_DAYS = [10, 11, 12, 13, 14].filter((day) => {
  const date = new Date(Date.UTC(YEAR, MONTH - 1, day));
  return date.getUTCDay() !== 0 && dayOf(day) !== HOLIDAY;
}).length;

/**
 * Deterministic stand-in for face-api, injected in place of the real matcher.
 *
 * Attendance behaviour — exception routing, sequencing, payroll locks — is what
 * these tests are about, and running genuine WASM inference against real
 * photographs would make them slow, non-deterministic, and would require
 * committing biometric data to the repository. The real implementation's inference
 * is verified separately; this fake makes "same person" an input the test controls.
 */
class ScriptedBiometrics extends BiometricsService {
  /** Value the next computed descriptor is filled with. */
  public nextValue = 0.5;
  public failWithNoFace = false;

  async computeDescriptor(): Promise<Float32Array> {
    if (this.failWithNoFace) {
      throw new NoFaceDetectedError(0);
    }
    return descriptorOf(this.nextValue);
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

describe('My Workspace — enrolment and punch (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  const biometrics = new ScriptedBiometrics();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** Fixture access under the system/bypass RLS context, mirroring settings.e2e. */
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
  let siteId: string;
  /** The site holiday fixture, removed in afterAll along with its site link. */
  let holidayId: string | undefined;
  let shiftId: string;
  let employeeUserId: string;
  let employeeToken: string;
  let employeeId: string;
  let otherUserId: string;
  let otherToken: string;
  let otherEmployeeId: string;
  let adminUserId: string;
  let adminToken: string;
  let adminRoleId: string;
  let workerRoleId: string;

  const SITE_LAT = 19.076;
  const SITE_LNG = 72.8777;

  const punchBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'in',
    photo: JPEG,
    latitude: SITE_LAT,
    longitude: SITE_LNG,
    capturedAt: new Date().toISOString(),
    ...overrides,
  });

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
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, roleId: role.id, token: login.body.accessToken };
  };

  /**
   * A signed-in, enrolled employee with an untouched punch day.
   *
   * FR-008 allows one punch-in and one punch-out per employee per day, so scenarios
   * that each need their own punch cannot share `employeeToken` — the second would
   * be refused with 409. Giving each its own employee keeps them independent
   * without dating punches into other months, which the payroll lock would close
   * (see the note on date handling at the top of this file).
   *
   * Enrolled through the real endpoint rather than seeded, so the descriptor is
   * produced and stored exactly as production would.
   */
  const enrolledWorker = async (label: string) => {
    const worker = await makeUser(label, [Permission.MY_WORKSPACE]);
    const employee = await sys.employee.create({
      data: {
        userId: worker.userId,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique(label.toUpperCase()).slice(0, 12),
      },
    });
    await http()
      .post('/my/face-enrol')
      .set(auth(worker.token))
      .send({
        photos: [JPEG, JPEG, JPEG],
        consentMethod: 'digital',
        consentAcknowledged: true,
      })
      .expect(201);
    return { ...worker, employeeId: employee.id };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The one binding swapped out: everything else is the real application.
      .overrideProvider(BiometricsService)
      .useValue(biometrics)
      .compile();

    // `bodyParser: false` + configureApp() applies the SAME parsers and pipes
    // main.ts does, rather than hand-copying a subset of them. Mirroring by hand is
    // what previously let the suite pass against an app configured differently from
    // the deployed one — see configure-app.ts.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'E2E MW Constructions',
        shortCode: unique('MW').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: SITE_LAT,
        longitude: SITE_LNG,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    siteId = site.id;

    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00.000Z'),
        outTime: new Date('1970-01-01T18:00:00.000Z'),
        graceMinutes: 10,
      },
    });
    shiftId = shift.id;

    const worker = await makeUser('worker', [Permission.MY_WORKSPACE]);
    employeeUserId = worker.userId;
    employeeToken = worker.token;
    workerRoleId = worker.roleId;

    const other = await makeUser('other', [Permission.MY_WORKSPACE]);
    otherUserId = other.userId;
    otherToken = other.token;

    const admin = await makeUser('admin', [
      Permission.MY_WORKSPACE,
      Permission.ATTENDANCE,
      // Re-enrolment approval is gated on EMPLOYEES rather than ATTENDANCE: it
      // decides whose face the gate accepts, which is a record-level identity
      // decision, not an attendance correction.
      Permission.EMPLOYEES,
    ]);
    adminUserId = admin.userId;
    adminToken = admin.token;
    adminRoleId = admin.roleId;

    const employee = await sys.employee.create({
      data: {
        userId: employeeUserId,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('EMP').slice(0, 12),
      },
    });
    employeeId = employee.id;

    const otherEmployee = await sys.employee.create({
      data: {
        userId: otherUserId,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('OTH').slice(0, 12),
      },
    });
    otherEmployeeId = otherEmployee.id;
  });

  afterAll(async () => {
    // Cascades to its HolidaySite link, so one delete is enough.
    if (holidayId) {
      await sys.holiday.deleteMany({ where: { id: holidayId } });
    }
    if (companyId) {
      const employees = await sys.employee.findMany({
        where: { companyId },
        select: { id: true },
      });
      const ids = employees.map((e: { id: string }) => e.id);
      if (ids.length) {
        await sys.punchRecord.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.reEnrolmentRequest.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.faceEnrolment.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.leaveApplication.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.leaveBalance.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.reimbursementClaim.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.salarySlip.deleteMany({
          where: { employeeId: { in: ids } },
        });
        await sys.employee.deleteMany({ where: { id: { in: ids } } });
      }
      await sys.payrollRun.deleteMany({ where: { companyId } });
      await sys.reimbursementCategory.deleteMany({ where: { companyId } });
      await sys.site.deleteMany({ where: { companyId } });
      await sys.shift.deleteMany({ where: { companyId } });
      await sys.company.deleteMany({ where: { id: companyId } });
    }
    for (const id of [employeeUserId, otherUserId, adminUserId].filter(
      Boolean,
    )) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.user.deleteMany({ where: { id } });
    }
    for (const id of [workerRoleId, adminRoleId].filter(Boolean)) {
      await sys.role.deleteMany({ where: { id } });
    }
    await app.close();
  });

  // ------------------------------------------------------------- User Story 1
  describe('Face enrolment (US1, T020/T021)', () => {
    it('reports not_enrolled before any enrolment', async () => {
      const res = await http()
        .get('/my/face-enrol')
        .set(auth(employeeToken))
        .expect(200);
      expect(res.body.status).toBe('not_enrolled');
      expect(res.body.enrolledAt).toBeNull();
    });

    it('rejects fewer than 3 photos with 400', async () => {
      await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG],
          consentMethod: 'digital',
          consentAcknowledged: true,
        })
        .expect(400);
    });

    it('rejects unacknowledged consent with 400', async () => {
      // Biometric enrolment without recorded consent is not permitted (FR-002).
      await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG, JPEG],
          consentMethod: 'digital',
          consentAcknowledged: false,
        })
        .expect(400);
    });

    it('rejects a photo with no detectable face with 400', async () => {
      biometrics.failWithNoFace = true;
      await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG, JPEG],
          consentMethod: 'digital',
          consentAcknowledged: true,
        })
        .expect(400);
      biometrics.failWithNoFace = false;
    });

    it('enrols with 3 photos and recorded consent', async () => {
      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG, JPEG],
          consentMethod: 'digital',
          consentAcknowledged: true,
        })
        .expect(201);

      expect(res.body.status).toBe('enrolled');
      expect(res.body.enrolledAt).not.toBeNull();

      const stored = await sys.faceEnrolment.findUnique({
        where: { employeeId },
      });
      // The descriptor is persisted; the raw photos are not (research.md §2).
      expect(stored.descriptor).not.toBeNull();
      expect(stored.descriptor.length).toBe(FACE_DESCRIPTOR_LENGTH * 4);
      expect(stored.photoRefs).toHaveLength(3);
      expect(stored.consentAcknowledgedAt).not.toBeNull();
    });

    it('rejects a second enrolment with 409', async () => {
      await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG, JPEG],
          consentMethod: 'digital',
          consentAcknowledged: true,
        })
        .expect(409);
    });

    it('writes an audit entry for the enrolment without recording the biometric data', async () => {
      const entries = await sys.auditLogEntry.findMany({
        where: { entityType: 'FACE_ENROLMENT', accountId: employeeUserId },
      });
      expect(entries.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(entries.map((e: any) => e.changes));
      expect(serialized).not.toContain('face-enrolment/');
      expect(serialized).not.toContain('descriptor');
    });
  });

  // ------------------------------------------------------------- User Story 2
  describe('Punch (US2, T028–T031)', () => {
    it('rejects a punch from an employee with no enrolment (T029)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(otherToken))
        .send(punchBody())
        .expect(400);
    });

    it('records a matching, in-geofence punch-in as clean (T028)', async () => {
      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(201);

      expect(res.body.type).toBe('in');
      expect(res.body.faceMatchResult).toBe('matched');
      expect(res.body.geofenceResult).toBe('in_range');
      expect(res.body.isOfflineSync).toBe(false);
    });

    it('rejects a second punch-in while the first is open (T029, FR-008)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(409);
    });

    it('accepts the punch-out that closes the pair (T028)', async () => {
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
        .expect(201);
      expect(res.body.type).toBe('out');

      // The punch-in is now closed, which is what frees the partial unique index.
      const open = await sys.punchRecord.findMany({
        where: { employeeId, type: 'in', closedByPunchId: null },
      });
      expect(open).toHaveLength(0);
    });

    it('rejects a second punch-out on the same day (T029, FR-008)', async () => {
      // Renamed to what it actually exercises: the pair above is already complete,
      // so this is the second punch-out, not a punch-out with nothing to close.
      // The genuine no-punch-in case is covered on a fresh employee below.
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
        .expect(409);
    });

    it('rejects a punch-out with no punch-in that day (T123, FR-008)', async () => {
      const worker = await enrolledWorker('nopunchin');
      await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ type: 'out' }))
        .expect(409);
    });

    it('rejects a second punch-in after the day is closed (T121, FR-008)', async () => {
      // The rule this amendment introduces: a completed pair used to free the day
      // for another punch-in, and no longer does.
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(409);
    });

    it('reports the day as complete once both punches are in (T121, FR-008b)', async () => {
      const res = await http()
        .get('/my/punch/open')
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body.punchedInAt).toEqual(expect.any(String));
      expect(res.body.punchedOutAt).toEqual(expect.any(String));
      expect(res.body.isComplete).toBe(true);
    });

    it('records an out-of-geofence punch as an exception, still 201 (T030)', async () => {
      // Its own employee: `employeeToken` has already used today's one pair
      // (FR-008), so reusing it here would be refused with 409 rather than
      // exercising the geofence path.
      const worker = await enrolledWorker('geofence');
      // ~5.5 km from the site centre, well outside the 200 m radius.
      const res = await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ latitude: SITE_LAT + 0.05 }))
        .expect(201);

      expect(res.body.geofenceResult).toBe('exception');
      const record = await sys.punchRecord.findUnique({
        where: { id: res.body.id },
      });
      expect(record.exceptionResolution).toBe('pending');
    });

    it('records a non-matching face as an exception, still 201 (T030, FR-007)', async () => {
      // Enrolled at the usual descriptor, then punched by "someone else". The
      // punch-out that used to open this test existed only to free the old
      // one-open-punch-in slot; under FR-008 a fresh employee is what a fresh
      // punch needs.
      const worker = await enrolledWorker('facemismatch');

      // A different person's descriptor: distance far above the 0.6 threshold.
      biometrics.nextValue = 5;
      const res = await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody())
        .expect(201);

      expect(res.body.faceMatchResult).toBe('exception');
      biometrics.nextValue = 0.5;
    });

    it('flags an offline-queued punch (research.md §4)', async () => {
      // Its own employee, so the queued punch-in lands on an untouched day. The
      // punch-out bracketing this test previously existed only to free the old
      // one-open-punch-in slot, and under FR-008 would now be refused.
      const worker = await enrolledWorker('queued');

      // Three hours old: well past the clock-skew tolerance, well inside the
      // offline-queue window.
      const queued = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const res = await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ capturedAt: queued }))
        .expect(201);
      expect(res.body.isOfflineSync).toBe(true);

      // And the day's punch-out still closes it. Dated a minute after the
      // punch-in rather than at `now`: FR-008 pairs punches by calendar day, and
      // a run started just after midnight IST would otherwise put the two on
      // different days and get a 409 for the wrong reason.
      await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(
          punchBody({
            type: 'out',
            capturedAt: new Date(Date.parse(queued) + 60_000).toISOString(),
          }),
        )
        .expect(201);
    });

    it('returns 423 for a punch in an already-locked payroll period (T031, FR-010)', async () => {
      // Two months back is locked whatever the lock day.
      const old = new Date();
      old.setUTCMonth(old.getUTCMonth() - 2);
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ capturedAt: old.toISOString() }))
        .expect(423);
    });

    it('rejects a punch older than the offline-sync window (FR-012)', async () => {
      // Stale but inside the current, unlocked month.
      const now = new Date();
      const stale = new Date(now.getTime() - 80 * 3_600_000);
      if (stale.getUTCMonth() === now.getUTCMonth()) {
        await http()
          .post('/my/punch')
          .set(auth(employeeToken))
          .send(punchBody({ capturedAt: stale.toISOString() }))
          .expect(400);
      }
    });
  });

  // ------------------------------------------- Ownership: FR-028's core guarantee
  describe('Caller can only reach their own data (T029, FR-028)', () => {
    it('scopes enrolment status to the caller, not to any supplied identifier', async () => {
      // The second employee has no enrolment; if any body/query parameter could
      // redirect the lookup, this would return the first employee's status.
      const res = await http()
        .get('/my/face-enrol')
        .query({ employeeId })
        .set(auth(otherToken))
        .expect(200);
      expect(res.body.status).toBe('not_enrolled');
    });

    it('rejects an attempt to smuggle an employeeId into a punch', async () => {
      // `forbidNonWhitelisted` makes an unexpected property a 400 outright, so an
      // employeeId can never reach the service to be honoured.
      await http()
        .post('/my/punch')
        .set(auth(otherToken))
        .send({ ...punchBody(), employeeId })
        .expect(400);
    });

    it('never exposes another employee id in the caller-facing punch result', async () => {
      // Its own employee: the shared one's single punch-in and punch-out for the
      // day were spent by the US2 describe, and FR-008 allows no more.
      const worker = await enrolledWorker('leakcheck');
      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody())
        .expect(201);
      expect(JSON.stringify(res.body)).not.toContain(otherEmployeeId);

      await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ type: 'out' }))
        .expect(201);
    });
  });

  // ------------------------------------------------------ Admin exception queue
  describe('Attendance exceptions (US2 admin, T030, FR-011a)', () => {
    let pendingPunchId: string;

    it('lists pending exceptions for an admin', async () => {
      const res = await http()
        .get('/workspace-admin/attendance-exceptions')
        .set(auth(adminToken))
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      pendingPunchId = res.body[0].id;
    });

    it('refuses a caller without the ATTENDANCE permission', async () => {
      await http()
        .get('/workspace-admin/attendance-exceptions')
        .set(auth(employeeToken))
        .expect(403);
    });

    it('resolves an exception as confirmed', async () => {
      const res = await http()
        .post(
          `/workspace-admin/attendance-exceptions/${pendingPunchId}/resolve`,
        )
        .set(auth(adminToken))
        .send({ resolution: 'confirmed' })
        .expect(201);

      expect(res.body.exceptionResolution).toBe('confirmed');
      expect(res.body.resolvedByUserId).toBe(adminUserId);
      expect(res.body.resolvedAt).not.toBeNull();
    });

    it('refuses to re-decide an already-resolved exception', async () => {
      // Re-deciding would silently overwrite another admin's judgement.
      await http()
        .post(
          `/workspace-admin/attendance-exceptions/${pendingPunchId}/resolve`,
        )
        .set(auth(adminToken))
        .send({ resolution: 'rejected' })
        .expect(403);
    });

    it('rejects an invalid resolution value', async () => {
      // `pending` is a state, not a decision — resolving back to unresolved must
      // not be expressible.
      const res = await http()
        .get('/workspace-admin/attendance-exceptions')
        .set(auth(adminToken))
        .expect(200);
      if (res.body.length > 0) {
        await http()
          .post(
            `/workspace-admin/attendance-exceptions/${res.body[0].id}/resolve`,
          )
          .set(auth(adminToken))
          .send({ resolution: 'pending' })
          .expect(400);
      }
    });
  });

  // -------------------------------------------------------- Consent withdrawal
  describe('Consent withdrawal (US1, T021, FR-004)', () => {
    it('deletes the template and reverts status', async () => {
      const res = await http()
        .delete('/my/face-enrol/consent')
        .set(auth(employeeToken))
        .expect(200);
      expect(res.body.status).toBe('not_enrolled');

      const stored = await sys.faceEnrolment.findUnique({
        where: { employeeId },
      });
      // Gone, not soft-deleted: a retained descriptor is still biometric data.
      expect(stored.descriptor).toBeNull();
      expect(stored.photoRefs).toHaveLength(0);
      expect(stored.enrolledAt).toBeNull();
      expect(stored.status).toBe('not_enrolled');
    });

    it('blocks punching once consent is withdrawn (FR-005)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(400);
    });

    it('is idempotent', async () => {
      await http()
        .delete('/my/face-enrol/consent')
        .set(auth(employeeToken))
        .expect(200);
    });

    it('allows re-enrolling after withdrawal', async () => {
      // Withdrawal returns the employee to not_enrolled, so the ordinary enrolment
      // path must work again — the 409 guard applies only while actually enrolled.
      await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos: [JPEG, JPEG, JPEG],
          consentMethod: 'signed_paper',
          consentAcknowledged: true,
        })
        .expect(201);
    });
  });

  // ------------------------------------------------------------- User Story 3
  describe('Attendance history (US3, T040)', () => {
    it('returns every date of the month with a computed status', async () => {
      const res = await http()
        .get(`/my/punch/history?month=${MONTH}&year=${YEAR}`)
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body.days).toHaveLength(daysInMonth(YEAR, MONTH));
      expect(res.body.days[0].date).toBe(dayOf(1));
      expect(res.body.days.at(-1).date).toBe(dayOf(daysInMonth(YEAR, MONTH)));
    });

    it('marks the site’s weekly off day as weekly_off', async () => {
      const res = await http()
        .get(`/my/punch/history?month=${MONTH}&year=${YEAR}`)
        .set(auth(employeeToken))
        .expect(200);

      // The site's weeklyOffDay is 0 (Sunday); no punch or leave exists on the
      // Sundays of this month.
      const sundays = res.body.days.filter(
        (d: { dayOfWeek: number }) => d.dayOfWeek === 0,
      );
      expect(sundays.length).toBeGreaterThan(0);
      for (const day of sundays) {
        expect(['weekly_off', 'present', 'on_leave']).toContain(day.status);
      }
    });

    it('marks a day with a punch pair as present, with in/out times', async () => {
      // Asked for in the business timezone, because that is the day the US2
      // punches below were stamped with — see `BUSINESS_TODAY`.
      const [year, month] = BUSINESS_TODAY.split('-').map(Number);
      const res = await http()
        .get(`/my/punch/history?month=${month}&year=${year}`)
        .set(auth(employeeToken))
        .expect(200);

      // The US2 tests above punched today.
      const today = res.body.days.find(
        (d: { date: string }) => d.date === BUSINESS_TODAY,
      );
      expect(today.status).toBe('present');
      expect(today.inTime).not.toBeNull();
    });

    it('marks a working day with nothing recorded as absent', async () => {
      const res = await http()
        .get(`/my/punch/history?month=${MONTH}&year=${YEAR}`)
        .set(auth(employeeToken))
        .expect(200);

      expect(
        res.body.days.some((d: { status: string }) => d.status === 'absent'),
      ).toBe(true);
    });

    it('returns a blank month rather than an error when nothing happened', async () => {
      // A month before this employee existed still has to render — an employee
      // paging back through history must not hit an error wall.
      const res = await http()
        .get('/my/punch/history?month=1&year=2020')
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body.days).toHaveLength(31);
      expect(
        res.body.days.every((d: { inTime: null }) => d.inTime === null),
      ).toBe(true);
    });

    it('scopes history to the caller, never to another employee', async () => {
      // The other employee has never punched, so an identical request returns a
      // month with nothing in it — proof the route reads the token, not a shared
      // dataset.
      const res = await http()
        .get(`/my/punch/history?month=${MONTH}&year=${YEAR}`)
        .set(auth(otherToken))
        .expect(200);

      expect(
        res.body.days.every((d: { status: string }) => d.status !== 'present'),
      ).toBe(true);
    });

    it('rejects a month outside 1–12', async () => {
      await http()
        .get(`/my/punch/history?month=13&year=${YEAR}`)
        .set(auth(employeeToken))
        .expect(400);
    });
  });

  // ------------------------------------------------------------- User Story 4
  describe('Leave (US4, T044–T047)', () => {
    let pendingApplicationId: string;
    let approvableApplicationId: string;

    beforeAll(async () => {
      // 12 days of earned leave to spend, and one site holiday inside the range
      // the day-count test applies for.
      await sys.leaveBalance.create({
        data: {
          employeeId,
          leaveType: 'earned',
          financialYear: FINANCIAL_YEAR,
          opening: 12,
        },
      });
      // `projects.Site.holidays` was dropped by migration
      // 20260901194500_drop_site_holidays_column and superseded by the first-class
      // `hr.Holiday` calendar (see the comment above the model). This spec still
      // wrote to the old column, so the whole suite failed to set up long before
      // 008 touched it; the calendar row below is the same fixture expressed the
      // way the schema now models it.
      holidayId = (
        await sys.holiday.create({
          data: {
            companyId,
            name: 'E2EMW Holiday',
            date: new Date(`${HOLIDAY}T00:00:00.000Z`),
            appliesToAllSites: false,
            sites: { create: [{ siteId }] },
          },
        })
      ).id;
    });

    it('returns every leave type, including ones with no entitlement', async () => {
      const res = await http()
        .get('/my/leave/balance')
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body).toHaveLength(4);
      const earned = res.body.find(
        (b: { leaveType: string }) => b.leaveType === 'earned',
      );
      expect(earned.balance).toBe(12);
      const casual = res.body.find(
        (b: { leaveType: string }) => b.leaveType === 'casual',
      );
      expect(casual.balance).toBe(0);
    });

    it('computes dayCount excluding weekly offs and site holidays (T044)', async () => {
      const res = await http()
        .post('/my/leave/applications')
        .set(auth(employeeToken))
        .send({
          leaveType: 'earned',
          fromDate: LEAVE_FROM,
          toDate: LEAVE_TO,
          reason: 'Family function',
        })
        .expect(201);

      expect(res.body.status).toBe('pending');
      // The range spans LEAVE_SPAN dates; the holiday seeded above and any Sunday
      // in it are not chargeable.
      expect(Number(res.body.dayCount)).toBe(LEAVE_WORKING_DAYS);
      pendingApplicationId = res.body.id;
    });

    it('rejects an application exceeding the available balance (T044)', async () => {
      await http()
        .post('/my/leave/applications')
        .set(auth(employeeToken))
        .send({
          leaveType: 'earned',
          fromDate: dayOf(1),
          toDate: dayOf(daysInMonth(YEAR, MONTH)),
          reason: 'Whole month',
        })
        .expect(400);
    });

    it('never balance-checks LWP (T044, FR-020)', async () => {
      // Leave without pay is unpaid by definition, so there is no entitlement for
      // it to exhaust — a month of it must still be accepted.
      const res = await http()
        .post('/my/leave/applications')
        .set(auth(employeeToken))
        .send({
          leaveType: 'lwp',
          fromDate: dayOf(1),
          toDate: dayOf(daysInMonth(YEAR, MONTH)),
          reason: 'Extended absence',
        })
        .expect(201);
      expect(res.body.status).toBe('pending');
      approvableApplicationId = res.body.id;
    });

    it('rejects an inverted date range', async () => {
      await http()
        .post('/my/leave/applications')
        .set(auth(employeeToken))
        .send({
          leaveType: 'casual',
          fromDate: LEAVE_TO,
          toDate: LEAVE_FROM,
          reason: 'Backwards',
        })
        .expect(400);
    });

    it('returns 423 for a range inside a locked payroll period (T047)', async () => {
      const twoMonthsBack = new Date();
      twoMonthsBack.setUTCMonth(twoMonthsBack.getUTCMonth() - 2);
      const locked = twoMonthsBack.toISOString().slice(0, 10);
      await http()
        .post('/my/leave/applications')
        .set(auth(employeeToken))
        .send({
          leaveType: 'casual',
          fromDate: locked,
          toDate: locked,
          reason: 'Retroactive',
        })
        .expect(423);
    });

    it('lists only the caller’s own applications (T045, FR-022)', async () => {
      const mine = await http()
        .get('/my/leave/applications')
        .set(auth(employeeToken))
        .expect(200);
      expect(mine.body.length).toBeGreaterThan(0);

      const theirs = await http()
        .get('/my/leave/applications')
        .set(auth(otherToken))
        .expect(200);
      expect(theirs.body).toHaveLength(0);
    });

    it('refuses to let one employee cancel another’s application (T045)', async () => {
      await http()
        .post(`/my/leave/applications/${pendingApplicationId}/cancel`)
        .set(auth(otherToken))
        .expect(404);
    });

    it('scopes the balance to the caller (T045)', async () => {
      const res = await http()
        .get('/my/leave/balance')
        .set(auth(otherToken))
        .expect(200);
      expect(res.body.every((b: { balance: number }) => b.balance === 0)).toBe(
        true,
      );
    });

    it('cancels a pending application (T045)', async () => {
      const res = await http()
        .post(`/my/leave/applications/${pendingApplicationId}/cancel`)
        .set(auth(employeeToken))
        .expect(201);
      expect(res.body.status).toBe('cancelled');
    });

    it('refuses to cancel a non-pending application with 409 (T045)', async () => {
      await http()
        .post(`/my/leave/applications/${pendingApplicationId}/cancel`)
        .set(auth(employeeToken))
        .expect(409);
    });

    describe('admin decisions (T046, FR-022a)', () => {
      it('refuses a caller without the ATTENDANCE permission', async () => {
        await http()
          .get('/workspace-admin/leave-applications')
          .set(auth(employeeToken))
          .expect(403);
      });

      it('lists pending applications for an approver', async () => {
        const res = await http()
          .get('/workspace-admin/leave-applications')
          .set(auth(adminToken))
          .expect(200);
        expect(
          res.body.some(
            (a: { id: string }) => a.id === approvableApplicationId,
          ),
        ).toBe(true);
      });

      it('requires remarks when rejecting', async () => {
        await http()
          .post(
            `/workspace-admin/leave-applications/${approvableApplicationId}/decide`,
          )
          .set(auth(adminToken))
          .send({ decision: 'rejected' })
          .expect(400);
      });

      it('approves an application and debits the balance', async () => {
        const before = await http()
          .get('/my/leave/balance')
          .set(auth(employeeToken))
          .expect(200);

        const approved = await http()
          .post(
            `/workspace-admin/leave-applications/${approvableApplicationId}/decide`,
          )
          .set(auth(adminToken))
          .send({ decision: 'approved' })
          .expect(201);
        expect(approved.body.status).toBe('approved');

        // The approved application was LWP, which has no balance to debit — the
        // earned balance must be exactly as it was.
        const after = await http()
          .get('/my/leave/balance')
          .set(auth(employeeToken))
          .expect(200);
        const earnedBefore = before.body.find(
          (b: { leaveType: string }) => b.leaveType === 'earned',
        ).balance;
        const earnedAfter = after.body.find(
          (b: { leaveType: string }) => b.leaveType === 'earned',
        ).balance;
        expect(earnedAfter).toBe(earnedBefore);
      });

      it('makes approved dates show as on_leave in attendance history (T046)', async () => {
        const res = await http()
          .get(`/my/punch/history?month=${MONTH}&year=${YEAR}`)
          .set(auth(employeeToken))
          .expect(200);

        expect(
          res.body.days.some(
            (d: { status: string }) => d.status === 'on_leave',
          ),
        ).toBe(true);
      });

      it('refuses to re-decide a settled application with 409', async () => {
        await http()
          .post(
            `/workspace-admin/leave-applications/${approvableApplicationId}/decide`,
          )
          .set(auth(adminToken))
          .send({ decision: 'rejected', remarks: 'Changed my mind' })
          .expect(409);
      });
    });
  });

  // ------------------------------------------------------------- User Story 5
  describe('Salary slip (US5, T055)', () => {
    const DRAFT_PERIOD = '2026-05';
    const PAID_PERIOD = '2026-06';

    beforeAll(async () => {
      const figures = {
        monthDays: 30,
        payableDays: 28,
        lopDays: 2,
        otHours: 10,
        earningBasic: 18000,
        earningHra: 7200,
        earningConveyance: 1600,
        earningSiteAllowance: 2500,
        earningSpecialAllowance: 1200,
        earningOt: 1800,
        deductionPf: 2160,
        deductionEsic: 243,
        deductionPt: 200,
        deductionTds: 0,
        deductionLoanEmi: 1500,
        deductionAdvanceRecovery: 500,
        employerPf: 1980,
        employerEps: 1250,
        employerEdli: 75,
        employerAdminCharges: 90,
        employerGratuity: 866,
        employerBonus: 1499,
        netPay: 27697,
        minimumWagesNote: 'Meets the notified minimum wage.',
      };
      await sys.payrollRun.create({
        data: { companyId, period: DRAFT_PERIOD, status: 'draft' },
      });
      await sys.payrollRun.create({
        data: { companyId, period: PAID_PERIOD, status: 'paid' },
      });
      await sys.salarySlip.create({
        data: { employeeId, period: DRAFT_PERIOD, ...figures },
      });
      await sys.salarySlip.create({
        data: { employeeId, period: PAID_PERIOD, ...figures },
      });
    });

    it('excludes draft periods from the available list (T055, FR-024)', async () => {
      const res = await http()
        .get('/my/salary/available-periods')
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body).toContain(PAID_PERIOD);
      expect(res.body).not.toContain(DRAFT_PERIOD);
    });

    it('returns the full slip projection for a published period (T055)', async () => {
      const res = await http()
        .get(`/my/salary/${PAID_PERIOD}`)
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body.period).toBe(PAID_PERIOD);
      expect(res.body.earnings.basic).toBe(18000);
      expect(res.body.earnings.total).toBe(32300);
      expect(res.body.deductions.total).toBe(4603);
      expect(res.body.netPay).toBe(27697);
      expect(res.body.netPayInWords).toMatch(/Rupees Only$/);
      // Employer contributions are informational and must not be netted off.
      expect(res.body.employerContributions.total).toBeGreaterThan(0);
    });

    it('returns 404 for a period whose run is still draft (T055)', async () => {
      await http()
        .get(`/my/salary/${DRAFT_PERIOD}`)
        .set(auth(employeeToken))
        .expect(404);
    });

    it('returns 404 for a period that has no run at all', async () => {
      await http()
        .get('/my/salary/1999-01')
        .set(auth(employeeToken))
        .expect(404);
    });

    it('never serves another employee’s slip (T055, FR-028)', async () => {
      // Identical request, different token: the other employee has no slip, so
      // there is nothing to return — the route reads the token, not a parameter.
      await http()
        .get(`/my/salary/${PAID_PERIOD}`)
        .set(auth(otherToken))
        .expect(404);
    });

    it('serves a PDF with the same figures as the JSON (T055)', async () => {
      const res = await http()
        .get(`/my/salary/${PAID_PERIOD}/pdf`)
        .set(auth(employeeToken))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.body.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });
  });

  // ------------------------------------------------------------- User Story 6
  describe('Offline punch sync (US6, T061–T062)', () => {
    // Its own employee, and its own `queued` instant shared by the pair below.
    // FR-008 gives each employee one punch-in and one punch-out per calendar day,
    // all of which the shared employee spent in the US2 describe; and pinning the
    // punch-out to the punch-in's day keeps the pair together for a run that
    // starts just after midnight IST.
    let offlineWorker: Awaited<ReturnType<typeof enrolledWorker>>;
    let queued: Date;

    beforeAll(async () => {
      offlineWorker = await enrolledWorker('offlinesync');
      queued = new Date(Date.now() - 4 * 3_600_000);
    });

    it('preserves the declared capture time and tags the punch (T061)', async () => {
      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/punch')
        .set(auth(offlineWorker.token))
        .send(punchBody({ type: 'in', capturedAt: queued.toISOString() }))
        .expect(201);

      expect(res.body.isOfflineSync).toBe(true);
      expect(new Date(res.body.capturedAt).getTime()).toBe(queued.getTime());

      const row = await sys.punchRecord.findFirst({
        where: { id: res.body.id },
      });
      // Both timestamps are retained — flattening them would hide that the punch
      // was written retroactively (FR-012).
      expect(row.receivedAt.getTime()).toBeGreaterThan(
        row.capturedAt.getTime(),
      );
    });

    it('rejects a capture older than the offline window with 400 (T062)', async () => {
      const ancient = new Date(Date.now() - 200 * 3_600_000);
      await http()
        .post('/my/punch')
        .set(auth(offlineWorker.token))
        .send(punchBody({ type: 'out', capturedAt: ancient.toISOString() }))
        .expect(400);
    });

    it('closes the offline pair so the next punch-in is possible', async () => {
      await http()
        .post('/my/punch')
        .set(auth(offlineWorker.token))
        .send(
          punchBody({
            type: 'out',
            capturedAt: new Date(queued.getTime() + 60_000).toISOString(),
          }),
        )
        .expect(201);
    });
  });

  // ------------------------------------------------------------- User Story 7
  describe('Re-enrolment (US7, T065–T068)', () => {
    let requestId: string;

    it('rejects a completion attempt with no unlock (T066, FR-013)', async () => {
      await http()
        .post('/my/face-enrol/re-enrolment-complete')
        .set(auth(employeeToken))
        .send({ photos: [JPEG, JPEG, JPEG], consentAcknowledged: true })
        .expect(403);
    });

    it('records a request and moves status to re_enrolment_requested (T065)', async () => {
      const res = await http()
        .post('/my/face-enrol/re-enrolment-request')
        .set(auth(employeeToken))
        .send({ reason: 'Grew a beard; matching keeps failing' })
        .expect(201);
      requestId = res.body.id;

      const status = await http()
        .get('/my/face-enrol')
        .set(auth(employeeToken))
        .expect(200);
      expect(status.body.status).toBe('re_enrolment_requested');
    });

    it('refuses a second request while one is outstanding (T066)', async () => {
      await http()
        .post('/my/face-enrol/re-enrolment-request')
        .set(auth(employeeToken))
        .send({ reason: 'Again' })
        .expect(409);
    });

    it('refuses an approver without the EMPLOYEES permission (T066)', async () => {
      await http()
        .get('/workspace-admin/re-enrolment-requests')
        .set(auth(employeeToken))
        .expect(403);
    });

    it('requires remarks when rejecting (T066)', async () => {
      await http()
        .post(`/workspace-admin/re-enrolment-requests/${requestId}/decide`)
        .set(auth(adminToken))
        .send({ decision: 'rejected' })
        .expect(400);
    });

    it('approves the request and issues a bounded unlock (T065)', async () => {
      const res = await http()
        .post(`/workspace-admin/re-enrolment-requests/${requestId}/decide`)
        .set(auth(adminToken))
        .send({ decision: 'approved' })
        .expect(201);

      expect(res.body.status).toBe('approved');
      expect(res.body.unlockExpiresAt).not.toBeNull();
      expect(res.body.unlockConsumedAt).toBeNull();
    });

    it('completes the capture, replacing the template (T065)', async () => {
      biometrics.nextValue = 0.25;
      const res = await http()
        .post('/my/face-enrol/re-enrolment-complete')
        .set(auth(employeeToken))
        .send({ photos: [JPEG, JPEG, JPEG], consentAcknowledged: true })
        .expect(200);

      expect(res.body.status).toBe('enrolled');

      const request = await sys.reEnrolmentRequest.findFirst({
        where: { id: requestId },
      });
      expect(request.status).toBe('completed');
      expect(request.unlockConsumedAt).not.toBeNull();
    });

    it('refuses a second completion once the unlock is consumed (T066)', async () => {
      // One approval, one replacement. Anything else turns a single decision into
      // a standing licence to change whose face the gate accepts.
      await http()
        .post('/my/face-enrol/re-enrolment-complete')
        .set(auth(employeeToken))
        .send({ photos: [JPEG, JPEG, JPEG], consentAcknowledged: true })
        .expect(403);
    });

    it('refuses a completion once the unlock window has expired (T067)', async () => {
      const expired = await sys.reEnrolmentRequest.create({
        data: {
          employeeId,
          reason: 'Stale approval',
          status: 'approved',
          decidedAt: new Date(Date.now() - 10 * 86_400_000),
          unlockExpiresAt: new Date(Date.now() - 3 * 86_400_000),
        },
      });

      await http()
        .post('/my/face-enrol/re-enrolment-complete')
        .set(auth(employeeToken))
        .send({ photos: [JPEG, JPEG, JPEG], consentAcknowledged: true })
        .expect(403);

      await sys.reEnrolmentRequest.deleteMany({ where: { id: expired.id } });
    });

    it('auto-closes a pending request when consent is withdrawn (T068, FR-017)', async () => {
      const pending = await http()
        .post('/my/face-enrol/re-enrolment-request')
        .set(auth(employeeToken))
        .send({ reason: 'Another change' })
        .expect(201);

      await http()
        .delete('/my/face-enrol/consent')
        .set(auth(employeeToken))
        .expect(200);

      const closed = await sys.reEnrolmentRequest.findFirst({
        where: { id: pending.body.id },
      });
      expect(closed.status).toBe('expired');

      const status = await http()
        .get('/my/face-enrol')
        .set(auth(employeeToken))
        .expect(200);
      expect(status.body.status).toBe('not_enrolled');
    });
  });

  // ------------------------------------------------------------- User Story 8
  describe('Reimbursement claims (US8, T078–T080)', () => {
    let categoryId: string;
    let noReceiptCategoryId: string;
    let draftClaimId: string;
    let submittedClaimId: string;

    beforeAll(async () => {
      const travel = await sys.reimbursementCategory.create({
        data: {
          companyId,
          code: unique('TRV').slice(0, 10),
          name: 'Travel',
          receiptRequiredAbove: 1000,
        },
      });
      categoryId = travel.id;

      const misc = await sys.reimbursementCategory.create({
        data: {
          companyId,
          code: unique('MSC').slice(0, 10),
          name: 'Miscellaneous',
          receiptRequiredAbove: null,
        },
      });
      noReceiptCategoryId = misc.id;
    });

    it('accepts a claim below the receipt threshold with no receipt (T078)', async () => {
      const res = await http()
        .post('/my/reimbursements')
        .set(auth(employeeToken))
        .send({
          categoryId,
          amount: 750,
          expenseDate: dayOf(2),
          description: 'Site visit auto fare',
        })
        .expect(201);

      expect(res.body.status).toBe('submitted');
      submittedClaimId = res.body.id;
    });

    it('rejects a claim above the threshold with no receipt (T078, FR-030)', async () => {
      await http()
        .post('/my/reimbursements')
        .set(auth(employeeToken))
        .send({
          categoryId,
          amount: 4500,
          expenseDate: dayOf(3),
          description: 'Intercity travel',
        })
        .expect(400);
    });

    it('accepts the same claim once a receipt is attached (T078)', async () => {
      const res = await http()
        .post('/my/reimbursements')
        .set(auth(employeeToken))
        .send({
          categoryId,
          amount: 4500,
          expenseDate: dayOf(3),
          description: 'Intercity travel',
          receiptRef: 'receipts/ref-1',
          status: 'draft',
        })
        .expect(201);

      expect(res.body.status).toBe('draft');
      draftClaimId = res.body.id;
    });

    it('accepts any amount for a category with no threshold (T078)', async () => {
      await http()
        .post('/my/reimbursements')
        .set(auth(employeeToken))
        .send({
          categoryId: noReceiptCategoryId,
          amount: 99999,
          expenseDate: dayOf(4),
          description: 'Uncapped category',
        })
        .expect(201);
    });

    it('rejects a claim against an unknown category', async () => {
      await http()
        .post('/my/reimbursements')
        .set(auth(employeeToken))
        .send({
          categoryId: 'not-a-real-category',
          amount: 100,
          expenseDate: dayOf(5),
          description: 'Bogus',
        })
        .expect(400);
    });

    it('edits a draft claim (T079)', async () => {
      const res = await http()
        .patch(`/my/reimbursements/${draftClaimId}`)
        .set(auth(employeeToken))
        .send({ description: 'Intercity travel — corrected' })
        .expect(200);
      expect(res.body.description).toBe('Intercity travel — corrected');
    });

    it('re-checks the receipt rule against the edited amount (T079)', async () => {
      // Raising the amount past the threshold must require the receipt the
      // original claim did not need.
      await http()
        .patch(`/my/reimbursements/${submittedClaimId}`)
        .set(auth(employeeToken))
        .send({ amount: 5000 })
        .expect(409); // submitted, so no longer editable at all
    });

    it('refuses to edit a submitted claim with 409 (T079)', async () => {
      await http()
        .patch(`/my/reimbursements/${submittedClaimId}`)
        .set(auth(employeeToken))
        .send({ description: 'Too late' })
        .expect(409);
    });

    it('withdraws a submitted claim while still pending (T079, FR-032)', async () => {
      const res = await http()
        .post(`/my/reimbursements/${submittedClaimId}/withdraw`)
        .set(auth(employeeToken))
        .expect(201);
      expect(res.body.status).toBe('withdrawn');
    });

    it('refuses to withdraw an already-withdrawn claim (T079)', async () => {
      await http()
        .post(`/my/reimbursements/${submittedClaimId}/withdraw`)
        .set(auth(employeeToken))
        .expect(409);
    });

    it('lists only the caller’s own claims (T080, FR-033)', async () => {
      const mine = await http()
        .get('/my/reimbursements')
        .set(auth(employeeToken))
        .expect(200);
      expect(mine.body.length).toBeGreaterThan(0);

      const theirs = await http()
        .get('/my/reimbursements')
        .set(auth(otherToken))
        .expect(200);
      expect(theirs.body).toHaveLength(0);
    });

    it('refuses to let one employee act on another’s claim (T080)', async () => {
      await http()
        .patch(`/my/reimbursements/${draftClaimId}`)
        .set(auth(otherToken))
        .send({ description: 'Not mine' })
        .expect(404);

      await http()
        .post(`/my/reimbursements/${draftClaimId}/withdraw`)
        .set(auth(otherToken))
        .expect(404);

      await http()
        .delete(`/my/reimbursements/${draftClaimId}`)
        .set(auth(otherToken))
        .expect(404);
    });

    it('refuses to delete a non-draft claim (T079, FR-031)', async () => {
      await http()
        .delete(`/my/reimbursements/${submittedClaimId}`)
        .set(auth(employeeToken))
        .expect(409);
    });

    it('deletes a draft claim (T079, FR-031)', async () => {
      await http()
        .delete(`/my/reimbursements/${draftClaimId}`)
        .set(auth(employeeToken))
        .expect(204);

      const remaining = await http()
        .get('/my/reimbursements')
        .set(auth(employeeToken))
        .expect(200);
      expect(
        remaining.body.some((c: { id: string }) => c.id === draftClaimId),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------- Audit trail
  // -------------------------------------------------- Realistic payload sizes
  describe('Accepts realistically-sized photo payloads (T098)', () => {
    /**
     * Every other test in this suite posts a 160-byte 1x1 JPEG, which is roughly
     * 3500x smaller than what the app actually uploads. That gap is not academic:
     * it let the API ship with Express's 100 KB body default still in place, so a
     * fully green suite coexisted with an enrolment endpoint that returned
     * `413 request entity too large` for every real request.
     *
     * These cases post photographs of representative dimensions — the face-api
     * package ships sample images — so a body limit regression fails here instead
     * of in the field.
     */
    const demoDir = join(
      dirname(require.resolve('@vladmandic/face-api/package.json')),
      'demo',
    );
    const realPhoto = () =>
      readFileSync(join(demoDir, 'sample1.jpg')).toString('base64');

    beforeAll(async () => {
      await http().delete('/my/face-enrol/consent').set(auth(employeeToken));
    });

    it('accepts a three-photo enrolment built from real photographs', async () => {
      const photos = [realPhoto(), realPhoto(), realPhoto()];
      const payloadKb = Math.round(JSON.stringify({ photos }).length / 1024);
      // Guards the guard: if the fixture ever shrinks back to a token image, this
      // test would still pass while testing nothing.
      expect(payloadKb).toBeGreaterThan(100);

      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/face-enrol')
        .set(auth(employeeToken))
        .send({
          photos,
          consentMethod: 'digital',
          consentAcknowledged: true,
        });

      expect(res.status).not.toBe(413);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('enrolled');
    });

    it('accepts a punch carrying a real photograph', async () => {
      // Its own employee: what this guards is the punch payload size, and the
      // shared employee's one punch-in for the day belongs to the US2 describe.
      const worker = await enrolledWorker('bigphoto');
      const res = await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ photo: realPhoto() }));

      expect(res.status).not.toBe(413);
      expect(res.status).toBe(201);

      await http()
        .post('/my/punch')
        .set(auth(worker.token))
        .send(punchBody({ type: 'out', photo: realPhoto() }))
        .expect(201);
    });
  });

  describe('Audit trail covers every new entity type (T087a, SC-009)', () => {
    it('writes a correctly attributed entry for each of the five types', async () => {
      // Every action in the suites above has already happened; this asserts that
      // each produced a real, attributable row rather than a silent no-op.
      for (const entityType of [
        'PUNCH',
        'LEAVE_APPLICATION',
        'FACE_ENROLMENT',
        'RE_ENROLMENT_REQUEST',
        'REIMBURSEMENT_CLAIM',
      ]) {
        const entry = await sys.auditLogEntry.findFirst({
          where: { entityType, accountId: employeeUserId },
          orderBy: { createdAt: 'desc' },
        });

        expect(entry).not.toBeNull();
        expect(entry.entityType).toBe(entityType);
        expect(entry.entityId).not.toBeNull();
        expect(entry.action).not.toBeNull();
        expect(entry.companyId).toBe(companyId);
        expect(entry.ipAddress).toBeTruthy();
        expect(entry.createdAt).toBeInstanceOf(Date);
      }
    });

    it('attributes an admin decision to the admin, not the employee', async () => {
      const entry = await sys.auditLogEntry.findFirst({
        where: { entityType: 'LEAVE_APPLICATION', accountId: adminUserId },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry).not.toBeNull();
      expect(entry.action).toBe('UPDATE');
    });
  });
});
