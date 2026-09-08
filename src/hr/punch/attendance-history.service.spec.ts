import {
  AttendanceHistoryService,
  statusForDay,
} from './attendance-history.service';

/**
 * The per-day attendance rule (T041, research.md §6).
 *
 * Tested through the pure function because what matters here is precedence — which
 * fact wins when several are true of the same day — and that is decided entirely by
 * the five booleans below, with no database in the way.
 */
describe('statusForDay', () => {
  const SUNDAY = 0;
  const WEDNESDAY = 3;
  const facts = (overrides: Partial<Parameters<typeof statusForDay>[0]> = {}) =>
    statusForDay({
      dayOfWeek: WEDNESDAY,
      weeklyOffDay: SUNDAY,
      isHoliday: false,
      isOnApprovedLeave: false,
      hasPunch: false,
      ...overrides,
    });

  it('is present when the employee punched', () => {
    expect(facts({ hasPunch: true })).toBe('present');
  });

  it('is on leave when approved leave covers the day', () => {
    expect(facts({ isOnApprovedLeave: true })).toBe('on_leave');
  });

  it('is a holiday when the site calendar says so', () => {
    expect(facts({ isHoliday: true })).toBe('holiday');
  });

  it('is a weekly off on the site’s configured off day', () => {
    expect(facts({ dayOfWeek: SUNDAY })).toBe('weekly_off');
  });

  it('is absent on a working day with nothing recorded', () => {
    expect(facts()).toBe('absent');
  });

  describe('precedence', () => {
    it('reports present over a holiday', () => {
      // Someone who actually turned up on a holiday worked that day; reporting it
      // as a holiday would erase the day they worked.
      expect(facts({ hasPunch: true, isHoliday: true })).toBe('present');
    });

    it('reports present over a weekly off', () => {
      expect(facts({ hasPunch: true, dayOfWeek: SUNDAY })).toBe('present');
    });

    it('reports present over approved leave', () => {
      expect(facts({ hasPunch: true, isOnApprovedLeave: true })).toBe(
        'present',
      );
    });

    it('reports on leave over a holiday', () => {
      // The employee was charged for the leave, so it should read as leave rather
      // than as a day that cost them nothing.
      expect(facts({ isOnApprovedLeave: true, isHoliday: true })).toBe(
        'on_leave',
      );
    });

    it('reports on leave over a weekly off', () => {
      expect(facts({ isOnApprovedLeave: true, dayOfWeek: SUNDAY })).toBe(
        'on_leave',
      );
    });

    it('reports a holiday over a weekly off', () => {
      expect(facts({ isHoliday: true, dayOfWeek: SUNDAY })).toBe('holiday');
    });
  });
});

/**
 * The batch form of the same rule, used by the admin Daily Register
 * (005 amendment 2026-09-08, FR-069).
 *
 * `statusForDay` above already settles precedence; what matters here is the
 * fan-out around it — that site facts are read once per site rather than once per
 * employee, that leave is one query for the whole roster, and that the caller's
 * punch answer is the one used.
 */
describe('AttendanceHistoryService.statusesForDate', () => {
  const WEDNESDAY = '2026-09-09';

  const EMPLOYEES = [
    { id: 'emp-1', siteId: 'site-1' },
    { id: 'emp-2', siteId: 'site-1' },
    { id: 'emp-3', siteId: 'site-2' },
  ];

  function build(
    over: { holidays?: Record<string, string[]>; onLeave?: string[] } = {},
  ) {
    const sites = {
      // site-2's weekly off falls on the date under test; site-1's does not.
      getWeeklyOffDay: jest.fn(async (_ctx: unknown, siteId: string) =>
        siteId === 'site-2' ? 3 : 0,
      ),
    };
    const holidays = {
      getHolidayCalendar: jest.fn(
        async (_c: unknown, _co: string, siteId: string) =>
          (over.holidays ?? {})[siteId] ?? [],
      ),
    };
    const leave = {
      getEmployeesOnApprovedLeave: jest
        .fn()
        .mockResolvedValue(new Set(over.onLeave ?? [])),
    };

    const service = new AttendanceHistoryService(
      {} as never,
      {} as never,
      sites as never,
      holidays as never,
      leave as never,
      {} as never,
      { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
    );

    return { service, sites, holidays, leave };
  }

  const rls = { companyId: 'co-1', isSuperAdmin: false };
  const caller = { userId: 'u1', rls } as never;

  it('derives each employee from their own site’s calendar', async () => {
    const { service } = build({ holidays: { 'site-1': [WEDNESDAY] } });

    const statuses = await service.statusesForDate(
      caller,
      'co-1',
      EMPLOYEES,
      WEDNESDAY,
      () => false,
    );

    // Same date, same company, three employees, three different answers — the
    // holiday is declared for site-1 only and the weekly off is site-2's.
    expect(statuses.get('emp-1')).toBe('holiday');
    expect(statuses.get('emp-2')).toBe('holiday');
    expect(statuses.get('emp-3')).toBe('weekly_off');
  });

  it('reads site facts once per site, not once per employee', async () => {
    const { service, sites, holidays } = build();

    await service.statusesForDate(
      caller,
      'co-1',
      EMPLOYEES,
      WEDNESDAY,
      () => false,
    );

    expect(sites.getWeeklyOffDay).toHaveBeenCalledTimes(2);
    expect(holidays.getHolidayCalendar).toHaveBeenCalledTimes(2);
  });

  it('asks for the whole roster’s leave in one call', async () => {
    const { service, leave } = build({ onLeave: ['emp-2'] });

    const statuses = await service.statusesForDate(
      caller,
      'co-1',
      EMPLOYEES,
      WEDNESDAY,
      () => false,
    );

    expect(leave.getEmployeesOnApprovedLeave).toHaveBeenCalledTimes(1);
    expect(leave.getEmployeesOnApprovedLeave).toHaveBeenCalledWith(
      rls,
      ['emp-1', 'emp-2', 'emp-3'],
      WEDNESDAY,
    );
    expect(statuses.get('emp-2')).toBe('on_leave');
    expect(statuses.get('emp-1')).toBe('absent');
  });

  it('uses the caller’s punch answer', async () => {
    const { service } = build();

    const statuses = await service.statusesForDate(
      caller,
      'co-1',
      EMPLOYEES,
      WEDNESDAY,
      (id) => id === 'emp-1',
    );

    expect(statuses.get('emp-1')).toBe('present');
    expect(statuses.get('emp-2')).toBe('absent');
  });

  it('returns an empty map for an empty roster without querying anything', async () => {
    const { service, sites, leave } = build();

    const statuses = await service.statusesForDate(
      caller,
      'co-1',
      [],
      WEDNESDAY,
      () => false,
    );

    expect(statuses.size).toBe(0);
    expect(sites.getWeeklyOffDay).not.toHaveBeenCalled();
    expect(leave.getEmployeesOnApprovedLeave).not.toHaveBeenCalled();
  });
});
