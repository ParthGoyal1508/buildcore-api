import * as ExcelJS from 'exceljs';
import type { Response } from 'express';

import { contentDispositionFor } from '../common/storage/file-type';
import { MAX_PAGE_SIZE } from './constants/plant.constants';

/**
 * Excel downloads of the plant registers' filtered lists (036 K16): the logbook and the fuel
 * register had no export, so a month's figures were copied off the screen a page at a time.
 *
 * The rows come from each service's own paged `findAll`, walked page by page, so an export is
 * exactly what the list shows under the same filters — names resolved, nothing re-derived here.
 */

/** The most rows one list export writes. */
export const LIST_EXPORT_LIMIT = 5000;

/** Every row of a paged list, up to {@link LIST_EXPORT_LIMIT}. */
export async function allPages<T>(
  fetchPage: (
    page: number,
    pageSize: number,
  ) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < LIST_EXPORT_LIMIT; page++) {
    const { items, total } = await fetchPage(page, MAX_PAGE_SIZE);
    rows.push(...items);
    if (items.length === 0 || rows.length >= total) break;
  }
  return rows.slice(0, LIST_EXPORT_LIMIT);
}

export interface ExportColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string | number | null;
  /** An Excel number format, e.g. `#,##0.00`. */
  numFmt?: string;
}

/** `2026-10-05` (or a Date) → `05-10-2026`, the format lists and exports use (036 A18). */
export function ddmmyyyy(value: Date | string | null): string {
  if (!value) return '';
  const iso = typeof value === 'string' ? value : value.toISOString();
  return iso.slice(0, 10).split('-').reverse().join('-');
}

export async function sendListXlsx<T>(
  res: Response,
  filename: string,
  sheetName: string,
  columns: ExportColumn<T>[],
  rows: T[],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns.map((c, index) => ({
    header: c.header,
    key: `c${index}`,
    width: c.width,
  }));
  ws.getRow(1).font = { bold: true };
  for (const row of rows) {
    ws.addRow(
      Object.fromEntries(
        columns.map((c, index) => [`c${index}`, c.value(row) ?? '']),
      ),
    );
  }
  columns.forEach((c, index) => {
    if (c.numFmt) ws.getColumn(`c${index}`).numFmt = c.numFmt;
  });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', contentDispositionFor(filename));
  res.send(buffer);
}
