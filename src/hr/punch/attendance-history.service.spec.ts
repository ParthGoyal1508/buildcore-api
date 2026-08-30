import { statusForDay } from './attendance-history.service';

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
