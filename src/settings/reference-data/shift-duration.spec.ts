import { shiftDurationHours } from './reference-data.service';

/** Postgres `time` values reach Prisma as Dates on an arbitrary epoch day, so only
 * the time-of-day component is meaningful — these fixtures mirror that shape. */
const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

describe('shiftDurationHours', () => {
  it('measures an ordinary day shift', () => {
    expect(shiftDurationHours(at('09:00'), at('18:00'))).toBe(9);
  });

  it('measures a half-hour boundary', () => {
    expect(shiftDurationHours(at('09:30'), at('18:00'))).toBe(8.5);
  });

  it('handles a night shift crossing midnight', () => {
    // 22:00 → 06:00 is 8 hours, not −16.
    expect(shiftDurationHours(at('22:00'), at('06:00'))).toBe(8);
  });

  it('treats an equal in/out time as a full 24 hours rather than zero', () => {
    expect(shiftDurationHours(at('08:00'), at('08:00'))).toBe(24);
  });
});
