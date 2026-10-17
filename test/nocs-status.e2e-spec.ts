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
 * NOC open/closed status (2026-10-17): a record is open until a NOC is uploaded and closed from
 * then on; a work order closes on its NOC after the work order, not the LOI's; removing the
 * closing NOC reopens it. Fixtures are prefixed `E2ENOC` and removed in `afterAll`.
 */
const PREFIX = 'E2ENOC';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const PDF = Buffer.from('%PDF-1.4\n%dummy\n').toString('base64');

describe('NOC open/closed status (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let companyId: string;
  let token: string;
  let labourOnlyToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = (fn: (tx: any) => Promise<any>) =>
    withRlsContext(prisma, { isSuperAdmin: true }, fn);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const makeUser = async (label: string, permissions: Permission[]) => {
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique(label)}@example.test`,
          username: unique(label),
          password: hashed,
          firstname: label,
          lastname: 'Tester',
          companyId,
        },
      }),
    );
    const role = await sys((tx) =>
      tx.role.create({ data: { name: unique(`${label}Role`), permissions } }),
    );
    await sys((tx) =>
      tx.userRole.create({ data: { userId: user.id, roleId: role.id } }),
    );
    userIds.push(user.id);
    roleIds.push(role.id);
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return login.body.accessToken as string;
  };
  let hashed: string;

  const upload = (subjectType: string, subjectId: string, stage?: string) =>
    http()
      .post('/nocs')
      .set(auth(token))
      .send({
        subjectType,
        subjectId,
        ...(stage ? { stage } : {}),
        file: PDF,
        fileName: 'noc.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

  const status = async (subjectType: string, ids: string[], t = token) =>
    (
      await http()
        .get(
          `/nocs/status?subjectType=${subjectType}&subjectIds=${ids.join(',')}`,
        )
        .set(auth(t))
        .expect(200)
    ).body as { subjectId: string; status: string; closedAt: string | null }[];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());
    hashed = await hash('secret42');

    const company = await sys((tx) =>
      tx.company.create({
        data: {
          name: 'Dummy NOC Test Firm',
          shortCode: unique('NC').slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      }),
    );
    companyId = company.id;
    token = await makeUser('office', [
      Permission.PROJECTS,
      Permission.DAILY_WORKER_REGISTRY,
      Permission.MACHINERY,
    ]);
    labourOnlyToken = await makeUser('labour', [
      Permission.DAILY_WORKER_REGISTRY,
    ]);
  });

  afterAll(async () => {
    if (companyId) {
      await sys((tx) => tx.nocDocument.deleteMany({ where: { companyId } }));
    }
    for (const id of userIds) {
      await sys((tx) => tx.userRole.deleteMany({ where: { userId: id } }));
      await sys((tx) =>
        tx.refreshToken.deleteMany({ where: { accountId: id } }),
      );
      await sys((tx) =>
        tx.auditLogEntry.updateMany({
          where: { accountId: id },
          data: { accountId: null },
        }),
      );
      await sys((tx) => tx.user.deleteMany({ where: { id } }));
    }
    for (const id of roleIds) {
      await sys((tx) => tx.role.deleteMany({ where: { id } }));
    }
    if (companyId) {
      await sys((tx) => tx.company.deleteMany({ where: { id: companyId } }));
    }
    await app.close();
  });

  it('reports every record open before any NOC', async () => {
    const res = await status('work_order', ['wo-a', 'wo-b']);
    expect(res).toEqual([
      { subjectId: 'wo-a', status: 'open', closedAt: null },
      { subjectId: 'wo-b', status: 'open', closedAt: null },
    ]);
  });

  it('keeps a work order open after the LOI NOC and closes it on the work-order NOC', async () => {
    await upload('work_order', 'wo-a', 'loi');
    expect((await status('work_order', ['wo-a']))[0].status).toBe('open');

    const noc = await upload('work_order', 'wo-a', 'work_order');
    const [row] = await status('work_order', ['wo-a', 'wo-b']);
    expect(row.status).toBe('closed');
    expect(row.closedAt).toBeTruthy();
    expect((await status('work_order', ['wo-b']))[0].status).toBe('open');

    // Removing the closing NOC reopens it; the LOI's alone does not close it.
    await http().delete(`/nocs/${noc.body.id}`).set(auth(token)).expect(204);
    expect((await status('work_order', ['wo-a']))[0].status).toBe('open');
  });

  it('closes any other record on its first NOC', async () => {
    await upload('labour_worker', 'lw-1');
    await upload('hire_order', 'ho-1');
    expect(
      (await status('labour_worker', ['lw-1', 'lw-2'])).map((r) => r.status),
    ).toEqual(['closed', 'open']);
    expect((await status('hire_order', ['ho-1']))[0].status).toBe('closed');
  });

  it("needs the subject's permission, as reading the NOC does", async () => {
    await http()
      .get('/nocs/status?subjectType=work_order&subjectIds=wo-a')
      .set(auth(labourOnlyToken))
      .expect(403);
    expect(
      (await status('labour_worker', ['lw-1'], labourOnlyToken))[0].status,
    ).toBe('closed');
  });

  it('refuses an unknown subject type and an oversized page', async () => {
    await http()
      .get('/nocs/status?subjectType=project&subjectIds=x')
      .set(auth(token))
      .expect(400);
    const ids = Array.from({ length: 501 }, (_, i) => `id${i}`).join(',');
    await http()
      .get(`/nocs/status?subjectType=work_order&subjectIds=${ids}`)
      .set(auth(token))
      .expect(400);
  });
});
