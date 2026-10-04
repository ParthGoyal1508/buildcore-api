import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * The project P&L against real costs from four different modules (018 T034, T053, T054).
 *
 * ## What makes this suite different from the unit tests beside it
 *
 * `project-pnl.service.spec.ts` asks the service the right questions with a mocked registry. The
 * thing it cannot ask is whether the four modules that *register* cost sources actually answer — and
 * that is the whole of FR-010. Each of `plant`, `inventory` and `labour` announces a reader to
 * `ProjectSourcesRegistry` on init; if one fails to register, its category is correctly reported as
 * unavailable and **the P&L is silently missing a quarter of the project's cost** while looking
 * complete. Nothing short of booting the application and seeding real rows in those modules' own
 * tables can tell the two apart.
 *
 * So this seeds, in four other modules' schemas:
 *
 *   * `projects.RABill` — subcontractor cost, through the API.
 *   * `inventory.Purchase` — material cost, on a site of this project.
 *   * `plant.FuelEntry` against an `Equipment` deployed to that site — fuel cost.
 *   * `labour.LabourPaymentSheet` with one line, approved — labour cost.
 *
 * and then asserts the two properties the screen's trustworthiness rests on: a drill-down's total is
 * **summed from the records it returns**, and a category nobody can answer for is **named rather
 * than zeroed**.
 *
 * Fixtures are prefixed `E2E` and removed in `afterAll`.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** The month everything below is dated into. */
const PERIOD = '2026-08';
const IN_PERIOD = '2026-08-14';

const QUOTED = 0.0246;

/** What each module contributes, so the assertions can be derived rather than transcribed. */
const COST = {
  materials: 18400.5,
  fuel: 7250.25,
  labour: 46000,
};

jest.setTimeout(240_000);

