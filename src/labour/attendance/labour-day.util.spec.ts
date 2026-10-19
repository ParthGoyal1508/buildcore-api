import { AttendanceType, LabourPunchType } from '@prisma/client';

import {
  DEFAULT_LABOUR_DAY_RULES,
  deriveLabourDay,
  labourDayRulesProblem,
  musterLineFor,
  openShiftDate,
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

describe('openShiftDate (036 O5)', () => {
  const utc = (iso: string) => new Date(iso);
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
  // 20:00 IST on 16 Oct is 14:30 UTC.
  const nightIn = {
    punchDate: day('2026-10-16'),
    type: LabourPunchType.in,
    punchedAt: utc('2026-10-16T14:30:00.000Z'),
  };

  it("closes yesterday's punch-in within 16 hours — a night shift", () => {
    // 04:00 IST on 17 Oct.
    expect(
      openShiftDate([nightIn], utc('2026-10-16T22:30:00.000Z'), '2026-10-17'),
    ).toBe('2026-10-16');
  });

  it("will not close yesterday's punch-in after 16 hours", () => {
    expect(
      openShiftDate([nightIn], utc('2026-10-17T07:00:00.000Z'), '2026-10-17'),
    ).toBeNull();
  });

  it('will not close a punch-in that already has its punch-out', () => {
    const out = {
      punchDate: day('2026-10-16'),
      type: LabourPunchType.out,
      punchedAt: utc('2026-10-16T20:00:00.000Z'),
    };
    expect(
      openShiftDate(
        [nightIn, out],
        utc('2026-10-16T22:00:00.000Z'),
        '2026-10-17',
      ),
    ).toBeNull();
  });

  it('only ever closes the latest punch-in', () => {
    const todayIn = {
      punchDate: day('2026-10-17'),
      type: LabourPunchType.in,
      punchedAt: utc('2026-10-17T00:30:00.000Z'),
    };
    const todayOut = {
      punchDate: day('2026-10-17'),
      type: LabourPunchType.out,
      punchedAt: utc('2026-10-17T01:30:00.000Z'),
    };
    expect(
      openShiftDate(
        [nightIn, todayIn, todayOut],
        utc('2026-10-17T02:30:00.000Z'),
        '2026-10-17',
      ),
    ).toBeNull();
  });

  it("keeps today's own punch-in open however long ago it was", () => {
    const earlyIn = {
      punchDate: day('2026-10-17'),
      type: LabourPunchType.in,
      punchedAt: utc('2026-10-16T19:00:00.000Z'),
    };
    expect(
      openShiftDate([earlyIn], utc('2026-10-17T18:00:00.000Z'), '2026-10-17'),
    ).toBe('2026-10-17');
  });
});
