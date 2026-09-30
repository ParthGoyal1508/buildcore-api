import { BadRequestException } from '@nestjs/common';
import { PunchType } from '@prisma/client';

import { AttendanceAdminService } from './attendance-admin.service';

/**
 * The two calendar rules the admin attendance surface enforces
 * (005 amendment 2026-09-08: FR-069 to FR-074).
 *
 * `statusForDay` itself is already covered in attendance-history.service.spec.ts;
 * what is tested here is the wiring around it — that the derived status reaches the
 * row, that an explicit override outranks it, and that a date which has not
 * happened is refused in the business timezone rather than in UTC.
 */

const CALLER = {
  userId: 'user-1',
  companyId: 'co-1',
  ipAddress: '10.0.0.1',
  rls: { companyId: 'co-1', isSuperAdmin: false },
} as never;

const EMPLOYEES = [
  {
    id: 'emp-1',
    employeeCode: 'PRPL-1001',
    firstName: 'Rajesh',
    lastName: 'Kulkarni',
    siteId: 'site-1',
  },
  {
    id: 'emp-2',
    employeeCode: 'PRPL-1002',
    firstName: 'Sneha',
    lastName: 'Iyer',
    siteId: 'site-2',
  },
];

function build(
  options: {
    punches?: unknown[];
    statuses?: [string, string][];
    /** 016: simulate a payroll run under review for this period. */
    underReview?: boolean;
    /** 016: the role id the `hr` chain slot resolves to, or null when unmapped. */
    hrRoleId?: string | null;
  } = {},
) {
  const employee = {
    findMany: jest.fn().mockResolvedValue(EMPLOYEES),
    // 016's lock tests exercise `mark()`, which resolves the employee first.
    findFirst: jest.fn().mockResolvedValue({ id: 'emp-1', companyId: 'co-1' }),
  };
  const punchRecord = {
    findMany: jest.fn().mockResolvedValue(options.punches ?? []),
    createMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
  };
  const attendanceModification = { create: jest.fn(), findMany: jest.fn() };
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        employee,
        punchRecord,
        attendanceModification,
        $executeRaw: jest.fn().mockResolvedValue(undefined),
      }),
    ),
  } as never;

  const companies = { getPayrollLockDay: jest.fn().mockResolvedValue(null) };
  const employeeDocuments = {
    assertMandatoryDocsComplete: jest.fn().mockResolvedValue(undefined),
  };
  const attendanceHistory = {
    statusesForDate: jest
      .fn()
      .mockResolvedValue(new Map(options.statuses ?? [])),
  };
  const configService = {
    get: (key: string) =>
      key === 'settings'
        ? { timezone: 'Asia/Kolkata' }
        : { attendanceImportMaxRows: 1000 },
  };

  // 016: the attendance write path asks payroll whether the period is under review, and
  // asks the approval chain which role is HR. Both default to "not under review" here so
  // the existing assertions keep exercising what they were written for; the lock itself
  // is covered below and in the e2e suite.
  const payrollSchedule = {
    isPeriodUnderReview: jest
      .fn()
      .mockResolvedValue(options.underReview ?? false),
  };
  const chains = {
    resolveSlot: jest.fn().mockResolvedValue(options.hrRoleId ?? null),
  };
  const events = {
    emit: jest.fn(),
    // 016 uses `emitAsync` so the edit is not reported done while the approvals it voids
    // are still outstanding.
    emitAsync: jest.fn().mockResolvedValue([]),
  };

  const service = new AttendanceAdminService(
    prisma,
    companies as never,
    employeeDocuments as never,
    attendanceHistory as never,
    {} as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    payrollSchedule as never,
    chains as never,
    // 016 FR-012: the spine. These tests exercise `mark`, which applies directly; the
    // submission path has its own coverage, so this only needs to satisfy the constructor.
    { submit: jest.fn() } as never,
    events as never,
    configService as never,
  );

  return {
    service,
    employee,
    punchRecord,
    companies,
    attendanceHistory,
    payrollSchedule,
    chains,
    events,
  };
}

/** A punch row with only the fields `daily()` reads. */
const punch = (over: Record<string, unknown> = {}) => ({
  employeeId: 'emp-1',
  type: PunchType.in,
  capturedAt: new Date('2026-09-08T03:35:00.000Z'),
  statusOverride: null,
  adminEdited: false,
  remarks: null,
  faceMatchResult: 'matched',
  geofenceResult: 'in_range',
  ...over,
});

