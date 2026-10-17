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
 * Feature 036 stream 1e — platform hardening, observed through the HTTP API.
 *
 * - B3: a Super Admin whose home company is A and who has selected B sees B's activity log and
 *   B's sites, not A's.
 * - B17: responses name their company; a save from a tab on another company is refused 409.
 * - B8: a non-upload route refuses a body over the default limit with the API's JSON error; an
 *   upload route accepts a ~9 MB file.
 * - B9: helmet's headers are on every response.
 * - B10: a validation refusal has one string `message`, an `errors` array and a `code`.
 *
 * The approval-spine half of "selected company" (B2) needs row-level security actually in
 * force, which this superuser connection does not have — see `selected-company-rls.e2e-spec.ts`.
 *
 * Every fixture is prefixed `E2EPH` and removed in `afterAll`.
 */
const PREFIX = 'E2EPH';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(120_000);

describe('Platform hardening (036 1e, e2e)', () => {
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
  let companyBName: string;
  let crossToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const newCompany = async (label: string) => {
    const name = `${PREFIX} Dummy ${label} Test Firm`;
    const company = await sys.company.create({
      data: {
        name,
        shortCode: unique(label).slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    return { id: company.id as string, name };
  };

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

    companyA = (await newCompany('Alpha')).id;
    const b = await newCompany('Beta');
    companyB = b.id;
    companyBName = b.name;

    crossToken = await makeUser('cross', companyA, [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.DASHBOARD,
      Permission.COMPANY_SETTINGS,
      Permission.PROJECTS,
    ]);

    // One audit row and one site in each company, told apart by name.
    for (const [companyId, label] of [
      [companyA, 'ALPHA'],
      [companyB, 'BETA'],
    ]) {
      await sys.auditLogEntry.create({
        data: {
          entityType: 'COMPANY',
          action: 'UPDATE',
          entityId: companyId,
          companyId,
          changes: { marker: `${PREFIX}-${label}` },
          ipAddress: '127.0.0.1',
        },
      });
      await sys.site.create({
        data: {
          companyId,
          name: `${PREFIX} Site ${label}`,
          latitude: 12.97,
          longitude: 77.59,
          geofenceRadiusMeters: 100,
          weeklyOffDay: 0,
        },
      });
    }

    await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyB })
      .expect(200);
  });

  afterAll(async () => {
    const companies = [companyA, companyB].filter(Boolean);
    await sys.userCompanySelection.deleteMany({
      where: { userId: { in: userIds } },
    });
    await sys.auditLogEntry.deleteMany({
      where: { companyId: { in: companies } },
    });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.permissionRefusal.deleteMany({
      where: { companyId: { in: companies } },
    });
    await sys.site.deleteMany({ where: { companyId: { in: companies } } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: { in: companies } } });
    if (app) await app.close();
  });

  describe('the selected company, not the home one (B3)', () => {
    it("shows the selected company's activity log", async () => {
      const res = await http()
        .get('/activity-log')
        .set(auth(crossToken))
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).toContain(companyB);
      expect(body).not.toContain(companyA);
    });

    it("lists the selected company's sites on the site dashboard", async () => {
      const res = await http()
        .get('/site-dashboard/sites')
        .set(auth(crossToken))
        .expect(200);
      const names = res.body.map((s: { name: string }) => s.name);
      expect(names).toContain(`${PREFIX} Site BETA`);
      expect(names).not.toContain(`${PREFIX} Site ALPHA`);
    });
  });

  describe('responses name their company (B17)', () => {
    it('sends X-Company-Id with the selected company', async () => {
      const res = await http()
        .get('/activity-log')
        .set(auth(crossToken))
        .expect(200);
      expect(res.headers['x-company-id']).toBe(companyB);
    });

    it('sends it on a refusal from a later guard too', async () => {
      // No PAYROLL: PermissionsGuard refuses, after authentication.
      const res = await http()
        .get('/hr/loans')
        .set(auth(crossToken))
        .expect(403);
      expect(res.headers['x-company-id']).toBe(companyB);
    });

    it('refuses a save from a tab that still thinks it is in company A', async () => {
      const res = await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .set('X-Expected-Company-Id', companyA)
        .send({})
        .expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'COMPANY_CHANGED',
        message: `Company was changed to ${companyBName} in another tab. Reload to continue.`,
        companyId: companyB,
        companyName: companyBName,
      });
    });

    it('lets the same request through with the right company, or with no header', async () => {
      // Reaches validation (400), so the company check passed.
      await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .set('X-Expected-Company-Id', companyB)
        .send({})
        .expect(400);
      await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .send({})
        .expect(400);
    });

    it('never blocks switching company itself', async () => {
      await http()
        .put('/my/company-selection')
        .set(auth(crossToken))
        .set('X-Expected-Company-Id', companyA)
        .send({ companyId: companyB })
        .expect(200);
    });
  });

  describe('body limits (B8) and error bodies (B10)', () => {
    it('refuses a 200 KB body on an ordinary route with the JSON error body', async () => {
      const res = await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .send({ name: 'x'.repeat(200 * 1024) })
        .expect(413);
      expect(res.body).toMatchObject({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
      expect(typeof res.body.message).toBe('string');
    });

    it('accepts a ~9 MB file on an upload route', async () => {
      const file = Buffer.alloc(9 * 1024 * 1024, 0x20);
      file.write('%PDF-1.4\n', 0, 'ascii');
      const res = await http()
        .post('/nocs')
        .set(auth(crossToken))
        .send({
          subjectType: 'work_order',
          subjectId: 'no-such-work-order',
          file: file.toString('base64'),
        });
      // Past the parser and validation: refused only because the work order does not exist.
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOC_SUBJECT_NOT_FOUND');
    });

    it('answers a validation refusal with one message string, its parts and a code', async () => {
      const res = await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .send({})
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(typeof res.body.message).toBe('string');
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body).not.toHaveProperty('error');
    });

    it('answers malformed JSON with 400 INVALID_JSON', async () => {
      const res = await http()
        .post('/projects/sites')
        .set(auth(crossToken))
        .set('Content-Type', 'application/json')
        .send('{"name": ')
        .expect(400);
      expect(res.body.code).toBe('INVALID_JSON');
    });
  });

  describe('security headers (B9)', () => {
    it('sends nosniff, HSTS and a frame-ancestors policy', async () => {
      const res = await http().get('/');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'self'",
      );
    });
  });
});
