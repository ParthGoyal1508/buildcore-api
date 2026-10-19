import { MeterType } from '@prisma/client';

import { hasReadingGap, readingProblem } from './logbook-readings';

const base = {
  date: '2026-10-10',
  dateValue: new Date('2026-10-10T00:00:00.000Z'),
  today: new Date('2026-10-17T00:00:00.000Z'),
  meterType: MeterType.hours,
  openingReading: 1000,
  closingReading: 1008,
  previousClosing: 1000,
};

describe('readingProblem (036 K4)', () => {
  it('accepts a day that follows on from the previous one', () => {
    expect(readingProblem(base)).toBeNull();
  });

  it('accepts today', () => {
    expect(readingProblem({ ...base, dateValue: base.today })).toBeNull();
  });

  it('refuses a future date', () => {
    expect(
      readingProblem({
        ...base,
        date: '2062-10-10',
        dateValue: new Date('2062-10-10T00:00:00.000Z'),
      }),
    ).toMatch(/in the future/);
  });

  it('refuses more than 24 hours a day on an hour meter', () => {
    expect(readingProblem({ ...base, closingReading: 1024.5 })).toMatch(
      /more than 24/,
    );
    expect(readingProblem({ ...base, closingReading: 1024 })).toBeNull();
  });

  it('puts no daily ceiling on a km meter', () => {
    expect(
      readingProblem({
        ...base,
        meterType: MeterType.km,
        closingReading: 1400,
      }),
    ).toBeNull();
  });

  it('refuses an opening reading that does not follow the previous closing one', () => {
    expect(readingProblem({ ...base, previousClosing: 990 })).toMatch(
      /does not follow on from the previous closing reading 990/,
    );
  });

  it('accepts the gap when a reason is given', () => {
    expect(
      readingProblem({
        ...base,
        previousClosing: 990,
        readingGapReason: 'Meter replaced',
      }),
    ).toBeNull();
    expect(
      readingProblem({ ...base, previousClosing: 990, readingGapReason: '  ' }),
    ).not.toBeNull();
  });

  it('has nothing to compare for the first entry', () => {
    expect(readingProblem({ ...base, previousClosing: null })).toBeNull();
  });

  it('compares in thousandths, so float noise is not a gap', () => {
    expect(hasReadingGap(0.1 + 0.2, 0.3)).toBe(false);
    expect(hasReadingGap(1000, 1000.001)).toBe(true);
  });
});
