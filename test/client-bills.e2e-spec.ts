import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Client bills measured against a real BOQ, against a real database (018 T013, T037, T045, T053).
 *
 * ## Why this suite could not exist until now
 *
 * Every assertion below needs a project with a priced BOQ on it. Until 2026-10-03 nothing in this
 * repository could create one: `BOQTaskGroup` and `BOQTaskItem` were read in four places and written
 * in none, so these tasks carried the note *"needs a seeded project with a real BOQ"* and stayed
 * open. 008's BOQ entry and import closed that, and this is the first run of the billing path
 * end to end.
 *
 * ## What a mocked Prisma client would report working
 *
 * The behaviours chosen here are the ones a unit test cannot see:
 *
 *   * **The frozen rate.** `ClientBillLine.rate` is written once at composition. A unit test asserts
 *     the write; only a database can show the bill standing still when the BOQ rate moves under it.
 *   * **Cumulative quantity as an aggregate.** Summed over sibling rows each time, so it needs
 *     siblings — and the over-scope flag is computed from it.
 *   * **The composite unique on `(projectId, billNumber)`,** which is a constraint and not a check in
 *     the service.
 *   * **`onDelete: Restrict` from a billed line back to its BOQ item**, which is the guard stopping a
 *     billed figure being orphaned.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run repeatedly against
 * a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** The client's own quoted excess, as a fraction. `docs/BOQ_794578.xls` carries 2.46%. */
const QUOTED = 0.0246;

jest.setTimeout(120_000);

