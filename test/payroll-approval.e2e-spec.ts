import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { SLOT_FIRST_APPROVER, SLOT_HR } from '../src/approvals/approval-slots';
import { ACTION_PAYROLL_RUN } from '../src/approvals/default-chains';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { BankSheetService } from '../src/payroll/runs/bank-sheet.service';
import { PayrollScheduleService } from '../src/payroll/runs/payroll-schedule.service';

/**
 * Payroll runs itself, then waits for the right people — spec US2 scenarios 1 to 6
 * (016 T040).
 *
 * The claim under test is that **a payroll run cannot reach money without three recorded
 * approvals**, and that the inputs cannot be quietly changed while it is being reviewed.
 * Those are the two places in this feature where an error costs real money.
 *
 * The scheduler is driven by calling `createRunsForPreviousPeriod` directly rather than
 * by waiting for a cron — deliberately, and the same choice `ReminderEvaluationCron`'s
 * tests make: a test that waits for a scheduler tests the scheduler, not the work.
 *
 * Every fixture is prefixed `E2EPA` and removed in `afterAll`.
 */
const PREFIX = 'E2EPA';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/**
 * Today's calendar date **in the business timezone**, which is the only clock the payroll lock
 * rule reads.
 *
 * Deriving a period in UTC instead is a mistake with a five-and-a-half-hour window and a
 * once-a-month consequence: between 18:30 and 24:00 UTC, IST is already tomorrow, and on the last
 * day of a month it is already *next month*. A period computed in UTC then lands two months
 * before the rule's "today" rather than one, and `isPayrollLocked` refuses anything two months
 * back whatever the lock day says. That is how the first attempt at this fix still failed —
 * correct on the 15th, wrong at 01:30 IST on the 1st.
 */
function businessToday(): { year: number; month: number; day: number } {
  // `en-CA` renders as YYYY-MM-DD, which is the shape the rest of this suite speaks.
  const [year, month, day] = new Date()
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    .split('-')
    .map(Number);
  return { year, month, day };
}

