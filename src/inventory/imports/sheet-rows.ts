import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import { parseDateOnly } from '../../hr/leave/leave-days';

/**
 * Reading the client's inventory workbook (051): the Opening Stock and Vendor Rates tabs.
 *
 * Pure — base64 in, rows of cell values out — so each import says only which columns it wants and
 * what a value must look like. `.xlsx` only, through `exceljs` (the constitution's read/write split);
 * the client's workbook is `.xlsx`.
 *
 * The sheet is found by its **header row**, not its tab name: the whole four-tab workbook can be
 * uploaded, or the one tab saved on its own, and either works. A header is matched on its letters
 * and digits only, so "Rate (₹ per Unit)", "Rate per unit" and "RATE/UNIT" are one column.
 */

/** Most data rows one import reads: far beyond a company's item × store list, and bounded. */
export const MAX_IMPORT_ROWS = 5000;

/** One column an import reads: its key, and every header spelling it accepts (normalised). */
export interface SheetColumn<K extends string> {
  key: K;
  /** The header as the client's sheet and the template spell it. */
  label: string;
  /** Every other spelling accepted, normalised by `headerKey`. The label is always accepted. */
  headers: string[];
  required: boolean;
}

export interface SheetRow<K extends string> {
  /** The row number as Excel shows it, for the report. */
  line: number;
  cells: Record<K, ExcelJS.CellValue>;
}

/** Letters and digits only, lower case: how both headers and names are compared. */
export const headerKey = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A name compared case- and space-insensitively: "  ACC  cement " and "acc cement" are one. */
export const nameKey = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toUpperCase();

/** A name compared on its letters and digits alone: "Shree Traders Pvt. Ltd." = "SHREE TRADERS PVT LTD". */
export const looseNameKey = (name: string): string => headerKey(name);

/** Names → every record carrying that name under `keyOf`, so two records that clash are visible. */
export function indexByName<T>(
  records: T[],
  nameOf: (record: T) => string,
  keyOf: (name: string) => string,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(nameOf(record));
    index.set(key, [...(index.get(key) ?? []), record]);
  }
  return index;
}

/** The cell as trimmed text, or null when empty. Formulas read as their result. */
export function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) {
      return (
        value.richText
          .map((part) => part.text)
          .join('')
          .trim() || null
      );
    }
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text).trim() || null;
    return null;
  }
  return String(value).trim() || null;
}

/**
 * A number from a cell: a numeric cell, or text such as "1,250.50" or "₹ 412". `null` for an empty
 * cell, `NaN` for anything that is not a number — the caller says which of those is an error.
 */
export function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') return value;
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    'result' in value
  ) {
    return cellNumber(value.result as ExcelJS.CellValue);
  }
  const text = cellText(value);
  if (text === null) return null;
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/** Days from Excel's day 0 (1899-12-30, with its 1900 leap-year bug folded in) to 1970-01-01. */
const EXCEL_EPOCH_OFFSET = 25569;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A calendar date from a cell, `YYYY-MM-DD`: an Excel date cell, a date serial, or text in the
 * sheet's own DD-MM-YYYY (also `/` or `.` separated), or YYYY-MM-DD. `null` for an empty cell,
 * `'invalid'` for anything else — including an impossible date such as 31-02-2026.
 */
export function cellDate(value: ExcelJS.CellValue): string | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? 'invalid'
      : value.toISOString().slice(0, 10);
  }
  if (
    typeof value === 'object' &&
    'result' in value &&
    !('richText' in value)
  ) {
    return cellDate(value.result as ExcelJS.CellValue);
  }
  if (typeof value === 'number') {
    if (value < 1 || value > 2958465) return 'invalid';
    return new Date(Math.round((value - EXCEL_EPOCH_OFFSET) * DAY_MS))
      .toISOString()
      .slice(0, 10);
  }
  const text = cellText(value);
  if (text === null) return null;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const iso = dmy
    ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
    : ymd
    ? `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
    : null;
  if (!iso) return 'invalid';
  try {
    parseDateOnly(iso);
    return iso;
  } catch {
    return 'invalid';
  }
}

/**
 * The data rows of the first sheet whose header row (within its top ten rows) carries every
 * required column. Rows with no value in any read column are skipped — a blank line or a sheet's
 * trailing formatting is not a row anybody meant.
 *
 * @param describe the sheet in the refusal, e.g. `the Opening Stock sheet`.
 */
export async function readSheetRows<K extends string>(
  fileBase64: string,
  columns: SheetColumn<K>[],
  describe: string,
): Promise<SheetRow<K>[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      Buffer.from(fileBase64, 'base64') as unknown as ExcelJS.Buffer,
    );
  } catch {
    throw new BadRequestException(
      'The file is not a readable .xlsx workbook. Save it as Excel Workbook (.xlsx) and try again.',
    );
  }

  for (const sheet of workbook.worksheets) {
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const at = new Map<string, number>();
      sheet.getRow(r).eachCell((cell, col) => {
        const label = cellText(cell.value);
        if (label && !at.has(headerKey(label))) at.set(headerKey(label), col);
      });
      const found = new Map<K, number>();
      for (const column of columns) {
        const col = [headerKey(column.label), ...column.headers]
          .map((header) => at.get(header))
          .find((c) => c !== undefined);
        if (col !== undefined) found.set(column.key, col);
      }
      if (columns.some((c) => c.required && !found.has(c.key))) continue;

      const rows: SheetRow<K>[] = [];
      for (let line = r + 1; line <= sheet.rowCount; line++) {
        const row = sheet.getRow(line);
        const cells = {} as Record<K, ExcelJS.CellValue>;
        let any = false;
        for (const column of columns) {
          const col = found.get(column.key);
          const value = col === undefined ? null : row.getCell(col).value;
          cells[column.key] = value ?? null;
          if (cellText(value ?? null) !== null) any = true;
        }
        if (!any) continue;
        rows.push({ line, cells });
        if (rows.length > MAX_IMPORT_ROWS) {
          throw new BadRequestException(
            `${describe} has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`,
          );
        }
      }
      if (rows.length === 0) {
        throw new BadRequestException(
          `${describe} has no rows under its header.`,
        );
      }
      return rows;
    }
  }

  throw new BadRequestException(
    `No sheet in this workbook has the ${describe} header row. It needs the columns ` +
      columns
        .filter((c) => c.required)
        .map((c) => `"${c.label}"`)
        .join(', ') +
      ' in one of its first ten rows. Download the template to see the layout.',
  );
}
