import { classifyExpiry } from './employee-documents.service';

/** Fixed "today" so these assertions never depend on when the suite runs. */
const TODAY = new Date('2026-09-02T00:00:00.000Z');
const WARNING_DAYS = 30;

const on = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('classifyExpiry (T029)', () => {
  it('reports no state at all for a document without an expiry', () => {
    // A document type that does not expire must not be reported as "valid for
    // ever" — it has no expiry dimension, which is different from having a
    // distant one.
    expect(classifyExpiry(null, TODAY, WARNING_DAYS)).toEqual({
      state: null,
      daysToExpiry: null,
    });
  });

  it('is valid well outside the warning window', () => {
    expect(classifyExpiry(on('2026-12-31'), TODAY, WARNING_DAYS)).toEqual({
      state: 'valid',
      daysToExpiry: 120,
    });
  });

  it('is expiring_soon exactly on the warning boundary', () => {
    // Inclusive boundary: 30 days out with a 30-day window already warns.
    expect(classifyExpiry(on('2026-10-02'), TODAY, WARNING_DAYS)).toEqual({
      state: 'expiring_soon',
      daysToExpiry: 30,
    });
  });

  it('is valid one day beyond the warning boundary', () => {
    expect(classifyExpiry(on('2026-10-03'), TODAY, WARNING_DAYS)).toEqual({
      state: 'valid',
      daysToExpiry: 31,
    });
  });

  it('is expiring_soon, not expired, on the expiry date itself', () => {
    // A licence is valid through its last day; treating today as expired would
    // block attendance a day early.
    expect(classifyExpiry(on('2026-09-02'), TODAY, WARNING_DAYS)).toEqual({
      state: 'expiring_soon',
      daysToExpiry: 0,
    });
  });

  it('is expired the day after, with a negative day count', () => {
    // Negative rather than clamped at zero so callers can sort expired documents
    // to the top by how long they have been overdue.
    expect(classifyExpiry(on('2026-09-01'), TODAY, WARNING_DAYS)).toEqual({
      state: 'expired',
      daysToExpiry: -1,
    });
  });

  it('reports how far past expiry a long-overdue document is', () => {
    expect(classifyExpiry(on('2026-06-04'), TODAY, WARNING_DAYS)).toEqual({
      state: 'expired',
      daysToExpiry: -90,
    });
  });

  it('honours a reconfigured warning window', () => {
    // The window is config, not a literal (Principle III) — a company that wants
    // 90 days' notice gets it without a code change.
    expect(classifyExpiry(on('2026-11-01'), TODAY, 90)).toEqual({
      state: 'expiring_soon',
      daysToExpiry: 60,
    });
  });

  it('ignores the time of day on both sides', () => {
    // Expiry is a calendar fact. A document expiring "today at 23:00" compared
    // against a "now" of 09:00 must not read as a fraction of a day.
    const lateToday = new Date('2026-09-02T23:30:00.000Z');
    const earlyNow = new Date('2026-09-02T00:30:00.000Z');
    expect(classifyExpiry(lateToday, earlyNow, WARNING_DAYS)).toEqual({
      state: 'expiring_soon',
      daysToExpiry: 0,
    });
  });
});
