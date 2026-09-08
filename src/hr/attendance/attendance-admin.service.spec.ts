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
  options: { punches?: unknown[]; statuses?: [string, string][] } = {},
) {
  const employee = {
    findMany: jest.fn().mockResolvedValue(EMPLOYEES),
    findFirst: jest.fn(),
  };
  const punchRecord = {
    findMany: jest.fn().mockResolvedValue(options.punches ?? []),
    createMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        employee,
        punchRecord,
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

  const service = new AttendanceAdminService(
    prisma,
    companies as never,
    employeeDocuments as never,
    attendanceHistory as never,
    {} as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    configService as never,
  );

  return { service, employee, punchRecord, companies, attendanceHistory };
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
