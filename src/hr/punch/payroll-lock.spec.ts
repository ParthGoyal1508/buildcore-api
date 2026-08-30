import { isPayrollLocked } from './payroll-lock';

describe('isPayrollLocked', () => {
  const LOCK_DAY = 7;
  const utc = (iso: string) => new Date(iso);

  it('leaves the current month open regardless of the lock day', () => {
    // Well past the lock day, but the punch is in the month still being collected.
    const now = utc('2026-08-20T10:00:00Z');
    expect(isPayrollLocked(utc('2026-08-19T09:00:00Z'), LOCK_DAY, now)).toBe(
      false,
    );
  });

  it('leaves last month open before the lock day arrives', () => {
    const now = utc('2026-08-05T10:00:00Z');
    expect(isPayrollLocked(utc('2026-07-31T09:00:00Z'), LOCK_DAY, now)).toBe(
      false,
    );
  });

  it('locks last month once the lock day is reached', () => {
    // The boundary itself: on the lock day, the previous period closes.
    const now = utc('2026-08-07T00:00:00Z');
    expect(isPayrollLocked(utc('2026-07-31T09:00:00Z'), LOCK_DAY, now)).toBe(
      true,
    );
  });

  it('locks anything two or more months back', () => {
    const now = utc('2026-08-01T10:00:00Z');
    expect(isPayrollLocked(utc('2026-06-30T09:00:00Z'), LOCK_DAY, now)).toBe(
      true,
    );
  });

  it('handles a year boundary', () => {
    const now = utc('2027-01-10T10:00:00Z');
    expect(isPayrollLocked(utc('2026-12-31T09:00:00Z'), LOCK_DAY, now)).toBe(
      true,
    );
    expect(isPayrollLocked(utc('2027-01-02T09:00:00Z'), LOCK_DAY, now)).toBe(
      false,
    );
  });

  it('does not lock a future-dated punch', () => {
    // Out-of-window future punches are the offline-age check's job, not the lock's.
    const now = utc('2026-08-20T10:00:00Z');
    expect(isPayrollLocked(utc('2026-09-01T09:00:00Z'), LOCK_DAY, now)).toBe(
      false,
    );
  });
});
