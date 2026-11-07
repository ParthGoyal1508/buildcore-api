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
 * The Cashier (client, 2026-11-07): `PAYMENTS` opens each module's payment screen, read-only except
 * recording a payment or a client receipt. Every payment route lets them past the permission check
 * (a fake id is then refused for the record, never with 403); the rest of each module stays shut.
 * Fixtures are prefixed `E2ECP`.
 */
const PREFIX = 'E2ECP';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('The Cashier records payments on each module (e2e)', () => {
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
          name: 'Dummy Cashier Test Firm',
          shortCode: unique('RL').slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      })
    ).id;

    await makeUser('cashier', [
      Permission.PAYMENTS,
      Permission.CASH_ENTRY,
      Permission.MY_WORKSPACE,
    ]);
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

  const call = (method: 'get' | 'post' | 'patch', url: string) =>
    http()[method](url).set(auth(tokens.cashier)).send({});
  const FAKE = 'c000000000000000000000000';

  it.each([
    '/inventory/payments',
    '/inventory/bills',
    '/labour/payment-sheets',
    '/labour/advances',
    '/plant/maintenance',
    '/plant/service-bills',
    '/plant/hire-bills',
    '/hr/reimbursements',
    '/partners/bocw',
    '/projects',
    '/projects/ra-bills',
    '/projects/client-bills',
    '/projects/work-orders',
  ])('reads %s', async (url) => {
    await call('get', url).expect(200);
  });

  it.each([
    ['post', '/inventory/payments'],
    ['patch', `/labour/payment-sheets/lines/${FAKE}/disburse`],
    ['patch', `/labour/advances/${FAKE}/disburse`],
    ['post', `/plant/maintenance/${FAKE}/job-card/payments`],
    ['patch', `/plant/service-bills/${FAKE}/pay`],
    ['patch', `/plant/hire-bills/${FAKE}/pay`],
    ['patch', `/hr/reimbursements/${FAKE}/pay`],
    ['post', `/partners/bocw/${FAKE}/payments`],
    ['post', `/projects/ra-bills/${FAKE}/payments`],
    ['post', `/projects/client-bills/${FAKE}/receipts`],
  ] as const)(
    'may %s %s (refused for the record, not the permission)',
    async (method, url) => {
      const res = await call(method, url);
      expect(res.status).not.toBe(403);
      expect([400, 404, 409, 422]).toContain(res.status);
    },
  );

  it.each([
    ['post', '/labour/payment-sheets'],
    ['post', '/plant/hire-bills'],
    ['patch', `/plant/hire-bills/${FAKE}/verify`],
    ['patch', `/hr/reimbursements/${FAKE}/approve`],
    ['patch', `/labour/advances/${FAKE}/approve`],
    ['post', '/inventory/purchases'],
    ['get', '/inventory/stock'],
    ['get', '/hr/employees'],
    ['get', '/hr/payroll/runs'],
    ['get', '/plant/equipment/next-code'],
  ] as const)('may not %s %s', async (method, url) => {
    await call(method, url).expect(403);
  });
});
