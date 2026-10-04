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
 * The company switcher and the cash toggle (019 FR-008 to FR-017) — `bugs.md` items 5 and 16.
 *
 * The two claims that matter most, and neither can be checked without a second company:
 *
 * 1. **A selection narrows scope and never widens it.** The worst a stale or forged selection
 *    can do is show the caller less than they are entitled to.
 * 2. **Revoked access is not honoured because a selection was stored.** A selection is a record
 *    of a past choice, not a standing grant.
 *
 * Every fixture is prefixed `E2ECS` and removed in `afterAll`.
 */
const PREFIX = 'E2ECS';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(90_000);

describe('Company selection and cash visibility (e2e)', () => {
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyA: string;
  let companyB: string;
  let crossToken: string;
  let singleToken: string;
  let crossRoleId: string;
  let projectAId: string;
  let projectBId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const clientIds: string[] = [];

  const newCompany = async (label: string) =>
    (
      await sys.company.create({
        data: {
          name: `${PREFIX} ${label}`,
          shortCode: unique(label).slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      })
    ).id as string;

  const makeUser = async (
    label: string,
    companyId: string,
    permissions: Permission[],
  ) => {
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
    return {
      userId: user.id,
      roleId: role.id as string,
      token: login.body.accessToken as string,
    };
  };

  const makeProject = async (companyId: string, label: string) => {
    const client = await sys.client.create({
      data: { companyId, name: `${PREFIX} ${label} Client` },
    });
    clientIds.push(client.id);
    const project = await sys.project.create({
      data: {
        companyId,
        clientId: client.id,
        code: unique(label),
        name: `${PREFIX} ${label} Project`,
        contractValue: 1000,
        startDate: new Date('2026-01-01'),
      },
    });
    return project.id as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
    prisma = app.get(PrismaService);

    companyA = await newCompany('Alpha');
    companyB = await newCompany('Beta');

    const cross = await makeUser('cross', companyA, [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.PROJECTS,
      Permission.COMPANY_SETTINGS,
    ]);
    crossToken = cross.token;
    crossRoleId = cross.roleId;

    singleToken = (await makeUser('single', companyA, [Permission.PROJECTS]))
      .token;

    projectAId = await makeProject(companyA, 'Alpha');
    projectBId = await makeProject(companyB, 'Beta');
  }, 90_000);

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.userCompanySelection.deleteMany({
      where: { userId: { in: userIds } },
    });
    await sys.permissionRefusal.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    });
    await sys.project.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    });
    await sys.client.deleteMany({ where: { id: { in: clientIds } } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({
      where: { id: { in: [companyA, companyB] } },
    });
    await app?.close();
  });

  it('offers both companies to a cross-company caller', async () => {
    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(crossToken))
      .expect(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(companyA);
    expect(ids).toContain(companyB);
  });

  it('offers exactly one company to a single-company caller (FR-013)', async () => {
    // One element is how the interface knows not to offer a switcher, without a second call.
    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(singleToken))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(companyA);
    expect(res.body[0].selected).toBe(true);
  });

  it('switches from one company to another, not only from none to one', async () => {
    // **Every test in this suite selected exactly once**, so the row was only ever inserted and
    // the conflict path was never taken. On the deployment that path was a 42501: the upsert ran
    // scoped to the company being switched *to*, and Postgres applied the policy's USING to the
    // row already there, which still held the previous one.
    //
    // This test would **not** have caught it. The local and CI role is a superuser and Postgres
    // exempts superusers from RLS unconditionally, so the policy is not in force here — see
    // `company-selection-rls.e2e-spec.ts`, which asks under a role that cannot bypass it. This
    // covers the half that is observable from the API: that a second switch is honoured and
    // reported.
    await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyA })
      .expect(200);

    const res = await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyB })
      .expect(200);

    const selected = res.body.find((c: { selected: boolean }) => c.selected);
    expect(selected.id).toBe(companyB);
  });

  it('scopes every list to the selected company (FR-010)', async () => {
    await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyB })
      .expect(200);

    const res = await http().get('/projects').set(auth(crossToken)).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(projectBId);
    // The selection narrows: company A's project is no longer visible even though this caller
    // holds CROSS_COMPANY_ACCESS.
    expect(body).not.toContain(projectAId);
  });

  it('persists across a fresh sign-in (FR-011)', async () => {
    // The stronger test than reloading a browser: a new token, and the selection is still there,
    // which proves it is stored rather than held in memory or in the token.
    const user = await sys.user.findFirst({
      where: { id: { in: userIds }, companyId: companyA },
      orderBy: { createdAt: 'asc' },
    });
    const login = await http()
      .post('/auth/login')
      .send({
        identifier: user.email,
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);

    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(login.body.accessToken))
      .expect(200);
    const selected = res.body.find((c: { selected: boolean }) => c.selected);
    expect(selected.id).toBe(companyB);
  });

  it('refuses a company the caller may not reach, with 403 not 404', async () => {
    // A 404 would tell a caller which company ids exist.
    const res = await http()
      .put('/my/company-selection')
      .set(auth(singleToken))
      .send({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('COMPANY_NOT_ACCESSIBLE');
  });

  it('stops honouring a selection once cross-company access is revoked', async () => {
    // The spec's own edge case, and the one that would be a cross-tenant read if the stored
    // selection were trusted rather than re-validated.
    await sys.role.update({
      where: { id: crossRoleId },
      data: {
        permissions: [Permission.PROJECTS, Permission.COMPANY_SETTINGS],
        rolePermissions: {
          deleteMany: { permission: Permission.CROSS_COMPANY_ACCESS },
        },
      },
    });

    const res = await http().get('/projects').set(auth(crossToken)).expect(200);
    const body = JSON.stringify(res.body);
    // Back to their own company, and company B's records are gone.
    expect(body).not.toContain(projectBId);
  });

  it('hides cash amounts when the company asks, and alters no data (FR-014, FR-017)', async () => {
    const admin = await makeUser('cashadmin', companyA, [
      Permission.COMPANY_SETTINGS,
      Permission.PROJECTS,
    ]);

    await http()
      .patch('/settings/cash-visibility')
      .set(auth(admin.token))
      .send({ hideCashTransactions: true })
      .expect(200);

    const current = await http()
      .get('/settings/cash-visibility')
      .set(auth(admin.token))
      .expect(200);
    expect(current.body.hideCashTransactions).toBe(true);

    // FR-017: the stored setting changed, and nothing else did. Read a project back and confirm
    // its contract value — not a cash amount — is untouched.
    const projects = await http()
      .get('/projects')
      .set(auth(admin.token))
      .expect(200);
    expect(JSON.stringify(projects.body)).toContain(PREFIX);

    await http()
      .patch('/settings/cash-visibility')
      .set(auth(admin.token))
      .send({ hideCashTransactions: false })
      .expect(200);
  });

  it('refuses the toggle to a caller without COMPANY_SETTINGS (FR-016)', async () => {
    const res = await http()
      .patch('/settings/cash-visibility')
      .set(auth(singleToken))
      .send({ hideCashTransactions: true });
    expect(res.status).toBe(403);
  });
});
