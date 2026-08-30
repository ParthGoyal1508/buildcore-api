import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The one binding swapped out: everything else is the real application.
      .overrideProvider(BiometricsService)
      .useValue(biometrics)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
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
        holidays: [],
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
        await sys.employee.deleteMany({ where: { id: { in: ids } } });
      }
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

    it('rejects a second punch-in while one is open (T029, FR-008)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(400);
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

    it('rejects a punch-out with no open punch-in (T029, FR-008)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
        .expect(400);
    });

    it('records an out-of-geofence punch as an exception, still 201 (T030)', async () => {
      // ~5.5 km from the site centre, well outside the 200 m radius.
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ latitude: SITE_LAT + 0.05 }))
        .expect(201);

      expect(res.body.geofenceResult).toBe('exception');
      const record = await sys.punchRecord.findUnique({
        where: { id: res.body.id },
      });
      expect(record.exceptionResolution).toBe('pending');
    });

    it('records a non-matching face as an exception, still 201 (T030, FR-007)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
        .expect(201);

      // A different person's descriptor: distance far above the 0.6 threshold.
      biometrics.nextValue = 5;
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(201);

      expect(res.body.faceMatchResult).toBe('exception');
      biometrics.nextValue = 0.5;
    });

    it('flags an offline-queued punch (research.md §4)', async () => {
      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
        .expect(201);

      const queued = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ capturedAt: queued }))
        .expect(201);
      expect(res.body.isOfflineSync).toBe(true);

      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody({ type: 'out' }))
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
      biometrics.nextValue = 0.5;
      const res = await http()
        .post('/my/punch')
        .set(auth(employeeToken))
        .send(punchBody())
        .expect(201);
      expect(JSON.stringify(res.body)).not.toContain(otherEmployeeId);

      await http()
        .post('/my/punch')
        .set(auth(employeeToken))
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
});