describe('Payroll approval chain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let schedule: PayrollScheduleService;
  let bankSheet: BankSheetService;
  let http: () => request.SuperTest<request.Test>;

  /**
   * Waits for a consequence that arrives on a later tick, and fails loudly if it never does.
   *
   * Used only where the system is genuinely asynchronous — the approval spine emits
   * completion fire-and-forget, so what a decision causes is not done when `decide` returns.
   * A fixed sleep would be either flaky or slow; polling to a deadline is neither, and a
   * timeout here is a real failure rather than a slow machine, because the work is in-process.
   */
  const eventually = async <T>(
    probe: () => Promise<T | null>,
    timeoutMs = 10_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await probe();
      if (result !== null) return result;
      if (Date.now() > deadline) {
        throw new Error(
          `Expected consequence did not arrive within ${timeoutMs}ms.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

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
  let siteId: string;
  let shiftId: string;
  let employeeId: string;

  const userIds: string[] = [];
  const roleIds: string[] = [];

  let siteRoleId: string;
  let hrRoleId: string;
  let finalRoleId: string;

  let siteUser: { userId: string; token: string };
  let hrUser: { userId: string; token: string };
  let directorUser: { userId: string; token: string };

  /** The period the scheduler will draw up, given `whenItFires` below. */
  let period: string;
  /**
   * 00:30 IST on the first of the **current** month, so the scheduler draws up last month.
   *
   * This was a fixed instant — `2026-08-31T19:00:00Z` — with a comment saying it was fixed so
   * the test would not change behaviour depending on the day it runs. It achieved the reverse.
   * Pinning the fixture while the clock moves means the gap between them grows, and the day the
   * gap passed two months `isPayrollLocked` began refusing every attendance edit in the suite:
   * its rule is that anything two or more months back is locked whatever the lock day says. Nine
   * tests across two files failed on 1 October having passed on 30 September, for no reason
   * connected to the code.
   *
   * Derived from `now` instead, the period under test is always *last* month — which the
   * fixture's `payrollLockDay: 31` keeps open, and which is the case the scheduler actually
   * handles in production.
   */
  const whenItFires = (() => {
    const { year, month } = businessToday();
    // Day 0 of this month is the last day of the previous one; 19:00 UTC is 00:30 IST next day.
    return new Date(Date.UTC(year, month - 1, 0, 19, 0, 0));
  })();

  /** `YYYY-MM` for the month before `whenItFires` fires — what the scheduler will draw. */
  const periodItDraws = (() => {
    const { year, month } = businessToday();
    const previous = new Date(Date.UTC(year, month - 2, 1));
    return `${previous.getUTCFullYear()}-${String(
      previous.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
  })();

  const asUser = (id: string, holds: string[]): AuthenticatedUser =>
    ({
      id,
      companyId,
      permissions: [Permission.PAYROLL, Permission.ATTENDANCE],
      roleNames: [],
      roleIds: holds,
      status: 'active',
      email: `${id}@example.test`,
      username: id,
      displayName: null,
      firstname: null,
      lastname: null,
    } as unknown as AuthenticatedUser);

  const callerFor = (id: string, holds: string[]) => ({
    userId: id,
    companyId,
    ipAddress: '127.0.0.1',
    rls: { isSuperAdmin: false, companyId },
    roleIds: holds,
  });

  const makeUser = async (
    label: string,
    chainRoleId: string | null,
    permissions: Permission[],
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

    const accessRole = await sys.role.create({
      data: { name: unique(`${label}Access`), permissions },
    });
    roleIds.push(accessRole.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: accessRole.id, companyId },
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

  const runForPeriod = () =>
    sys.payrollRun.findFirst({ where: { companyId, period, isFnf: false } });

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
    schedule = app.get(PayrollScheduleService);
    bankSheet = app.get(BankSheetService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'E2E Payroll Approval Co',
        shortCode: unique('PA').slice(0, 10),
        // 31 so the pre-existing payroll lock-day rule never fires and mask what these
        // tests are actually about.
        payrollLockDay: 31,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
        // Added 2026-10-04. Scenario 5 builds a bank transfer sheet, and `BankSheetService`
        // refuses the whole file when the company has no debit account on file — correctly:
        // every row names the account the money leaves from, and a sheet with that column
        // blank is one the bank cannot act on. This company predates that rule, so the test
        // was failing on a refusal that is right, for a fixture that was incomplete.
        payrollDebitAccountNumber: '00112233445566',
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
    siteId = site.id;

    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    shiftId = shift.id;

    const employeeUser = await sys.user.create({
      data: {
        email: `${unique('Emp')}@example.test`.toLowerCase(),
        username: unique('Emp'),
        companyId,
        status: 'active',
      },
    });
    userIds.push(employeeUser.id);

    const employee = await sys.employee.create({
      data: {
        userId: employeeUser.id,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('E').slice(0, 20),
        firstName: 'Sneha',
        lastName: 'Iyer',
        dateOfJoining: new Date('2026-01-01'),
      },
    });
    employeeId = employee.id;

    for (const label of ['Site', 'Hr', 'Final'] as const) {
      const role = await sys.role.create({
        data: { name: unique(`Chain${label}`), permissions: [] },
      });
      roleIds.push(role.id);
      if (label === 'Site') siteRoleId = role.id;
      if (label === 'Hr') hrRoleId = role.id;
      if (label === 'Final') finalRoleId = role.id;
    }

    const setup = await makeUser('Setup', null, [Permission.PAYROLL]);
    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: setup.userId, ipAddress: '127.0.0.1' };

    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      chains.seedDefaultsForCompany(companyId, tx, {
        superAdminRoleId: finalRoleId,
      }),
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_FIRST_APPROVER, roleId: siteRoleId },
      actor,
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_HR, roleId: hrRoleId },
      actor,
    );

    siteUser = await makeUser('SiteIncharge', siteRoleId, [
      Permission.PAYROLL,
      Permission.ATTENDANCE,
    ]);
    hrUser = await makeUser('HrOffice', hrRoleId, [
      Permission.PAYROLL,
      Permission.ATTENDANCE,
    ]);
    directorUser = await makeUser('Director', finalRoleId, [
      Permission.PAYROLL,
    ]);

    period = periodItDraws;
  }, 90_000);

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.attendanceModification.deleteMany({ where: { employeeId } });
    await sys.punchRecord.deleteMany({ where: { employeeId } });
    await sys.payrollLineItem.deleteMany({ where: {} }).catch(() => undefined);
    await sys.payrollRun.deleteMany({ where: { companyId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.shift.deleteMany({ where: { id: shiftId } });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 90_000);

  it('scenario 1 — the schedule draws up the previous period and it is awaiting the first level', async () => {
    const result = await schedule.createRunsForPreviousPeriod(whenItFires);

    expect(result.period).toBe(period);
    expect(result.created).toContain(companyId);

    const run = await runForPeriod();
    expect(run).toBeTruthy();
    // Distinguishable from a run somebody created by hand — which matters, because the
    // production instance may be suspended when the cron is due.
    expect(run.createdBySchedule).toBe(true);

    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(state).toMatchObject({
      state: 'pending',
      currentPosition: 1,
      totalLevels: 3,
      levelLabel: 'Site Incharge',
      // Nobody raised it — and it does not pretend somebody did.
      originatorUserId: null,
      originatorName: 'The system',
    });
  }, 60_000);

  it('scenario 6 — firing again creates no duplicate', async () => {
    const before = await sys.payrollRun.count({
      where: { companyId, period, isFnf: false },
    });

    const result = await schedule.createRunsForPreviousPeriod(whenItFires);
    expect(result.alreadyPresent).toContain(companyId);
    expect(result.created).not.toContain(companyId);

    const after = await sys.payrollRun.count({
      where: { companyId, period, isFnf: false },
    });
    expect(after).toBe(before);
    expect(after).toBe(1);
  }, 60_000);

  it('scenario 2 — a bank transfer sheet is refused, naming the outstanding level', async () => {
    const run = await runForPeriod();

    const error = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);

    expect(error.response.code).toBe('PAYROLL_RUN_NOT_APPROVED');
    // Naming the level is the difference between "go and find out whose desk this is on"
    // and "go to the site in-charge".
    expect(error.response.message).toContain('Site Incharge');
  }, 60_000);

  it('scenario 3 — a non-HR user cannot edit attendance for the period under review', async () => {
    const res = await http()
      .post('/hr/attendance')
      .set(auth(siteUser.token))
      .send({ employeeId, date: `${period}-12`, inTime: '09:05' })
      .expect(403);

    expect(res.body.code).toBe('ATTENDANCE_UNDER_PAYROLL_REVIEW');
    expect(res.body.message).toMatch(/Only HR may edit/);
  }, 60_000);

  it('scenario 2b — the sheet stays refused after the first level approves', async () => {
    const run = await runForPeriod();
    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );

    await approvals.decide(
      { instanceId: state.instanceId, action: ApprovalDecisionAction.approve },
      asUser(siteUser.userId, [siteRoleId]),
      '127.0.0.1',
    );

    const error = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);

    expect(error.response.code).toBe('PAYROLL_RUN_NOT_APPROVED');
    expect(error.response.message).toContain('HR Office');
  }, 60_000);

  /**
   * FR-016 and FR-017 together, as they behave once corrections travel a chain of their own
   * (016 Phase 8).
   *
   * **What changed, and why the assertion moved.** `POST /hr/attendance` used to apply the
   * edit on the spot, so the payroll chain restarted the moment HR pressed save. It now
   * raises the correction into its own Site → HR → Director chain, which means that at
   * submission time *the attendance has not changed* — and so the approvers' figures still
   * hold, and voiding their approvals then would be wrong. A correction that is later
   * rejected must not have cost a payroll run its approvals.
   *
   * The void still happens; it happens at the moment it becomes true, which is application.
   * That is what the second half of this test pins down, and it is the property that
   * actually protects the money: no run reaches a bank sheet on figures that have since
   * been corrected.
   */
  it('scenario 4 — a correction voids the approvals when it is applied, not when it is asked for', async () => {
    const run = await runForPeriod();

    const before = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(before.currentPosition).toBe(2); // the site in-charge approved above

    const submitted = await http()
      .post('/hr/attendance')
      .set(auth(hrUser.token))
      .send({ employeeId, date: `${period}-12`, inTime: '09:05' })
      .expect(201);

    // Pending, not applied — so the run's approvers have nothing to re-approve yet.
    const whilePending = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(whilePending.currentPosition).toBe(2);
    expect(whilePending.instanceId).toBe(before.instanceId);

    // Now walk the correction's own chain to completion. Its instance id comes from the
    // submission response — the route answers with the item it raised, which is the only
    // handle a caller has on a correction that has not been applied yet.
    const correctionInstanceId = submitted.body.approvalInstanceId;
    expect(correctionInstanceId).toBeTruthy();
    for (const [userId, roleId] of [
      [siteUser.userId, siteRoleId],
      [hrUser.userId, hrRoleId],
      [directorUser.userId, finalRoleId],
    ] as const) {
      await approvals.decide(
        {
          instanceId: correctionInstanceId,
          action: ApprovalDecisionAction.approve,
        },
        asUser(userId, [roleId]),
        '127.0.0.1',
      );
    }

    // **Eventual, and deliberately awaited here rather than assumed.** The spine announces
    // completion fire-and-forget, so a correction is applied — and the payroll chain voided —
    // on a later tick than the decision that approved it. The old version of this test could
    // assert immediately because the edit and the void happened inside the request; now they
    // do not, and a test that read the state once would pass or fail on timing.
    const after = await eventually(async () => {
      const state = await approvals.stateOfSystem(
        ACTION_PAYROLL_RUN,
        run.id,
        companyId,
      );
      // The restart is a new instance, which is the signal that the void has landed.
      if (state.instanceId === before.instanceId) return null;
      return state;
    });
    expect(after.state).toBe('pending');
    // Back to level 1: the approval already given was to figures that no longer hold.
    expect(after.currentPosition).toBe(1);
    expect(after.instanceId).not.toBe(before.instanceId);
  }, 60_000);

  it('scenario 5 — the sheet is produced once every level has approved', async () => {
    const run = await runForPeriod();

    for (const [userId, roleId] of [
      [siteUser.userId, siteRoleId],
      [hrUser.userId, hrRoleId],
      [directorUser.userId, finalRoleId],
    ] as const) {
      const state = await approvals.stateOfSystem(
        ACTION_PAYROLL_RUN,
        run.id,
        companyId,
      );
      await approvals.decide(
        {
          instanceId: state.instanceId,
          action: ApprovalDecisionAction.approve,
        },
        asUser(userId, [roleId]),
        '127.0.0.1',
      );
    }

    const final = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(final.state).toBe('approved');

    const sheet = await bankSheet.build(
      callerFor(directorUser.userId, [finalRoleId]) as never,
      run.id,
    );
    expect(sheet.filename).toContain(period);
    expect(sheet.buffer.length).toBeGreaterThan(0);

    // All three approvers are named, in order (FR-002, SC-002).
    const history = await approvals.historyOf(
      ACTION_PAYROLL_RUN,
      run.id,
      asUser(directorUser.userId, [finalRoleId]),
    );
    expect(history.map((h) => h.actorUserId)).toEqual([
      siteUser.userId,
      hrUser.userId,
      directorUser.userId,
    ]);
    expect(history.map((h) => h.levelLabel)).toEqual([
      'Site Incharge',
      'HR Office',
      'Director',
    ]);
  }, 60_000);

  it('lets attendance be edited again once the run is approved', async () => {
    // The lock is scoped to a period under *review*. Once the chain is complete it no
    // longer applies — a correction after approval is a different problem, governed by
    // the payroll lock day.
    await http()
      .post('/hr/attendance')
      .set(auth(siteUser.token))
      .send({ employeeId, date: `${period}-13`, inTime: '09:10' })
      .expect(201);
  }, 60_000);
});