describe('AttendanceAdminService — effective status (FR-069, FR-070)', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T06:00:00.000Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('reports the derived status for an employee with nothing recorded', async () => {
    // The defect this closes: with no derived status on the wire, the client fell
    // back to "present", so an employee who never punched read as Present.
    const { service } = build({
      statuses: [
        ['emp-1', 'absent'],
        ['emp-2', 'weekly_off'],
      ],
    });

    const rows = await service.daily(CALLER, 'co-1', {
      date: '2026-09-08',
    } as never);

    expect(rows.map((r) => r.status)).toEqual(['absent', 'weekly_off']);
    expect(rows.every((r) => r.inTime === null)).toBe(true);
  });

  it('lets an explicit override outrank the derived status', async () => {
    const { service } = build({
      punches: [punch({ statusOverride: 'absent' })],
      statuses: [
        ['emp-1', 'present'],
        ['emp-2', 'absent'],
      ],
    });

    const rows = await service.daily(CALLER, 'co-1', {
      date: '2026-09-08',
    } as never);

    // emp-1 punched, so the derivation says present — but an admin marked them
    // absent for this day and meant it.
    expect(rows[0].status).toBe('absent');
    expect(rows[0].statusOverride).toBe('absent');
    expect(rows[1].status).toBe('absent');
  });

  it('tells the derivation which employees punched', async () => {
    const { service, attendanceHistory } = build({
      punches: [punch()],
      statuses: [
        ['emp-1', 'present'],
        ['emp-2', 'absent'],
      ],
    });

    await service.daily(CALLER, 'co-1', { date: '2026-09-08' } as never);

    const hasPunch = attendanceHistory.statusesForDate.mock.calls[0][4];
    expect(hasPunch('emp-1')).toBe(true);
    expect(hasPunch('emp-2')).toBe(false);
  });
});

