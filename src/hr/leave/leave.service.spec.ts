import {
  countLeaveDays,
  eachDateInRange,
  financialYearOf,
  parseDateOnly,
  toDateOnly,
} from './leave-days';

/**
 * The leave day-count rule (T048, spec FR-019).
 *
 * Tested through the pure function rather than the service: this number is what a
 * balance is debited by, and the cases that actually go wrong — a range that is
 * entirely non-working, a holiday that also falls on the weekly off, a month
 * boundary — are calendar arithmetic, not database behaviour.
 */
describe('leave-days', () => {
  describe('countLeaveDays', () => {
    // 2026-09-14 is a Monday; the week runs Mon 14 → Sun 20.
    const MONDAY = '2026-09-14';
    const SUNDAY = '2026-09-20';
    const SUNDAY_OFF = 0;

    it('counts every day of a range with no weekly off or holiday in it', () => {
      expect(countLeaveDays(MONDAY, '2026-09-16', SUNDAY_OFF, [])).toBe(3);
    });

    it('counts a single day as one', () => {
      expect(countLeaveDays(MONDAY, MONDAY, SUNDAY_OFF, [])).toBe(1);
    });

    it('excludes the weekly off day', () => {
      // Mon–Sun is seven dates, of which the Sunday is not a working day.
      expect(countLeaveDays(MONDAY, SUNDAY, SUNDAY_OFF, [])).toBe(6);
    });

    it('excludes site holidays', () => {
      expect(
        countLeaveDays(MONDAY, '2026-09-16', SUNDAY_OFF, ['2026-09-15']),
      ).toBe(2);
    });

    it('does not double-count a holiday that falls on the weekly off', () => {
      // The Sunday is excluded once, not twice — otherwise the count would go
      // negative on a week with several such collisions.
      expect(countLeaveDays(MONDAY, SUNDAY, SUNDAY_OFF, [SUNDAY])).toBe(6);
    });

    it('returns zero when the range contains no working day at all', () => {
      expect(countLeaveDays(SUNDAY, SUNDAY, SUNDAY_OFF, [])).toBe(0);
    });

    it('honours a non-Sunday weekly off', () => {
      // Friday off (5): Mon–Sun loses the Friday instead of the Sunday.
      expect(countLeaveDays(MONDAY, SUNDAY, 5, [])).toBe(6);
      expect(countLeaveDays('2026-09-18', '2026-09-18', 5, [])).toBe(0);
    });

    it('spans a month boundary', () => {
      // 2026-09-30 (Wed) → 2026-10-02 (Fri): three working days.
      expect(countLeaveDays('2026-09-30', '2026-10-02', SUNDAY_OFF, [])).toBe(
        3,
      );
    });

    it('ignores holidays outside the range', () => {
      expect(
        countLeaveDays(MONDAY, '2026-09-16', SUNDAY_OFF, ['2026-10-02']),
      ).toBe(3);
    });
  });

  describe('eachDateInRange', () => {
    it('is inclusive at both ends', () => {
      expect(eachDateInRange('2026-09-14', '2026-09-16')).toEqual([
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
      ]);
    });

    it('crosses a leap-year February without dropping a day', () => {
      expect(eachDateInRange('2028-02-27', '2028-03-01')).toEqual([
        '2028-02-27',
        '2028-02-28',
        '2028-02-29',
        '2028-03-01',
      ]);
    });

    it('returns nothing when the end precedes the start', () => {
      expect(eachDateInRange('2026-09-16', '2026-09-14')).toEqual([]);
    });
  });

  describe('parseDateOnly / toDateOnly', () => {
    it('round-trips a calendar date', () => {
      expect(toDateOnly(parseDateOnly('2026-09-14'))).toBe('2026-09-14');
    });

    it('rejects anything that is not YYYY-MM-DD', () => {
      // Including a full ISO instant: accepting one would smuggle a timezone into
      // arithmetic that must stay calendar-only.
      expect(() => parseDateOnly('2026-09-14T10:00:00Z')).toThrow(RangeError);
      expect(() => parseDateOnly('14-09-2026')).toThrow(RangeError);
    });

    it('rejects a date that does not exist', () => {
      expect(() => parseDateOnly('2026-02-30')).toThrow(RangeError);
    });
  });

  describe('financialYearOf', () => {
    it('starts a new financial year on 1 April', () => {
      expect(financialYearOf(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
      expect(financialYearOf(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    });

    it('keeps January to March in the previous year’s label', () => {
      expect(financialYearOf(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
    });

    it('pads a century rollover to two digits', () => {
      expect(financialYearOf(new Date('2099-05-01T00:00:00Z'))).toBe('2099-00');
    });
  });
});
