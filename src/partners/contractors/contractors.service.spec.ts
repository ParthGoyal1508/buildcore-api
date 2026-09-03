import { EXPIRY_WARNING_DAYS, expiryWarningFor } from './contractors.service';

describe('expiryWarningFor (FR-005 document expiry)', () => {
  const now = new Date('2026-09-03T00:00:00Z');

  it('warns for a document expiring inside the window', () => {
    const soon = new Date('2026-09-20T00:00:00Z');
    expect(expiryWarningFor(soon, now)).toBe(true);
  });

  it('warns for one that has already expired', () => {
    // Past expiry is more urgent than imminent expiry, not less — a rule that only
    // looked forward would stop warning the moment the licence actually lapsed.
    expect(expiryWarningFor(new Date('2026-08-01T00:00:00Z'), now)).toBe(true);
  });

  it('does not warn beyond the window', () => {
    const far = new Date(now);
    far.setDate(far.getDate() + EXPIRY_WARNING_DAYS + 1);
    expect(expiryWarningFor(far, now)).toBe(false);
  });

  it('warns exactly on the boundary', () => {
    const boundary = new Date(now);
    boundary.setDate(boundary.getDate() + EXPIRY_WARNING_DAYS);
    expect(expiryWarningFor(boundary, now)).toBe(true);
  });

  it('does not warn when there is no expiry date', () => {
    // A permanent registration is not "expiring today"; treating a null date as an
    // expiry would flag every document that legitimately has none.
    expect(expiryWarningFor(null, now)).toBe(false);
  });
});
