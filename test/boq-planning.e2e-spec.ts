import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { BOQ_ERRORS } from '../src/projects/boq/boq-error-codes';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * Planning a schedule line that already exists (025 US2, quickstart pass 2).
 *
 * ## The state this feature found the product in
 *
 * A tender schedule carries no dates and the importer reads none, so every imported line was
 * unplanned — and there was **no update of any kind** for a BOQ item. The only route to a finish
 * date was to delete the line and create it again, which stops being possible the moment a daily
 * work report measures against it. On a 312-line tender, that meant the three programme columns
 * read "Not planned" permanently and the four alert tabs had nothing to report.
 *
 * ## Why each test is shaped the way it is
 *
 * **The round trip re-reads.** Asserting that the PATCH answered 200 proves the request was
 * accepted and nothing about what is stored or derived. Every assertion below reads the line back
 * through the BOQ endpoint a screen actually uses.
 *
 * **Clearing and omitting are both asserted.** A clear that works beside an omission that *also*
 * clears is a planner's work silently discarded, and only the pair can tell them apart.
 *
 * **The contradiction case sends only a finish date.** A check reading the request alone passes it;
 * the stored start date is what makes it wrong.
 */
const stamp = `${Date.now() % 100000}`;
const unique = (s: string) => `E2E${s}${stamp}`;

const isoDay = (offsetDays: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

describe('Planning a BOQ line (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;
  let projectId: string;
  let clientId: string;
  let groupId: string;
  let itemId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );

  /** The line as the BOQ screen reads it — the shape every assertion here is made against. */
  const readLine = async () => {
    const res = await http()
      .get(`/projects/${projectId}/boq?companyId=${companyId}`)
      .set(auth())
      .expect(200);
    const groups = Array.isArray(res.body) ? res.body : res.body.groups;
    return groups
      .flatMap((g: { items: Record<string, unknown>[] }) => g.items)
      .find((i: { id: string }) => i.id === itemId);
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

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;
    companyId = await effectiveCompanyIdFor(sys);

    const client = await http()
      .post(`/projects/clients?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Client') })
      .expect(201);
    clientId = client.body.id;

    const project = await createProjectWithMandatoryDocuments({
      http,
      headers: auth(),
      body: {
        code: unique('P').slice(0, 14),
        name: unique('Project'),
        clientId,
        contractValue: 10_000_000,
        startDate: '2025-01-01',
      },
      companyId,
    });
    expect(project.status).toBe(201);
    projectId = project.body.id;

    const group = await http()
      .post(`/projects/${projectId}/boq/groups?companyId=${companyId}`)
      .set(auth())
      .send({ boqNo: '1', name: 'Earthwork', scopeQty: '0' })
      .expect(201);
    groupId = group.body.id;

    // Created exactly as the importer creates one: no dates at all.
    const item = await http()
      .post(`/projects/${projectId}/boq/items?companyId=${companyId}`)
      .set(auth())
      .send({
        groupId,
        boqNo: '1.10',
        taskName: 'Earth work in excavation',
        unit: 'Cum',
        scopeQty: '825.729',
        rate: '251.00',
      })
      .expect(201);
    itemId = item.body.id;
  });

  afterAll(async () => {
    await sys.bOQTaskItem.deleteMany({ where: { groupId } });
    await sys.bOQTaskGroup.deleteMany({ where: { id: groupId } });
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('starts unplanned, which is what an imported tender looks like', async () => {
    const line = await readLine();

    // The non-vacuity assertion, first: every test below is about moving these away from null, and
    // a line that arrived already planned would make all of them pass without the endpoint doing
    // anything at all.
    expect(line.startDate).toBeNull();
    expect(line.finishDate).toBeNull();
    expect(line.perDayQty).toBeNull();
    expect(line.avgQtyPerDay).toBeNull();
    expect(line.state).toBe('unplanned');
  });

  it('reports a needed rate and a finish date where it read Not planned', async () => {
    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ startDate: isoDay(0), finishDate: isoDay(60) })
      .expect(200);

    const line = await readLine();
    expect(line.finishDate).not.toBeNull();
    expect(line.startDate).not.toBeNull();
    // Derived rather than stored: 825.729 outstanding over the days remaining. The point of the
    // assertion is that the figure exists at all — before this endpoint, `neededRate` returned null
    // for every line on every project because no line had a finish date.
    expect(line.state).not.toBe('unplanned');
  });

  it('lets an explicit per-day target override the derived rate', async () => {
    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ perDayQty: '20.000' })
      .expect(200);

    expect((await readLine()).perDayQty).toBe('20.000');
  });

  it('leaves a field alone when the request omits it', async () => {
    // Half of FR-011, and the half a clearing implementation gets wrong: this request mentions
    // only the duration, and the per-day target set above must survive it untouched.
    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ duration: 45 })
      .expect(200);

    expect((await readLine()).perDayQty).toBe('20.000');
  });

  it('clears a field when the request sends null', async () => {
    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ perDayQty: null })
      .expect(200);

    const line = await readLine();
    expect(line.perDayQty).toBeNull();
    // And the rest of the programme is still there: clearing one field is not clearing the line.
    expect(line.finishDate).not.toBeNull();
  });

  it('refuses a finish date before the stored start date, naming the contradiction', async () => {
    // The request carries ONLY a finish date. A check that read the request alone would accept it
    // and leave the line finishing before it starts, after which every derived figure divides by a
    // negative number of days and returns a plausible small quantity.
    const res = await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ finishDate: isoDay(-30) })
      .expect(400);

    expect(res.body.code).toBe(BOQ_ERRORS.programmeInconsistent);
  });

  it('refuses to touch what the work is, as distinct from when it happens', async () => {
    // FR-015 as a property of the DTO rather than a check in the service: `forbidNonWhitelisted`
    // makes an undeclared field a 400, so a rate cannot be changed by a request that is ostensibly
    // setting a date.
    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ rate: '9999.00' })
      .expect(400);

    expect((await readLine()).rate).toBe('251.00');
  });

  it('reports an unknown line as not found rather than refused', async () => {
    // 404, never 403: a 403 confirms the row exists, which is itself across the boundary row-level
    // security is drawn to protect.
    await http()
      .patch(
        `/projects/${projectId}/boq/items/00000000-0000-0000-0000-000000000000?companyId=${companyId}`,
      )
      .set(auth())
      .send({ duration: 10 })
      .expect(404);
  });

  it('refuses a write against a locked project with 423, not 403', async () => {
    await sys.project.update({
      where: { id: projectId },
      data: { isLocked: true },
    });

    await http()
      .patch(
        `/projects/${projectId}/boq/items/${itemId}?companyId=${companyId}`,
      )
      .set(auth())
      .send({ duration: 10 })
      .expect(423);

    await sys.project.update({
      where: { id: projectId },
      data: { isLocked: false },
    });
  });
});
