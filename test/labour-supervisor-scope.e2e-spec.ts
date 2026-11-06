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
 * 058 US4: a site supervisor holding only "Labour registration & attendance" registers labour and
 * marks attendance at their sites — and nothing else in Labour. The Operations Manager (labour
 * management + approvals) does the rest. Fixtures are prefixed `E2ELS` and removed in `afterAll`.
 */
const PREFIX = 'E2ELS';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

const JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('Site supervisor labour scope (058 US4, e2e)', () => {
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
  let supervisorId: string;
  let workerId: string;
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

    companyId = (
      await sys.company.create({
        data: {
          name: 'Dummy Labour Scope Test Firm',
          shortCode: unique('LS').slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      })
    ).id;
    siteId = (
      await sys.site.create({
        data: {
          companyId,
          name: unique('Site'),
          latitude: 25.4,
          longitude: 75.7,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        },
      })
    ).id;

    supervisorId = await makeUser('supervisor', [
      Permission.LABOUR_ATTENDANCE,
      Permission.MY_WORKSPACE,
    ]);
    await sys.supervisorSite.create({
      data: { companyId, userId: supervisorId, siteId },
    });
    await makeUser('operations', [
      Permission.DAILY_WORKER_REGISTRY,
      Permission.LABOUR_APPROVE,
    ]);
  }, 120_000);

  afterAll(async () => {
    if (companyId) {
      await sys.labourSitePhoto.deleteMany({ where: { companyId } });
      await sys.labourCodeSequence.deleteMany({ where: { companyId } });
      await sys.labourWorker.deleteMany({ where: { companyId } });
      await sys.supervisorSite.deleteMany({ where: { companyId } });
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

  const as = (who: string) => ({
    get: (url: string) => http().get(url).set(auth(tokens[who])),
    post: (url: string, body: object) =>
      http().post(url).set(auth(tokens[who])).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set(auth(tokens[who])).send(body),
  });

  describe('what the supervisor does', () => {
    it('sees their own site', async () => {
      const res = await as('supervisor').get('/labour/my-sites').expect(200);
      expect(res.body.map((s: { id: string }) => s.id)).toEqual([siteId]);
    });

    it('registers a labour at their site', async () => {
      const res = await as('supervisor')
        .post('/labour/workers', {
          fullName: 'Dummy Labour',
          gender: 'male',
          siteId,
        })
        .expect(201);
      workerId = res.body.id;
    });

    it('lists the labour', async () => {
      const res = await as('supervisor')
        .get(`/labour/workers?siteId=${siteId}`)
        .expect(200);
      expect(JSON.stringify(res.body)).toContain(workerId);
    });

    it("sees today's attendance list", async () => {
      await as('supervisor')
        .get(`/labour/attendance/today?siteId=${siteId}`)
        .expect(200);
    });

    it('uploads the group photo', async () => {
      await as('supervisor')
        .post('/labour/muster-attendance/site-photos', { siteId, photo: JPEG })
        .expect(201);
    });
  });

  describe('what is the Operations Manager’s', () => {
    it.each([
      ['payment sheets', '/labour/payment-sheets'],
      ['advances', '/labour/advances'],
      ['musters', '/labour/musters'],
      ['muster attendance', `/labour/muster-attendance/daily?siteId=SITE`],
      ['group photos', `/labour/muster-attendance/site-photos?siteId=SITE`],
      ['site rates', '/labour/site-rates'],
      ['wage rates', '/labour/wage-rates'],
      ['supervisor allocation', '/labour/supervisor-sites'],
      ['gangs', '/labour/gangs'],
    ])('refuses the supervisor %s', async (_what, url) => {
      await as('supervisor').get(url.replace('SITE', siteId)).expect(403);
    });

    it('refuses the supervisor editing a labour', async () => {
      await as('supervisor')
        .patch(`/labour/workers/${workerId}`, { fatherName: 'Dummy' })
        .expect(403);
    });

    it('refuses the supervisor transferring a labour', async () => {
      await as('supervisor')
        .post(`/labour/workers/${workerId}/transfer`, { toSiteId: siteId })
        .expect(403);
    });

    it('refuses the supervisor deactivating a labour', async () => {
      await as('supervisor')
        .patch(`/labour/workers/${workerId}/deactivate`, { reason: 'left' })
        .expect(403);
    });

    it('lists the supervisor for site allocation', async () => {
      const res = await as('operations')
        .get('/labour/supervisor-sites')
        .expect(200);
      const ids = res.body.supervisors.map((s: { userId: string }) => s.userId);
      expect(ids).toContain(supervisorId);
    });
  });
});
