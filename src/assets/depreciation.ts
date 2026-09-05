import { MONTHS_PER_YEAR } from './constants/assets.constants';

/**
 * Straight-line depreciation, computed on demand (spec FR-019, FR-020).
 *
 * Nothing here is posted. The clarification of 2026-09-01 settled that this module
 * produces a *costing* figure for the register and for 008's P&L, and never a journal
 * entry — which is why these are pure functions over an asset's own columns rather
 * than a service that writes anything.
 *
 * Everything is `number` rather than `Prisma.Decimal`. The inputs are money and a
 * percentage rate; the output is a reporting figure rounded to paise at the boundary.
 * Decimal would be right if this were a posting that had to reconcile to the rupee
 * against a ledger — it is not, and threading Decimal through a function called once
 * per row on a 500-row stock screen buys nothing.
 */

/** What an asset's depreciation is worth per month. */
export function monthlyDepreciation(
  purchaseCost: number,
  ratePercent: number,
): number {
  if (purchaseCost <= 0 || ratePercent <= 0) return 0;
  return (purchaseCost * ratePercent) / 100 / MONTHS_PER_YEAR;
}

/**
 * Whole months from `from` to `asOf`, never negative.
 *
 * Whole, not fractional: an asset capitalised on the 20th has not depreciated for a
 * month until the 20th of the next month comes round. Counting part-months would make
 * the book value drift a little every day, which reads as an error to anyone
 * reconciling the register against a purchase invoice.
 *
 * A date before capitalisation returns 0 — the pre-capitalisation zero FR-019
 * requires, and the reason an asset registered ahead of its capitalisation date sits
 * at full cost rather than accruing backwards.
 */
export function monthsElapsed(from: Date, asOf: Date): number {
  const months =
    (asOf.getUTCFullYear() - from.getUTCFullYear()) * MONTHS_PER_YEAR +
    (asOf.getUTCMonth() - from.getUTCMonth());
  // The day-of-month has not come round yet in the final month, so it does not count.
  const wholeMonths =
    asOf.getUTCDate() < from.getUTCDate() ? months - 1 : months;
  return Math.max(0, wholeMonths);
}

/** An asset, as the depreciation functions need it. */
export interface DepreciableAsset {
  purchaseCost: number;
  depreciationRatePercent: number;
  salvageValue: number;
  capitalisationDate: Date;
}

/**
 * Accumulated depreciation to a date, capped so the book value never dips below the
 * salvage floor (spec FR-019, SC-008).
 *
 * The cap is applied here rather than only in `bookValue` so the two always agree:
 * a summary that reported accumulated depreciation from one formula and book value
 * from another would show a category whose columns do not add up.
 */
export function accumulatedDepreciation(
  asset: DepreciableAsset,
  asOf: Date = new Date(),
): number {
  const perMonth = monthlyDepreciation(
    asset.purchaseCost,
    asset.depreciationRatePercent,
  );
  if (perMonth === 0) return 0;

  const raw = perMonth * monthsElapsed(asset.capitalisationDate, asOf);
  // Never more than the depreciable amount. A salvage value above the purchase cost
  // is nonsense but is possible in data, so the floor is clamped at zero rather than
  // allowed to make `depreciable` negative and hand back a *negative* depreciation.
  const depreciable = Math.max(0, asset.purchaseCost - asset.salvageValue);
  return round2(Math.min(raw, depreciable));
}

/**
 * Current book value: cost less accumulated depreciation, floored at salvage and
 * never negative (spec FR-019, SC-008).
 */
export function bookValue(
  asset: DepreciableAsset,
  asOf: Date = new Date(),
): number {
  const value = asset.purchaseCost - accumulatedDepreciation(asset, asOf);
  return round2(Math.max(0, value));
}

/**
 * Depreciation attributable to a span of days, for 008's P&L (spec FR-021, FR-022).
 *
 * Pro-rated by days rather than by months because an allocation rarely starts on the
 * 1st. `days / daysInPeriod × monthlyDepreciation × monthsInPeriod` would double-count
 * across a month boundary, so this works in daily units throughout: the monthly charge
 * is converted to a daily one against the actual length of the month the day falls in,
 * which is what makes FR-022's guarantee hold — the pro-rated figures for two
 * allocations of the same asset in one month sum to at most that month's charge,
 * because each day is counted once and no day is worth more than its share.
 *
 * Days before the capitalisation date contribute nothing.
 */
export function depreciationForDays(
  asset: DepreciableAsset,
  from: Date,
  to: Date,
): number {
  const perMonth = monthlyDepreciation(
    asset.purchaseCost,
    asset.depreciationRatePercent,
  );
  if (perMonth === 0) return 0;

  const start = new Date(
    Math.max(from.getTime(), asset.capitalisationDate.getTime()),
  );
  if (start > to) return 0;

  let total = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );

  // Month by month rather than day by day: a five-year allocation would otherwise
  // loop 1,800 times per asset per P&L read.
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthEnd = new Date(Date.UTC(year, month, daysInMonth));
    const sliceEnd = monthEnd < end ? monthEnd : end;
    // Inclusive of both endpoints: an allocation from the 1st to the 1st is one day
    // on site, not zero.
    const days =
      Math.round((sliceEnd.getTime() - cursor.getTime()) / 86_400_000) + 1;
    total += (perMonth * days) / daysInMonth;
    cursor.setUTCFullYear(year, month + 1, 1);
  }

  // The salvage floor applies to the asset's whole life, not to one slice of it, so
  // it is not re-applied here — the caller sums slices and the register's own book
  // value is where the floor is enforced.
  return round2(total);
}

/** Money, to paise. Half-up on the last digit, the same rounding every money figure
 * in this codebase uses. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
