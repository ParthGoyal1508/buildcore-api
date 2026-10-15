/**
 * How the plant and store documents print figures and dates (2026-10-15).
 *
 * Presentation only. Indian digit grouping (1,50,000.00) and the dates the client's own formats
 * use: `07.09.2026` on the hiring bill, `1-Aug-26` down the log book.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Indian grouping of an integer string: `150000` → `1,50,000`. */
function group(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/**
 * A number with Indian grouping and a fixed count of decimals — `inr(150000)` → `1,50,000.00`,
 * `inr(42082, 0)` → `42,082`. Null, undefined and non-numbers print empty, so a blank cell stays
 * blank rather than reading `NaN`.
 */
export function inr(
  value: number | string | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  const fixed = Math.abs(n).toFixed(decimals);
  const [whole, fraction] = fixed.split('.');
  return `${n < 0 ? '-' : ''}${group(whole)}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A quantity: up to `decimals` places, trailing zeros dropped — `44.360` → `44.36`, `31` → `31`.
 * Grouped like `inr` once it reaches four figures.
 */
export function qty(
  value: number | string | null | undefined,
  decimals = 3,
): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  // Only a fraction's trailing zeros go: `100` must not lose its own.
  const fixed = Math.abs(n)
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  const [whole, fraction] = fixed.split('.');
  return `${n < 0 ? '-' : ''}${group(whole)}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A meter reading: no grouping, trailing zeros dropped — `337560` stays `337560`, as an odometer
 * reads, rather than `3,37,560`.
 */
export function reading(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '';
}

function parts(value: Date | string | null | undefined) {
  if (!value) return null;
  const iso =
    typeof value === 'string' ? value : value.toISOString().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? { y: match[1], m: match[2], d: match[3] } : null;
}

/** `2026-09-07` → `07.09.2026`. */
export function dotDate(value: Date | string | null | undefined): string {
  const p = parts(value);
  return p ? `${p.d}.${p.m}.${p.y}` : '';
}

/** `2026-09-07` → `07-09-2026`. */
export function dashDate(value: Date | string | null | undefined): string {
  const p = parts(value);
  return p ? `${p.d}-${p.m}-${p.y}` : '';
}

/** `2026-08-01` → `1-Aug-26`, as the log book's date column reads. */
export function shortDate(value: Date | string | null | undefined): string {
  const p = parts(value);
  return p ? `${Number(p.d)}-${MONTHS[Number(p.m) - 1]}-${p.y.slice(2)}` : '';
}

/** `2026-08` → `August 2026`. */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const long = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${long[Number(match[2]) - 1]} ${match[1]}`;
}

/** A file-name-safe stem: `JCB01/2027` → `JCB01-2027`. */
export function fileSafe(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
