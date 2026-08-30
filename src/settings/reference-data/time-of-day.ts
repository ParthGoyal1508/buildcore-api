/**
 * Shift in/out times are wall-clock times of day with no date or zone component,
 * stored in a Postgres `time` column. Prisma surfaces those as `Date`, so both
 * directions pin the date half to the Unix epoch in UTC and only ever read or write
 * the time half — anything else would let a server's local zone shift a 09:00 shift.
 */
export function parseTimeOfDay(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

export function formatTimeOfDay(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
