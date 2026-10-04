import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import {
  SLOT_FINAL,
  SLOT_FIRST_APPROVER,
  SLOT_HR,
} from '../src/approvals/approval-slots';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { ACTION_ATTENDANCE_CORRECTION } from '../src/approvals/default-chains';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { AttendanceAdminService } from '../src/hr/attendance/attendance-admin.service';
import { AttendanceHistoryService } from '../src/hr/punch/attendance-history.service';

/**
 * A manual attendance correction through the chain (016 FR-012, T068, T078, T079).
 *
 * The two claims that matter, and neither can be checked without walking a real chain:
 *
 * 1. **The attendance does not change until the chain completes.** The whole point of
 *    FR-012 — and the web side's FR-009c, which must present a submitted correction as
 *    awaiting approval, depends on it being true here.
 * 2. **A rejected correction leaves no `AttendanceModification`.** A log that recorded
 *    rejected corrections would disagree with the attendance it claims to explain.
 *
 * Plus the client's own sentence, as one assertion: the affected employee sees who changed
 * their day, by name.
 *
 * Every fixture is prefixed `E2EAC` and removed in `afterAll`.
 */
const PREFIX = 'E2EAC';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(90_000);

describe('Attendance correction through the chain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let attendance: AttendanceAdminService;
  let history: AttendanceHistoryService;

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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let companyId: string;
  let employeeId: string;
  let employeeUserId: string;
  let siteId: string;
  let shiftId: string;
  let siteRoleId: string;
  let hrRoleId: string;
  let finalRoleId: string;
  let adminUserId: string;
  let siteUserId: string;
  let hrUserId: string;
  let finalUserId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  /**
   * Four distinct days that are genuinely outside the payroll lock window, whenever this runs.
   *
   * The first version of this named `2026-09-11` and called itself "safely outside any payroll
   * lock window". It was, on the day it was written. `isPayrollLocked` locks last month once the
   * current date reaches the lock day and locks anything older unconditionally — and this
   * suite's company fixture uses `payrollLockDay: 1`, which locks last month from its first day.
   * So the date aged into the lock and five tests here began failing on 1 October for no reason
   * connected to the code they cover.
   *
   * The current month is always open, whatever the lock day, so that is the first choice. Early
   * in a month there are not four days available yet, and the fallback is last month — which the
   * raised lock day below keeps open until its final day.
   *
   * **Derived in the business timezone, not UTC**, because that is the clock the lock rule reads.
   * Between 18:30 and 24:00 UTC, IST is already the next day, and on a month's last day it is
   * already the next *month* — so a month chosen in UTC can be two months behind the rule's
   * "today" rather than one, which `isPayrollLocked` refuses whatever the lock day says.
   */
  const CORRECTION_DATES = (() => {
    // `en-CA` renders as YYYY-MM-DD, the shape the rest of this suite speaks.
    const [year, month, day] = new Date()
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      .split('-')
      .map(Number);
    const useCurrentMonth = day >= 5;
    const base = new Date(
      Date.UTC(year, useCurrentMonth ? month - 1 : month - 2, 1),
    );
    const chosen = `${base.getUTCFullYear()}-${String(
      base.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    return [1, 2, 3, 4].map(
      (dayOfMonth) => `${chosen}-${String(dayOfMonth).padStart(2, '0')}`,
    );
  })();

  const CORRECTION_DATE = CORRECTION_DATES[0];

  const makeUser = async (label: string, roleId: string | null) => {
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
    if (roleId) {
      await sys.userRole.create({
        data: { userId: user.id, roleId, companyId },
      });
    }
    return user.id as string;
  };

  const asUser = (userId: string, roles: string[]) =>
    ({
      id: userId,
      userId,
      companyId,
      roleIds: roles,
      permissions: [Permission.ATTENDANCE],
      rls: { isSuperAdmin: false, companyId },
      ipAddress: '127.0.0.1',
    } as never);

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
    attendance = app.get(AttendanceAdminService);
    history = app.get(AttendanceHistoryService);

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Correction Constructions`,
        shortCode: unique('C').slice(0, 10),
        // 31, not 1. Nothing here tests the payroll lock, and a lock day of 1 locks last month
        // from its first day — which is what aged the fixed dates above into a refusal.
        payrollLockDay: 31,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    for (const [label, target] of [
      ['Site', 'site'],
      ['Hr', 'hr'],
      ['Final', 'final'],
    ] as const) {
      const role = await sys.role.create({
        data: { name: unique(label), permissions: [Permission.ATTENDANCE] },
      });
      roleIds.push(role.id);
      if (target === 'site') siteRoleId = role.id;
      if (target === 'hr') hrRoleId = role.id;
      if (target === 'final') finalRoleId = role.id;
    }

    adminUserId = await makeUser('Admin', null);
    siteUserId = await makeUser('SiteApprover', siteRoleId);
    hrUserId = await makeUser('HrApprover', hrRoleId);
    finalUserId = await makeUser('Director', finalRoleId);

    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: adminUserId, ipAddress: '127.0.0.1' };
    for (const [slotKey, roleId] of [
      [SLOT_FIRST_APPROVER, siteRoleId],
      [SLOT_HR, hrRoleId],
      [SLOT_FINAL, finalRoleId],
    ] as const) {
      await chains.putSlotMapping(ctx, { companyId, slotKey, roleId }, actor);
    }
    // The migration seeds this chain for every company that existed when it ran; a company
    // created here needs it explicitly, which is also what `seedDefaultsForCompany` does.
    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: ACTION_ATTENDANCE_CORRECTION,
        levels: [
          { position: 1, slotKey: SLOT_FIRST_APPROVER },
          { position: 2, slotKey: SLOT_HR },
          { position: 3, slotKey: SLOT_FINAL, isFinalAuthority: true },
        ],
      },
      actor,
    );

    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 20,
        longitude: 78,
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

    employeeUserId = await makeUser('Worker', null);
    const employee = await sys.employee.create({
      data: {
        userId: employeeUserId,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('EMP'),
        firstName: 'Ramesh',
        lastName: 'Kumar',
      },
    });
    employeeId = employee.id;
  }, 90_000);

  afterAll(async () => {
    await sys.attendanceModification.deleteMany({ where: { employeeId } });
    await sys.pendingAttendanceCorrection.deleteMany({ where: { companyId } });
    await sys.punchRecord.deleteMany({ where: { employeeId } });
    await sys.employee.deleteMany({ where: { id: employeeId } });
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.shift.deleteMany({ where: { id: shiftId } });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  });

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });

  const submit = (date: string) =>
    attendance.submitCorrection(asUser(adminUserId, []), {
      employeeId,
      date,
      inTime: '09:05',
      outTime: '18:10',
      remarks: 'Biometric was down',
    } as never);

  const decide = (
    instanceId: string,
    userId: string,
    roleId: string,
    action: ApprovalDecisionAction,
  ) =>
    approvals.decide(
      { instanceId, action, reason: action === 'approve' ? null : 'no' },
      asUser(userId, [roleId]),
      '127.0.0.1',
    );

  const punchesFor = (date: string) =>
    sys.punchRecord.count({
      where: { employeeId, punchDate: new Date(`${date}T00:00:00.000Z`) },
    });

  /**
   * Application is **eventual, not synchronous.**
   *
   * The spine emits `approval.completed` with `emit`, not `emitAsync`, deliberately: the
   * event goes out after the decision's transaction commits and the spine does not wait for
   * its listeners. So `decide()` returning "approved" does not mean the correction has
   * landed yet — a fact the interface has to respect too, and the reason this helper exists
   * rather than a bare assertion.
   */
  const eventually = async (
    check: () => Promise<boolean>,
    what: string,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  };

  it('submits into the chain and changes nothing yet', async () => {
    const result = await submit(CORRECTION_DATE);

    expect(result.approvalInstanceId).toBeTruthy();
    expect(result.state).toBe('pending');
    // The whole point of FR-012. The web side's "awaiting approval" presentation depends on
    // this being true.
    expect(await punchesFor(CORRECTION_DATE)).toBe(0);
    expect(
      await sys.attendanceModification.count({ where: { employeeId } }),
    ).toBe(0);
  });

  it('applies the correction only once every level has approved', async () => {
    const date = CORRECTION_DATES[1];
    const { approvalInstanceId } = await submit(date);

    await decide(
      approvalInstanceId,
      siteUserId,
      siteRoleId,
      ApprovalDecisionAction.approve,
    );
    expect(await punchesFor(date)).toBe(0);

    await decide(
      approvalInstanceId,
      hrUserId,
      hrRoleId,
      ApprovalDecisionAction.approve,
    );
    expect(await punchesFor(date)).toBe(0);

    await decide(
      approvalInstanceId,
      finalUserId,
      finalRoleId,
      ApprovalDecisionAction.approve,
    );

    await eventually(
      async () => (await punchesFor(date)) > 0,
      'the correction to be applied after the final approval',
    );
    const applied = await sys.pendingAttendanceCorrection.findUnique({
      where: { approvalInstanceId },
    });
    expect(applied.appliedAt).not.toBeNull();
  });

  it('the affected employee sees who changed their day, by name', async () => {
    // The client's own sentence — "it should also reflect in the attendance of the affected
    // employee" — as one assertion.
    // The month and year are taken from the date the previous test corrected, rather than
    // named again — two places naming the same month is how one of them goes stale.
    const corrected = CORRECTION_DATES[1];
    const [correctedYear, correctedMonth] = corrected.split('-');
    const month = await history.getMonthForEmployee(
      {
        userId: employeeUserId,
        rls: { isSuperAdmin: false, companyId },
      } as never,
      { id: employeeId, siteId, shiftId, companyId },
      Number(correctedMonth),
      Number(correctedYear),
    );
    const day = month.days.find((d) => d.date === corrected);

    expect(day?.modifications.length).toBeGreaterThan(0);
    expect(day?.modifications[0].actorName).toContain('Admin');
    expect(day?.modifications[0].reason).toBe('Biometric was down');
  });

  it('a rejected correction leaves no modification and no punch', async () => {
    const date = CORRECTION_DATES[2];
    const { approvalInstanceId } = await submit(date);

    await decide(
      approvalInstanceId,
      siteUserId,
      siteRoleId,
      ApprovalDecisionAction.reject,
    );

    expect(await punchesFor(date)).toBe(0);
    const mods = await sys.attendanceModification.count({
      where: { employeeId, date: new Date(`${date}T00:00:00.000Z`) },
    });
    // A log that recorded rejected corrections would disagree with the attendance it
    // claims to explain. The rejection lives as an approval instance, which is correct.
    expect(mods).toBe(0);
  });

  it('applying the same completion twice writes once', async () => {
    const date = CORRECTION_DATES[3];
    const { approvalInstanceId } = await submit(date);
    for (const [u, r] of [
      [siteUserId, siteRoleId],
      [hrUserId, hrRoleId],
      [finalUserId, finalRoleId],
    ] as const) {
      await decide(approvalInstanceId, u, r, ApprovalDecisionAction.approve);
    }

    await eventually(
      async () => (await punchesFor(date)) > 0,
      'the first application to land before re-delivering',
    );
    const before = await sys.attendanceModification.count({
      where: { employeeId, date: new Date(`${date}T00:00:00.000Z`) },
    });

    // Redelivery is an explicit expectation, not a hazard — the event bus offers no
    // once-only guarantee.
    await attendance.onApprovalCompleted({
      entityType: ACTION_ATTENDANCE_CORRECTION,
      entityId: 'ignored',
      companyId,
      instanceId: approvalInstanceId,
    });

    const after = await sys.attendanceModification.count({
      where: { employeeId, date: new Date(`${date}T00:00:00.000Z`) },
    });
    expect(after).toBe(before);
  });

  it('ignores completions for other action types', async () => {
    // Both this handler and attendance-exceptions' filter on entityType. Reusing one action
    // type for both would have each receiving the other's completions.
    await expect(
      attendance.onApprovalCompleted({
        entityType: 'payroll_run',
        entityId: 'x',
        companyId,
        instanceId: 'y',
      }),
    ).resolves.toBeUndefined();
  });
});