describe('Project P&L across four modules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let clientId = '';
  let projectId = '';
  /** A second project, so T054's group total has rows to be the sum of. */
  let siblingProjectId = '';
  let siteId = '';
  let groupId = '';
  let workOrderId = '';
  let categoryId = '';
  let equipmentId = '';
  let sheetId = '';
  const boqItem: Record<string, string> = {};

  let subcontractorCost = 0;
  let revenueGross = 0;

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

    const client = await http()
      .post('/projects/clients')
      .set(auth())
      .send({ name: unique('PnlClient') })
      .expect(201);
    clientId = client.body.id;
    companyId = client.body.companyId;

    const makeProject = async (label: string) =>
      (
        await sys.project.create({
          data: {
            companyId,
            code: unique(label).slice(0, 40),
            name: unique(label),
            clientId,
            contractValue: 5000000,
            startDate: new Date('2026-07-01'),
            quotedPercentage: QUOTED,
          },
          select: { id: true },
        })
      ).id;

    // Created directly for the reason `client-bills.e2e-spec.ts` records: 017 refuses project
    // creation until every mandatory document kind is attached, which is not the path under test.
    projectId = await makeProject('PnlProject');
    siblingProjectId = await makeProject('PnlSibling');

    // Every cost source resolves a project to its **sites** and reads from there, so without a site
    // three of the four categories answer zero and the suite would pass by measuring nothing.
    siteId = (
      await sys.site.create({
        data: {
          companyId,
          name: unique('PnlSite'),
          latitude: 23.0225,
          longitude: 72.5714,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
          projectId,
        },
        select: { id: true },
      })
    ).id;

    // ── Revenue: a BOQ, a bill, a variation and a certified shortfall ─────────
    groupId = (
      await http()
        .post(`/projects/${projectId}/boq/groups`)
        .set(auth())
        .send({ boqNo: '1', name: 'Structure', scopeQty: '0' })
        .expect(201)
    ).body.id;

    for (const line of [
      {
        key: 'scope',
        boqNo: '1.1',
        taskName: 'RCC in foundation',
        unit: 'Cum',
        scopeQty: '200',
        rate: '6200.00',
      },
      {
        key: 'variation',
        boqNo: '1.2',
        taskName: 'Extra shoring, instruction 7',
        unit: 'Sqm',
        scopeQty: '50',
        rate: '610.00',
        isVariation: true,
        variationRef: 'VO-07',
      },
    ]) {
      const { key, ...body } = line;
      boqItem[key] = (
        await http()
          .post(`/projects/${projectId}/boq/items`)
          .set(auth())
          .send({ groupId, ...body })
          .expect(201)
      ).body.id;
    }

    const bill = async (
      number: string,
      lines: { boqTaskItemId: string; quantity: number }[],
    ) => {
      const draft = await http()
        .post(`/projects/client-bills?companyId=${companyId}`)
        .set(auth())
        .send({
          projectId,
          billNumber: number,
          billingDate: IN_PERIOD,
          lines,
        })
        .expect(201);
      return (
        await http()
          .post(`/projects/client-bills/${draft.body.id}/submit`)
          .set(auth())
          .expect(201)
      ).body;
    };

    const scopeBill = await bill(unique('RA1').slice(0, 30), [
      { boqTaskItemId: boqItem.scope, quantity: 30 },
    ]);
    const variationBill = await bill(unique('RA2').slice(0, 30), [
      { boqTaskItemId: boqItem.variation, quantity: 20 },
    ]);
    revenueGross =
      Math.round((scopeBill.grossAmount + variationBill.grossAmount) * 100) /
      100;

    // Certified for less than billed, so `revenueCertifiedShortfall` has something in it and can be
    // told apart from `revenueAwaitingCertification`.
    await http()
      .post(`/projects/client-bills/${scopeBill.id}/certify`)
      .set(auth())
      .send({
        certifiedAmount: Math.round((scopeBill.grossAmount - 5000) * 100) / 100,
      })
      .expect(201);

    // ── Subcontractors: a work order, an award and an issued bill ─────────────
    workOrderId = (
      await http()
        .post(`/projects/work-orders?companyId=${companyId}`)
        .set(auth())
        .send({
          projectId,
          workDetail: 'RCC labour and shuttering',
          retentionPercent: 0.05,
        })
        .expect(201)
    ).body.id;

    const award = await http()
      .put(`/projects/ra-bills/awards/${workOrderId}?companyId=${companyId}`)
      .set(auth())
      .send({
        lines: [
          {
            description: 'RCC labour',
            unit: 'Cum',
            awardedQty: 200,
            rate: 1850,
          },
        ],
      })
      .expect(200);
    const awardLineId = (award.body.lines ?? award.body)[0].id;

    const raDraft = await http()
      .post(`/projects/ra-bills?companyId=${companyId}`)
      .set(auth())
      .send({
        projectId,
        workOrderId,
        billNumber: unique('SC1').slice(0, 30),
        billingDate: IN_PERIOD,
        lines: [{ workOrderBoqItemId: awardLineId, quantity: 30 }],
      })
      .expect(201);
    const raBill = await http()
      .post(`/projects/ra-bills/${raDraft.body.id}/submit`)
      .set(auth())
      .expect(201);
    // Gross, not net. An RA bill's retention is money withheld and its advance recovery is money
    // already paid — neither is a cost, and reading `netPayable` here would understate the project
    // by the retention held across it.
    subcontractorCost = raBill.body.pnlAmount;

    // ── Materials: one purchase on this project's site ────────────────────────
    await sys.purchase.create({
      data: {
        companyId,
        siteId,
        itemId: unique('item').slice(0, 30),
        vendorId: unique('vendor').slice(0, 30),
        date: new Date(IN_PERIOD),
        quantity: 100,
        rate: 184.005,
        amount: COST.materials,
      },
    });

    // ── Fuel: a machine deployed to that site, and a diesel entry ─────────────
    categoryId = (
      await sys.equipmentCategory.create({
        data: {
          companyId,
          name: unique('PnlCategory'),
          meterType: 'hours',
        },
        select: { id: true },
      })
    ).id;
    equipmentId = (
      await sys.equipment.create({
        data: {
          companyId,
          code: unique('EQ').slice(0, 20),
          name: unique('Excavator'),
          categoryId,
          ownership: 'owned',
          powerSource: 'diesel',
          meterType: 'hours',
          deployedSiteId: siteId,
        },
        select: { id: true },
      })
    ).id;
    await sys.fuelEntry.create({
      data: {
        companyId,
        equipmentId,
        date: new Date(IN_PERIOD),
        quantity: 85,
        rate: 85.3,
        amount: COST.fuel,
      },
    });

    // ── Labour: an approved payment sheet for the period ─────────────────────
    sheetId = (
      await sys.labourPaymentSheet.create({
        data: {
          companyId,
          projectId,
          periodFrom: new Date('2026-08-01'),
          periodTo: new Date('2026-08-31'),
          engagementType: 'direct',
          // Only `approved`, `partially_disbursed` and `closed` are counted. A draft sheet is what
          // somebody is still working on, and the P&L must read what was approved for payment.
          status: 'approved',
          grossTotal: COST.labour,
          deductionTotal: 0,
          netTotal: COST.labour,
        },
        select: { id: true },
      })
    ).id;
    await sys.paymentSheetLine.create({
      data: {
        companyId,
        sheetId,
        workerId: unique('worker').slice(0, 30),
        daysWorked: 26,
        resolvedRate: COST.labour / 26,
        rateSource: 'project_rate',
        // Gross, not net. A deduction is money recovered from the worker, not money the project did
        // not spend — `bill-totals.ts` makes the same call about retention.
        grossWage: COST.labour,
        deductions: {},
        netPayable: COST.labour,
      },
    });
  }, 300_000);

  afterAll(async () => {
    const quiet = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* a fixture that was never created is not a cleanup failure */
      }
    };

    await quiet(() => sys.paymentSheetLine.deleteMany({ where: { sheetId } }));
    await quiet(() =>
      sys.labourPaymentSheet.deleteMany({ where: { id: sheetId } }),
    );
    await quiet(() => sys.fuelEntry.deleteMany({ where: { equipmentId } }));
    await quiet(() => sys.equipment.deleteMany({ where: { id: equipmentId } }));
    await quiet(() =>
      sys.equipmentCategory.deleteMany({ where: { id: categoryId } }),
    );
    await quiet(() => sys.purchase.deleteMany({ where: { siteId } }));
    await quiet(() => sys.rABill.deleteMany({ where: { projectId } }));
    await quiet(() =>
      sys.workOrderBOQItem.deleteMany({ where: { workOrderId } }),
    );
    await quiet(() => sys.workOrder.deleteMany({ where: { projectId } }));
    await quiet(() => sys.clientBill.deleteMany({ where: { projectId } }));
    await quiet(() => sys.bOQTaskItem.deleteMany({ where: { groupId } }));
    await quiet(() => sys.bOQTaskGroup.deleteMany({ where: { projectId } }));
    await quiet(() => sys.site.deleteMany({ where: { id: siteId } }));
    await quiet(() =>
      sys.project.deleteMany({
        where: { id: { in: [projectId, siblingProjectId] } },
      }),
    );
    await quiet(() => sys.client.deleteMany({ where: { id: clientId } }));
    await app.close();
  }, 240_000);

  const summary = () =>
    http()
      .get(
        `/projects/pnl?projectId=${projectId}&period=${PERIOD}&companyId=${companyId}`,
      )
      .set(auth())
      .expect(200);

  const drill = (figure: string, scope = 'month') =>
    http()
      .get(
        `/projects/pnl/drill-down?projectId=${projectId}&period=${PERIOD}` +
          `&figure=${figure}&scope=${scope}&companyId=${companyId}`,
      )
      .set(auth())
      .expect(200);

  describe('four cost categories, each answered by its own module (T034, FR-010)', () => {
    it('reads a real figure for subcontractors, materials, fuel and labour', async () => {
      const res = await summary();
      const by = Object.fromEntries(
        res.body.categories.map((row: { category: string }) => [
          row.category,
          row,
        ]),
      );

      // Each of these comes from a different module's own tables, through a source that module
      // registered on init. A zero here would mean the registration silently did not happen — and
      // the P&L would look complete while missing that category entirely.
      expect(by.subcontractors.monthly).toBe(subcontractorCost);
      expect(by.materials.monthly).toBe(COST.materials);
      expect(by.fuel.monthly).toBe(COST.fuel);
      expect(by.labour.monthly).toBe(COST.labour);
    });

    it('names the category nobody registered for rather than reporting it as zero', async () => {
      const res = await summary();

      // FR-010, and the single most consequential line in the service. "We could not ask" and
      // "nothing was spent" are different facts, and a director acts differently on each.
      expect(res.body.unavailableCategories).toContain('overheads');
      for (const answered of [
        'subcontractors',
        'materials',
        'fuel',
        'labour',
        'machinery',
      ]) {
        expect(res.body.unavailableCategories).not.toContain(answered);
      }
    });

    it('excludes the unavailable category from the cost total', async () => {
      const res = await summary();

      const counted = res.body.categories.filter(
        (row: { category: string }) =>
          !res.body.unavailableCategories.includes(row.category),
      );
      const summed =
        Math.round(
          counted.reduce(
            (total: number, row: { monthly: number }) => total + row.monthly,
            0,
          ) * 100,
        ) / 100;

      expect(res.body.costMonthly).toBe(summed);
      expect(res.body.costMonthly).toBe(
        Math.round(
          (subcontractorCost + COST.materials + COST.fuel + COST.labour) * 100,
        ) / 100,
      );
    });
  });

  describe('every figure traces to the records behind it (T034, FR-012)', () => {
    it('sums each drill-down total from the records it returns, not from a second query', async () => {
      const itemised: string[] = [];
      const totalOnly: string[] = [];
      for (const figure of [
        'revenue',
        'subcontractors',
        'materials',
        'fuel',
        'labour',
      ]) {
        const res = await drill(figure);
        expect(res.body.figure).toBe(figure);

        if (res.body.records === null) {
          // Allowed, but only with a reason — see the next case. Never silently.
          expect(res.body.unavailableReason).toBeTruthy();
          totalOnly.push(figure);
          continue;
        }
        itemised.push(figure);

        const summed =
          Math.round(
            res.body.records.reduce(
              (total: number, record: { amount: number }) =>
                total + record.amount,
              0,
            ) * 100,
          ) / 100;
        // A drill-down whose rows do not add up to its total is worse than no drill-down: it tells
        // the reader the number is wrong without telling them how, and from then on they check
        // everything by hand.
        expect(res.body.total).toBe(summed);
      }

      // What stops this passing by itemising nothing: every figure returning `null` would satisfy
      // the loop above without comparing a single total to a single row. Named because the same
      // shape of vacuous assertion shipped in `boq-workbook.reader.spec.ts` earlier the same day
      // and passed four times before anybody looked.
      //
      // Split by name rather than counted, because **which** figures itemise is itself the finding.
      // Three do. Materials and fuel answer with a period total and no breakdown: both read their
      // modules' per-site aggregates, which is what the registry interface asks of them, and the
      // drill-down says so with a reason instead of returning an empty list. That is the documented
      // behaviour, and writing it down here is how a change to it becomes visible.
      expect(itemised.sort()).toEqual(['labour', 'revenue', 'subcontractors']);
      expect(totalOnly.sort()).toEqual(['fuel', 'materials']);
    });

    it('gives every record a reference a person could look up, not an id', async () => {
      const res = await drill('subcontractors');
      expect(res.body.records.length).toBeGreaterThan(0);
      for (const record of res.body.records) {
        expect(typeof record.reference).toBe('string');
        expect(record.reference.length).toBeGreaterThan(0);
        expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
      }
    });

    it('distinguishes "cannot be itemised" from "nothing here"', async () => {
      const res = await drill('overheads');

      // `records: null` with a reason, never `[]` and never a total of 0 — a reader acts differently
      // on "no module answers for this" than on "nothing was spent".
      expect(res.body.records).toBeNull();
      expect(res.body.total).toBeNull();
      expect(res.body.unavailableReason).toBeTruthy();
    });

    it('points at labour’s own register rather than copying it in here', async () => {
      const res = await drill('labour');
      // A second copy of the per-worker register would be a second thing to keep in step with the
      // sheets. One request away is the right distance.
      expect(res.body.itemisedFurtherAt?.endpoint ?? '').toContain('labour');
    });

    it('refuses a figure that is not drillable rather than returning an empty one', async () => {
      await http()
        .get(
          `/projects/pnl/drill-down?projectId=${projectId}&period=${PERIOD}` +
            `&figure=profit&companyId=${companyId}`,
        )
        .set(auth())
        .expect(400);
    });
  });

  describe('revenue, and the three things it is not (FR-005, FR-015a)', () => {
    it('counts billed gross on bills out of draft, and says so on the response', async () => {
      const res = await summary();

      expect(res.body.revenueMonthly).toBe(revenueGross);
      // Said on the response rather than left to be discovered: a reader comparing this to the bank
      // will find a gap, and a figure somebody cannot reconcile is a figure they stop trusting.
      expect(res.body.revenueNote).toMatch(/gross|retention/i);
    });

    it('reports variation revenue as a part of revenue, never as an addition to it', async () => {
      const res = await summary();

      expect(res.body.revenueFromVariationsMonthly).toBeGreaterThan(0);
      expect(res.body.revenueFromVariationsMonthly).toBeLessThan(
        res.body.revenueMonthly,
      );
      // The distinction a director actually asks about: a project at 110% of contract value is doing
      // well if the extra is approved variations and in trouble if it is not.
      expect(
        Math.round(
          (res.body.revenueMonthly - res.body.revenueFromVariationsMonthly) *
            100,
        ) / 100,
      ).toBeGreaterThan(0);
    });

    it('keeps a certified shortfall apart from a bill nobody has certified yet', async () => {
      const res = await summary();

      // One is a dispute to pursue with the client; the other is a decision outstanding. Summing
      // them into a single "uncertified" figure would merge a disagreement with a queue.
      expect(res.body.revenueCertifiedShortfall).toBe(5000);
      expect(res.body.revenueAwaitingCertification).toBeGreaterThan(0);
    });
  });

  describe('the group board’s total is the sum of its rows (T054, research §7)', () => {
    it('adds up exactly, with no separately-derived aggregate', async () => {
      const res = await http()
        .get(
          `/projects/pnl/group?projectIds=${projectId},${siblingProjectId}` +
            `&period=${PERIOD}&companyId=${companyId}`,
        )
        .set(auth())
        .expect(200);

      expect(res.body.rows).toHaveLength(2);

      const sum = (field: string) =>
        Math.round(
          res.body.rows.reduce(
            (total: number, row: Record<string, number>) => total + row[field],
            0,
          ) * 100,
        ) / 100;

      // Exactly, not approximately. Pass 9 of the quickstart asks for this by hand for the same
      // reason: a board whose total is a rupee off its rows is a board nobody trusts again, and the
      // only way to guarantee it is to sum the rows rather than to ask the database twice.
      expect(res.body.totals.revenueCumulative).toBe(sum('revenueCumulative'));
      expect(res.body.totals.costCumulative).toBe(sum('costCumulative'));
    });

    it('reports the sibling project at zero without inventing costs for it', async () => {
      const res = await http()
        .get(
          `/projects/pnl/group?projectIds=${projectId},${siblingProjectId}` +
            `&period=${PERIOD}&companyId=${companyId}`,
        )
        .set(auth())
        .expect(200);

      const sibling = res.body.rows.find(
        (row: { projectId: string }) => row.projectId === siblingProjectId,
      );
      // It has no site, so no module can attribute anything to it. Zero is the right answer here —
      // and it is a different answer from `unavailableCategories`, which is about the source and
      // not about the project.
      expect(sibling.costCumulative).toBe(0);
      expect(sibling.revenueCumulative).toBe(0);
    });
  });

  describe('the month exports as a document (T053, FR-011a)', () => {
    it('produces a file that carries the instant it was made', async () => {
      const res = await http()
        .get(
          `/projects/pnl/export?projectId=${projectId}&period=${PERIOD}` +
            `&format=excel&companyId=${companyId}`,
        )
        .set(auth())
        .expect(200);

      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
      // The quickstart's edge case is a payment sheet reopened and re-approved after a month was
      // exported: without the production instant, the older document is indistinguishable from the
      // current position and somebody quotes it to a client.
      expect(res.headers['content-disposition']).toMatch(/\d/);
    });

    it('refuses a format it cannot produce rather than guessing one', async () => {
      await http()
        .get(
          `/projects/pnl/export?projectId=${projectId}&period=${PERIOD}` +
            `&format=csv&companyId=${companyId}`,
        )
        .set(auth())
        .expect(400);
    });
  });
});
