import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { configureApp } from '../src/common/configure-app';

/**
 * End-to-end coverage of `/projects/*` against a real database (008 T016, T025).
 *
 * Scoped to User Stories 1–3 — clients, sites and the portfolio — because those are
 * the only endpoints that exist. The behaviours asserted are the ones a mocked
 * Prisma client would happily report working while the database did something else:
 * the partial unique index behind GSTIN uniqueness, the atomic code-series
 * allocation, and the delete guards that read counts across four relations.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** A structurally valid GSTIN, varied per run so repeat runs cannot collide. */
const gstinFor = (n: number) =>
  `27AAPFU${String(1000 + (n % 9000)).padStart(4, '0')}F1ZV`;

describe('Projects module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const createdClientIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdSiteIds: string[] = [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_t, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;

    const company = await sys.company.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    companyId = company.id;
  });

  afterAll(async () => {
    // Order matters: Project RESTRICTs on Client, and Site SetNulls on Project, so
    // sites and projects have to go before the clients they point at.
    for (const id of createdSiteIds) {
      await sys.site.deleteMany({ where: { id } });
    }
    for (const id of createdProjectIds) {
      await sys.project.deleteMany({ where: { id } });
    }
    for (const id of createdClientIds) {
      await sys.client.deleteMany({ where: { id } });
    }
    await app.close();
  });

  async function createClient(body: Record<string, unknown>) {
    const res = await http()
      .post(`/projects/clients?companyId=${companyId}`)
      .set(auth())
      .send(body)
      .expect(201);
    createdClientIds.push(res.body.id);
    return res.body;
  }

  async function createProject(body: Record<string, unknown>) {
    const res = await http()
      .post(`/projects?companyId=${companyId}`)
      .set(auth())
      .send(body)
      .expect(201);
    createdProjectIds.push(res.body.id);
    return res.body;
  }

  describe('Clients (T016)', () => {
    it('creates a client and returns it with its status defaulted to active', async () => {
      const client = await createClient({
        name: unique('Client'),
        contactPerson: 'R Sharma',
        phone: '9876543210',
        email: 'contact@example.com',
        gstin: gstinFor(1),
      });

      expect(client.id).toBeDefined();
      expect(client.status).toBe('active');
      expect(client.companyId).toBe(companyId);
    });

    it('refuses a duplicate GSTIN within the same company with 409', async () => {
      const gstin = gstinFor(2);
      await createClient({ name: unique('First'), gstin });

      const clash = await http()
        .post(`/projects/clients?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Second'), gstin })
        .expect(409);

      // Naming the existing holder is the point — "duplicate GSTIN" alone leaves the
      // caller with nowhere to go.
      expect(clash.body.message).toMatch(/already belongs to client/i);
    });

    it('allows any number of clients with no GSTIN at all', async () => {
      // The partial unique index exists precisely so this does not collide. A plain
      // UNIQUE would also permit it, but only by Postgres treating NULLs as
      // distinct — an accident this asserts we are not relying on by luck.
      await createClient({ name: unique('NoGstinA') });
      await createClient({ name: unique('NoGstinB') });
      await createClient({ name: unique('NoGstinC') });
    });

    it('filters the list by search term and by status', async () => {
      const name = unique('Searchable');
      const created = await createClient({ name, status: 'inactive' });

      const bySearch = await http()
        .get(`/projects/clients?companyId=${companyId}&search=${name}`)
        .set(auth())
        .expect(200);
      expect(bySearch.body.items.map((c: { id: string }) => c.id)).toContain(
        created.id,
      );

      // Same row, filtered out by a status it does not have.
      const byWrongStatus = await http()
        .get(
          `/projects/clients?companyId=${companyId}&search=${name}&status=active`,
        )
        .set(auth())
        .expect(200);
      expect(
        byWrongStatus.body.items.map((c: { id: string }) => c.id),
      ).not.toContain(created.id);
    });

    it('reports projectCount per row, so the caller can predict a delete refusal', async () => {
      const client = await createClient({ name: unique('WithProjects') });
      await createProject({
        name: unique('Proj'),
        clientId: client.id,
        contractValue: 1000,
        startDate: '2026-01-01',
      });

      const list = await http()
        .get(`/projects/clients?companyId=${companyId}&search=${client.name}`)
        .set(auth())
        .expect(200);

      const row = list.body.items.find(
        (c: { id: string }) => c.id === client.id,
      );
      expect(row.projectCount).toBe(1);
    });

    it('refuses to delete a client that still has projects, with 409', async () => {
      const client = await createClient({ name: unique('Undeletable') });
      await createProject({
        name: unique('Blocker'),
        clientId: client.id,
        contractValue: 500,
        startDate: '2026-02-01',
      });

      const refused = await http()
        .delete(`/projects/clients/${client.id}`)
        .set(auth())
        .expect(409);
      expect(refused.body.message).toMatch(/linked/i);
    });

    it('deletes a client nothing references', async () => {
      const client = await createClient({ name: unique('Disposable') });
      await http()
        .delete(`/projects/clients/${client.id}`)
        .set(auth())
        .expect(200);

      await http()
        .get(`/projects/clients/${client.id}`)
        .set(auth())
        .expect(404);
    });
  });

  describe('Portfolio (T025)', () => {
    let clientId: string;

    beforeAll(async () => {
      const client = await createClient({ name: unique('PortfolioClient') });
      clientId = client.id;
    });

    it('allocates a project code from the company series when none is supplied', async () => {
      const project = await createProject({
        name: unique('AutoCoded'),
        clientId,
        contractValue: 25000000,
        startDate: '2026-03-01',
      });

      // `<company shortCode>-PRJ-<4 digits>`, allocated by CodeSeriesService.
      expect(project.code).toMatch(/-PRJ-\d{4}$/);
    });

    it('gives consecutive projects consecutive numbers', async () => {
      const first = await createProject({
        name: unique('SeqA'),
        clientId,
        contractValue: 1,
        startDate: '2026-03-01',
      });
      const second = await createProject({
        name: unique('SeqB'),
        clientId,
        contractValue: 1,
        startDate: '2026-03-01',
      });

      const numberOf = (code: string) => Number(code.split('-').pop());
      expect(numberOf(second.code)).toBe(numberOf(first.code) + 1);
    });

    it('honours a caller-supplied code, for projects migrated with one already', async () => {
      const code = unique('MIGRATED');
      const project = await createProject({
        name: unique('Migrated'),
        clientId,
        code,
        contractValue: 1,
        startDate: '2026-03-01',
      });
      expect(project.code).toBe(code);
    });

    it('refuses a project whose client belongs to another company', async () => {
      await http()
        .post(`/projects?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('BadClient'),
          clientId: 'client-that-does-not-exist',
          contractValue: 1,
          startDate: '2026-03-01',
        })
        .expect(404);
    });

    it('toggles the lock and persists it, which every write endpoint then reads', async () => {
      const project = await createProject({
        name: unique('Lockable'),
        clientId,
        contractValue: 1,
        startDate: '2026-04-01',
      });
      expect(project.isLocked).toBe(false);

      const locked = await http()
        .patch(`/projects/${project.id}`)
        .set(auth())
        .send({ isLocked: true })
        .expect(200);
      expect(locked.body.isLocked).toBe(true);

      const unlocked = await http()
        .patch(`/projects/${project.id}`)
        .set(auth())
        .send({ isLocked: false })
        .expect(200);
      expect(unlocked.body.isLocked).toBe(false);
    });

    it('audits a lock transition with its before and after, not as a bare update', async () => {
      const project = await createProject({
        name: unique('Audited'),
        clientId,
        contractValue: 1,
        startDate: '2026-04-01',
      });
      await http()
        .patch(`/projects/${project.id}`)
        .set(auth())
        .send({ isLocked: true })
        .expect(200);

      const entry = await sys.auditLogEntry.findFirst({
        where: {
          entityType: 'PROJECT',
          entityId: project.id,
          action: 'UPDATE',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry.changes).toEqual({
        isLocked: { before: false, after: true },
      });
    });

    it('returns aggregated tabs, naming the modules it could not consult', async () => {
      const project = await createProject({
        name: unique('Detailed'),
        clientId,
        contractValue: 1,
        startDate: '2026-05-01',
      });

      const detail = await http()
        .get(`/projects/${project.id}`)
        .set(auth())
        .expect(200);

      expect(detail.body.tabs.dwrSummary).toEqual({
        count: 0,
        latestDate: null,
      });
      expect(detail.body.tabs.revenueSummary).toEqual({
        totalReceived: 0,
        totalPending: 0,
      });
      // Empty because 006 and 009 do not exist — which the response says outright
      // rather than leaving the caller to infer there is no machinery.
      expect(detail.body.tabs.machinery).toEqual([]);
      expect(detail.body.unavailableModules).toEqual(['plant', 'inventory']);
    });

    it('refuses to delete a project that has recorded data, naming what is in the way', async () => {
      const project = await createProject({
        name: unique('HasDwr'),
        clientId,
        contractValue: 1,
        startDate: '2026-06-01',
      });

      // Written directly: the DWR endpoints are User Story 5 and do not exist yet,
      // but the delete guard that reads them does, and it is what this asserts.
      const dwr = await sys.dailyWorkReport.create({
        data: {
          companyId,
          projectId: project.id,
          workDate: new Date('2026-06-02'),
          dprNumber: unique('DPR'),
        },
      });

      const refused = await http()
        .delete(`/projects/${project.id}`)
        .set(auth())
        .expect(409);
      expect(refused.body.message).toMatch(/1 work report\(s\)/);

      await sys.dailyWorkReport.deleteMany({ where: { id: dwr.id } });
    });

    it('deletes a project nothing has been recorded against', async () => {
      const project = await createProject({
        name: unique('Empty'),
        clientId,
        contractValue: 1,
        startDate: '2026-07-01',
      });
      await http().delete(`/projects/${project.id}`).set(auth()).expect(200);
      await http().get(`/projects/${project.id}`).set(auth()).expect(404);
    });
  });

  describe('Sites (US2)', () => {
    let projectId: string;

    beforeAll(async () => {
      const client = await createClient({ name: unique('SiteClient') });
      const project = await createProject({
        name: unique('SiteProject'),
        clientId: client.id,
        contractValue: 1,
        startDate: '2026-08-01',
      });
      projectId = project.id;
    });

    async function createSite(body: Record<string, unknown>) {
      const res = await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send(body)
        .expect(201);
      createdSiteIds.push(res.body.id);
      return res.body;
    }

    it("creates a site carrying both the new fields and 003's geofence data", async () => {
      const site = await createSite({
        name: unique('Site'),
        latitude: 19.076,
        longitude: 72.8777,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
        projectId,
        address: 'Plot 4, MIDC',
      });

      expect(site.projectId).toBe(projectId);
      expect(site.status).toBe('active');
      expect(Number(site.geofenceRadiusMeters)).toBe(200);
    });

    it("keeps 003's picker endpoint returning a bare array, which HR's form consumes", async () => {
      // Not a paginated envelope: the Add Employee form reads this response directly,
      // and 008 adding an administrative list must not have changed its shape.
      const picker = await http()
        .get(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      expect(Array.isArray(picker.body)).toBe(true);
      expect(picker.body[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
        }),
      );
    });

    it('serves the administrative list separately, paginated and filterable', async () => {
      const list = await http()
        .get(
          `/projects/sites/list?companyId=${companyId}&projectId=${projectId}`,
        )
        .set(auth())
        .expect(200);

      expect(list.body).toEqual(
        expect.objectContaining({
          total: expect.any(Number),
          page: 1,
          items: expect.any(Array),
        }),
      );
      expect(
        list.body.items.every(
          (s: { projectId: string }) => s.projectId === projectId,
        ),
      ).toBe(true);
    });

    it('refuses to attach a site to a project in another company', async () => {
      await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Orphan'),
          latitude: 19,
          longitude: 72,
          geofenceRadiusMeters: 100,
          weeklyOffDay: 0,
          projectId: 'project-that-does-not-exist',
        })
        .expect(404);
    });

    it('rejects an out-of-range latitude before it reaches the database', async () => {
      await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('BadGeo'),
          latitude: 200,
          longitude: 72,
          geofenceRadiusMeters: 100,
          weeklyOffDay: 0,
        })
        .expect(400);
    });
  });
});
