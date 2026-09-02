import {
  dayCompliance,
  minutesOf,
  summarise,
  type ShiftWindow,
} from './shift-compliance';

/** 09:00–18:00 with 15 minutes' grace. */
const SHIFT: ShiftWindow = {
  inTime: '09:00',
  outTime: '18:00',
  graceMinutes: 15,
};

describe('minutesOf', () => {
  it('converts HH:mm to minutes since midnight', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('23:59')).toBe(1439);
  });
});

describe('dayCompliance — markers', () => {
  it('reports no_shift_assigned rather than zero minutes late', () => {
    // Zero would read as perfect punctuality; the truth is that nobody
    // configured a shift to measure against (FR-062).
    const r = dayCompliance(null, { inTime: '10:30', outTime: '18:00' });
    expect(r.marker).toBe('no_shift_assigned');
    expect(r.lateMinutes).toBe(0);
  });

  it('reports no_punch_times for a day with neither punch', () => {
    const r = dayCompliance(SHIFT, { inTime: null, outTime: null });
    expect(r.marker).toBe('no_punch_times');
    expect(r.lateMinutes).toBe(0);
  });

  it('excludes approved leave and holidays entirely', () => {
    const r = dayCompliance(
      SHIFT,
      { inTime: null, outTime: null },
      { excluded: true },
    );
    expect(r.marker).toBe('excluded');
  });
});

describe('dayCompliance — lateness', () => {
  it('is not late within the grace period', () => {
    expect(
      dayCompliance(SHIFT, { inTime: '09:15', outTime: '18:00' }).lateMinutes,
    ).toBe(0);
  });

  it('counts only the minutes beyond grace', () => {
    // 09:20 is 20 minutes after start, but grace absorbs 15 of them.
    expect(
      dayCompliance(SHIFT, { inTime: '09:20', outTime: '18:00' }).lateMinutes,
    ).toBe(5);
  });

  it('is never negative for an early arrival', () => {
    expect(
      dayCompliance(SHIFT, { inTime: '08:30', outTime: '18:00' }).lateMinutes,
    ).toBe(0);
  });
});

describe('dayCompliance — early departure and short hours', () => {
  it('counts minutes left before the shift ends', () => {
    const r = dayCompliance(SHIFT, { inTime: '09:00', outTime: '17:30' });
    expect(r.earlyDepartureMinutes).toBe(30);
    expect(r.shortHours).toBe(0.5);
  });

  it('is not early for staying past the shift', () => {
    const r = dayCompliance(SHIFT, { inTime: '09:00', outTime: '19:00' });
    expect(r.earlyDepartureMinutes).toBe(0);
    expect(r.shortHours).toBe(0);
  });

  it('reports short hours even when neither late nor early', () => {
    // A long break recorded as a second punch pair would show up here; arriving
    // and leaving on time does not by itself prove a full shift was worked.
    const r = dayCompliance(
      { inTime: '09:00', outTime: '18:00', graceMinutes: 0 },
      { inTime: '09:00', outTime: '18:00' },
    );
    expect(r.shortHours).toBe(0);
  });

  it('handles a shift crossing midnight', () => {
    const night: ShiftWindow = {
      inTime: '22:00',
      outTime: '06:00',
      graceMinutes: 0,
    };
    const r = dayCompliance(night, { inTime: '22:00', outTime: '06:00' });
    expect(r.shortHours).toBe(0);
    expect(r.lateMinutes).toBe(0);
  });
});

describe('summarise', () => {
  const late = (mins: number) => ({
    marker: 'ok' as const,
    lateMinutes: mins,
    earlyDepartureMinutes: 0,
    shortHours: 0,
  });

  it('counts late days and total minutes', () => {
    const s = summarise([late(5), late(0), late(20)], 3);
    expect(s.lateDays).toBe(2);
    expect(s.totalLateMinutes).toBe(25);
  });

  it('flags a repeat late-comer at the configured threshold', () => {
    expect(summarise([late(1), late(1), late(1)], 3).repeatLateComer).toBe(true);
    expect(summarise([late(1), late(1)], 3).repeatLateComer).toBe(false);
  });

  it('counts the unmeasurable days separately from punctual ones', () => {
    const s = summarise(
      [
        { marker: 'no_shift_assigned', lateMinutes: 0, earlyDepartureMinutes: 0, shortHours: 0 },
        { marker: 'no_punch_times', lateMinutes: 0, earlyDepartureMinutes: 0, shortHours: 0 },
        late(0),
      ],
      3,
    );
    expect(s.daysWithoutShift).toBe(1);
    expect(s.daysWithoutPunchTimes).toBe(1);
    // Critically, none of these count as late days.
    expect(s.lateDays).toBe(0);
  });
});
