import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { SLOT_FINAL } from '../src/approvals/approval-slots';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { ExitClearanceService } from '../src/hr/offboarding/exit-clearance.service';

/**
 * A waived exit obligation clears only once the Director agrees (021 FR-016, T092).
 *
 * ## The three cases, and why the middle one is the point
 *
 * The task says it plainly: *"The middle case is the one that proves the wiring; the other two
 * prove it did not open a hole."* Before 2026-10-02 HR waived an obligation alone and the write
 * happened immediately. The client's answer made it a proposal the Director countersigns, which
 * means the write had to move out of `waive()` and into the approval's completion handler — and
 * the failure mode of that move is a waiver that is **both applied and awaiting approval**, which
 * is worse than either.
 *
 * So:
 *
 *   * **pending** — the clearance must come back still blocked. A waiver written at proposal time
 *     would clear the obligation before anybody agreed to it, and nothing on the screen would say
 *     so.
 *   * **approved** — it must clear. This is the wiring: the spine's event reaching this module's
 *     handler, resolving the final approver, and writing the waiver with both names on it.
 *   * **rejected** — it must stay blocked. The failure worth guarding against is a rejection that
 *     silently clears the item anyway, which looks like success to everybody except the company's
 *     balance sheet.
 *
 * ## Why an end-to-end test rather than a unit one
 *
 * `exit-clearance.service.spec.ts` already asserts that `waive()` writes no waiver row — the
 * structural half. What it cannot assert is that the clearance **recomputes** after the handler
 * runs: `settleable` is derived from the items and their waivers on every read, so the question
 * "does this exit settle now" has an answer only a database can give.
 *
 * Fixtures are prefixed `E2EXW` and removed in `afterAll`.
 */
