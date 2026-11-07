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
 * The lists a module's own forms pick from (2026-11-07).
 *
 * A Plant and Machinery Incharge could not pick a category on the machine form: the category list
 * was Masters & setup only, for reading as well as changing. Reading such a list is now open to the
 * module that uses it, and changing it is not. Employee pickers outside HR read code and name from
 * `/hr/employees/options`, never the full record. Fixtures are prefixed `E2ERL`.
 */
const PREFIX = 'E2ERL';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Lists a module picks from (e2e)', () => {
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
  const tokens: Record<string, string> = {};
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
    tokens[label] = login.body.accessToken as string;
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

    companyId = (
      await sys.company.create({
        data: {
          name: 'Dummy Role Lookups Test Firm',
          shortCode: unique('RL').slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      })
    ).id;

    // As the client's sheet sets them, without Masters & setup or HR.
    await makeUser('plant', [
      Permission.MACHINERY,
      Permission.LOGBOOK,
      Permission.FUEL,
      Permission.MAINTENANCE,
      Permission.HIRE_BILLS,
      Permission.ASSETS,
      Permission.MY_WORKSPACE,
    ]);
    await makeUser('billing', [
      Permission.PROJECTS,
      Permission.HIRE_BILLS,
      Permission.RECRUITMENT,
      Permission.ASSETS,
      Permission.PARTNERS,
      Permission.MY_WORKSPACE,
    ]);
    await makeUser('purchase', [Permission.INVENTORY, Permission.MY_WORKSPACE]);
    await makeUser('employee', [Permission.MY_WORKSPACE]);
  }, 120_000);

  afterAll(async () => {
    for (const id of madeUserIds) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.permissionRefusal.deleteMany({ where: { userId: id } });
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

  const get = (who: string, url: string) =>
    http().get(url).set(auth(tokens[who]));

  describe('the Plant and Machinery Incharge', () => {
    it.each([
      '/plant/categories',
      '/plant/doc-types',
      '/plant/rates',
      '/plant/equipment',
      '/assets/categories',
      '/assets/condition-grades',
      '/assets/doc-types',
      '/hr/employees/options',
    ])('reads %s', async (url) => {
      await get('plant', url).expect(200);
    });

    it('still cannot read the full employee list', async () => {
      await get('plant', '/hr/employees').expect(403);
    });

    it('still cannot add a category', async () => {
      await http()
        .post('/plant/categories')
        .set(auth(tokens.plant))
        .send({ name: 'Dummy' })
        .expect(403);
    });
  });

  describe('the Billing Engineer', () => {
    it.each([
      '/plant/equipment',
      '/plant/hire-orders',
      '/plant/rates',
      '/settings/departments',
      '/settings/designations',
      '/partners/vendor-categories',
      '/assets/categories',
      '/hr/employees/options',
    ])('reads %s', async (url) => {
      await get('billing', url).expect(200);
    });

    it('still cannot add a department', async () => {
      await http()
        .post('/settings/departments')
        .set(auth(tokens.billing))
        .send({ name: 'Dummy' })
        .expect(403);
    });
  });

  describe('the Purchase Manager', () => {
    it.each(['/inventory/composite-items', '/partners/vendor-categories'])(
      'reads %s',
      async (url) => {
        await get('purchase', url).expect(200);
      },
    );
  });

  describe('an employee', () => {
    it('reads no employee names', async () => {
      await get('employee', '/hr/employees/options').expect(403);
    });
  });

  it('gives a picker code and name only', async () => {
    const branch = await sys.companyBranch.create({
      data: { companyId, label: 'Head office', isHeadOffice: true },
    });
    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 25.4,
        longitude: 75.7,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    const employee = await sys.employee.create({
      data: {
        companyId,
        branchId: branch.id,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode: unique('EMP'),
        firstName: 'Dummy',
        lastName: 'Operator',
        mobile: '9000000000',
      },
    });
    try {
      const res = await get(
        'plant',
        '/hr/employees/options?search=Operator',
      ).expect(200);
      expect(res.body.items).toEqual([
        {
          id: employee.id,
          employeeCode: employee.employeeCode,
          firstName: 'Dummy',
          lastName: 'Operator',
        },
      ]);
      // A list names whoever a row is about, leavers included.
      await sys.employee.update({
        where: { id: employee.id },
        data: { isActive: false },
      });
      const byId = await get(
        'billing',
        `/hr/employees/options?ids=${employee.id}`,
      ).expect(200);
      expect(byId.body.items.map((e: { id: string }) => e.id)).toEqual([
        employee.id,
      ]);
    } finally {
      await sys.employee.deleteMany({ where: { companyId } });
      await sys.shift.deleteMany({ where: { companyId } });
      await sys.site.deleteMany({ where: { companyId } });
      await sys.companyBranch.deleteMany({ where: { companyId } });
    }
  });
});
