import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessLevel, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Feature 036 stream 3b — HR and payroll controllers resolve the **selected** company.
 *
 * Ten HR/payroll controllers chose their company as `user.companyId ?? requested`. For a Super
 * Admin that is their *home* company whatever they ask for, and the switcher's selection (which
 * arrives on the RLS context, not on `user`) is never consulted. They now use `resolveCompanyId`.
 *
 * Observed through the holiday calendar (one of the ten, and the simplest to fixture):
 * - a Super Admin homed in A who has **selected** B reads B's holidays, not A's, and a holiday
 *   they declare without naming a company lands in B;
 * - a Super Admin homed in A with **nothing selected** who asks for `?companyId=B` gets B.
 *
 * Every fixture is prefixed `E2EHSC` and removed in `afterAll`.
 */
const PREFIX = 'E2EHSC';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(120_000);

describe('HR selected company (036 3b, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyA: string;
  let companyB: string;
  let selectedToken: string;
  let unselectedToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const newCompany = async (label: string) => {
    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Dummy ${label} Test Firm`,
        shortCode: unique(label).slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    return company.id as string;
  };

  const makeUser = async (label: string, companyId: string) => {
    const permissions = [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.ATTENDANCE,
    ];
    const role = await sys.role.create({
      data: {
        name: unique(`${label}Role`),
        permissions,
        rolePermissions: {
          create: permissions.flatMap((permission) => [
            { permission, level: AccessLevel.read },
            { permission, level: AccessLevel.write },
          ]),
        },
      },
    });
    roleIds.push(role.id);
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`.toLowerCase(),
        username: unique(label),
        password: await hash('secret42'),
        displayName: `${PREFIX} ${label}`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(user.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return login.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    companyA = await newCompany('Alpha');
    companyB = await newCompany('Beta');
    for (const [companyId, label] of [
      [companyA, 'ALPHA'],
      [companyB, 'BETA'],
    ]) {
      await sys.holiday.create({
        data: {
          companyId,
          name: `${PREFIX} Holiday ${label}`,
          date: new Date('2031-01-15'),
        },
      });
    }

    selectedToken = await makeUser('selected', companyA);
    unselectedToken = await makeUser('unselected', companyA);
    await http()
      .put('/my/company-selection')
      .set(auth(selectedToken))
      .send({ companyId: companyB })
      .expect(200);
  });

  afterAll(async () => {
    const companies = [companyA, companyB].filter(Boolean);
    await sys.userCompanySelection.deleteMany({
      where: { userId: { in: userIds } },
    });
    await sys.holiday.deleteMany({ where: { companyId: { in: companies } } });
    await sys.auditLogEntry.deleteMany({
      where: { companyId: { in: companies } },
    });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: { in: companies } } });
    if (app) await app.close();
  });

  const names = (body: { name: string }[]) =>
    body.map((h) => h.name).filter((n) => n.startsWith(PREFIX));

  it("reads the selected company's holidays, not the home company's", async () => {
    const res = await http()
      .get('/hr/holidays?from=2031-01-01&to=2031-01-31')
      .set(auth(selectedToken))
      .expect(200);
    expect(names(res.body)).toEqual([`${PREFIX} Holiday BETA`]);
  });

  it('declares a holiday in the selected company when none is named', async () => {
    await http()
      .post('/hr/holidays')
      .set(auth(selectedToken))
      .send({ name: `${PREFIX} Declared`, date: '2031-02-10' })
      .expect(201);
    const row = await sys.holiday.findFirst({
      where: { name: `${PREFIX} Declared` },
    });
    expect(row?.companyId).toBe(companyB);
  });

  it('honours ?companyId for a Super Admin with nothing selected', async () => {
    const res = await http()
      .get(`/hr/holidays?companyId=${companyB}&from=2031-01-01&to=2031-01-31`)
      .set(auth(unselectedToken))
      .expect(200);
    expect(names(res.body)).toEqual([`${PREFIX} Holiday BETA`]);
  });
});
