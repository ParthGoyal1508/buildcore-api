import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission, PunchRefusalReason, PunchType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * 058 US1: the staff and labour refused-punch logs, and their photos, are for Super Admin only.
 *
 * The audience before 058 was "write on attendance" (staff) and "daily worker registry or labour
 * approve" (labour). Both now also need `CROSS_COMPANY_ACCESS`. What does not change is the
 * employee's own view of their own refused attempts (FR-004). Fixtures are prefixed `E2ERV` and
 * removed in `afterAll`.
 */
const PREFIX = 'E2ERV';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Refusal visibility (058 US1, e2e)', () => {
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
  let siteId: string;
  let shiftId: string;
  let employeeId: string;
  let refusalId: string;
  const madeUserIds: string[] = [];
  const madeRoleIds: string[] = [];
  const tokens: Record<string, string> = {};

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
    tokens[label] = login.body.accessToken as string;
    return user.id as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'Dummy Refusal Visibility Test Firm',
        shortCode: unique('RV').slice(0, 10),
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
        latitude: 20,
        longitude: 78,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    siteId = site.id;
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    shiftId = shift.id;

    await makeUser('superAdmin', [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.ATTENDANCE,
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
    ]);
    // Write on attendance: the old audience of the staff refusal log.
    await makeUser('hr', [Permission.ATTENDANCE]);
    // The old audience of the labour refusal list.
    await makeUser('labourApprover', [
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
    ]);
    const workerUserId = await makeUser('worker', [Permission.MY_WORKSPACE]);

    const branch = await sys.companyBranch.create({
      data: { companyId, label: 'Head office', isHeadOffice: true },
    });
    const employee = await sys.employee.create({
      data: {
        userId: workerUserId,
        companyId,
        branchId: branch.id,
        siteId,
        shiftId,
        employeeCode: unique('EMP'),
        firstName: 'Dummy',
        lastName: 'Worker',
      },
    });
    employeeId = employee.id;
    const refusal = await sys.punchRefusal.create({
      data: {
        companyId,
        employeeId,
        type: PunchType.in,
        reason: PunchRefusalReason.outside_geofence,
        latitude: 20.05,
        longitude: 78,
        distanceMeters: 5500,
        capturedAt: new Date(),
      },
    });
    refusalId = refusal.id;
  }, 90_000);

  afterAll(async () => {
    if (companyId) {
      await sys.punchRefusal.deleteMany({ where: { companyId } });
      await sys.employee.deleteMany({ where: { companyId } });
      await sys.shift.deleteMany({ where: { companyId } });
      await sys.companyBranch.deleteMany({ where: { companyId } });
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
    await app?.close();
  });

  const staffLog = () => `/hr/attendance/refusals`;
  const staffPhoto = () => `/hr/attendance/refusals/${refusalId}/photo`;
  const labourLog = () => `/labour/attendance/refusals?siteId=${siteId}`;
  const labourPhoto = () => `/labour/attendance/refusals/no-such-id/photo`;

  it('shows a Super Admin the staff refusal log', async () => {
    const res = await http()
      .get(staffLog())
      .set(auth(tokens.superAdmin))
      .expect(200);
    expect(JSON.stringify(res.body)).toContain(refusalId);
  });

  it('shows a Super Admin the labour refusal list', async () => {
    await http().get(labourLog()).set(auth(tokens.superAdmin)).expect(200);
  });

  it.each([
    ['hr', 'staff log', staffLog],
    ['hr', 'staff photo', staffPhoto],
    ['labourApprover', 'labour list', labourLog],
    ['labourApprover', 'labour photo', labourPhoto],
  ])(
    'refuses %s the %s, with the Super Admin wording',
    async (who, _what, url) => {
      const res = await http().get(url()).set(auth(tokens[who])).expect(403);
      expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    },
  );

  it('still lets the employee see their own refused attempt (FR-004)', async () => {
    const res = await http()
      .get('/my/punch/refusals')
      .set(auth(tokens.worker))
      .expect(200);
    expect(JSON.stringify(res.body)).toContain('outside_geofence');
  });
});