const PREFIX = 'E2EXW';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Exit clearance waiver through the Director (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let clearance: ExitClearanceService;
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
  let employeeId: string;
  let hrToken = '';
  let directorRoleId = '';
  let directorUserId = '';

  const userIds: string[] = [];
  const roleIds: string[] = [];
  /**
   * One advance, waived three times over: refused, proposed again, then agreed.
   *
   * **Not two.** `SalaryAdvance` carries a unique constraint on `employeeId` — one open advance
   * per person — so the three cases run in sequence over the same obligation rather than in
   * parallel over two. That ordering is better anyway: refusal first, so the route back out of a
   * refusal is exercised rather than assumed, and the exit ends settled rather than half-cleared.
   */
  let advanceId = '';
  /** Instance ids, captured from the propose responses — see `propose`. */
  let firstProposalInstanceId = '';
  let secondProposalInstanceId = '';

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

  const makeActor = async (
    label: string,
    permissions: Permission[],
    chainRoleId?: string,
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
      data: { name: unique(`${label}Access`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    if (chainRoleId) {
      await sys.userRole.create({
        data: { userId: user.id, roleId: chainRoleId, companyId },
      });
    }

    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken };
  };

  /** An outstanding salary advance — the simplest obligation that blocks a settlement. */
  const outstandingAdvance = async (amount: number) => {
    const advance = await sys.salaryAdvance.create({
      data: {
        employeeId,
        amount,
        reason: `${PREFIX} advance`,
        recoveryMonth: '2026-09',
        outstandingBalance: amount,
        status: 'approved',
      },
    });
    return advance.id;
  };

  const ctxFor = () => ({ isSuperAdmin: false, companyId });

  const readClearance = async () =>
    clearance.forEmployee(ctxFor(), companyId, employeeId);

  /**
   * Re-reads until the condition holds, or gives up — because the waiver is written **after** the
   * decision responds.
   *
   * `decide()` emits on the event bus after its transaction commits, and the bus does not await
   * its listeners. So the HTTP response to an approval returns before this module's handler has
   * written the waiver. That is correct — a handler inside the transaction would apply a decision
   * a rollback then undid — but it has a consequence worth stating: **a screen that re-reads the
   * clearance the instant an approval returns may still see it blocked.** The window is
   * milliseconds, and it is real.
   *
   * Written as a bounded poll rather than a fixed sleep: a sleep long enough to be safe makes the
   * suite slow, and one short enough to be fast makes it flaky.
   */
  const eventually = async <T>(
    read: () => Promise<T>,
    holds: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 5_000;
    let last = await read();
    while (!holds(last) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = await read();
    }
    if (!holds(last)) {
      throw new Error(
        `${label} did not become true within 5s. Last value: ${JSON.stringify(
          last,
        )}`,
      );
    }
    return last;
  };

  /**
   * Proposes a waiver through the HTTP route a person uses, and returns the response.
   *
   * The approval instance id comes from **here**, not from the proposal row:
   * `ExitClearanceWaiverProposal` carries no reference to its approval item. The spine finds the
   * instance by `entityType` and `entityId`, and the proposal's id *is* the entity id — so the
   * link exists in one direction only, and the response is the one place the caller is told it.
   */
  const propose = async (advanceId: string) => {
    const res = await http()
      .post(`/hr/employees/${employeeId}/exit-clearance/waivers`)
      .set(auth(hrToken))
      .send({
        kind: 'salary_advance',
        ref: advanceId,
        reason: `${PREFIX}: written off, the employee is destitute`,
      })
      .expect(201);
    return res.body;
  };

  const decide = (instanceId: string, action: ApprovalDecisionAction) =>
    approvals.decide(
      {
        instanceId,
        action,
        reason:
          action === ApprovalDecisionAction.reject
            ? 'E2E: pursue it through the final settlement instead'
            : null,
      },
      asUser(directorUserId, [directorRoleId]),
      '127.0.0.1',
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalService);
    chains = app.get(ChainsService);
    clearance = app.get(ExitClearanceService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Exit Waiver Co`,
        shortCode: unique('XW').slice(0, 10),
        payrollLockDay: 31,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 18.5204,
        longitude: 73.8567,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });

    directorRoleId = (
      await sys.role.create({
        data: { name: unique('FinalSlot'), permissions: [] },
      })
    ).id;
    roleIds.push(directorRoleId);

    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      chains.seedDefaultsForCompany(companyId, tx, {
        superAdminRoleId: directorRoleId,
      }),
    );
    // Asserted rather than assumed: the whole suite rests on this slot resolving, and an unmapped
    // one refuses with `APPROVAL_SLOT_UNMAPPED` at the decision rather than at the setup — which
    // reads as a broken test rather than a broken fixture.
    const mapped = await chains.resolveSlot(
      { isSuperAdmin: true },
      companyId,
      SLOT_FINAL,
    );
    expect(mapped).toBe(directorRoleId);

    const hr = await makeActor('Hr', [
      Permission.PAYROLL,
      Permission.EMPLOYEES,
    ]);
    hrToken = hr.token;
    const director = await makeActor('Director', [], directorRoleId);
    directorUserId = director.userId;

    const leaver = await makeActor('Leaver', []);
    const employee = await sys.employee.create({
      data: {
        userId: leaver.userId,
        companyId,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode: unique('EMP').slice(0, 20),
        firstName: 'E2E',
        lastName: 'Leaver',
        dateOfJoining: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    employeeId = employee.id;

    await sys.exitRecord.create({
      data: {
        employeeId,
        lastWorkingDay: new Date(Date.UTC(2026, 8, 30)),
        reason: 'resignation',
        initiatedByUserId: hr.userId,
      },
    });

    advanceId = await outstandingAdvance(5000);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.exitClearanceWaiver.deleteMany({ where: { companyId } });
    await sys.exitClearanceWaiverProposal.deleteMany({ where: { companyId } });
    await sys.exitRecord.deleteMany({ where: { employeeId } });
    await sys.salaryAdvance.deleteMany({ where: { employeeId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.site.deleteMany({ where: { companyId } });
    await sys.shift.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    for (const id of userIds) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.user.deleteMany({ where: { id } });
    }
    for (const id of roleIds) {
      await sys.rolePermission.deleteMany({ where: { roleId: id } });
      await sys.role.deleteMany({ where: { id } });
    }
    await sys.company.deleteMany({ where: { id: companyId } });
  }, 120_000);

  it('starts blocked, and names the obligation that blocks it', async () => {
    // Vacuity: if the clearance were settleable here, every assertion below would pass for the
    // wrong reason.
    const before = await readClearance();
    expect(before.settleable).toBe(false);
    expect(
      before.items.filter((i) => i.outstanding).map((i) => i.ref),
    ).toContain(advanceId);

    await expect(
      clearance.assertSettleable(ctxFor(), companyId, employeeId),
    ).rejects.toMatchObject({
      response: { code: 'EXIT_CLEARANCE_OUTSTANDING' },
    });
  });

  it('stays blocked while the Director has the proposal in front of them', async () => {
    const { pending } = await propose(advanceId);
    expect(pending.state).toBe('pending');
    firstProposalInstanceId = pending.instanceId;

    // **The write must not have happened.** Checked at the table as well as through the clearance:
    // a waiver row written at proposal time is the specific risk the 2026-10-02 change introduced,
    // and the clearance would then read settleable with nobody having agreed to anything.
    const rows = await sys.exitClearanceWaiver.findMany({
      where: { companyId },
    });
    expect(rows).toEqual([]);

    const during = await readClearance();
    expect(during.settleable).toBe(false);
    const item = during.items.find((i) => i.ref === advanceId);
    expect(item?.outstanding).toBe(true);
    expect(item?.waiver).toBeNull();
  });

  it('refuses a second proposal for the same obligation while one is pending', async () => {
    // Not a hole: two pending proposals for one obligation would put the same decision to the
    // Director twice, and whichever was approved second would overwrite a reason already agreed.
    const res = await http()
      .post(`/hr/employees/${employeeId}/exit-clearance/waivers`)
      .set(auth(hrToken))
      .send({
        kind: 'salary_advance',
        ref: advanceId,
        reason: `${PREFIX}: a second, different reason`,
      });

    // A 409, not a 400: the request is well formed and the obligation exists — what is in the way
    // is a decision already in flight, which is a conflict with the current state rather than a
    // fault in what was sent.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXIT_WAIVER_ALREADY_PENDING');
  });

  it('stays blocked when the Director rejects, and the obligation survives', async () => {
    const decided = await decide(
      firstProposalInstanceId,
      ApprovalDecisionAction.reject,
    );
    expect(decided.state).toBe('rejected');

    // Read after the same window the approval case needs, so this is not passing merely because
    // the test got there first. A rejection that wrote a waiver asynchronously would clear the
    // item a moment later, and an immediate read would miss it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await readClearance();
    const item = after.items.find((i) => i.ref === advanceId);

    // **No waiver.** The failure this guards is a rejection that clears the item anyway, which
    // looks like success to everybody except the company's balance sheet.
    expect(item?.waiver).toBeNull();
    expect(item?.outstanding).toBe(true);
    expect(after.settleable).toBe(false);
    await expect(
      clearance.assertSettleable(ctxFor(), companyId, employeeId),
    ).rejects.toMatchObject({
      response: { code: 'EXIT_CLEARANCE_OUTSTANDING' },
    });
  });

  it('lets HR propose again after a refusal, rather than trapping the exit', async () => {
    // The route back, and it is the reason the rejection case runs first. A refused proposal left
    // `pending` for ever would make `EXIT_WAIVER_ALREADY_PENDING` permanent, and the exit could
    // then be neither settled nor waived — the same shape of trap found in feature 020's fuel
    // recovery on the same day. Here it is handled by reading the instance's state on the next
    // attempt rather than by an event, and this is what proves that path actually runs.
    const { pending } = await propose(advanceId);
    expect(pending.state).toBe('pending');
    secondProposalInstanceId = pending.instanceId;

    const proposals = await sys.exitClearanceWaiverProposal.findMany({
      where: { itemRef: advanceId },
      orderBy: { proposedAt: 'asc' },
    });
    expect(proposals).toHaveLength(2);
    expect(proposals[0].status).toBe('rejected');
    expect(proposals[1].status).toBe('pending');
  });

  it('clears the obligation once the Director approves — the wiring', async () => {
    const decided = await decide(
      secondProposalInstanceId,
      ApprovalDecisionAction.approve,
    );
    expect(decided.state).toBe('approved');

    const after = await eventually(
      readClearance,
      (c) => c.items.some((i) => i.ref === advanceId && i.waiver !== null),
      'the waiver reaching the clearance',
    );
    const item = after.items.find((i) => i.ref === advanceId);
    expect(item?.waiver).not.toBeNull();

    // Both names, which is the whole reason the client's answer changed this: "HR waived this" and
    // "HR asked and the Director agreed" are different facts, and collapsing them loses the one
    // the countersign exists to create.
    expect(item?.waiver?.waivedByName).toBeTruthy();
    expect(item?.waiver?.approvedByName).toBeTruthy();
    expect(item?.waiver?.waivedByName).not.toBe(item?.waiver?.approvedByName);

    // And the exit settles, which is the question only a database can answer: `settleable` is
    // derived from the items and their waivers on every read.
    expect(after.settleable).toBe(true);
    await expect(
      clearance.assertSettleable(ctxFor(), companyId, employeeId),
    ).resolves.toBeUndefined();
  });
});
