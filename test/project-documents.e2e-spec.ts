import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { REQUIRED_PROJECT_DOCUMENT_KINDS } from '../src/settings/document-kinds';

/**
 * Project document readiness over HTTP (017 US2, T025).
 *
 * Driven over HTTP because every claim here is about the endpoint: that readiness rides
 * in the **list** rather than requiring each project to be opened, that a project may be
 * created before its papers arrive, that configuring the required set is a `SETTINGS`
 * decision while reading it is not, and that `/projects/document-requirements` is not
 * swallowed by `/projects/:id`.
 *
 * Every fixture is prefixed `E2EPD` and removed in `afterAll`.
 */
const PREFIX = 'E2EPD';
// A random tail as well as the clock: e2e suites run in parallel against one database,
// and two of them entering `unique()` in the same millisecond would collide on a name a
// unique index protects. Observed once as a lone transient failure in a combined run.
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(30_000);

describe('Project documents (e2e)', () => {
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
  let clientId: string;
  let adminToken: string;
  let readerToken: string;
  const typeIdByCode = new Map<string, string>();
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const projectIds: string[] = [];

  const makeUser = async (label: string, permissions: Permission[]) => {
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
      data: { name: unique(`${label}Role`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return login.body.accessToken as string;
  };

  const createProject = async (name: string) => {
    const res = await http()
      .post('/projects')
      .set(auth(adminToken))
      .send({
        code: unique('P').slice(0, 30),
        name: `${PREFIX} ${name}`,
        clientId,
        contractValue: 1000000,
        startDate: '2026-04-01',
      })
      .expect(201);
    projectIds.push(res.body.id);
    return res.body.id as string;
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
        name: 'E2EPD Project Documents Constructions',
        shortCode: unique('P').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    for (const kind of REQUIRED_PROJECT_DOCUMENT_KINDS) {
      const type = await sys.documentType.create({
        data: { companyId, code: kind.code, name: kind.label },
      });
      typeIdByCode.set(kind.code, type.id);
    }

    const client = await sys.client.create({
      data: { companyId, name: `${PREFIX} Highways Authority` },
    });
    clientId = client.id;

    adminToken = await makeUser('Admin', [
      Permission.PROJECTS,
      Permission.SETTINGS,
    ]);
    readerToken = await makeUser('Reader', [Permission.PROJECTS]);
  }, 120_000);

  afterAll(async () => {
    await sys.projectDocument.deleteMany({ where: { companyId } });
    await sys.projectDocumentRequirement.deleteMany({ where: { companyId } });
    await sys.project.deleteMany({ where: { companyId } });
    await sys.client.deleteMany({ where: { companyId } });
    await sys.documentType.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  it('serves /projects/document-requirements rather than treating it as a project id', async () => {
    // Nest matches routes in registration order. If `ProjectsController` were registered
    // first, `GET /projects/:id` would swallow this path and answer "project
    // document-requirements not found" — a routing fault wearing a data fault's clothes.
    const res = await http()
      .get('/projects/document-requirements')
      .set(auth(readerToken))
      .expect(200);

    expect(res.body.usingDefaults).toBe(true);
    expect(res.body.requirements).toHaveLength(
      REQUIRED_PROJECT_DOCUMENT_KINDS.length,
    );
  });

  it('lets a project be created before any of its documents exist (FR-009)', async () => {
    const projectId = await createProject('Ring Road');

    // Creation succeeds; readiness is reported, never enforced.
    const readiness = await http()
      .get('/projects?include=documentReadiness')
      .set(auth(adminToken))
      .expect(200);

    const row = readiness.body.items.find(
      (p: { id: string }) => p.id === projectId,
    );
    expect(row.documentReadiness.required).toBe(
      REQUIRED_PROJECT_DOCUMENT_KINDS.length,
    );
    expect(row.documentReadiness.present).toBe(0);
  });

  it('reports readiness in the LIST, without opening each project (FR-008)', async () => {
    const projectId = projectIds[0];

    // A document filed against a required kind. The upload endpoint belongs to 008's
    // unbuilt US8; what 017 owns is whether readiness notices the row.
    await sys.projectDocument.create({
      data: {
        companyId,
        projectId,
        documentType: 'Letter of intent',
        documentTypeId: typeIdByCode.get('LOI'),
        fileRef: 'e2epd/loi.pdf',
        uploadedByUserId: userIds[0],
      },
    });

    const res = await http()
      .get('/projects?include=documentReadiness')
      .set(auth(adminToken))
      .expect(200);

    const row = res.body.items.find((p: { id: string }) => p.id === projectId);
    expect(row.documentReadiness.present).toBe(1);
    expect(row.documentReadiness.missingTypeIds).not.toContain(
      typeIdByCode.get('LOI'),
    );
    expect(row.documentReadiness.missingTypeIds).toContain(
      typeIdByCode.get('BOQ'),
    );
  });

  it('omits readiness entirely when it was not asked for', async () => {
    const res = await http().get('/projects').set(auth(adminToken)).expect(200);

    // Opt-in: the screens that do not show readiness should not pay two queries for it.
    for (const item of res.body.items) {
      expect(item.documentReadiness).toBeUndefined();
    }
  });

  it('ignores a supplementary document, which answers no required kind', async () => {
    const projectId = await createProject('Bypass');
    await sys.projectDocument.create({
      data: {
        companyId,
        projectId,
        documentType: 'Site photograph',
        // Null: filed, but against no required kind (US2 scenario 5).
        documentTypeId: null,
        fileRef: 'e2epd/photo.jpg',
        uploadedByUserId: userIds[0],
      },
    });

    const res = await http()
      .get('/projects?include=documentReadiness')
      .set(auth(adminToken))
      .expect(200);
    const row = res.body.items.find((p: { id: string }) => p.id === projectId);
    expect(row.documentReadiness.present).toBe(0);
  });

  it('refuses requirement configuration without SETTINGS (FR-007)', async () => {
    await http()
      .put('/projects/document-requirements')
      .set(auth(readerToken))
      .send({ requirements: [{ documentTypeId: typeIdByCode.get('LOI') }] })
      .expect(403);
  });

  it('refuses a requirement naming a document type this company does not have', async () => {
    const res = await http()
      .put('/projects/document-requirements')
      .set(auth(adminToken))
      .send({ requirements: [{ documentTypeId: 'dt-belongs-to-nobody' }] })
      .expect(400);

    expect(res.body.code).toBe('PROJECT_DOCUMENT_TYPE_UNKNOWN');
  });

  it('applies a configured set in place of the shipped defaults', async () => {
    const res = await http()
      .put('/projects/document-requirements')
      .set(auth(adminToken))
      .send({
        requirements: [
          { documentTypeId: typeIdByCode.get('LOI') },
          {
            documentTypeId: typeIdByCode.get('WORK_ORDER'),
            isMandatory: false,
          },
        ],
      })
      .expect(200);

    expect(res.body.usingDefaults).toBe(false);
    expect(res.body.requirements).toHaveLength(2);

    // The optional one does not count: the first project holds its LOI, so it is now
    // complete despite holding none of the other five shipped kinds.
    const list = await http()
      .get('/projects?include=documentReadiness')
      .set(auth(adminToken))
      .expect(200);
    const row = list.body.items.find(
      (p: { id: string }) => p.id === projectIds[0],
    );
    expect(row.documentReadiness).toEqual({
      required: 1,
      present: 1,
      missingTypeIds: [],
    });
  });
});
