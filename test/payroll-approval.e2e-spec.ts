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

describe('Payroll approval chain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let schedule: PayrollScheduleService;
  let bankSheet: BankSheetService;
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
  /** Fixed so the test does not change behaviour depending on the day it runs. */
  const whenItFires = new Date('2026-08-31T19:00:00Z'); // 1 Sep 00:30 IST

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

    period = '2026-08';
  }, 90_000);

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

  it('scenario 4 — HR may edit, and doing so voids the approvals and restarts the chain', async () => {
    const run = await runForPeriod();

    const before = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(before.currentPosition).toBe(2); // the site in-charge approved above

    await http()
      .post('/hr/attendance')
      .set(auth(hrUser.token))
      .send({ employeeId, date: `${period}-12`, inTime: '09:05' })
      .expect(201);

    // The listener runs in-process, so the chain has already restarted.
    const after = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
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
