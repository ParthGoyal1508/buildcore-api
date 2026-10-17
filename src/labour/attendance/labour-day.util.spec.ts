import { AttendanceType } from '@prisma/client';

import {
  DEFAULT_LABOUR_DAY_RULES,
  deriveLabourDay,
  labourDayRulesProblem,
  musterLineFor,
} from './labour-day.util';

const at = (hhmm: string, day = '2026-10-10') =>
  new Date(`${day}T${hhmm}:00+05:30`);
const rules = DEFAULT_LABOUR_DAY_RULES;

describe('deriveLabourDay', () => {
  it('counts 8 hours or more as a full day, with overtime beyond the standard shift', () => {
    const day = deriveLabourDay(at('08:00'), at('18:30'), true, rules);
    expect(day).toEqual({
      status: 'full_day',
      flag: null,
      hours: 10.5,
      overtimeHours: 2.5,
    });
    expect(musterLineFor(day)).toEqual({
      attendanceType: AttendanceType.full_day,
      overtimeHours: 2.5,
    });
  });

  it('counts 4 to 8 hours as a half day and fewer as short', () => {
    expect(deriveLabourDay(at('09:00'), at('13:00'), true, rules).status).toBe(
      'half_day',
    );
    const short = deriveLabourDay(at('09:00'), at('12:59'), true, rules);
    expect(short.status).toBe('short');
    expect(musterLineFor(short)).toEqual({
      attendanceType: AttendanceType.absent,
      overtimeHours: null,
    });
  });

  it('flags a missing punch out on an earlier day, and is on site today', () => {
    const past = deriveLabourDay(at('09:00'), null, true, rules);
    expect(past).toMatchObject({
      status: 'unresolved',
      flag: 'missing_punch_out',
    });
    expect(musterLineFor(past)).toBeNull();
    expect(deriveLabourDay(at('09:00'), null, false, rules)).toMatchObject({
      status: 'on_site',
      flag: null,
    });
  });

  it('flags a punch out without a punch in, and one before the punch in', () => {
    expect(deriveLabourDay(null, at('18:00'), true, rules).flag).toBe(
      'missing_punch_in',
    );
    const backwards = deriveLabourDay(at('18:00'), at('09:00'), true, rules);
    expect(backwards).toMatchObject({
      status: 'unresolved',
      flag: 'out_before_in',
    });
    expect(musterLineFor(backwards)).toBeNull();
  });

  it('follows the company thresholds', () => {
    const day = deriveLabourDay(at('09:00'), at('16:00'), true, {
      fullDayHours: 7,
      halfDayHours: 3.5,
      standardHours: 6,
    });
    expect(day).toMatchObject({
      status: 'full_day',
      hours: 7,
      overtimeHours: 1,
    });
  });
});

describe('labourDayRulesProblem', () => {
  it('accepts the defaults and refuses a half day not shorter than a full day', () => {
    expect(labourDayRulesProblem(rules)).toBeNull();
    expect(
      labourDayRulesProblem({
        fullDayHours: 6,
        halfDayHours: 6,
        standardHours: 8,
      }),
    ).toMatch(/fewer/);
    expect(
      labourDayRulesProblem({
        fullDayHours: 25,
        halfDayHours: 4,
        standardHours: 8,
      }),
    ).toMatch(/at most 24/);
  });
});
