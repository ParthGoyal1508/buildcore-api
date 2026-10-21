import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import type { EmailConfig } from '../src/common/configs/config.interface';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { SLOT_FIRST_APPROVER, SLOT_HR } from '../src/approvals/approval-slots';
import { ACTION_PAYROLL_RUN } from '../src/approvals/default-chains';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import * as ExcelJS from 'exceljs';

import { PiiCipherService } from '../src/hr/employees/pii-cipher.service';

import {
  BANK_SHEET_COLUMN,
  BANK_SHEET_COLUMN_COUNT,
  BankSheetService,
  IFSC_PATTERN,
} from '../src/payroll/runs/bank-sheet.service';
import { PayrollScheduleService } from '../src/payroll/runs/payroll-schedule.service';

/**
 * Payroll runs itself, then waits for the right people — spec US2 scenarios 1 to 6
 * (016 T040).
 *
 * The claim under test is that **a payroll run cannot reach money without the Director's recorded
 * approval** (039: one level, sent by HR after correcting the draft), and that the inputs cannot
 * be quietly changed while it is being reviewed.
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
    // Payslip email is off by default (PAYSLIP_EMAIL_ENABLED). The slip scenarios below test the
    // approval gate in front of it, so they run with it on; the flag is read on every send.
    app.get(ConfigService).get<EmailConfig>('email').payslipsEnabled = true;

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
        // Bank details, added 2026-10-04 for 021 T103. Without them the bank sheet's payment
        // tab is empty and every row lands on the unpayable tab instead — correctly, since
        // FR-008e refuses a row whose account holder name is unset rather than falling back to
        // the employee's own name. A cell-for-cell test against an empty sheet would pass every
        // assertion and prove nothing, which is what its vacuity guard caught.
        //
        // The holder name is deliberately **not** "Sneha Iyer": in the client's own sample the
        // beneficiary names are misspelled against any HR record, because they are what the
        // beneficiary's bank has on file. A fixture that made the two agree would hide the
        // distinction the column exists for.
        // A salary, so the run produces a payable line. Without it net pay is zero and the sheet
        // carries a transfer instruction for nothing — which the vacuity guard in T103 catches
        // as an amount of 0 rather than letting the test pass over an empty figure.
        basic: 30000,
        hra: 12000,
        conveyanceAllowance: 1600,
        bankName: 'E2E Bank',
        // Encrypted through the same service the application uses, not written as plaintext: the
        // column is regulated PII and the bank sheet decrypts it. A plaintext fixture fails at the
        // decrypt with "stored blob is truncated", which is the cipher refusing honestly.
        bankAccountNumberEncrypted: app
          .get(PiiCipherService)
          .encrypt('0001234567890'),
        ifscCode: 'HDFC0001234',
        bankAccountHolderName: 'SNEHA S IYER',
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
    // 036: scoped to this company's runs — `where: {}` deleted every line item in the database.
    await sys.payrollLineItem
      .deleteMany({ where: { payrollRun: { companyId } } })
      .catch(() => undefined);
    await sys.bankSheetExport.deleteMany({ where: { companyId } });
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

  it('scenario 1 — the schedule draws up the previous period and leaves it for HR to send (039)', async () => {
    const result = await schedule.createRunsForPreviousPeriod(whenItFires);

    expect(result.period).toBe(period);
    expect(result.created).toContain(companyId);

    const run = await runForPeriod();
    expect(run).toBeTruthy();
    // Distinguishable from a run somebody created by hand — which matters, because the
    // production instance may be suspended when the cron is due.
    expect(run.createdBySchedule).toBe(true);
    expect(run.status).toBe('draft');

    // 039: not in any chain. HR reviews and corrects the draft, then sends it.
    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(state).toBeNull();
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

  it('scenario 2 — neither processing nor a bank sheet before the Director approves (039)', async () => {
    const run = await runForPeriod();

    const processing = await http()
      .patch(`/hr/payroll/runs/${run.id}/status`)
      .set(auth(hrUser.token))
      .send({ status: 'processed' })
      .expect(409);
    expect(processing.body.code).toBe('PAYROLL_RUN_NOT_SUBMITTED');

    const error = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);
    expect(error.response.code).toBe('PAYROLL_RUN_NOT_FINALISED');
  }, 60_000);

  it('039 — HR corrects a generated line, with a justification, and the change is recorded', async () => {
    const run = await runForPeriod();
    const line = await sys.payrollLineItem.findFirst({
      where: { payrollRunId: run.id, employeeId },
    });

    await http()
      .patch(`/hr/payroll/runs/${run.id}/lines/${line.id}`)
      .set(auth(hrUser.token))
      .send({ changes: { basic: Number(line.basic) + 1000 } })
      .expect(400);

    const res = await http()
      .patch(`/hr/payroll/runs/${run.id}/lines/${line.id}`)
      .set(auth(hrUser.token))
      .send({
        changes: { basic: Number(line.basic) + 1000 },
        justification: 'Increment effective this month was missed',
      })
      .expect(200);
    expect(res.body.editedFields).toEqual(['basic']);
    expect(Number(res.body.netPay)).toBeGreaterThan(Number(line.netPay));

    const detail = await http()
      .get(`/hr/payroll/runs/${run.id}`)
      .set(auth(hrUser.token))
      .expect(200);
    expect(detail.body.lineItems[0].editedFields).toEqual(['basic']);

    const edits = await http()
      .get(`/hr/payroll/runs/${run.id}/edits?lineItemId=${line.id}`)
      .set(auth(hrUser.token))
      .expect(200);
    expect(edits.body).toHaveLength(1);
    expect(edits.body[0]).toMatchObject({
      field: 'basic',
      justification: 'Increment effective this month was missed',
      editedByUserId: hrUser.userId,
      editedByName: expect.stringContaining('HrOffice'),
    });

    // Regenerating would wipe the correction, so it asks first.
    const regen = await http()
      .post('/hr/payroll/runs')
      .set(auth(hrUser.token))
      .send({ period })
      .expect(409);
    expect(regen.body.code).toBe('PAYROLL_RUN_HAS_EDITS');
  }, 60_000);

  it('039 — HR sends it to the Director; edits lock while it waits', async () => {
    const run = await runForPeriod();
    const sent = await http()
      .post(`/hr/payroll/runs/${run.id}/submit-for-approval`)
      .set(auth(hrUser.token))
      .expect(201);
    expect(sent.body).toMatchObject({ runId: run.id, submitted: true });

    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(state).toMatchObject({
      state: 'pending',
      currentPosition: 1,
      totalLevels: 1,
      levelLabel: 'Director',
      originatorUserId: hrUser.userId,
    });

    const line = await sys.payrollLineItem.findFirst({
      where: { payrollRunId: run.id, employeeId },
    });
    const locked = await http()
      .patch(`/hr/payroll/runs/${run.id}/lines/${line.id}`)
      .set(auth(hrUser.token))
      .send({ changes: { hra: 1 }, justification: 'x' })
      .expect(409);
    expect(locked.body.code).toBe('PAYROLL_RUN_AWAITING_APPROVAL');

    const error = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);
    expect(error.response.code).toBe('PAYROLL_RUN_NOT_FINALISED');
  }, 60_000);

  it('021 T041 — slips are refused while the run is unapproved', async () => {
    /**
     * Emailing a slip is the one action here that **cannot be undone** — a bank sheet downloaded
     * early can be deleted, and 500 emails sent against an unapproved run cannot be recalled.
     */
    const run = await runForPeriod();

    const res = await http()
      .post(`/hr/payroll/runs/${run.id}/slip-deliveries`)
      .set(auth(hrUser.token))
      .send({});

    expect(res.status).toBe(409);

    // And nothing was queued. A refusal that still wrote delivery rows would send on the next
    // retry, which is the quiet version of this failure.
    const deliveries = await sys.slipDelivery.findMany({
      where: { payrollRunId: run.id },
    });
    expect(deliveries).toEqual([]);
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

  it('039 — the Director returns it with remarks; HR corrects and sends it again', async () => {
    const run = await runForPeriod();
    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    await approvals.decide(
      {
        instanceId: state.instanceId,
        action: ApprovalDecisionAction.return,
        reason: 'Check the site allowance for the new joiners',
      },
      asUser(directorUser.userId, [finalRoleId]),
      '127.0.0.1',
    );

    const detail = await http()
      .get(`/hr/payroll/runs/${run.id}`)
      .set(auth(hrUser.token))
      .expect(200);
    expect(detail.body.approval).toMatchObject({
      state: 'returned',
      latestDecision: {
        action: 'return',
        reason: 'Check the site allowance for the new joiners',
      },
    });

    const line = await sys.payrollLineItem.findFirst({
      where: { payrollRunId: run.id, employeeId },
    });
    await http()
      .patch(`/hr/payroll/runs/${run.id}/lines/${line.id}`)
      .set(auth(hrUser.token))
      .send({
        changes: { siteAllowance: 1500 },
        justification: 'Site allowance per the Director',
      })
      .expect(200);

    await http()
      .post(`/hr/payroll/runs/${run.id}/submit-for-approval`)
      .set(auth(hrUser.token))
      .expect(201);
    const again = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    // Resubmitted by its originator: the same instance, a new round, its history kept.
    expect(again).toMatchObject({
      instanceId: state.instanceId,
      state: 'pending',
      round: 2,
    });
  }, 60_000);

  /**
   * FR-016 and FR-017 together, as they behave once corrections travel a chain of their own
   * (016 Phase 8): the void happens when the correction is *applied*, not when it is asked for.
   *
   * 039: voided means abandoned and handed back to HR, not restarted. The stored lines do not
   * change with attendance — only a regeneration recomputes them — so restarting put the same
   * figures back in front of the Director.
   */
  it('scenario 4 — a correction voids the approval when it is applied, not when it is asked for', async () => {
    const run = await runForPeriod();

    const before = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(before.state).toBe('pending');

    const submitted = await http()
      .post('/hr/attendance')
      .set(auth(hrUser.token))
      .send({ employeeId, date: `${period}-12`, inTime: '09:05' })
      .expect(201);

    // Pending, not applied — so the run's approval stands for now.
    const whilePending = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(whilePending.state).toBe('pending');
    expect(whilePending.instanceId).toBe(before.instanceId);

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

    const after = await eventually(async () => {
      const state = await approvals.stateOfSystem(
        ACTION_PAYROLL_RUN,
        run.id,
        companyId,
      );
      return state.state === 'abandoned' ? state : null;
    });
    expect(after.instanceId).toBe(before.instanceId);
  }, 60_000);

  it('scenario 5 — sent again, approved by the Director, processed: the sheet is produced', async () => {
    const run = await runForPeriod();

    await http()
      .post(`/hr/payroll/runs/${run.id}/submit-for-approval`)
      .set(auth(hrUser.token))
      .expect(201);
    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(state.state).toBe('pending');
    await approvals.decide(
      { instanceId: state.instanceId, action: ApprovalDecisionAction.approve },
      asUser(directorUser.userId, [finalRoleId]),
      '127.0.0.1',
    );

    const final = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(final.state).toBe('approved');

    // An approved draft is still a draft: the sheet waits for processing.
    const early = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);
    expect(early.response.code).toBe('PAYROLL_RUN_NOT_FINALISED');

    await http()
      .patch(`/hr/payroll/runs/${run.id}/status`)
      .set(auth(hrUser.token))
      .send({ status: 'processed' })
      .expect(200);

    const sheet = await bankSheet.build(
      callerFor(directorUser.userId, [finalRoleId]) as never,
      run.id,
    );
    expect(sheet.filename).toContain(period);
    expect(sheet.buffer.length).toBeGreaterThan(0);

    // The Director is named (FR-002, SC-002).
    const history = await approvals.historyOf(
      ACTION_PAYROLL_RUN,
      run.id,
      asUser(directorUser.userId, [finalRoleId]),
    );
    expect(history.map((h) => h.actorUserId)).toEqual([directorUser.userId]);
    expect(history.map((h) => h.levelLabel)).toEqual(['Director']);
  }, 60_000);

  it('021 T041 — slips send once the run is approved', async () => {
    // Runs after scenario 5, which approved and processed this period's run.
    const run = await runForPeriod();
    const state = await approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    expect(state.state).toBe('approved');

    const res = await http()
      .post(`/hr/payroll/runs/${run.id}/slip-deliveries`)
      .set(auth(hrUser.token))
      .send({});

    // Permitted. Not asserting that mail left the building — there is no mail server in this
    // environment and the delivery rows record the attempt either way, which is what FR-007's
    // retry is built on.
    expect(res.status).toBe(201);
    expect(res.body.code).toBeUndefined();
  }, 60_000);

  it('021 T103 — the bank sheet matches the sample cell for cell, and type for type', async () => {
    /**
     * The task's own words: *"the types are the contract here, not just the values."*
     *
     * A bank reads this file by **position**, and three of the columns fail in ways a
     * value-only test cannot see. `Value Date` written as a real date is re-rendered by the
     * reader's locale, so `21/08/2026` read as month 21 is a rejected file — it must be text. An
     * account number written as a number loses a leading zero, silently, and the payment goes
     * nowhere. And a totals row appended to a file read row-by-row becomes a payment instruction.
     *
     * The shape is taken from `docs/RING ROAD JULY SALARY.xls`: 16 columns, blanks included.
     */
    const run = await runForPeriod();
    const sheet = await bankSheet.build(
      callerFor(directorUser.userId, [finalRoleId]) as never,
      run.id,
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(sheet.buffer as never);
    const ws = workbook.worksheets[0];

    // Sixteen columns, blanks included — the sample's width, not the number of columns that
    // happen to carry data.
    expect(ws.getRow(1).cellCount).toBe(BANK_SHEET_COLUMN_COUNT);
    expect(ws.getRow(1).getCell(1).value).toBe('CUSTOM_DETAILS1');
    expect(ws.getRow(1).getCell(BANK_SHEET_COLUMN.valueDate + 1).value).toBe(
      'Value Date',
    );
    expect(ws.getRow(1).getCell(BANK_SHEET_COLUMN.ifsc + 1).value).toBe(
      'Beneficiary Bank Swift Code / IFSC Code',
    );

    // At least one payment row, or everything below is vacuous.
    expect(ws.rowCount).toBeGreaterThan(1);

    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);

      // **A text date, not a date cell.** `typeof` on the value is the assertion: exceljs gives a
      // `Date` object for a real date cell, and a string for text. A test that only checked the
      // rendered characters would pass for both.
      const valueDate = row.getCell(BANK_SHEET_COLUMN.valueDate + 1).value;
      expect(typeof valueDate).toBe('string');
      expect(valueDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);

      // **A text account number.** A leading zero is part of the account, and a numeric cell
      // drops it without saying so.
      expect(
        typeof row.getCell(BANK_SHEET_COLUMN.beneficiaryAccount + 1).value,
      ).toBe('string');

      // The IFSC in the column whose label offers a choice the bank does not make.
      expect(row.getCell(BANK_SHEET_COLUMN.ifsc + 1).value).toMatch(
        IFSC_PATTERN,
      );

      // **The amount IS a number**, unlike the two above — it is arithmetic, and a bank summing a
      // column of text gets nothing. The asymmetry is the contract.
      expect(
        typeof row.getCell(BANK_SHEET_COLUMN.paymentAmount + 1).value,
      ).toBe('number');
      expect(
        row.getCell(BANK_SHEET_COLUMN.paymentAmount + 1).value as number,
      ).toBeGreaterThan(0);

      expect(
        row.getCell(BANK_SHEET_COLUMN.beneficiaryName + 1).value,
      ).toBeTruthy();
      expect(
        row.getCell(BANK_SHEET_COLUMN.debitAccount + 1).value,
      ).toBeTruthy();
    }

    // **No totals row.** Asserted as "every row has a beneficiary account" rather than by looking
    // for the word "Total": a totals row would have the amount column filled and the account
    // column empty, which is exactly the shape a bank would read as a payment to nobody.
    for (let r = 2; r <= ws.rowCount; r += 1) {
      expect(
        ws.getRow(r).getCell(BANK_SHEET_COLUMN.beneficiaryAccount + 1).value,
      ).toBeTruthy();
    }
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

  it('039 — processing a draft never sent to the Director is refused', async () => {
    const draft = await sys.payrollRun.create({
      data: { companyId, period: '2019-02', status: 'draft' },
    });
    const res = await http()
      .patch(`/hr/payroll/runs/${draft.id}/status`)
      .set(auth(hrUser.token))
      .send({ status: 'processed' })
      .expect(409);
    expect(res.body.code).toBe('PAYROLL_RUN_NOT_SUBMITTED');
  }, 60_000);

  it('2026-10-17 — a run processed without approval says so, and can be sent once', async () => {
    const run = await sys.payrollRun.create({
      data: { companyId, period: '2019-01', status: 'processed' },
    });

    const error = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);
    expect(error.response).toMatchObject({
      code: 'PAYROLL_RUN_NOT_SUBMITTED',
      runId: run.id,
    });

    const sent = await http()
      .post(`/hr/payroll/runs/${run.id}/submit-for-approval`)
      .set(auth(hrUser.token))
      .expect(201);
    expect(sent.body).toMatchObject({ runId: run.id, submitted: true });
    const again = await http()
      .post(`/hr/payroll/runs/${run.id}/submit-for-approval`)
      .set(auth(hrUser.token))
      .expect(409);
    expect(again.body.code).toBe('PAYROLL_RUN_AWAITING_APPROVAL');

    const refused = await bankSheet
      .build(callerFor(directorUser.userId, [finalRoleId]) as never, run.id)
      .catch((e) => e);
    expect(refused.response.code).toBe('PAYROLL_RUN_NOT_APPROVED');
  }, 60_000);

  it('2026-10-17 — every generated bank sheet is in the history, and downloads again', async () => {
    const run = await runForPeriod();
    const [year, month] = run.period.split('-').map(Number);
    const res = await http()
      .get(`/hr/payroll/bank-sheet/history?year=${year}&month=${month}`)
      .set(auth(hrUser.token))
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toMatchObject({
      period: run.period,
      fileName: expect.stringMatching(/\.xlsx$/),
    });

    const file = await http()
      .get(`/hr/payroll/bank-sheet/history/${res.body[0].id}/file`)
      .set(auth(hrUser.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect((file.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  }, 60_000);
});
