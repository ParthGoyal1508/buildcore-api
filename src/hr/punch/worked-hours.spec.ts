import { computeWorkedHours } from './worked-hours';

const at = (iso: string) => new Date(iso);
const NINE_HOUR_SHIFT = 9;

describe('computeWorkedHours', () => {
  it('reports no overtime for exactly a full shift', () => {
    const result = computeWorkedHours(
      at('2026-08-30T09:00:00Z'),
      at('2026-08-30T18:00:00Z'),
      NINE_HOUR_SHIFT,
    );
    expect(result).toEqual({ workedHours: 9, otHours: 0 });
  });

  it('counts hours beyond the shift as overtime', () => {
    const result = computeWorkedHours(
      at('2026-08-30T09:00:00Z'),
      at('2026-08-30T20:30:00Z'),
      NINE_HOUR_SHIFT,
    );
    expect(result).toEqual({ workedHours: 11.5, otHours: 2.5 });
  });

  it('reports no negative overtime for a short day', () => {
    const result = computeWorkedHours(
      at('2026-08-30T09:00:00Z'),
      at('2026-08-30T13:00:00Z'),
      NINE_HOUR_SHIFT,
    );
    expect(result).toEqual({ workedHours: 4, otHours: 0 });
  });

  it('handles a pair spanning midnight', () => {
    const result = computeWorkedHours(
      at('2026-08-30T22:00:00Z'),
      at('2026-08-31T07:00:00Z'),
      8,
    );
    expect(result).toEqual({ workedHours: 9, otHours: 1 });
  });

  it('rounds to two decimals rather than carrying float noise into payroll', () => {
    const result = computeWorkedHours(
      at('2026-08-30T09:00:00Z'),
      at('2026-08-30T18:20:00Z'),
      NINE_HOUR_SHIFT,
    );
    expect(result.workedHours).toBe(9.33);
    expect(result.otHours).toBe(0.33);
  });

  it('treats an out-before-in pair as zero rather than negative hours', () => {
    // Bad data must not credit or debit hours in payroll.
    const result = computeWorkedHours(
      at('2026-08-30T18:00:00Z'),
      at('2026-08-30T09:00:00Z'),
      NINE_HOUR_SHIFT,
    );
    expect(result).toEqual({ workedHours: 0, otHours: 0 });
  });
});
