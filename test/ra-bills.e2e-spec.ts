import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ACTION_RA_BILL } from '../src/approvals/default-chains';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Subcontractor bills measured against a work order's award (018 T020, T024, T041).
 *
 * ## Why these three stayed open
 *
 * Each carried a note naming data that did not exist: *"needs a seeded work order and three issued
 * bills"*, *"needs a seeded project and a submitted bill"*. Work orders became writable when 018
 * shipped and the BOQ became writable on 2026-10-03, so a project with a schedule, an award against
 * it and a run of bills is constructible for the first time.
 *
 * ## The three things only a database shows
 *
 *   * **To-date quantity as an aggregate** (T020). Summed over sibling bill lines, so the second
 *     bill's remaining figure is wrong in a way no single-bill test can see.
 *   * **A completed approval surviving a revision** (T024). The spine's rule is that a recorded
 *     decision is never edited — it describes what somebody approved. Asserting that needs a real
 *     instance, a real decision row, and a revision on top of them.
 *   * **The retention balance** (T041). Withheld is an aggregate over bills that have left draft and
 *     released is an aggregate over the ledger; the refusal that matters reads both inside the same
 *     transaction that writes.
 *
 * Fixtures are prefixed `E2E` and removed in `afterAll`.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

jest.setTimeout(180_000);

