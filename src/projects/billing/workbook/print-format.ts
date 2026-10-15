import type { WorkbookAbstract } from './bill-workbook.types';

/**
 * How the bill documents print a date, a figure and the tax decision (2026-10-15).
 *
 * Presentation only — none of these computes anything. The view's strings are already rounded
 * (`BillWorkbookView`), and these change only how they read: the client's printed bills say
 * 29-09-2026 and 3,11,581, not 2026-09-29 and 311581, and nobody reading a bill should meet an
 * enum like `intra_state (from_project_flag)`.
 */

/** `2026-09-29` → `29-09-2026`. Anything else is returned as it came. */
export function printDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

/**
 * A plain figure with Indian digit grouping — `311581` → `3,11,581`, `-1234567.50` →
 * `-12,34,567.50`. A string that is not a bare number (a label, "no record", a blank) is returned
 * untouched, so this can be applied to every cell of a figure column.
 */
export function indianFigure(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, whole, fraction = ''] = match;
  if (whole.length <= 3) return `${sign}${whole}${fraction}`;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}${rest},${last3}${fraction}`;
}

const BASIS: Record<string, string> = {
  intra_state: 'Intra-state supply — CGST + SGST',
  inter_state: 'Inter-state supply — IGST',
};
const SOURCE: Record<string, string> = {
  from_project_flag: 'as set on the project',
  derived_from_gstin: 'from the two parties’ GSTIN states',
};

/** "Tax basis: Intra-state supply — CGST + SGST (as set on the project)". */
export function taxBasisLine(
  abstract: Pick<WorkbookAbstract, 'taxBasis' | 'taxBasisSource'>,
): string {
  const basis = BASIS[abstract.taxBasis] ?? abstract.taxBasis;
  const source = SOURCE[abstract.taxBasisSource] ?? abstract.taxBasisSource;
  return `Tax basis: ${basis} (${source})`;
}
