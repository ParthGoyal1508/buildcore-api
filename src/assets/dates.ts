/**
 * Today, as the value a `@db.Date` column holds.
 *
 * Postgres hands a `date` back as UTC midnight, so every comparison in this module —
 * is this document expiring, is this inspection due, is this allocation overdue,
 * has this asset been capitalised — has to be made against UTC midnight too. Building
 * "today" from local midnight instead makes every one of those comparisons wrong by a
 * day for part of each day east of Greenwich, which is exactly where this system runs.
 *
 * The local calendar date is still the one the user means, so the year, month and day
 * are read locally and only then reinterpreted as UTC.
 */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
