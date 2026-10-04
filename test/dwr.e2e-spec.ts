import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * Daily work reports, end to end against a real database (022 Phase G, quickstart passes 1–8).
 *
 * ## What only a real database can show here
 *
 * Almost everything in this feature is a transaction, and a mocked Prisma client would report each
 * of these behaviours working while the database did something else. Specifically:
 *
 * - **the `DWRTask_quantity_matches_basis` CHECK**, which no unit test can exercise;
 * - **the conditional status transitions** that make approval at-most-once — their whole content is
 *   `updateMany ... where status = X` returning a row count, which a mock would simply agree with;
 * - **the relative increment**, which has to be evaluated by Postgres against the row as it stands
 *   for two concurrent approvals of different reports to both land;
 * - **the grouped aggregate** behind the period figures, whose correctness is a `CASE` over a
 *   column chosen per row;
 * - and **the 008 US5 acceptance test that has never been runnable at all** — submit moves nothing,
 *   approve moves it once — because until this feature there was no endpoint to call.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`.
 */
const stamp = `${Date.now() % 100000}`;
const unique = (s: string) => `E2E${s}${stamp}`;

/** Yesterday, so no assertion depends on a report being filed before midnight. */
function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('Daily work reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;
  let projectId: string;
  let clientId: string;
  let groupId: string;
  let itemA: string;
  let itemB: string;
  let itemUnmeasured: string;

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

  /** A BOQ line's stored executed quantity, read behind the API. */
  const doneQty = async (itemId: string): Promise<string> => {
    const row = await sys.bOQTaskItem.findUnique({
      where: { id: itemId },
      select: { doneQty: true },
    });
    return row.doneQty.toFixed(3);
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
      // Decimals cross the wire as **strings**, as everywhere else in this API — `@IsNumberString`
      // on the DTO, because a quantity routed through a JavaScript float is a quantity that has
      // already lost precision before the server sees it.
      .send({ boqNo: '30', name: 'Routine maintenance', scopeQty: '0' })
      .expect(201);
    groupId = group.body.id;

    const item = async (boqNo: string, unit: string, scopeQty: string) => {
      const res = await http()
        .post(`/projects/${projectId}/boq/items?companyId=${companyId}`)
        .set(auth())
        .send({
          groupId,
          boqNo,
          taskName: `Line ${boqNo}`,
          unit,
          scopeQty,
          rate: '1000',
        })
        .expect(201);
      return res.body.id;
    };

    itemA = await item('30.10', 'MON', '12');
    itemB = await item('30.20', 'CUM', '1000');
    // Measured by nobody, on purpose: FR-037's zero row.
    itemUnmeasured = await item('30.30', 'NO', '500');
  });

  afterAll(async () => {
    await sys.dailyWorkReport.deleteMany({ where: { projectId } });
    await sys.bOQTaskItem.deleteMany({ where: { groupId } });
    await sys.bOQTaskGroup.deleteMany({ where: { id: groupId } });
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    // `app.close()` alone does not disconnect Prisma — `nestjs-prisma`'s service implements only
    // `OnModuleInit`, which is why `PrismaShutdownService` exists and why
    // `e2e-teardown.spec.ts` scans for both of these.
    await app.close();
  });

  /** Creates a report and returns the body. */
  async function createReport(
    lines: Record<string, unknown>[],
    over: Record<string, unknown> = {},
  ) {
    const res = await http()
      .post(`/projects/${projectId}/dwr?companyId=${companyId}`)
      .set(auth())
      .send({ workDate: yesterday(), workerCount: 14, lines, ...over });
    return res;
  }

  // ── Pass 1 — the measured quantity, computed by the server ────────────────

  describe('Pass 1 — a measured day', () => {
    it('computes the quantity from the six factors', async () => {
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          nos1: '2',
          length: '12.5',
          breadth: '3.75',
          depth: '0.15',
        },
      ]);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.dprNumber).toContain('-DPR-');

      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      // 2 × 1 × 12.5 × 3.75 × 0.15 × 1
      expect(detail.body.lines[0].quantityInForce).toBe('14.063');
    });

    it('refuses a caller-supplied quantity outright rather than ignoring it', async () => {
      // Stronger than the guarantee this test was first written to assert. `configure-app` sets
      // `whitelist` **and** `forbidNonWhitelisted`, so a field the DTO does not declare is a 400
      // rather than a silently discarded value. Worth asserting rather than assuming: "the server
      // computes the quantity" and "the server refuses to be told the quantity" are different
      // promises, and only the second cannot be weakened by a later DTO gaining the field.
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '2',
          actualQty: '999',
        },
      ]);
      expect(res.status).toBe(400);
    });

    it('refuses a factor of 0 by name', async () => {
      const res = await createReport([
        { paymentMode: 'work_basis', boqItemId: itemB, nos1: '2', depth: '0' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('depth');
    });

    it('treats an omitted factor as 1 rather than 0', async () => {
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '4',
          breadth: '5',
        },
      ]);
      expect(res.status).toBe(201);
      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines[0].quantityInForce).toBe('20.000');
    });
  });

  // ── Pass 2 — the 008 US5 acceptance test, finally runnable ────────────────

  describe('Pass 2 — submission is a claim, approval is a fact', () => {
    it('moves no executed quantity on submission, and exactly once on approval', async () => {
      const before = await doneQty(itemA);

      const created = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '0.700',
          remark: '30% deduction — shoulder slope and staff not available',
        },
      ]);
      expect(created.status).toBe(201);
      const id = created.body.id;

      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      // **The assertion 008 wrote in August and nothing has ever been able to run.**
      expect(await doneQty(itemA)).toBe(before);

      // The seeded administrator submitted it, so they may not approve it (FR-012a). Asserted
      // before the happy path, because a segregation rule that is only tested by its absence is a
      // rule nobody has checked.
      const selfApprove = await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth());
      expect(selfApprove.status).toBe(403);
      expect(selfApprove.body.message).toContain('somebody else');
      expect(await doneQty(itemA)).toBe(before);

      // Approve as somebody else. The segregation rule compares `submittedByUserId`, so clearing
      // it is the smallest honest way to stand in for a second reviewer — the alternative is
      // provisioning a second account, which tests account creation rather than approval.
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });

      const approved = await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      expect(approved.body.status).toBe('approved');

      const after = await doneQty(itemA);
      expect(after).toBe('0.700');
      expect(after).not.toBe(before);

      // Approving twice must not bill twice.
      const again = await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth());
      expect(again.status).toBe(409);
      expect(await doneQty(itemA)).toBe(after);
    });

    it('refuses to approve a report that was never submitted', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const res = await http()
        .post(`/projects/dwr/${created.body.id}/approve?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('draft');
    });

    it('refuses to submit a report carrying no lines', async () => {
      const created = await createReport([]);
      expect(created.status).toBe(201);
      const res = await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(400);
    });
  });

  // ── Pass 3 — reversal ─────────────────────────────────────────────────────

  describe('Pass 3 — reversal returns the counter exactly', () => {
    it('takes back precisely what the approval added', async () => {
      const before = await doneQty(itemB);

      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '3',
          breadth: '4',
        },
      ]);
      const id = created.body.id;

      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });
      await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      expect(await doneQty(itemB)).not.toBe(before);

      // A reason is required, because a reversal moves a quantity a bill may depend on.
      const noReason = await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'oops' });
      expect(noReason.status).toBe(400);

      const reversed = await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'measured twice by both crews at CH 228+200' })
        .expect(201);

      expect(reversed.body.status).toBe('draft');
      expect(reversed.body.reversalCount).toBe(1);
      // Exactly, not approximately.
      expect(await doneQty(itemB)).toBe(before);

      const detail = await http()
        .get(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      // The approval still on the record — erasing it would leave a reversal reason referring to
      // an approval nobody can see.
      expect(detail.body.approvedAt).not.toBeNull();
      expect(detail.body.reversedAt).not.toBeNull();
      expect(detail.body.reversalReason).toContain('both crews');
    });

    it('refuses to edit an approved report, naming the reversal path', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });
      await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const res = await http()
        .patch(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .send({ workerCount: 99 });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Reverse it first');

      // Tidy up so later passes start from a known counter.
      await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'fixture cleanup for the next assertion' })
        .expect(201);
    });

    it('refuses to delete anything but a draft', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const refused = await http()
        .delete(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth());
      expect(refused.status).toBe(409);

      await http()
        .post(`/projects/dwr/${id}/return?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await http()
        .delete(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
    });
  });

  // ── Pass 4 — presence, and the number that would be right by coincidence ──

  describe('Pass 4 — presence-paid lines', () => {
    it('requires a remark for a short day', async () => {
      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '0.5' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('deduction');
    });

    it('accepts a zero day with a remark, distinguishably from no record', async () => {
      // FR-031. Many rows of the client's own measurement sheets read "-".
      const res = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '0',
          remark: 'crane on site, idle all day — no work released',
        },
      ]);
      expect(res.status).toBe(201);

      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines).toHaveLength(1);
      expect(detail.body.lines[0].quantityInForce).toBe('0.000');
    });

    it('refuses measurement factors on a presence line rather than ignoring them', async () => {
      const res = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '1',
          nos1: '7',
          length: '7',
        },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('nos1');
    });

    it('still yields the served quantity when the factors are set behind the API', async () => {
      // **Quickstart Pass 4 step 4, and the assertion most likely to rot.** All six factors
      // default to 1, so their product is 1 — identical to one day served. An implementation that
      // read them would be right for every row created through the API and wrong the instant a
      // factor moved. So they are set to 7 directly in the database, where the DTO cannot refuse
      // them, and the answer must not change. 7^6 = 117,649.
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;

      await sys.dWRTask.updateMany({
        where: { dwrId: id },
        data: { nos1: 7, nos2: 7, length: 7, breadth: 7, depth: 7, density: 7 },
      });

      const detail = await http()
        .get(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines[0].quantityInForce).toBe('1.000');
    });

    it('is refused by the database when a line carries both quantities', async () => {
      // The CHECK constraint, which no unit test can reach. A service-level invariant is one
      // direct write away from being bypassed, and this is that write.
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      await expect(
        sys.dWRTask.updateMany({
          where: { dwrId: created.body.id },
          data: { actualQty: 5 },
        }),
      ).rejects.toThrow(/DWRTask_quantity_matches_basis/);
    });
  });

  // ── Pass 6 and 7 — the figures, and reconciliation ────────────────────────

  describe('Passes 6 and 7 — the figures feature 023 bills from', () => {
    it('returns every BOQ line, including the one nobody measured', async () => {
      const res = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);

      const boqNos = res.body.lines.map((l: { boqNo: string }) => l.boqNo);
      // **FR-037a asserted as a count, not as contents.** An assertion over a returned list passes
      // just as happily over a short one, and a bill missing an item is a smaller invoice.
      expect(res.body.lines).toHaveLength(3);
      expect(boqNos).toEqual(['30.10', '30.20', '30.30']);

      const unmeasured = res.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemUnmeasured,
      );
      expect(unmeasured.approvedInPeriod).toBe('0.000');
      expect(unmeasured.approvedUpToDate).toBe('0.000');
    });

    it('counts only approved reports, and attributes them by work date', async () => {
      const before = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);
      const lineBefore = before.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemB,
      );

      // A submitted report contributes nothing, however large.
      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '100',
          breadth: '100',
        },
      ]);
      await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const after = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);
      const lineAfter = after.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemB,
      );

      expect(lineAfter.approvedUpToDate).toBe(lineBefore.approvedUpToDate);
    });

    it('refuses a period that ends before it begins', async () => {
      const res = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2026-02-01&to=2026-01-01`,
        )
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('before it begins');
    });

    it('reconciles to zero, then reports a drift it did not create, then repairs it', async () => {
      const clean = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(clean.body.discrepancies).toBe(0);

      // Induce a drift the way a partial failure or a hand-edit would.
      await sys.bOQTaskItem.update({
        where: { id: itemA },
        data: { doneQty: { increment: 5 } },
      });

      const drifted = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(drifted.body.discrepancies).toBe(1);
      const line = drifted.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemA,
      );
      expect(line.difference).toBe('5.000');

      // FR-039c: repair is explicit, needs a reason, and nothing happened on its own.
      const noReason = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({ boqItemIds: [itemA], reason: 'x' });
      expect(noReason.status).toBe(400);

      const repaired = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          boqItemIds: [itemA],
          reason: 'drift of 5.000 induced during verification',
        })
        .expect(201);
      expect(repaired.body.repaired[0].from).not.toBe(
        repaired.body.repaired[0].to,
      );

      const healed = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(healed.body.discrepancies).toBe(0);

      // Refused the second time rather than succeeding quietly: a caller chasing a drift needs to
      // learn it is already gone.
      const again = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          boqItemIds: [itemA],
          reason: 'checking the refusal when there is nothing to do',
        });
      expect(again.status).toBe(409);
    });
  });

  // ── Pass 8 — locks, permissions, tenancy ─────────────────────────────────

  describe('Pass 8 — locks and scope', () => {
    it('refuses a write to a locked project with 423, not 403', async () => {
      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: true },
      });

      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      // 423 and not 403: the same caller may write the moment it is unlocked, which is a different
      // statement from "you may not do this".
      expect(res.status).toBe(423);

      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: false },
      });
    });

    it('reports an unknown report as 404 rather than 403', async () => {
      const res = await http()
        .get(`/projects/dwr/clnonexistent000000000000?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(404);
    });

    it('lists with a total that does not depend on the page size', async () => {
      const page = await http()
        .get(`/projects/dwr?projectId=${projectId}&pageSize=1`)
        .set(auth())
        .expect(200);

      expect(page.body.items).toHaveLength(1);
      expect(page.body.total).toBeGreaterThan(1);
      expect(page.body.pageSize).toBe(1);
    });
  });

  // ── The concurrency properties ───────────────────────────────────────────

  describe('concurrency', () => {
    it('lands both increments when two reports on one line are approved at once', async () => {
      // FR-015a. A read-then-write would lose one of the two, and lose it silently. The relative
      // increment is evaluated by Postgres against the row as it stands, which is why this holds —
      // and why no unit test could demonstrate it.
      const before = await doneQty(itemA);

      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const created = await createReport([
          { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
        ]);
        const id = created.body.id;
        await http()
          .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
          .set(auth())
          .expect(201);
        await sys.dailyWorkReport.update({
          where: { id },
          data: { submittedByUserId: null },
        });
        ids.push(id);
      }

      const results = await Promise.all(
        ids.map((id) =>
          http()
            .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
            .set(auth()),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      // Both, not one.
      expect(Number(await doneQty(itemA))).toBeCloseTo(Number(before) + 2, 3);
    });

    it('moves the counter once when one report is approved twice at the same instant', async () => {
      // FR-014a. The status transition is a conditional update inside the same transaction as the
      // increments, so the two requests serialise on the row and exactly one sees a row count of 1.
      const before = await doneQty(itemB);

      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '1',
          breadth: '1',
        },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });

      const [first, second] = await Promise.all([
        http()
          .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
          .set(auth()),
        http()
          .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
          .set(auth()),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(Number(await doneQty(itemB))).toBeCloseTo(Number(before) + 1, 3);
    });
  });

  // ── SC-008 ───────────────────────────────────────────────────────────────

  describe('SC-008 — the numbers the success criteria name', () => {
    it('records, submits and approves a seventeen-line report inside three seconds a step', async () => {
      // Generous on purpose and said so rather than silently widened later: these bounds are three
      // seconds a step against a local Postgres, which is roughly an order of magnitude above what
      // the operations take and still well below the point at which a person would notice. The
      // criterion exists to catch a change that makes an operation *qualitatively* slower — a
      // per-line round trip reappearing, say — not to measure this machine.
      const lines = Array.from({ length: 17 }, (_, i) => ({
        paymentMode: 'work_basis' as const,
        boqItemId: i % 2 === 0 ? itemA : itemB,
        length: '2',
        breadth: '3',
        chainageFrom: String(220 + i),
        chainageTo: String(220.5 + i),
      }));

      const t0 = Date.now();
      const created = await createReport(lines);
      const createMs = Date.now() - t0;
      expect(created.status).toBe(201);

      const t1 = Date.now();
      await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      const submitMs = Date.now() - t1;

      await sys.dailyWorkReport.update({
        where: { id: created.body.id },
        data: { submittedByUserId: null },
      });

      const t2 = Date.now();
      await http()
        .post(`/projects/dwr/${created.body.id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      const approveMs = Date.now() - t2;

      const t3 = Date.now();
      await http()
        .get(`/projects/dwr?projectId=${projectId}&pageSize=200`)
        .set(auth())
        .expect(200);
      const listMs = Date.now() - t3;

      expect(createMs).toBeLessThan(3000);
      expect(submitMs).toBeLessThan(3000);
      expect(approveMs).toBeLessThan(3000);
      expect(listMs).toBeLessThan(2000);
    });
  });
});
