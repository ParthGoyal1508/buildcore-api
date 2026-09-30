import { AttendanceHistoryService } from './attendance-history.service';
import { actorNameOf } from '../../common/actor-name';

/**
 * The employee's own view of who changed their attendance (016 FR-012c, T067).
 *
 * The month is assembled from six parallel reads, so the Prisma handle here is a recorder
 * that returns fixture rows and counts the calls — this repository has no `jest.mock`
 * anywhere. What is asserted is the part a refactor would silently break: that the
 * modifications cost **one** query for the whole month rather than one per day, and that the
 * actor reaches the employee as a name.
 */

interface Recorded {
  model: string;
  args: unknown;
}

function serviceWith(
  modifications: Record<string, unknown>[],
  users: Record<string, unknown>[],
) {
  const calls: Recorded[] = [];
  const tx = {
    $executeRaw: async () => 0,
    punchRecord: { findMany: async () => [] },
    attendanceModification: {
      findMany: async (args: unknown) => {
        calls.push({ model: 'attendanceModification', args });
        return modifications;
      },
    },
    user: {
      findMany: async (args: unknown) => {
        calls.push({ model: 'user', args });
        return users;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const service = new AttendanceHistoryService(
    prisma as never,
    { requireByUserId: async () => ({}) } as never,
    { getWeeklyOffDay: async () => 0 } as never,
    { getHolidayCalendar: async () => [] } as never,
    {
      getApprovedLeaveDates: async () => new Set<string>(),
      getEmployeesOnApprovedLeave: async () => new Set<string>(),
    } as never,
    { getShiftDurationHours: async () => 8 } as never,
    { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
  );

  return { service, calls };
}

const employee = {
  id: 'emp-1',
  siteId: 'site-1',
  shiftId: 'shift-1',
  companyId: 'co-1',
};
const caller = { userId: 'u-1', rls: { isSuperAdmin: true } } as never;

describe('AttendanceMonth.modifications (FR-012c)', () => {
  it('attaches a modification to its day, with the actor’s name', async () => {
    const { service } = serviceWith(
      [
        {
          employeeId: 'emp-1',
          date: new Date('2026-09-11T00:00:00.000Z'),
          actorUserId: 'admin-1',
          before: { inTime: null },
          after: { inTime: '09:05' },
          reason: 'Forgot to punch',
          createdAt: new Date('2026-09-12T04:30:00.000Z'),
        },
      ],
      [{ id: 'admin-1', displayName: 'Priya Sharma', email: 'p@x.test' }],
    );

    const month = await service.getMonthForEmployee(caller, employee, 9, 2026);
    const day = month.days.find((d) => d.date === '2026-09-11');

    expect(day?.modifications).toHaveLength(1);
    // A name, never a cuid: the requirement is that the employee can see *who* changed
    // their attendance, and an id does not tell them that.
    expect(day?.modifications[0].actorName).toBe('Priya Sharma');
    expect(day?.modifications[0].reason).toBe('Forgot to punch');
    expect(day?.modifications[0].before).toEqual({ inTime: null });
    expect(day?.modifications[0].after).toEqual({ inTime: '09:05' });
  });

  it('leaves an untouched day with an empty array, never undefined', async () => {
    const { service } = serviceWith([], []);
    const month = await service.getMonthForEmployee(caller, employee, 9, 2026);
    expect(month.days.every((d) => Array.isArray(d.modifications))).toBe(true);
    expect(month.days.every((d) => d.modifications.length === 0)).toBe(true);
  });

  it('costs one modification query for the month, however many days were modified', async () => {
    // The N+1 this file's own Risks note warns about for `statesOf`. A per-day lookup would
    // be 30 queries for a screen an employee opens every month.
    const rows = [11, 12, 13, 14].map((day) => ({
      employeeId: 'emp-1',
      date: new Date(`2026-09-${day}T00:00:00.000Z`),
      actorUserId: 'admin-1',
      before: {},
      after: {},
      reason: null,
      createdAt: new Date(`2026-09-${day}T05:00:00.000Z`),
    }));
    const { service, calls } = serviceWith(rows, [
      { id: 'admin-1', displayName: 'Priya Sharma', email: 'p@x.test' },
    ]);

    await service.getMonthForEmployee(caller, employee, 9, 2026);

    const modificationQueries = calls.filter(
      (c) => c.model === 'attendanceModification',
    );
    expect(modificationQueries).toHaveLength(1);
    // And one for the actors, not one per modification.
    expect(calls.filter((c) => c.model === 'user')).toHaveLength(1);
  });

  it('skips the actor query entirely when nothing was modified', async () => {
    const { service, calls } = serviceWith([], []);
    await service.getMonthForEmployee(caller, employee, 9, 2026);
    expect(calls.filter((c) => c.model === 'user')).toHaveLength(0);
  });

  it('falls back to the id if the actor row has vanished', async () => {
    // A blank name would read as "nobody changed it", which is the opposite of the truth.
    const { service } = serviceWith(
      [
        {
          employeeId: 'emp-1',
          date: new Date('2026-09-11T00:00:00.000Z'),
          actorUserId: 'deleted-user',
          before: {},
          after: {},
          reason: null,
          createdAt: new Date('2026-09-12T04:30:00.000Z'),
        },
      ],
      [],
    );
    const month = await service.getMonthForEmployee(caller, employee, 9, 2026);
    const day = month.days.find((d) => d.date === '2026-09-11');
    expect(day?.modifications[0].actorName).toBe('deleted-user');
  });

  it('records several changes to one day in the order they happened', async () => {
    const { service } = serviceWith(
      [
        {
          employeeId: 'emp-1',
          date: new Date('2026-09-11T00:00:00.000Z'),
          actorUserId: 'admin-1',
          before: {},
          after: { inTime: '09:00' },
          reason: 'first',
          createdAt: new Date('2026-09-12T04:00:00.000Z'),
        },
        {
          employeeId: 'emp-1',
          date: new Date('2026-09-11T00:00:00.000Z'),
          actorUserId: 'admin-1',
          before: { inTime: '09:00' },
          after: { inTime: '09:30' },
          reason: 'second',
          createdAt: new Date('2026-09-12T06:00:00.000Z'),
        },
      ],
      [{ id: 'admin-1', displayName: 'Priya Sharma', email: 'p@x.test' }],
    );
    const month = await service.getMonthForEmployee(caller, employee, 9, 2026);
    const day = month.days.find((d) => d.date === '2026-09-11');
    expect(day?.modifications.map((m) => m.reason)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('actorNameOf', () => {
  it('prefers a display name', () => {
    expect(
      actorNameOf({ displayName: 'Priya Sharma', email: 'p@x.test' }),
    ).toBe('Priya Sharma');
  });

  it('falls back through real name, handle, then email', () => {
    expect(
      actorNameOf({
        firstname: 'Priya',
        lastname: 'Sharma',
        email: 'p@x.test',
      }),
    ).toBe('Priya Sharma');
    expect(actorNameOf({ username: 'priya', email: 'p@x.test' })).toBe('priya');
    expect(actorNameOf({ email: 'p@x.test' })).toBe('p@x.test');
  });

  it('treats a whitespace-only display name as absent', () => {
    expect(
      actorNameOf({ displayName: '   ', username: 'priya', email: 'p@x.test' }),
    ).toBe('priya');
  });
});
