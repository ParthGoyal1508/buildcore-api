import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * 058 US3: a role that works in all companies, without Super Admin's powers.
 *
 * A user homed in company A holds such a role. They can choose company B and then see B's data
 * only, through the ordinary single-company scope; every group power stays refused; their own
 * My Workspace record (in A) is still theirs while B is selected; and only a Super Admin can set
 * the flag or hand the role out. Fixtures are prefixed `E2EMC` and removed in `afterAll`.
 */
const PREFIX = 'E2EMC';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('All-companies roles (058 US3, e2e)', () => {
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

  /** The modules the all-companies role grants — chosen so each refusal below is the group rule's. */
  const MODULES: Permission[] = [
    Permission.INVENTORY,
    Permission.MY_WORKSPACE,
    Permission.DASHBOARD,
    Permission.ATTENDANCE,
    Permission.COMPANY_SETTINGS,
  ];

  const company: Record<'A' | 'B', string> = { A: '', B: '' };
  const site: Record<'A' | 'B', string> = { A: '', B: '' };
  let allRoleId: string;
  let moverId: string;
  let targetId: string;
  const tokens: Record<string, string> = {};
  const madeUserIds: string[] = [];
  const madeRoleIds: string[] = [];

  const makeRole = async (label: string, permissions: Permission[]) => {
    const role = await sys.role.create({
      data: { name: unique(`${label}Role`), permissions },
    });
    madeRoleIds.push(role.id);
    return role.id as string;
  };

  const makeUser = async (label: string, roleIds: string[]) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`,
        username: unique(label),
        password: await hash('secret42'),
        firstname: label,
        lastname: 'Tester',
        companyId: company.A,
      },
    });
    for (const roleId of roleIds) {
      await sys.userRole.create({
        data: { userId: user.id, roleId, companyId: company.A },
      });
    }
    madeUserIds.push(user.id);
    return user.id as string;
  };

  const login = async (label: string, userId: string) => {
    const user = await sys.user.findUnique({ where: { id: userId } });
    const res = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    tokens[label] = res.body.accessToken as string;
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

    for (const key of ['A', 'B'] as const) {
      const c = await sys.company.create({
        data: {
          name: `Dummy Multi Company ${key} Test Firm`,
          shortCode: unique(`MC${key}`).slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      });
      company[key] = c.id;
      const s = await sys.site.create({
        data: {
          companyId: c.id,
          name: unique(`Site${key}`),
          latitude: 25.4,
          longitude: 75.7,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        },
      });
      site[key] = s.id;
    }

    allRoleId = await makeRole('AllCo', MODULES);
    await sys.role.update({
      where: { id: allRoleId },
      data: { allCompanies: true },
    });
    const superRole = await makeRole('Super', [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.USER_MANAGEMENT,
    ]);
    // A company administrator who could grant every module the role carries, so the refusals
    // below are the all-companies rule's and not the grant ceiling's.
    const adminRole = await makeRole('Admin', [
      Permission.USER_MANAGEMENT,
      ...MODULES,
    ]);

    moverId = await makeUser('mover', [allRoleId]);
    targetId = await makeUser('target', []);
    await login('mover', moverId);
    await login('superAdmin', await makeUser('superAdmin', [superRole]));
    await login('admin', await makeUser('admin', [adminRole]));

    // The mover's own employee record, in their home company A.
    const branch = await sys.companyBranch.create({
      data: { companyId: company.A, label: 'Head office', isHeadOffice: true },
    });
    const shift = await sys.shift.create({
      data: {
        companyId: company.A,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    await sys.employee.create({
      data: {
        userId: moverId,
        companyId: company.A,
        branchId: branch.id,
        siteId: site.A,
        shiftId: shift.id,
        employeeCode: unique('EMP'),
        firstName: 'Dummy',
        lastName: 'Mover',
      },
    });
  }, 120_000);

  afterAll(async () => {
    for (const id of [company.A, company.B].filter(Boolean)) {
      await sys.employee.deleteMany({ where: { companyId: id } });
      await sys.shift.deleteMany({ where: { companyId: id } });
      await sys.companyBranch.deleteMany({ where: { companyId: id } });
      await sys.site.deleteMany({ where: { companyId: id } });
    }
    for (const id of madeUserIds) {
      await sys.userCompanySelection.deleteMany({ where: { userId: id } });
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
    for (const id of [company.A, company.B].filter(Boolean)) {
      await sys.company.deleteMany({ where: { id } });
    }
    await app.close();
  });

  const as = (who: string) => ({
    get: (url: string) => http().get(url).set(auth(tokens[who])),
    put: (url: string, body: object) =>
      http().put(url).set(auth(tokens[who])).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set(auth(tokens[who])).send(body),
  });
  const sitesSeen = async () =>
    (await as('mover').get('/projects/sites').expect(200)).body.map(
      (s: { id: string }) => s.id,
    );

  describe('switching company', () => {
    it('works in the home company until they choose', async () => {
      expect(await sitesSeen()).toEqual([site.A]);
    });

    it('is offered both companies', async () => {
      const res = await as('mover')
        .get('/settings/companies/selectable')
        .expect(200);
      const ids = res.body.map((c: { id: string }) => c.id);
      expect(ids).toEqual(expect.arrayContaining([company.A, company.B]));
    });

    it('sees only company B once B is chosen — never both', async () => {
      await as('mover')
        .put('/my/company-selection', { companyId: company.B })
        .expect(200);
      expect(await sitesSeen()).toEqual([site.B]);
    });
  });

  describe('no Super Admin powers while in B', () => {
    it('refuses the group dashboard', async () => {
      const res = await as('mover').get('/group/statutory-calendar').expect(403);
      expect(res.body.code).toBe('GROUP_ACCESS_REQUIRED');
    });

    it('refuses App Settings (cash visibility)', async () => {
      await as('mover').get('/settings/cash-visibility').expect(403);
    });

    it('refuses all-company reminders', async () => {
      await as('mover').get('/dashboard/reminders?scope=all').expect(403);
    });

    it('refuses the refused-punch log', async () => {
      const res = await as('mover').get('/hr/attendance/refusals').expect(403);
      expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    });

    it('refuses company A’s settings while working in B', async () => {
      await as('mover')
        .patch(`/settings/companies/${company.A}`, {})
        .expect(403);
    });
  });

  describe('their own records stay theirs', () => {
    it('finds their own employee record in A while B is selected', async () => {
      // Without @OwnRecords() this is "No employee record is linked to this account" (403).
      await as('mover').get('/my/punch/open').expect(200);
    });
  });

  describe('only a Super Admin hands it out', () => {
    it('refuses a company administrator giving the role', async () => {
      const res = await as('admin')
        .patch(`/settings/users/${targetId}`, { roleId: allRoleId })
        .expect(403);
      expect(res.body.code).toBe('ALL_COMPANIES_SUPER_ADMIN_ONLY');
    });

    it('refuses a company administrator unsetting the flag', async () => {
      const res = await as('admin')
        .patch(`/settings/roles/${allRoleId}`, { allCompanies: false })
        .expect(403);
      expect(res.body.code).toBe('ALL_COMPANIES_SUPER_ADMIN_ONLY');
    });

    it('lets a Super Admin unset it, and the holder is back home on the next request', async () => {
      await as('superAdmin')
        .patch(`/settings/roles/${allRoleId}`, { allCompanies: false })
        .expect(200);
      const res = await as('mover')
        .get('/settings/companies/selectable')
        .expect(200);
      expect(res.body.map((c: { id: string }) => c.id)).toEqual([company.A]);
      expect(await sitesSeen()).toEqual([site.A]);
    });
  });
});