describe('AttendanceAdminService — future dates (FR-071, FR-072, FR-074)', () => {
  afterEach(() => jest.useRealTimers());

  // 11:30 IST on 8 September: the UTC date and the IST date agree.
  const midMorning = () =>
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T06:00:00.000Z'));

  // 00:30 IST on 9 September, when it is still 8 September in UTC. This is the
  // window a UTC-truncated "today" gets wrong.
  const justAfterMidnightIst = () =>
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T19:00:00.000Z'));

  it('refuses tomorrow on the daily view', async () => {
    midMorning();
    const { service } = build();
    await expect(
      service.daily(CALLER, 'co-1', { date: '2026-09-09' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts today on the daily view', async () => {
    midMorning();
    const { service } = build({
      statuses: [
        ['emp-1', 'absent'],
        ['emp-2', 'absent'],
      ],
    });
    await expect(
      service.daily(CALLER, 'co-1', { date: '2026-09-08' } as never),
    ).resolves.toHaveLength(2);
  });

  it('accepts the IST date in the hours when UTC is still on the previous day', async () => {
    justAfterMidnightIst();
    const { service } = build({
      statuses: [
        ['emp-1', 'absent'],
        ['emp-2', 'absent'],
      ],
    });
    // A UTC comparison would call 9 September "future" here and refuse the
    // genuinely current working day.
    await expect(
      service.daily(CALLER, 'co-1', { date: '2026-09-09' } as never),
    ).resolves.toHaveLength(2);
    await expect(
      service.daily(CALLER, 'co-1', { date: '2026-09-10' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a future date on the Mark action before any other rule runs', async () => {
    midMorning();
    const { service, employee, companies } = build();
    employee.findFirst.mockResolvedValue({ id: 'emp-1', companyId: 'co-1' });

    await expect(
      service.mark(CALLER, {
        employeeId: 'emp-1',
        date: '2026-09-09',
        inTime: '09:00',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The calendar is checked before the payroll lock, so a future date is
    // refused as a future date rather than as whatever the lock happens to say.
    expect(companies.getPayrollLockDay).not.toHaveBeenCalled();
  });
});

describe('AttendanceAdminService — the payroll-review lock (016 FR-016, FR-017)', () => {
  const HR_ROLE = 'role-hr';

  const caller = (roleIds: string[]) => ({
    userId: 'user-1',
    companyId: 'co-1',
    ipAddress: '10.0.0.1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
    roleIds,
  });

  // Today's month, so the pre-existing payroll-lock-day rule (005 FR-010) does not fire
  // first and mask what these tests are about. `build()` already returns a null lock day,
  // which locks every *past* period.
  const today = new Date();
  const THIS_PERIOD = `${today.getFullYear()}-${String(
    today.getMonth() + 1,
  ).padStart(2, '0')}`;
  const edit = {
    employeeId: 'emp-1',
    date: `${THIS_PERIOD}-01`,
    inTime: '09:05',
  };

  it('lets anybody edit when no run is under review', async () => {
    const { service, events } = build();
    await expect(
      service.mark(caller([]) as never, edit as never),
    ).resolves.toMatchObject({ employeeId: 'emp-1' });
    // Nothing to invalidate, so nothing is announced.
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('refuses a non-HR editor once the period is under review', async () => {
    const { service } = build({ underReview: true, hrRoleId: HR_ROLE });

    const error = await service
      .mark(caller(['role-site']) as never, edit as never)
      .catch((e) => e);

    expect(error.response.code).toBe('ATTENDANCE_UNDER_PAYROLL_REVIEW');
    expect(error.response.message).toMatch(/Only HR may edit/);
  });

  it('permits HR, and announces that approvals are void', async () => {
    const { service, events } = build({ underReview: true, hrRoleId: HR_ROLE });

    await expect(
      service.mark(caller([HR_ROLE]) as never, edit as never),
    ).resolves.toMatchObject({ employeeId: 'emp-1' });

    // FR-017: the approvers agreed to figures that no longer hold.
    expect(events.emitAsync).toHaveBeenCalledWith(
      'attendance.changed-under-review',
      expect.objectContaining({
        companyId: 'co-1',
        period: THIS_PERIOD,
        employeeId: 'emp-1',
      }),
    );
  });

  it('refuses everybody, naming the settings gap, when HR is unmapped', async () => {
    // Nobody can edit, and the honest reason is a configuration fault rather than a
    // permissions one — otherwise HR goes looking for a permission that does not exist.
    const { service } = build({ underReview: true, hrRoleId: null });

    const error = await service
      .mark(caller([HR_ROLE]) as never, edit as never)
      .catch((e) => e);

    expect(error.response.code).toBe('APPROVAL_SLOT_UNMAPPED');
    expect(error.response.message).toMatch(/no role has been mapped to HR/);
  });

  it('asks payroll rather than reading its tables (Principle I)', async () => {
    const { service, payrollSchedule } = build({ underReview: false });
    await service.mark(caller([]) as never, edit as never);

    expect(payrollSchedule.isPeriodUnderReview).toHaveBeenCalledWith(
      'co-1',
      expect.any(Date),
    );
  });
});

/**
 * The FR-012d actor filter (016 T071).
 *
 * Asserted on the `where` clause the service builds rather than through the database,
 * because what matters is that the new filter **composes** with the existing ones instead of
 * replacing them — "what did this person change to this employee in September" is one
 * question, and a filter that replaced the others would answer a different one.
 */
describe('AttendanceAdminService.modifications — the actor filter (FR-012d)', () => {
  const capture = () => {
    const seen: { where?: Record<string, unknown> }[] = [];
    const tx = {
      $executeRaw: async () => 0,
      employee: { findMany: async () => [{ id: 'emp-1' }, { id: 'emp-2' }] },
      attendanceModification: {
        findMany: async (args: { where?: Record<string, unknown> }) => {
          seen.push(args);
          return [];
        },
        count: async () => 0,
      },
      user: { findMany: async () => [] },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return { prisma, seen };
  };

  const serviceFor = (prisma: unknown) =>
    new AttendanceAdminService(
      prisma as never,
      { getPayrollLockDay: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      { isPeriodUnderReview: jest.fn() } as never,
      { resolveSlot: jest.fn() } as never,
      { submit: jest.fn() } as never,
      { emit: jest.fn(), emitAsync: jest.fn() } as never,
      { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
    );

  const caller = { userId: 'u-1', rls: { isSuperAdmin: true } } as never;

  it('filters by actor when one is named', async () => {
    const { prisma, seen } = capture();
    await serviceFor(prisma).modifications(caller, 'co-1', {
      actorUserId: 'admin-7',
    } as never);
    expect(seen[0].where?.actorUserId).toBe('admin-7');
  });

  it('omits the clause entirely when no actor is named', async () => {
    // Not `actorUserId: undefined`. An explicit undefined is a filter on nothing in some
    // Prisma versions and a no-op in others, and the difference is an audit silently
    // returning everything.
    const { prisma, seen } = capture();
    await serviceFor(prisma).modifications(caller, 'co-1', {} as never);
    expect('actorUserId' in (seen[0].where ?? {})).toBe(false);
  });

  it('composes with the employee and date filters rather than replacing them', async () => {
    const { prisma, seen } = capture();
    await serviceFor(prisma).modifications(caller, 'co-1', {
      actorUserId: 'admin-7',
      employeeId: 'emp-1',
      from: '2026-09-01',
      to: '2026-09-30',
    } as never);

    const where = seen[0].where ?? {};
    expect(where.actorUserId).toBe('admin-7');
    expect(where.employeeId).toBe('emp-1');
    expect(where.date).toBeDefined();
  });
});
