import { businessToday, businessTodayIso } from './business-date';

describe('businessToday (036)', () => {
  it('is the Indian date, not the UTC one, before 05:30 IST', () => {
    // 00:30 IST on 17 Oct is still 16 Oct in UTC — the hour a UTC "today" refused today.
    const halfPastMidnightIst = new Date('2026-10-16T19:00:00.000Z');
    expect(businessTodayIso(halfPastMidnightIst)).toBe('2026-10-17');
    expect(businessToday(halfPastMidnightIst).toISOString()).toBe(
      '2026-10-17T00:00:00.000Z',
    );
  });

  it('agrees with UTC later in the day', () => {
    expect(businessTodayIso(new Date('2026-10-17T12:00:00.000Z'))).toBe(
      '2026-10-17',
    );
  });
});
