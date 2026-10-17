import * as ExcelJS from 'exceljs';

/**
 * The Excel downloads of the inventory registers (036 M12, M13): purchases, payments, issues, stock
 * and one item's ledger at one store — each the list's own filter, every page.
 *
 * One small builder rather than five hand-rolled sheets: a heading row, the rows, an optional total
 * row, dates as DD-MM-YYYY (the 036 A18 format) and amounts on the Indian grouping. Pure — it takes
 * rows and returns bytes — so each register only says which columns it has.
 */
export interface WorkbookColumn<Row> {
  header: string;
  width?: number;
  /** `money` → ₹ #,##,##0.00; `quantity` → up to three places; `date` → DD-MM-YYYY. */
  format?: 'money' | 'quantity' | 'date';
  value: (row: Row) => string | number | Date | null | undefined;
}

/** Most rows one download carries: enough for a year of a busy store, and bounded. */
export const EXPORT_ROW_CAP = 5000;

const FORMATS: Record<
  NonNullable<WorkbookColumn<unknown>['format']>,
  string
> = {
  money:
    '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00',
  quantity: '#,##0.###',
  date: 'dd-mm-yyyy',
};

export async function buildWorkbook<Row>(
  sheetName: string,
  columns: WorkbookColumn<Row>[],
  rows: Row[],
  totals?: Partial<Record<string, number | string>>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = columns.map((column) => ({
    header: column.header,
    width: column.width ?? 16,
    style: column.format ? { numFmt: FORMATS[column.format] } : {},
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) {
    sheet.addRow(
      columns.map((column) => {
        const value = column.value(row);
        return value === undefined ? null : value;
      }),
    );
  }
  if (totals) {
    const total = sheet.addRow(
      columns.map((column, index) =>
        index === 0 ? 'Total' : totals[column.header] ?? null,
      ),
    );
    total.font = { bold: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Every page of a paged list, up to {@link EXPORT_ROW_CAP} rows. */
export async function allPages<Row>(
  fetch: (
    page: number,
    pageSize: number,
  ) => Promise<{ rows: Row[]; total: number }>,
  pageSize = 200,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; out.length < EXPORT_ROW_CAP; page += 1) {
    const { rows, total } = await fetch(page, pageSize);
    out.push(...rows);
    if (rows.length === 0 || out.length >= total) break;
  }
  return out.slice(0, EXPORT_ROW_CAP);
}

export const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A stored date (`@db.Date`, UTC midnight) as the calendar date it is, for a date cell. */
export const dateCell = (value: Date | string | null | undefined) =>
  value
    ? new Date(
        String(value instanceof Date ? value.toISOString() : value).slice(
          0,
          10,
        ),
      )
    : null;
