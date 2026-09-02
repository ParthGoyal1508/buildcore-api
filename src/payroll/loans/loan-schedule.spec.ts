import { generateSchedule, nextPeriod, periodOf } from './loan-schedule';

describe('nextPeriod', () => {
  it('advances within a year', () => {
    expect(nextPeriod('2026-09')).toBe('2026-10');
  });

  it('rolls over at December', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01');
  });

  it('keeps the two-digit month padding', () => {
    expect(nextPeriod('2026-08')).toBe('2026-09');
    expect(nextPeriod('2027-01')).toBe('2027-02');
  });
});

describe('periodOf', () => {
  it('derives the period key from a date', () => {
    expect(periodOf(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09');
    expect(periodOf(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });
});

describe('generateSchedule', () => {
  it('divides a principal that splits evenly', () => {
    const s = generateSchedule(30000, 10000, '2026-10');
    expect(s).toHaveLength(3);
    expect(s.map((e) => e.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(s.map((e) => e.emiAmount)).toEqual([10000, 10000, 10000]);
    expect(s.map((e) => e.remainingBalance)).toEqual([20000, 10000, 0]);
  });

  it('makes the final instalment the remainder, not a full EMI', () => {
    // 25000 at 10000/month is 2 full instalments and 5000 left. Charging a third
    // full EMI would recover 30000 against a 25000 advance.
    const s = generateSchedule(25000, 10000, '2026-10');
    expect(s).toHaveLength(3);
    expect(s.map((e) => e.emiAmount)).toEqual([10000, 10000, 5000]);
    expect(s[2].remainingBalance).toBe(0);
  });

  it('recovers exactly the principal, never more', () => {
    for (const [amount, emi] of [
      [25000, 10000],
      [33333, 7777],
      [1000, 999],
      [12345.67, 1000],
    ]) {
      const s = generateSchedule(amount, emi, '2026-10');
      const recovered = s.reduce((a, e) => a + e.emiAmount, 0);
      expect(Math.round(recovered * 100) / 100).toBe(
        Math.round(amount * 100) / 100,
      );
      expect(s[s.length - 1].remainingBalance).toBe(0);
    }
  });

  it('rolls the schedule across a year boundary', () => {
    const s = generateSchedule(30000, 10000, '2026-11');
    expect(s.map((e) => e.month)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('produces a single instalment when the EMI covers the whole loan', () => {
    const s = generateSchedule(5000, 10000, '2026-10');
    expect(s).toHaveLength(1);
    expect(s[0].emiAmount).toBe(5000);
    expect(s[0].remainingBalance).toBe(0);
  });

  it('carries a zero interest line on every entry', () => {
    // These are interest-free advances. The column exists so an interest-bearing
    // variant is a value change rather than a migration.
    const s = generateSchedule(20000, 10000, '2026-10');
    expect(s.every((e) => e.interest === 0)).toBe(true);
    expect(s.every((e) => e.principal === e.emiAmount)).toBe(true);
  });

  it('rejects a non-positive amount or EMI', () => {
    expect(() => generateSchedule(0, 1000, '2026-10')).toThrow(/positive/);
    expect(() => generateSchedule(1000, 0, '2026-10')).toThrow(/positive/);
  });

  it('refuses a schedule that would never realistically end', () => {
    expect(() => generateSchedule(1_000_000, 1, '2026-10')).toThrow(/600/);
  });
});
