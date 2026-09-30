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
 * The read/write level over HTTP (019 T025, T026, Phase 2) — `bugs.md` item 19.
 *
 * This is the claim the client said could not be expressed today: a role that may read a
 * module and may not change it. Asserted over HTTP rather than through the container
 * because the level is derived from the **HTTP method**, which only exists at this
 * boundary — a container-level test would have to supply the verb itself and would
 * therefore prove nothing about the derivation.
 *
 * Every fixture is prefixed `E2EAL` and removed in `afterAll`.
 */
const PREFIX = 'E2EAL';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(60_000);

describe('Access levels (e2e)', () => {
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

  let companyId: string;
  let readOnlyToken: string;
  let writeToken: string;
  let noAreaToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  /** Creates a role with explicit grants rather than the legacy array. */
  const makeUser = async (
    label: string,
    grants: { permission: Permission; level: AccessLevel }[],
  ) => {
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
    const role = await sys.role.create({
      data: {
        name: unique(`${label}Role`),
        // The legacy array carries the AREAS only, which is what every other
        // `permissions.includes(...)` in the codebase still reads. The level lives in
        // `rolePermissions`. Both are set here because that is the state the migration
        // leaves a real role in.
        permissions: [...new Set(grants.map((g) => g.permission))],
        rolePermissions: { create: grants },
      },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken as string };
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

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Levels Constructions`,
        shortCode: unique('L').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    readOnlyToken = (
      await makeUser('ro', [
        { permission: Permission.PROJECTS, level: AccessLevel.read },
      ])
    ).token;

    writeToken = (
      await makeUser('rw', [
        { permission: Permission.PROJECTS, level: AccessLevel.read },
        { permission: Permission.PROJECTS, level: AccessLevel.write },
      ])
    ).token;

    noAreaToken = (
      await makeUser('none', [
        { permission: Permission.DASHBOARD, level: AccessLevel.read },
      ])
    ).token;
  });

  afterAll(async () => {
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    // RolePermission cascades from Role.
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app.close();
  });

  it('lets a read-only role read the module', async () => {
    await http().get('/projects').set(auth(readOnlyToken)).expect(200);
  });

  it('refuses a write from that same read-only role', async () => {
    // The whole point of bugs.md item 19. Before this feature the same call succeeded,
    // because holding PROJECTS meant reading and writing it.
    const res = await http()
      .post('/projects')
      .set(auth(readOnlyToken))
      .send({ name: `${PREFIX} Should Not Exist` });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_LEVEL_INSUFFICIENT');
    expect(res.body.required.level).toBe('write');
  });

  it('distinguishes "wrong level" from "no access to this area"', async () => {
    // One is an interface offering a control it should have hidden; the other is somebody
    // reaching for a module they hold nothing in. The codes must not be interchangeable.
    const wrongLevel = await http()
      .post('/projects')
      .set(auth(readOnlyToken))
      .send({ name: `${PREFIX} X` });
    const noArea = await http().get('/projects').set(auth(noAreaToken));

    expect(wrongLevel.body.code).toBe('PERMISSION_LEVEL_INSUFFICIENT');
    expect(noArea.status).toBe(403);
    expect(noArea.body.code).toBe('PERMISSION_AREA_DENIED');
  });

  it('lets a role holding write through to the handler', async () => {
    // A 4xx that is NOT 403 proves the guard passed and the request reached validation —
    // which is what this asserts, rather than that a project was created.
    const res = await http()
      .post('/projects')
      .set(auth(writeToken))
      .send({ name: `${PREFIX} Incomplete` });

    expect(res.status).not.toBe(403);
    expect([400, 201, 422]).toContain(res.status);
  });

  it('reports grants on /users/me alongside the unchanged permissions list', async () => {
    const res = await http()
      .get('/users/me')
      .set(auth(readOnlyToken))
      .expect(200);

    // Additive: an existing client reading `permissions` as strings is unaffected.
    expect(res.body.permissions).toContain('PROJECTS');
    expect(res.body.grants).toEqual([
      { permission: 'PROJECTS', level: 'read' },
    ]);
  });

  it('keeps a GET a read even when it carries a body', async () => {
    await http()
      .get('/projects')
      .set(auth(readOnlyToken))
      .send({ anything: true })
      .expect(200);
  });
});
