import config from './configs/config';
import { parseDateOnly, zonedDateOnly } from '../hr/leave/leave-days';

/**
 * Today's calendar date in the business timezone (`settings.timezone`, Asia/Kolkata by default),
 * as `YYYY-MM-DD` (036).
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which in India is *yesterday* until
 * 05:30 — so a "not in the future" check built from it refused today's date for the first five
 * and a half hours of every day (036 K18), and a "today" default stamped the previous date.
 */
export function businessTodayIso(now: Date = new Date()): string {
  return zonedDateOnly(now, config().settings.timezone);
}

/** `businessTodayIso()` as the UTC-midnight value a `@db.Date` column holds and compares with. */
export function businessToday(now: Date = new Date()): Date {
  return parseDateOnly(businessTodayIso(now));
}
