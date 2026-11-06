import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import {
  FaceMatchResult,
  GeofenceResult,
  Permission,
  PunchSource,
  PunchType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * 058 US2 through the HTTP API: an assignment covering a project's sites, and the register showing
 * where each punch was made.
 *
 * Punches are written directly, as `attendance-exceptions.e2e-spec` does: driving `/my/punch` end
 * to end needs a liveness capture, and which site a punch is matched to is covered against the real
 * service in `punch.service.spec` and `site-match.spec`. What this suite owns is everything around
 * it — the assignment's shape and validation, the register's site columns and site filter, and the
 * site check on HR's manual entries. Fixtures are prefixed `E2ESA` and removed in `afterAll`.
 */
const PREFIX = 'E2ESA';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

const DAY = '2026-10-15';

describe('Site-tagged staff attendance (058 US2, e2e)', () => {
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
  let projectId: string;
  let emptyProjectId: string;
  let siteA: string;
  let siteB: string;
  let siteElsewhere: string;
  let otherCompanySite: string;
  let employeeId: string;
  let bystanderId: string;
  let hrToken: string;
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
    return login.body.accessToken as string;
  };

  const makeCompany = (name: string) =>
    sys.company.create({
      data: {
        name,
        shortCode: unique(name.slice(6, 9)).slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });

  const makeSite = (company: string, name: string, project?: string) =>
    sys.site
      .create({
        data: {
          companyId: company,
          name: unique(name),
          latitude: 25.4,
          longitude: 75.7,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
          ...(project ? { projectId: project } : {}),
        },
      })
      .then((s: { id: string }) => s.id);

  const punchAt = (
    employee: string,
    type: PunchType,
    site: string,
    hour: number,
  ) =>
    sys.punchRecord.create({
      data: {
        employeeId: employee,
        type,
        capturedAt: new Date(`${DAY}T0${hour}:00:00.000Z`),
        punchDate: new Date(`${DAY}T00:00:00.000Z`),
        source: PunchSource.employee,
        geofenceResult: GeofenceResult.in_range,
        // An employee's own punch carries its capture (check constraint); the values are inert.
        photoRef: 'e2e/none',
        faceMatchResult: FaceMatchResult.matched,
        latitude: 25.4,
        longitude: 75.7,
        siteId: site,
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

    companyId = (await makeCompany('Dummy Site Attendance Test Firm')).id;
    otherCompanyId = (await makeCompany('Dummy Other Site Test Firm')).id;
    const branch = await sys.companyBranch.create({
      data: { companyId, label: 'Head office', isHeadOffice: true },
    });
    const client = await sys.client.create({
      data: { companyId, name: unique('Dummy Client') },
    });
    const makeProject = (name: string) =>
      sys.project
        .create({
          data: {
            companyId,
            clientId: client.id,
            branchId: branch.id,
            name: unique(name),
            code: unique('P').slice(0, 12),
            startDate: new Date('2026-01-01'),
            contractValue: 100000,
            status: 'ongoing',
          },
        })
        .then((p: { id: string }) => p.id);
    projectId = await makeProject('Dummy Ring Road');
    emptyProjectId = await makeProject('Dummy Tender');
    siteA = await makeSite(companyId, 'SiteA', projectId);
    siteB = await makeSite(companyId, 'SiteB', projectId);
    siteElsewhere = await makeSite(companyId, 'Elsewhere');
    otherCompanySite = await makeSite(otherCompanyId, 'OtherCo');

    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    const makeEmployee = (code: string) =>
      sys.employee
        .create({
          data: {
            companyId,
            branchId: branch.id,
            siteId: siteElsewhere,
            shiftId: shift.id,
            employeeCode: unique(code),
            firstName: 'Dummy',
            lastName: code,
            dateOfJoining: new Date('2026-01-01'),
          },
        })
        .then((e: { id: string }) => e.id);
    employeeId = await makeEmployee('Mover');
    bystanderId = await makeEmployee('Bystander');

    hrToken = await makeUser('hr', [
      Permission.EMPLOYEES,
      Permission.ATTENDANCE,
    ]);
  }, 120_000);

  afterAll(async () => {
    if (companyId) {
      await sys.attendanceModification.deleteMany({
        where: { employeeId: { in: [employeeId, bystanderId] } },
      });
      await sys.punchRecord.deleteMany({
        where: { employeeId: { in: [employeeId, bystanderId] } },
      });
      await sys.employeeLocationAssignment.deleteMany({
        where: { companyId },
      });
      await sys.employee.deleteMany({ where: { companyId } });
      await sys.shift.deleteMany({ where: { companyId } });
      await sys.companyBranch.deleteMany({ where: { companyId } });
      await sys.site.deleteMany({
        where: { companyId: { in: [companyId, otherCompanyId] } },
      });
      await sys.project.deleteMany({ where: { companyId } });
      await sys.client.deleteMany({ where: { companyId } });
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

  const assign = (body: Record<string, unknown>) =>
    http()
      .put(`/hr/employees/${employeeId}/location-assignments`)
      .set(auth(hrToken))
      .send({ effectiveFrom: '2026-10-01', ...body });

  describe('assignment', () => {
    it('refuses an assignment naming nothing', async () => {
      const res = await assign({}).expect(400);
      expect(res.body.code).toBe('ASSIGNMENT_EMPTY');
    });

    it('refuses mobile together with sites', async () => {
      const res = await assign({ isMobile: true, siteIds: [siteA] }).expect(
        400,
      );
      expect(res.body.code).toBe('ASSIGNMENT_MOBILE_WITH_TARGETS');
    });

    it("refuses another company's site", async () => {
      await assign({ siteIds: [otherCompanySite] }).expect(404);
    });

    it('warns about a project with no active site, and saves it', async () => {
      const res = await assign({ projectIds: [emptyProjectId] }).expect(200);
      expect(res.body.warnings).toEqual(['PROJECT_HAS_NO_ACTIVE_SITE']);
    });

    it('assigns a whole project, and names it in the history', async () => {
      const res = await assign({
        projectIds: [projectId],
        effectiveFrom: '2026-10-02',
        reason: 'Moves between the Ring Road camps',
      }).expect(200);
      expect(res.body.warnings).toEqual([]);
      expect(res.body.targets).toEqual([
        {
          siteId: null,
          projectId,
          name: expect.stringContaining('Dummy Ring Road'),
        },
      ]);

      const history = await http()
        .get(`/hr/employees/${employeeId}/location-assignments`)
        .set(auth(hrToken))
        .expect(200);
      expect(history.body[0].targets[0].projectId).toBe(projectId);
      expect(history.body).toHaveLength(2);

      const audit = await sys.auditLogEntry.findFirst({
        where: { entityType: 'EMPLOYEE', entityId: employeeId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.changes.locationAssignment.projectIds).toEqual([projectId]);
    });

    it('still reads the pre-058 single siteId as one site', async () => {
      const res = await http()
        .put(`/hr/employees/${bystanderId}/location-assignments`)
        .set(auth(hrToken))
        .send({ siteId: siteElsewhere, effectiveFrom: '2026-10-01' })
        .expect(200);
      expect(res.body.targets).toEqual([
        expect.objectContaining({ siteId: siteElsewhere, projectId: null }),
      ]);
    });
  });

  describe('register', () => {
    beforeAll(async () => {
      await punchAt(employeeId, PunchType.in, siteA, 3);
      await punchAt(employeeId, PunchType.out, siteB, 9);
      await punchAt(bystanderId, PunchType.in, siteElsewhere, 4);
    });

    it('shows where each punch was made', async () => {
      const res = await http()
        .get(`/hr/attendance?date=${DAY}`)
        .set(auth(hrToken))
        .expect(200);
      const mover = res.body.find(
        (r: { employeeId: string }) => r.employeeId === employeeId,
      );
      expect(mover.punchInSite).toMatchObject({ id: siteA });
      expect(mover.punchOutSite).toMatchObject({ id: siteB });
    });

    it('answers "who punched at site B" with one filter', async () => {
      const res = await http()
        .get(`/hr/attendance?date=${DAY}&punchSiteId=${siteB}`)
        .set(auth(hrToken))
        .expect(200);
      expect(res.body.map((r: { employeeId: string }) => r.employeeId)).toEqual(
        [employeeId],
      );
    });

    it("keeps the home-site filter's meaning: everyone posted there", async () => {
      const res = await http()
        .get(`/hr/attendance?date=${DAY}&siteId=${siteElsewhere}`)
        .set(auth(hrToken))
        .expect(200);
      expect(
        res.body.map((r: { employeeId: string }) => r.employeeId).sort(),
      ).toEqual([employeeId, bystanderId].sort());
    });

    it("shows the site on the employee's month", async () => {
      const res = await http()
        .get(`/hr/attendance/employee/${employeeId}?month=10&year=2026`)
        .set(auth(hrToken))
        .expect(200);
      const day = res.body.days.find((d: { date: string }) => d.date === DAY);
      expect(day.punchInSite).toMatchObject({ id: siteA });
      expect(day.punchOutSite).toMatchObject({ id: siteB });
    });
  });

  describe("HR's manual entries (FR-012)", () => {
    it('refuses a site the employee is not assigned to that day', async () => {
      const res = await http()
        .post('/hr/attendance')
        .set(auth(hrToken))
        .send({
          employeeId,
          date: '2026-10-16',
          inTime: '09:00',
          siteId: siteElsewhere,
        })
        .expect(400);
      expect(res.body.code).toBe('SITE_NOT_ASSIGNED');
    });

    it('does not refuse one of the project’s sites', async () => {
      const res = await http().post('/hr/attendance').set(auth(hrToken)).send({
        employeeId,
        date: '2026-10-16',
        inTime: '09:00',
        siteId: siteB,
      });
      // Later gates (documents, the approval chain) decide what happens next; the site passed.
      expect(res.body.code).not.toBe('SITE_NOT_ASSIGNED');
    });
  });
});