describe('Client bills against a BOQ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let clientId = '';
  let projectId = '';
  let groupId = '';
  /** Priced lines, keyed by the BOQ number given to them below. */
  const item: Record<string, { id: string; rate: number; scopeQty: number }> =
    {};

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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const billIds: string[] = [];

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

    // Read back rather than chosen. The company a caller writes to is the one on their *context* —
    // a cross-company caller who has selected a company arrives with the selection, not with the
    // company their account belongs to (019 FR-010) — so asking the server is the only way to know
    // which company these fixtures will land in. Picking the oldest company and assuming is how
    // `projects.e2e-spec.ts` came to fail against a database where a selection had been made.
    const client = await http()
      .post('/projects/clients')
      .set(auth())
      .send({ name: unique('BillClient') })
      .expect(201);
    clientId = client.body.id;
    companyId = client.body.companyId;

    // Created directly, and this is a deliberate exception to using the API for fixtures. 017's
    // `PROJECT_DOCUMENTS_MANDATORY_MISSING` refuses project creation until a document is attached
    // for every mandatory kind — for this company, four of them including the BOQ itself. That rule
    // is item 3 working exactly as asked, it has its own coverage in `project-documents.e2e-spec.ts`,
    // and satisfying it here would mean staging four blobs to reach the billing path this suite is
    // actually about.
    projectId = (
      await sys.project.create({
        data: {
          companyId,
          code: unique('PRJ').slice(0, 40),
          name: unique('BillProject'),
          clientId,
          contractValue: 3000000,
          startDate: new Date('2026-07-01'),
          // The percentage a percentage-BoQ bidder quotes against the whole schedule. It reaches a
          // real project from the BOQ import's confirm step; here it is a given.
          quotedPercentage: QUOTED,
        },
        select: { id: true },
      })
    ).id;

    const group = await http()
      .post(`/projects/${projectId}/boq/groups`)
      .set(auth())
      .send({ boqNo: '1', name: 'Earthwork', scopeQty: '0' })
      .expect(201);
    groupId = group.body.id;

    // Three priced lines and one unpriced. The unpriced one is the whole of `BOQ_RATE_MISSING`: the
    // rate column defaults to 0, so "nobody priced this" and "this is free" are the same byte.
    const lines = [
      {
        boqNo: '1.1',
        taskName: 'Excavation in ordinary rock',
        unit: 'Cum',
        scopeQty: '100',
        rate: '251.00',
      },
      {
        boqNo: '1.2',
        taskName: 'Filling with excavated earth',
        unit: 'Cum',
        scopeQty: '50',
        rate: '87.50',
      },
      {
        boqNo: '1.3',
        taskName: 'Disposal of surplus',
        unit: 'Cum',
        scopeQty: '30',
        rate: '41.25',
      },
      {
        boqNo: '1.4',
        taskName: 'Dewatering, rate to follow',
        unit: 'Day',
        scopeQty: '10',
      },
      // Two lines nothing else in this file touches, for the over-scope cases. They need a
      // cumulative position nobody else has moved, and sharing a line with the tests above made the
      // first draft of this suite depend on the order they ran in.
      {
        boqNo: '1.6',
        taskName: 'Shuttering to foundation, over-measure case',
        unit: 'Sqm',
        scopeQty: '12',
        rate: '100.00',
      },
      {
        boqNo: '1.7',
        taskName: 'Shuttering to plinth, justified over-measure case',
        unit: 'Sqm',
        scopeQty: '12',
        rate: '100.00',
      },
      // Two lines whose text order and numeric order disagree: as text `1.10` sorts between `1.1`
      // and `1.9`. Nothing else in this file touches them, so the bill composed against them
      // cannot move a cumulative figure another test reads.
      {
        boqNo: '1.9',
        taskName: 'Ordering case, ninth line',
        unit: 'Cum',
        scopeQty: '10',
        rate: '10.00',
      },
      {
        boqNo: '1.10',
        taskName: 'Ordering case, tenth line',
        unit: 'Cum',
        scopeQty: '10',
        rate: '10.00',
      },
    ];
    for (const line of lines) {
      const created = await http()
        .post(`/projects/${projectId}/boq/items`)
        .set(auth())
        .send({ groupId, ...line })
        .expect(201);
      item[line.boqNo] = {
        id: created.body.id,
        rate: Number(line.rate ?? 0),
        scopeQty: Number(line.scopeQty),
      };
    }
  }, 180_000);

  afterAll(async () => {
    // Order matters, and the order *is* the assertion in `refuses to delete a BOQ line a bill has
    // measured` below: a bill line Restricts its BOQ item, so bills go first.
    for (const id of billIds) {
      await sys.clientBill.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await sys.clientBill
      .deleteMany({ where: { projectId } })
      .catch(() => undefined);
    await sys.bOQTaskItem
      .deleteMany({ where: { groupId } })
      .catch(() => undefined);
    await sys.bOQTaskGroup
      .deleteMany({ where: { projectId } })
      .catch(() => undefined);
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    await app.close();
  }, 120_000);

  /** Composes a bill and remembers it for cleanup. */
  async function compose(
    body: Record<string, unknown>,
    expectStatus = 201,
  ): Promise<request.Response> {
    const res = await http()
      .post(`/projects/client-bills?companyId=${companyId}`)
      .set(auth())
      .send({ projectId, billingDate: '2026-08-21', ...body })
      .expect(expectStatus);
    if (res.body?.id) billIds.push(res.body.id);
    return res;
  }

  let counter = 0;
  const billNumber = () =>
    `RA-${String((counter += 1)).padStart(2, '0')}-${Date.now() % 10000}`;

  describe('the BOQ, priced and ready to measure (FR-001)', () => {
    it('serves two levels, two totals, and names the unpriced line before anybody measures it', async () => {
      const res = await http()
        .get(`/projects/client-bills/boq?projectId=${projectId}`)
        .set(auth())
        .expect(200);

      expect(res.body.groups).toHaveLength(1);
      // Six priced-and-unpriced fixture lines, plus the two 027 added for the ordering case.
      expect(res.body.groups[0].items).toHaveLength(8);
      // A heading carries no rate of its own, so a sheet cannot render it as a measured line of zero.
      expect(res.body.groups[0]).not.toHaveProperty('rate');

      // Derived from the fixture rather than transcribed, so adding a line above cannot leave a
      // stale constant here passing for the wrong reason.
      const scheduleTotal =
        Math.round(
          res.body.groups[0].items.reduce(
            (total: number, line: { scopeQty: number; rate: number }) =>
              total + line.scopeQty * line.rate,
            0,
          ) * 100,
        ) / 100;

      expect(res.body.quotedPercentage).toBe(QUOTED);
      // 100×251 + 50×87.50 + 30×41.25 + 10×0 + 12×100 + 12×100, and the two ordering lines
      // added in 027 at 10×10 each. Written out rather than summed from the fixture: a total
      // derived from the same array it is checking would agree with any fixture at all.
      expect(scheduleTotal).toBe(
        25100 + 4375 + 1237.5 + 1200 + 1200 + 100 + 100,
      );
      expect(res.body.estimatedTotal).toBe(scheduleTotal);
      expect(res.body.quotedTotal).toBeCloseTo(scheduleTotal * (1 + QUOTED), 2);

      // The endpoint the whole billing screen opens with. It returned HTTP 200 and an empty array
      // until the 2026-10-03 route-ordering fix, because `GET /projects/:id/boq` was registered
      // first and matched this path with `id` bound to the literal `client-bills` — see
      // `src/projects/route-shadowing.spec.ts`. A sheet cannot tell that from a project with no BOQ.
      expect(Array.isArray(res.body)).toBe(false);
      expect(res.body.projectId).toBe(projectId);

      // FR-002's refusal, pre-announced: said here so somebody marks the line rather than filling a
      // column and meeting the refusal at submit.
      expect(res.body.unpricedCount).toBe(1);
      const unpriced = res.body.groups[0].items.find(
        (i: { boqNo: string }) => i.boqNo === '1.4',
      );
      expect(unpriced.unpriced).toBe(true);
      expect(unpriced.remainingQty).toBe(10);
    });
  });

  describe('composing, flagging and submitting (T013, FR-002, FR-003)', () => {
    it('refuses an unpriced line by name rather than billing it as free work', async () => {
      const res = await compose(
        {
          billNumber: billNumber(),
          lines: [{ boqTaskItemId: item['1.4'].id, quantity: 2 }],
        },
        400,
      );

      expect(res.body.code).toBe('BOQ_RATE_MISSING');
      // Naming the line is the point. "Some lines have no rate" sends somebody down 231 rows.
      expect(res.body.boqNumbers).toEqual(['1.4']);
    });

    it('prices each line from the BOQ with the quoted percentage applied at the line', async () => {
      const res = await compose({
        billNumber: billNumber(),
        description: 'First running account bill',
        lines: [
          { boqTaskItemId: item['1.1'].id, quantity: 40 },
          { boqTaskItemId: item['1.2'].id, quantity: 20 },
        ],
      });

      const byNo = Object.fromEntries(
        res.body.lines.map((l: { boqNo: string }) => [l.boqNo, l]),
      );
      expect(byNo['1.1'].rate).toBe(251);
      // 40 × 251 × 1.0246 = 10286.984, to 10286.98 — the percentage at the line, which is what the
      // printed document shows and what its column must add up to.
      expect(byNo['1.1'].amount).toBe(
        Math.round(40 * 251 * (1 + QUOTED) * 100) / 100,
      );
      expect(byNo['1.1'].cumulativeQty).toBe(40);
      expect(byNo['1.1'].remainingQty).toBe(60);
      expect(byNo['1.1'].exceedsScope).toBe(false);

      // The bill's gross is the sum of the printed lines, never a separately-derived figure. A client
      // who adds the column up and gets a different answer stops trusting the document.
      const sum =
        Math.round(
          res.body.lines.reduce(
            (total: number, l: { amount: number }) => total + l.amount,
            0,
          ) * 100,
        ) / 100;
      expect(res.body.grossAmount).toBe(sum);
      expect(res.body.status).toBe('draft');
    });

    it('withholds retention without treating it as a reduction in what was billed', async () => {
      const res = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.3'].id, quantity: 10 }],
        retentionPercent: 0.05,
      });

      expect(res.body.retentionAmount).toBe(
        Math.round(res.body.grossAmount * 0.05 * 100) / 100,
      );
      expect(res.body.netAmount).toBe(
        Math.round((res.body.grossAmount - res.body.retentionAmount) * 100) /
          100,
      );
      // Gross is untouched: retention is the client's money held back and released later, not a
      // reduction in the work. A P&L reading net here would understate the project by every rupee
      // retained across it.
      expect(res.body.grossAmount).toBeGreaterThan(res.body.netAmount);
    });

    it('does not count a draft bill towards the cumulative position', async () => {
      // Asserted because the first draft of this suite assumed the opposite and its over-scope
      // cases passed for the wrong reason. A draft is a working document that has measured nothing
      // yet; counting it would flag a line as over-scope against a bill that may never be issued,
      // and would refuse a submit on the strength of one.
      const first = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.6'].id, quantity: 9 }],
      });
      expect(first.body.status).toBe('draft');

      const second = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.6'].id, quantity: 2 }],
      });
      expect(second.body.lines[0].cumulativeQty).toBe(2);
      expect(second.body.lines[0].exceedsScope).toBe(false);
    });

    it('flags an over-scope measurement rather than refusing it, then refuses the submit', async () => {
      // 1.6's scope is 12, and 15 passes it on its own bill — no dependence on what else is billed.
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.6'].id, quantity: 15 }],
      });

      // Flagged, not refused. Over-measurement happens on real sites and is often correct; refusing
      // it at entry means the measurement is never recorded anywhere, which is worse.
      expect(draft.body.exceedsScope).toBe(true);
      expect(draft.body.lines[0].exceedsScope).toBe(true);
      expect(draft.body.lines[0].cumulativeQty).toBe(15);
      // Negative rather than clamped: "0 remaining" and "3 over" are different facts.
      expect(draft.body.lines[0].remainingQty).toBe(-3);

      const refused = await http()
        .post(`/projects/client-bills/${draft.body.id}/submit`)
        .set(auth())
        .expect(400);
      expect(refused.body.code).toBe('OVER_SCOPE_REASON_REQUIRED');
      expect(refused.body.boqNumbers).toEqual(['1.6']);
    });

    it('accepts the same measurement once a reason is given', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [
          {
            boqTaskItemId: item['1.7'].id,
            quantity: 15,
            overScopeReason:
              'Rock encountered 1.2m deeper than the trial pit; joint survey 18 Aug.',
          },
        ],
      });
      expect(draft.body.lines[0].exceedsScope).toBe(true);

      const submitted = await http()
        .post(`/projects/client-bills/${draft.body.id}/submit`)
        .set(auth())
        .expect(201);

      expect(submitted.body.status).toBe('submitted');
      expect(submitted.body.submittedAt).toBeTruthy();
      expect(submitted.body.lines[0].overScopeReason).toMatch(/joint survey/);
    });

    it('refuses a second bill on the same project with the same number', async () => {
      const number = billNumber();
      await compose({
        billNumber: number,
        lines: [{ boqTaskItemId: item['1.2'].id, quantity: 1 }],
      });

      const clash = await compose(
        {
          billNumber: number,
          lines: [{ boqTaskItemId: item['1.2'].id, quantity: 1 }],
        },
        409,
      );
      // A database constraint, not a service check — which is why it needs this suite to observe.
      expect(clash.body.code).toBe('BILL_NUMBER_IN_USE');
    });

    it('refuses a bill on a project with no BOQ at all, and says which problem it is', async () => {
      // Quickstart Pass 1. Distinct from "this line is not on the BOQ": the project has no priced
      // scope whatsoever, and the remedy is to enter a BOQ rather than to correct a line. One code
      // for both would send somebody looking for a line that was never the problem.
      const bare = await sys.project.create({
        data: {
          companyId,
          code: unique('NOBOQ').slice(0, 40),
          name: unique('NoBoqProject'),
          clientId,
          contractValue: 1000,
          startDate: new Date('2026-07-01'),
        },
        select: { id: true },
      });

      try {
        const res = await http()
          .post(`/projects/client-bills?companyId=${companyId}`)
          .set(auth())
          .send({
            projectId: bare.id,
            billNumber: billNumber(),
            billingDate: '2026-08-21',
            // A real line id, but belonging to another project — which is the case that would
            // otherwise price a bill against a schedule the project does not have.
            lines: [{ boqTaskItemId: item['1.1'].id, quantity: 1 }],
          })
          .expect(400);
        expect(res.body.code).toBe('BOQ_REQUIRED');
      } finally {
        await sys.project.deleteMany({ where: { id: bare.id } });
      }
    });

    it('refuses a bill with no lines', async () => {
      const res = await compose({ billNumber: billNumber(), lines: [] }, 400);
      expect(res.body.code).toBe('BILL_HAS_NO_LINES');
    });
  });

  /**
   * Reported 2026-10-06: a composed bill listed its lines 1, 11, 2, 3 — `boqNo` is a text column
   * and `ORDER BY` on it is alphabetical.
   *
   * Asserts the order **on the response**, which is the thing that was wrong. The first fix sorted
   * in `submit()` rather than `view()` — a method that only counts the lines — so the code read as
   * fixed, the unit suite stayed green, and the screen was unchanged. A test that checked a sort
   * existed would have passed too; only one that reads the returned list catches it.
   */
  describe('the order lines come back in (027)', () => {
    it('lists 1.9 before 1.10, which text order does not', async () => {
      const res = await compose({
        lines: [
          { boqTaskItemId: item['1.10'].id, quantity: 1 },
          { boqTaskItemId: item['1.9'].id, quantity: 1 },
          { boqTaskItemId: item['1.1'].id, quantity: 1 },
        ],
      });

      const asReturned = res.body.lines.map((l: { boqNo: string }) => l.boqNo);
      expect(asReturned).toEqual(['1.1', '1.9', '1.10']);

      // And again on the read every screen actually uses, not only on the compose response.
      const read = await http()
        .get(`/projects/client-bills/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(read.body.lines.map((l: { boqNo: string }) => l.boqNo)).toEqual([
        '1.1',
        '1.9',
        '1.10',
      ]);
    });
  });

  describe('the frozen rate (FR-002)', () => {
    it('does not move when the BOQ rate is corrected underneath it', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.2'].id, quantity: 5 }],
      });
      await http()
        .post(`/projects/client-bills/${draft.body.id}/submit`)
        .set(auth())
        .expect(201);
      const grossAtSubmit = draft.body.grossAmount;

      await sys.bOQTaskItem.update({
        where: { id: item['1.2'].id },
        data: { rate: 999.99 },
      });
      try {
        const reread = await http()
          .get(`/projects/client-bills/${draft.body.id}`)
          .set(auth())
          .expect(200);

        // The assertion the whole feature turns on. A bill is a document that was sent; rendering it
        // from a live rate table makes every historical bill a lie that changes shape.
        expect(reread.body.lines[0].rate).toBe(87.5);
        expect(reread.body.grossAmount).toBe(grossAtSubmit);
      } finally {
        await sys.bOQTaskItem.update({
          where: { id: item['1.2'].id },
          data: { rate: 87.5 },
        });
      }
    });

    it('refuses to delete a BOQ line a bill has measured', async () => {
      // `onDelete: Restrict`, which is the only thing standing between a correction to the schedule
      // and a billed figure pointing at nothing.
      await expect(
        sys.bOQTaskItem.delete({ where: { id: item['1.1'].id } }),
      ).rejects.toThrow();
    });
  });

  describe('certification (T045, FR-005)', () => {
    let submittedId = '';
    let billedGross = 0;

    beforeAll(async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.3'].id, quantity: 4 }],
      });
      const submitted = await http()
        .post(`/projects/client-bills/${draft.body.id}/submit`)
        .set(auth())
        .expect(201);
      submittedId = submitted.body.id;
      billedGross = submitted.body.grossAmount;
    });

    it('refuses to certify a draft', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: item['1.3'].id, quantity: 1 }],
      });
      const res = await http()
        .post(`/projects/client-bills/${draft.body.id}/certify`)
        .set(auth())
        .send({ certifiedAmount: 1 })
        .expect(409);
      expect(res.body.code).toBe('BILL_NOT_SUBMITTED');
    });

    it('refuses more than was billed', async () => {
      const res = await http()
        .post(`/projects/client-bills/${submittedId}/certify`)
        .set(auth())
        .send({ certifiedAmount: billedGross + 1 })
        .expect(400);
      // Far more likely a typo than a windfall, and the typo is the one worth catching.
      expect(res.body.code).toBe('CERTIFIED_EXCEEDS_BILLED');
    });

    it('keeps both figures and reports the shortfall rather than absorbing it', async () => {
      const shortfall = 100;
      const res = await http()
        .post(`/projects/client-bills/${submittedId}/certify`)
        .set(auth())
        .send({
          certifiedAmount: Math.round((billedGross - shortfall) * 100) / 100,
        })
        .expect(201);

      expect(res.body.status).toBe('certified');
      // The billed amount is NOT overwritten. A shortfall is a dispute to pursue, and a system that
      // quietly reduced what was billed would lose the only record that there was one.
      expect(res.body.grossAmount).toBe(billedGross);
      expect(res.body.certifiedAmount).toBe(
        Math.round((billedGross - shortfall) * 100) / 100,
      );
      expect(res.body.certificationVariance).toBe(shortfall);
      expect(res.body.certifiedAt).toBeTruthy();

      // And cumulative billed quantity is untouched, so the next bill measures from what was billed
      // rather than from what was paid.
      const boq = await http()
        .get(`/projects/client-bills/boq?projectId=${projectId}`)
        .set(auth())
        .expect(200);
      const line = boq.body.groups[0].items.find(
        (i: { boqNo: string }) => i.boqNo === '1.3',
      );
      expect(line.previouslyBilledQty).toBeGreaterThanOrEqual(4);
    });
  });

  describe('a variation line (T037, FR-015a)', () => {
    let variationItemId = '';

    beforeAll(async () => {
      const created = await http()
        .post(`/projects/${projectId}/boq/items`)
        .set(auth())
        .send({
          groupId,
          boqNo: '1.5',
          taskName: 'Additional shoring, client instruction 12',
          unit: 'Sqm',
          scopeQty: '20',
          rate: '610.00',
          isVariation: true,
          variationRef: 'VO-12',
        })
        .expect(201);
      variationItemId = created.body.id;
    });

    it('bills and reconciles through exactly the same path as original scope', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: variationItemId, quantity: 8 }],
      });

      const line = draft.body.lines[0];
      // Same pricing, same quoted percentage, same cumulative aggregate, same over-scope check. The
      // task note said this was "covered in part by construction" — an argument from the data model.
      // This is the observation.
      expect(line.rate).toBe(610);
      expect(line.amount).toBe(Math.round(8 * 610 * (1 + QUOTED) * 100) / 100);
      expect(line.cumulativeQty).toBe(8);
      expect(line.remainingQty).toBe(12);
      expect(line.exceedsScope).toBe(false);

      // And it stays identifiable as a variation all the way through, which is what lets the P&L
      // report it apart from original scope rather than folded into it.
      expect(line.isVariation).toBe(true);
      expect(line.variationRef).toBe('VO-12');
    });

    it('is over-measured, flagged and refused on exactly the same terms', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [{ boqTaskItemId: variationItemId, quantity: 25 }],
      });
      expect(draft.body.lines[0].exceedsScope).toBe(true);

      const refused = await http()
        .post(`/projects/client-bills/${draft.body.id}/submit`)
        .set(auth())
        .expect(400);
      expect(refused.body.code).toBe('OVER_SCOPE_REASON_REQUIRED');
      expect(refused.body.boqNumbers).toEqual(['1.5']);
    });
  });

  describe('an internal estimate is not billable (008 US4 AC6, T097)', () => {
    let estimateGroupId = '';
    let estimateItemId = '';

    beforeAll(async () => {
      // Written directly because the only route to an estimate line is the estimate import, which
      // needs a workbook — and what is under test here is the billing refusal, not the import.
      estimateGroupId = (
        await sys.bOQTaskGroup.create({
          data: {
            companyId,
            projectId,
            boqNo: '9',
            name: 'Internal costing — not the client’s scope',
            scopeQty: '0',
            isEstimate: true,
          },
          select: { id: true },
        })
      ).id;
      estimateItemId = (
        await sys.bOQTaskItem.create({
          data: {
            companyId,
            groupId: estimateGroupId,
            boqNo: '9.1',
            taskName: 'RCC at our own cost rate',
            unit: 'Cum',
            scopeQty: '50',
            rate: '1850.00',
            isEstimate: true,
          },
          select: { id: true },
        })
      ).id;
    });

    afterAll(async () => {
      await sys.bOQTaskItem
        .deleteMany({ where: { groupId: estimateGroupId } })
        .catch(() => undefined);
      await sys.bOQTaskGroup
        .deleteMany({ where: { id: estimateGroupId } })
        .catch(() => undefined);
    });

    it('is absent from the billing sheet’s schedule entirely', async () => {
      const res = await http()
        .get(`/projects/client-bills/boq?projectId=${projectId}`)
        .set(auth())
        .expect(200);

      // Offering both would present the company's internal rates as billable scope: doubled
      // quantities at the wrong prices, on a sheet that looks correct.
      expect(
        res.body.groups.map((g: { boqNo: string }) => g.boqNo),
      ).not.toContain('9');
      const everyItem = res.body.groups.flatMap(
        (g: { items: { id: string }[] }) => g.items,
      );
      expect(everyItem.map((i: { id: string }) => i.id)).not.toContain(
        estimateItemId,
      );
    });

    it('refuses a bill that names one directly, by BOQ number', async () => {
      const res = await compose(
        {
          billNumber: billNumber(),
          lines: [{ boqTaskItemId: estimateItemId, quantity: 5 }],
        },
        400,
      );

      // The sheet never offers it, so reaching here means a line id was supplied by hand — and the
      // consequence is a client billed at the company's own costing, on a document indistinguishable
      // from a correct one.
      expect(res.body.code).toBe('BOQ_LINE_IS_ESTIMATE');
      expect(res.body.boqNumbers).toEqual(['9.1']);
    });

    it('does not report its lines on the alerts screen', async () => {
      const res = await http()
        .get(`/projects/${projectId}/boq/alerts`)
        .set(auth())
        .expect(200);

      const everyAlert = [
        ...res.body.today,
        ...res.body.delayed,
        ...res.body.toBeDelayed,
        ...res.body.unplanned,
      ];
      expect(everyAlert.map((item: { id: string }) => item.id)).not.toContain(
        estimateItemId,
      );
      // And the tender's lines are still there, so this is not passing because the endpoint
      // returned nothing.
      expect(everyAlert.length).toBeGreaterThan(0);
    });

    it('is still on the tree, because somebody entered it and must be able to read it', async () => {
      const res = await http()
        .get(`/projects/${projectId}/boq`)
        .set(auth())
        .expect(200);

      const estimate = res.body.find(
        (group: { boqNo: string }) => group.boqNo === '9',
      );
      expect(estimate).toBeDefined();
      expect(estimate.isEstimate).toBe(true);
      expect(estimate.items[0].isEstimate).toBe(true);
    });
  });

  describe('cumulative position as at the bill’s own date', () => {
    it('shows a historical bill the running total as it stood then, not today’s', async () => {
      const first = await compose({
        billNumber: billNumber(),
        billingDate: '2026-07-10',
        lines: [{ boqTaskItemId: item['1.2'].id, quantity: 6 }],
      });
      await http()
        .post(`/projects/client-bills/${first.body.id}/submit`)
        .set(auth())
        .expect(201);

      const second = await compose({
        billNumber: billNumber(),
        billingDate: '2026-09-10',
        lines: [{ boqTaskItemId: item['1.2'].id, quantity: 7 }],
      });
      await http()
        .post(`/projects/client-bills/${second.body.id}/submit`)
        .set(auth())
        .expect(201);

      const reread = await http()
        .get(`/projects/client-bills/${first.body.id}`)
        .set(auth())
        .expect(200);

      // Opening July's bill must not show September's running total beside July's quantity — beside
      // figures from then, today's cumulative reads as an arithmetic error in the bill.
      const julyCumulative = reread.body.lines[0].cumulativeQty;
      const laterRead = await http()
        .get(`/projects/client-bills/${second.body.id}`)
        .set(auth())
        .expect(200);
      expect(laterRead.body.lines[0].cumulativeQty).toBeGreaterThan(
        julyCumulative,
      );
    });

    it('lists the project’s bills newest first', async () => {
      const list = await http()
        .get(`/projects/client-bills?projectId=${projectId}`)
        .set(auth())
        .expect(200);

      const dates = (list.body.items ?? list.body).map(
        (b: { billingDate: string }) => b.billingDate,
      );
      const sorted = [...dates].sort().reverse();
      expect(dates).toEqual(sorted);
    });
  });

  describe('a measurement, not an assertion: the two quoted totals', () => {
    it('records how far the schedule’s quoted total sits from the sum of per-line bills', async () => {
      // Two correct figures that are not the same figure, and this suite is where that is written
      // down rather than discovered by somebody reconciling.
      //
      //   * `BillableBoq.quotedTotal` applies the percentage ONCE to the schedule total, which is how
      //     the tender document states it and what the BOQ import reconciles against.
      //   * A bill applies it PER LINE and sums the printed lines, because the total on a document a
      //     client reads must equal the column above it.
      //
      // Bill the whole schedule and the two differ by rounding — at most half a paisa per line.
      const boq = await http()
        .get(`/projects/client-bills/boq?projectId=${projectId}`)
        .set(auth())
        .expect(200);

      const priced = boq.body.groups[0].items.filter(
        (i: { unpriced: boolean }) => !i.unpriced,
      );
      const perLine =
        Math.round(
          priced.reduce(
            (total: number, i: { scopeQty: number; rate: number }) =>
              total +
              Math.round(i.scopeQty * i.rate * (1 + QUOTED) * 100) / 100,
            0,
          ) * 100,
        ) / 100;

      const divergence = Math.abs(perLine - boq.body.quotedTotal);
      // Bounded, derived rather than chosen: one line can round by at most half a paisa, and the
      // total of the per-line figures can be at most that many out.
      expect(divergence).toBeLessThanOrEqual(priced.length * 0.005 + 0.005);
    });
  });
});
