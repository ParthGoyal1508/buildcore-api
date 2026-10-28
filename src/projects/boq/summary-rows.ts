/**
 * Rows of a tender schedule that are arithmetic about the schedule, not work in it (047).
 *
 * Reported 2026-10-28 on `STMC KOTA DARAH 23-24/BOQ_832999.xls`: the schedule ends with
 * `Total amount` and `Add GST @18%` — the second with unit `%`, quantity 18 and the schedule total
 * as its rate — and the importer took the GST row as a line worth ₹21 crore. These rows are
 * excluded from the lines and listed on the report instead.
 *
 * **Whole-description matches for totals, deliberately.** "Total station survey" and "rates
 * inclusive of GST" are real work items; a rule that dropped anything *starting* with "Total" or
 * *mentioning* GST would delete them silently. A total row is one whose description is nothing but
 * a total label; a tax row is one that adds or levies a tax.
 */
export type SummaryRowKind = 'tax' | 'total';

const TOTAL_PATTERNS = [
  /^(grand\s*|sub[\s-]*|net\s*)?total(\s+(amount|cost|value|in\s+figures|rs\.?))?$/i,
  /^quoted\s*rate\s*in\s*(figures|words)$/i,
  /^total\s*in\s*words$/i,
];

const TAX_PATTERNS = [
  // "Add GST @18%", "Add: CGST 9%", "Less TDS", "Plus labour cess"
  /^(add|plus|less)\b[\s:.-]*.*\b(c|s|i)?gst\b/i,
  /^(add|plus|less)\b[\s:.-]*.*\b(tax|cess|vat)\b/i,
  // "GST @ 18%", "CGST 9 %", "IGST @18" — a description that *is* the levy
  /^(c|s|i|u)?gst\b[\s:]*(@|\d)/i,
  /\bgst\s*@\s*\d/i,
];

/** Null for an ordinary schedule row. */
export function summaryRowKind(description: string): SummaryRowKind | null {
  const text = description
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:.\-\s]+$/, '');
  if (text.length === 0) return null;
  if (TAX_PATTERNS.some((pattern) => pattern.test(text))) return 'tax';
  if (TOTAL_PATTERNS.some((pattern) => pattern.test(text))) return 'total';
  return null;
}
