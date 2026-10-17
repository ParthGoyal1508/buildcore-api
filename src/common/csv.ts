/**
 * One CSV cell, safe to open in a spreadsheet (036 B14).
 *
 * RFC 4180 quoting (wrapped in quotes, inner quotes doubled) **and** formula neutralisation: a
 * value beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`, so
 * Excel and Sheets show it as text instead of evaluating it. Audit rows carry text people typed —
 * a vendor named `=HYPERLINK("http://evil","Click")` would otherwise become a live link, or worse,
 * in the auditor's spreadsheet.
 *
 * A plain negative number (`-1500`, `-12.5`) is left alone: it is data, not a formula, and the
 * apostrophe would turn an amount column into text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe =
    FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvRow(values: (string | number | null | undefined)[]): string {
  return values.map(csvCell).join(',');
}