describe('RA bills against an award (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId = '';
  let callerUserId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let clientId = '';
  let projectId = '';
  let workOrderId = '';
  /** Award lines, by description. */
  const awarded: Record<string, { id: string; rate: number; qty: number }> = {};

  /** The role this suite maps to the `final` slot so an approval can actually complete. */
  let probeRoleId = '';
  /** True when this suite created the slot mapping and must therefore remove it. */
  let mappedSlotHere = false;
  /** Set only when this suite created a role, so only a role it created is ever deleted. */
  let createdRoleId = '';

  const RETENTION = 0.05;

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

  /** An authenticated caller as `request.user` would carry it, holding the given roles. */
  const asUser = (id: string, holds: string[]): AuthenticatedUser =>
    ({
      id,
      companyId,
      permissions: [],
      roleNames: [],
      roleIds: holds,
      displayName: null,
      firstname: 'E2E',
      lastname: 'Director',
      username: id,
      email: `${id}@example.test`,
      status: 'active',
    } as unknown as AuthenticatedUser);

  const raBillIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalService);
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
      .send({ name: unique('RaClient') })
      .expect(201);
    clientId = client.body.id;
    // Read back, not chosen — see the note in `client-bills.e2e-spec.ts`.
    companyId = client.body.companyId;

    const me = await sys.user.findFirst({
      where: { email: 'admin@buildcore.dev' },
      select: { id: true },
    });
    callerUserId = me.id;

    // Created directly for the reason `client-bills.e2e-spec.ts` gives: 017 refuses project creation
    // until every mandatory document kind is attached, which is item 3 working as asked and not the
    // path this suite is about.
    projectId = (
      await sys.project.create({
        data: {
          companyId,
          code: unique('RAP').slice(0, 40),
          name: unique('RaProject'),
          clientId,
          contractValue: 2000000,
          startDate: new Date('2026-07-01'),
        },
        select: { id: true },
      })
    ).id;

    const order = await http()
      .post(`/projects/work-orders?companyId=${companyId}`)
      .set(auth())
      .send({
        projectId,
        workDetail: 'RCC works — blocks A to C',
        retentionPercent: RETENTION,
      })
      .expect(201);
    workOrderId = order.body.id;

    const lines = [
      { description: 'Excavation', unit: 'Cum', awardedQty: 100, rate: 200 },
      { description: 'PCC 1:4:8', unit: 'Cum', awardedQty: 40, rate: 4500 },
      { description: 'Reinforcement', unit: 'Kg', awardedQty: 2000, rate: 72 },
    ];
    const award = await http()
      .put(`/projects/ra-bills/awards/${workOrderId}?companyId=${companyId}`)
      .set(auth())
      .send({ lines })
      .expect(200);

    for (const line of award.body.lines ?? award.body) {
      awarded[line.description] = {
        id: line.id,
        rate: line.rate,
        qty: line.awardedQty,
      };
    }

    // The `ra_bill` chain has one level, on the `final` slot, so `decide` admits exactly whoever
    // holds the role that slot maps to — and refuses with `APPROVAL_SLOT_UNMAPPED` when nothing is
    // mapped. The seeded companies map `final` to Super Admin, so this reads the existing mapping
    // and uses it. Only if there is none does it create a role and map one, and then it removes
    // both afterwards: overwriting a real mapping would leave a company's chains pointing at a role
    // this suite deleted.
    //
    // The first draft created the role unconditionally and deleted it only in the branch that also
    // made the mapping, so every run leaked a role into `settings.Role`. Five of them, before the
    // leftovers were counted.
    const existing = await sys.roleSlotMapping.findUnique({
      where: { companyId_slotKey: { companyId, slotKey: 'final' } },
    });
    if (existing) {
      probeRoleId = existing.roleId;
    } else {
      createdRoleId = (
        await sys.role.create({
          data: { name: unique('RaBillDirectorRole'), permissions: [] },
          select: { id: true },
        })
      ).id;
      probeRoleId = createdRoleId;
      await sys.roleSlotMapping.create({
        data: { companyId, slotKey: 'final', roleId: probeRoleId },
      });
      mappedSlotHere = true;
    }
  }, 240_000);

  afterAll(async () => {
    // Approvals first: an instance points at the company, and its decisions at the instance.
    await sys.approvalDecision
      .deleteMany({
        where: {
          approvalInstance: {
            entityType: ACTION_RA_BILL,
            entityId: { in: raBillIds },
          },
        },
      })
      .catch(() => undefined);
    await sys.approvalInstance
      .deleteMany({
        where: { entityType: ACTION_RA_BILL, entityId: { in: raBillIds } },
      })
      .catch(() => undefined);

    if (mappedSlotHere) {
      await sys.roleSlotMapping
        .deleteMany({ where: { companyId, slotKey: 'final' } })
        .catch(() => undefined);
    }
    if (createdRoleId) {
      await sys.role
        .deleteMany({ where: { id: createdRoleId } })
        .catch(() => undefined);
    }

    await sys.rABill
      .deleteMany({ where: { projectId } })
      .catch(() => undefined);
    await sys.workOrderBOQItem
      .deleteMany({ where: { workOrderId } })
      .catch(() => undefined);
    await sys.retentionRelease
      .deleteMany({ where: { workOrderId } })
      .catch(() => undefined);
    await sys.workOrder
      .deleteMany({ where: { projectId } })
      .catch(() => undefined);
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    await app.close();
  }, 180_000);

  let counter = 0;
  const billNumber = () =>
    `SC-${String((counter += 1)).padStart(2, '0')}-${Date.now() % 10000}`;

  async function compose(
    body: Record<string, unknown>,
    expectStatus = 201,
  ): Promise<request.Response> {
    const res = await http()
      .post(`/projects/ra-bills?companyId=${companyId}`)
      .set(auth())
      .send({
        projectId,
        workOrderId,
        billingDate: '2026-08-21',
        ...body,
      })
      .expect(expectStatus);
    if (res.body?.id) raBillIds.push(res.body.id);
    return res;
  }

  const submit = (id: string, expectStatus = 201) =>
    http()
      .post(`/projects/ra-bills/${id}/submit`)
      .set(auth())
      .expect(expectStatus);

  const retention = () =>
    http()
      .get(`/projects/ra-bills/retention/${workOrderId}`)
      .set(auth())
      .expect(200);

  describe('the award this bills against (FR-006)', () => {
    it('holds the subcontractor’s own rates, not the client’s', async () => {
      const res = await http()
        .get(`/projects/ra-bills/awards/${workOrderId}`)
        .set(auth())
        .expect(200);

      const lines = res.body.lines ?? res.body;
      expect(lines).toHaveLength(3);
      // The whole reason `WorkOrderBOQItem` exists as a separate table: the margin between this rate
      // and the client's BOQ rate for the same work is what the project P&L shows. One rate column
      // would make that margin unrepresentable.
      expect(awarded['PCC 1:4:8'].rate).toBe(4500);
    });
  });

  describe('two bills against one award (T020, FR-007)', () => {
    let firstId = '';

    it('measures the first bill and counts its remaining quantity down', async () => {
      const first = await compose({
        billNumber: billNumber(),
        lines: [
          { workOrderBoqItemId: awarded['Excavation'].id, quantity: 60 },
          { workOrderBoqItemId: awarded['PCC 1:4:8'].id, quantity: 10 },
        ],
      });
      firstId = first.body.id;

      const excavation = first.body.lines.find(
        (line: { description: string }) => line.description === 'Excavation',
      );
      expect(excavation.thisPeriodQty).toBe(60);
      expect(excavation.toDateQty).toBe(60);
      expect(excavation.remainingQty).toBe(40);
      expect(excavation.amount).toBe(60 * 200);

      // Gross is cost, net is cash. Named separately on the view so the P&L cannot reach for the
      // field that looks most like "the amount" and understate the project by every deduction.
      expect(first.body.pnlAmount).toBe(first.body.grossAmount);
      expect(first.body.retentionAmount).toBe(
        Math.round(first.body.grossAmount * RETENTION * 100) / 100,
      );
      expect(first.body.netPayable).toBeLessThan(first.body.grossAmount);
    });

    /**
     * 027. The reason exists for whoever decides the bill a *second* time, so a draft — decided by
     * nobody — must not demand one. Sends the quantities back unchanged, so this proves the gate
     * without moving the figures the next test reads.
     *
     * Not vacuous: this was a 400 from the DTO before `reason` became optional, and it is still a
     * 400 on a submitted bill — the test at `refuses a revision with no reason given` holds that
     * side and would start failing if the requirement were simply dropped.
     */
    it('revises a draft with no reason given, because nobody has decided it yet', async () => {
      const revised = await http()
        .patch(`/projects/ra-bills/${firstId}/lines?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            { workOrderBoqItemId: awarded['Excavation'].id, quantity: 60 },
            { workOrderBoqItemId: awarded['PCC 1:4:8'].id, quantity: 10 },
          ],
        })
        .expect(200);

      expect(revised.body.status).toBe('draft');
      const excavation = revised.body.lines.find(
        (line: { description: string }) => line.description === 'Excavation',
      );
      expect(excavation.thisPeriodQty).toBe(60);
    });

    it('carries the first bill’s quantity into the second, once the first has left draft', async () => {
      await submit(firstId);

      const second = await compose({
        billNumber: billNumber(),
        lines: [{ workOrderBoqItemId: awarded['Excavation'].id, quantity: 25 }],
      });

      const line = second.body.lines[0];
      expect(line.thisPeriodQty).toBe(25);
      // The assertion this task exists for. To-date is summed over sibling rows each time rather
      // than stored, so it cannot drift after a bill is revised or deleted — and it needs a sibling
      // to be wrong about, which is why no unit test could see it.
      expect(line.toDateQty).toBe(85);
      expect(line.remainingQty).toBe(15);
    });

    it('refuses a measurement past the award rather than flagging it', async () => {
      // The opposite call from the client side, and deliberately so: a client BOQ over-measurement
      // is a claim to justify, while measuring more than a subcontractor was awarded is work nobody
      // agreed to pay for. The remedy is a variation on the award, not a reason on the bill.
      const res = await compose(
        {
          billNumber: billNumber(),
          lines: [
            { workOrderBoqItemId: awarded['Excavation'].id, quantity: 90 },
          ],
        },
        400,
      );
      expect(res.body.code).toBe('RA_BILL_EXCEEDS_AWARD');
    });
  });

  describe('approve, then revise (T024, FR-009)', () => {
    // `RaBillStatus` is `draft | submitted | approved` — there is no `certified` state on an RA
    // bill, and the first draft of this suite asserted one. The client-side bill has `certified`
    // because a *client* certifies what they will pay; a subcontractor's bill is approved
    // internally, by the chain. Two different acts, deliberately two different words.
    let billId = '';
    let decisionId = '';
    let completedInstanceId = '';
    let grossAtApproval = 0;

    it('approves the bill when the chain completes, and not before', async () => {
      const draft = await compose({
        billNumber: billNumber(),
        lines: [
          { workOrderBoqItemId: awarded['Reinforcement'].id, quantity: 500 },
        ],
      });
      billId = draft.body.id;
      grossAtApproval = draft.body.grossAmount;

      const submitted = await submit(billId);
      // Submitting enters the chain. **Nothing is approved here** — a bill flipped to a decided
      // state by its own endpoint would be a bill waiting on nobody that reads as submitted.
      expect(submitted.body.status).toBe('submitted');

      const state = await approvals.stateOfSystem(
        ACTION_RA_BILL,
        billId,
        companyId,
      );
      expect(state).not.toBeNull();
      completedInstanceId = String(state?.instanceId);

      const decided = await approvals.decide(
        {
          instanceId: completedInstanceId,
          action: ApprovalDecisionAction.approve,
          reason: 'E2E: measured quantities verified against the joint survey',
        },
        asUser(callerUserId, [probeRoleId]),
        '127.0.0.1',
      );
      expect(decided.state).toBe('approved');

      const afterApproval = await http()
        .get(`/projects/ra-bills/${billId}`)
        .set(auth())
        .expect(200);
      // `onApprovalCompleted` is what moves it — the spine decides, the module records.
      expect(afterApproval.body.status).toBe('approved');
      expect(afterApproval.body.approvedByUserId ?? callerUserId).toBe(
        callerUserId,
      );

      const decisions = await sys.approvalDecision.findMany({
        where: { approvalInstanceId: completedInstanceId },
      });
      expect(decisions).toHaveLength(1);
      decisionId = decisions[0].id;
    });

    it('refuses a revision with no reason given', async () => {
      const res = await http()
        .patch(`/projects/ra-bills/${billId}/lines?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            { workOrderBoqItemId: awarded['Reinforcement'].id, quantity: 400 },
          ],
          reason: '',
        })
        .expect(400);
      // 400 from the DTO or the service; either way the reason is not optional. "Why did this bill
      // change" is the first question the second approver asks.
      expect(String(JSON.stringify(res.body))).toMatch(/reason|REASON/i);
    });

    it('leaves the completed decision exactly as it was and raises a NEW approval', async () => {
      const revised = await http()
        .patch(`/projects/ra-bills/${billId}/lines?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            { workOrderBoqItemId: awarded['Reinforcement'].id, quantity: 400 },
          ],
          reason: 'Re-measured after joint survey on 3 Oct; 400 Kg not 500.',
        })
        .expect(200);

      expect(revised.body.lines[0].thisPeriodQty).toBe(400);
      expect(revised.body.grossAmount).toBe(400 * 72);
      expect(revised.body.grossAmount).toBeLessThan(grossAtApproval);

      // **The decision row is untouched.** 016's chain records what was approved; editing
      // quantities under a completed approval would leave an approver's name against numbers they
      // never saw. The instance stays as history and a new one is raised instead.
      const survivor = await sys.approvalDecision.findFirst({
        where: { id: decisionId },
      });
      expect(survivor).not.toBeNull();
      expect(survivor.approvalInstanceId).toBe(completedInstanceId);
      expect(survivor.action).toBe('approve');
      expect(survivor.reason).toMatch(/joint survey/);

      const old = await sys.approvalInstance.findFirst({
        where: { id: completedInstanceId },
      });
      expect(old.state).toBe('approved');

      // And the prior approval does not survive as *authority*: the bill is waiting on somebody
      // again, on a fresh instance, and is no longer approved.
      const live = await approvals.stateOfSystem(
        ACTION_RA_BILL,
        billId,
        companyId,
      );
      expect(live).not.toBeNull();
      expect(live?.instanceId).not.toBe(completedInstanceId);
      expect(live?.state).toBe('pending');

      const reread = await http()
        .get(`/projects/ra-bills/${billId}`)
        .set(auth())
        .expect(200);
      expect(reread.body.status).not.toBe('approved');
    });
  });

  describe('retention across three bills, released in part (T041, FR-016a)', () => {
    it('withholds only from bills that have left draft', async () => {
      const before = await retention();
      const withheldBefore = before.body.withheld;

      const draft = await compose({
        billNumber: billNumber(),
        lines: [
          { workOrderBoqItemId: awarded['Reinforcement'].id, quantity: 100 },
        ],
      });
      expect(draft.body.retentionAmount).toBeGreaterThan(0);

      const after = await retention();
      // A draft is a working document and its retention has been withheld from nobody. Counting it
      // would let somebody release money against a bill that may never be issued.
      expect(after.body.withheld).toBe(withheldBefore);

      await submit(draft.body.id);
      const submitted = await retention();
      expect(submitted.body.withheld).toBe(
        Math.round((withheldBefore + draft.body.retentionAmount) * 100) / 100,
      );
    });

    it('accumulates across every issued bill and reconciles to the ledger', async () => {
      const ledger = await retention();
      expect(ledger.body.retentionPercent).toBe(RETENTION);

      const issued = await sys.rABill.findMany({
        where: { workOrderId, status: { not: 'draft' } },
        select: { retentionAmount: true },
      });
      // At least three bills have left draft by now — two from T020, one from T024, one above.
      expect(issued.length).toBeGreaterThanOrEqual(3);

      const summed =
        Math.round(
          issued.reduce(
            (total: number, bill: { retentionAmount: unknown }) =>
              total + Number(bill.retentionAmount),
            0,
          ) * 100,
        ) / 100;
      expect(ledger.body.withheld).toBe(summed);
      expect(ledger.body.outstanding).toBe(
        Math.round((ledger.body.withheld - ledger.body.released) * 100) / 100,
      );
    });

    it('refuses a release with no reason, and one past what is held', async () => {
      const ledger = await retention();

      const noReason = await http()
        .post(
          `/projects/ra-bills/retention/${workOrderId}/release?companyId=${companyId}`,
        )
        .set(auth())
        .send({ amount: 1, releasedOn: '2026-10-01', reason: '  ' })
        .expect(400);
      expect(String(JSON.stringify(noReason.body))).toMatch(/reason|REASON/i);

      const tooMuch = await http()
        .post(
          `/projects/ra-bills/retention/${workOrderId}/release?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          amount: Math.round((ledger.body.outstanding + 1) * 100) / 100,
          releasedOn: '2026-10-01',
          reason: 'E2E: more than was ever held',
        })
        .expect(400);
      // The one refusal this whole ledger exists for. Money the company never held, paid out as
      // though it had been — and nothing downstream would catch it: the bills it was withheld from
      // are closed, and a subcontractor does not query a payment in their favour.
      expect(tooMuch.body.code).toBe('RETENTION_EXCEEDS_HELD');
    });

    it('releases part and leaves the balance correct', async () => {
      const before = await retention();
      const part = Math.round(before.body.outstanding * 0.4 * 100) / 100;

      const after = await http()
        .post(
          `/projects/ra-bills/retention/${workOrderId}/release?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          amount: part,
          releasedOn: '2026-10-01',
          reason: 'E2E: half at practical completion, per clause 14',
        })
        .expect(201);

      expect(after.body.released).toBe(part);
      expect(after.body.outstanding).toBe(
        Math.round((before.body.withheld - part) * 100) / 100,
      );
      expect(after.body.releases).toHaveLength(1);
      expect(after.body.releases[0].reason).toMatch(/clause 14/);

      // Append-only. A second release adds a row rather than editing the first, because the row IS
      // the evidence that money moved.
      const second = await http()
        .post(
          `/projects/ra-bills/retention/${workOrderId}/release?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          amount: 1,
          releasedOn: '2026-10-02',
          reason: 'E2E: a token second release, to show the ledger appends',
        })
        .expect(201);
      expect(second.body.releases).toHaveLength(2);
      expect(second.body.released).toBe(Math.round((part + 1) * 100) / 100);
      expect(second.body.outstanding).toBe(
        Math.round((before.body.withheld - part - 1) * 100) / 100,
      );
    });
  });
});
