import { isPayrollLocked } from './payroll-lock';

describe('isPayrollLocked', () => {
  const LOCK_DAY = 7;
  const utc = (iso: string) => new Date(iso);
  /** These cases were written against UTC semantics; naming the zone keeps their
   * original intent exact rather than re-deriving every expectation. */
  const UTC = 'UTC';
  const IST = 'Asia/Kolkata';

  it('leaves the current month open regardless of the lock day', () => {
    // Well past the lock day, but the punch is in the month still being collected.
    const now = utc('2026-08-20T10:00:00Z');
    expect(isPayrollLocked(utc('2026-08-19T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      false,
    );
  });

  it('leaves last month open before the lock day arrives', () => {
    const now = utc('2026-08-05T10:00:00Z');
    expect(isPayrollLocked(utc('2026-07-31T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      false,
    );
  });

  it('locks last month once the lock day is reached', () => {
    // The boundary itself: on the lock day, the previous period closes.
    const now = utc('2026-08-07T00:00:00Z');
    expect(isPayrollLocked(utc('2026-07-31T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      true,
    );
  });

  it('locks anything two or more months back', () => {
    const now = utc('2026-08-01T10:00:00Z');
    expect(isPayrollLocked(utc('2026-06-30T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      true,
    );
  });

  it('handles a year boundary', () => {
    const now = utc('2027-01-10T10:00:00Z');
    expect(isPayrollLocked(utc('2026-12-31T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      true,
    );
    expect(isPayrollLocked(utc('2027-01-02T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      false,
    );
  });

  describe('reckons the day in the configured zone', () => {
    // The bug this guards: `capturedAt` is an instant, and reading it in UTC files
    // a punch made just after local midnight under the previous day — which at the
    // turn of a month means the previous *period*, closing the lock a day early on
    // a punch that is not late at all.
    it('treats a post-midnight IST punch as the new month, not the old one', () => {
      // 2026-09-01T00:30 IST — still 31 August in UTC.
      const punch = utc('2026-08-31T19:00:00Z');
      const now = utc('2026-10-08T04:00:00Z'); // 8 Oct IST, past the lock day.

      // In IST the punch is in September: exactly last month, and locked only
      // because October has passed the lock day.
      expect(isPayrollLocked(punch, LOCK_DAY, now, IST)).toBe(true);
      // Read in UTC it lands in August — two months back — which is the same
      // verdict for the wrong reason. The distinction shows before the lock day:
      const beforeLockDay = utc('2026-10-03T04:00:00Z');
      expect(isPayrollLocked(punch, LOCK_DAY, beforeLockDay, IST)).toBe(false);
      expect(isPayrollLocked(punch, LOCK_DAY, beforeLockDay, UTC)).toBe(true);
    });

    it('does not close the period early on the lock day itself in IST', () => {
      // 2026-09-07T02:00 IST is the lock day locally, but still 6 September UTC.
      const now = utc('2026-09-06T20:30:00Z');
      const lastMonth = utc('2026-08-20T09:00:00Z');
      expect(isPayrollLocked(lastMonth, LOCK_DAY, now, IST)).toBe(true);
      expect(isPayrollLocked(lastMonth, LOCK_DAY, now, UTC)).toBe(false);
    });
  });

  it('does not lock a future-dated punch', () => {
    // Out-of-window future punches are the offline-age check's job, not the lock's.
    const now = utc('2026-08-20T10:00:00Z');
    expect(isPayrollLocked(utc('2026-09-01T09:00:00Z'), LOCK_DAY, now, UTC)).toBe(
      false,
    );
  });
});
