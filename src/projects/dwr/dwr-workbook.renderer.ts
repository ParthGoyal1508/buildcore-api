import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/** One measured line, already formatted, as the client's form lays it out. */
export interface DwrWorkbookLine {
  srNo: number;
  /** The BOQ number where the line has one; a freeform line has none. */
  boqNo: string | null;
  activity: string;
  details: string | null;
  chainageFrom: string | null;
  chainageTo: string | null;
  unit: string | null;
  side: string | null;
  length: string | null;
  width: string | null;
  depth: string | null;
  quantity: string;
  target: string | null;
  engineerName: string | null;
  remarks: string | null;
}

/**
 * One day's report as the printable form needs it (028 FR-022).
 *
 * Strings, already rounded, for the reason `BillWorkbookView` is: a renderer that formatted its own
 * figures would eventually print a different number from the screen the figure came from.
 */
export interface DwrWorkbookView {
  companyName: string | null;
  projectName: string;
  projectCode: string;
  clientName: string | null;
  dprNumber: string;
  /** `yyyy-mm-dd`. */
  workDate: string;
  weather: string;
  status: string;
  /** FR-024. Both, because on a report returned for correction they are different people. */
  recordedByName: string | null;
  submittedByName: string | null;
  workerCount: number;
  machineryCount: number;
  location: string | null;
  description: string | null;
  lines: DwrWorkbookLine[];
}

/** The twenty-one columns of the client's own form, in its order. */
const COLUMNS: { header: string; width: number }[] = [
  { header: 'Sr. No.', width: 7 },
  { header: 'BOQ No.', width: 12 },
  { header: 'Works', width: 34 },
  { header: 'Details of works', width: 30 },
  { header: 'Chainage from', width: 12 },
  { header: 'Chainage to', width: 12 },
  { header: 'UOM', width: 8 },
  { header: 'Side', width: 7 },
  { header: 'Length', width: 10 },
  { header: 'Width', width: 10 },
  { header: 'Depth', width: 10 },
  { header: 'Quantity', width: 12 },
  { header: 'Target', width: 10 },
  { header: 'Engineer', width: 18 },
  { header: 'Remarks', width: 26 },
];

/**
 * A day's report as the printable form (028 FR-022).
 *
 * ## What did not exist
 *
 * The daily-work controller carries fifteen endpoints and **none of them produces a file**. A
 * report could be entered, submitted, approved and read on screen, and then had to be retyped into
 * the client's own spreadsheet to be sent anywhere — which is both the work this system exists to
 * remove and the point at which the two copies start to disagree.
 *
 * ## One layout, and why that is the right scope
 *
 * The client's form is `docs/4280 -DPR -Medshi to Washim 05.10.2026.xlsx`: a header block naming
 * the company, the project, the client and the date, then a measured table. Their workbook carries
 * one sheet per day of the month; this produces **one day**, named by its date the way their sheets
 * are, because a report is what the caller asked for and a month is a different document.
 *
 * Per-client layout variants are deliberately out of scope until a second client asks for one
 * (spec, out of scope). A second layout built speculatively is a second layout to keep correct.
 *
 * ## It holds no database client, deliberately
 *
 * The constructor takes nothing, exactly as `BillWorkbookRenderer`'s and `BillPdfRenderer`'s do.
 * A renderer that could query could recompute, and the figure on the form would then be free to
 * differ from the figure on the screen the day somebody changed a derivation. Everything it prints
 * arrives in the view.
 *
 * `import * as ExcelJS` is correct here and `pdfkit` is imported differently: `exceljs` is read
 * through its properties, which works under both SWC and ts-jest. `src/common/swc-interop.spec.ts`
 * is the guard, and `bill-workbook.renderer.ts` records the reasoning.
 */
@Injectable()
export class DwrWorkbookRenderer {
  async render(view: DwrWorkbookView): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = view.companyName ?? 'BuildCore';

    // Pinned to the work date, not to the clock — the rule both bill renderers follow. A document
    // produced twice should differ in nothing a reader can see, metadata included.
    const stamp = new Date(`${view.workDate}T00:00:00.000Z`);
    workbook.created = stamp;
    workbook.modified = stamp;

    // Named as the client names theirs: `05.10.2026`. A sheet called "Sheet1" in a folder of
    // thirty-one is a sheet somebody has to open to identify.
    const sheet = workbook.addWorksheet(sheetNameFor(view.workDate));
    sheet.columns = COLUMNS.map((column) => ({ width: column.width }));

    writeHeader(sheet, view);
    writeTable(sheet, view);
    writeFooter(sheet, view);

    const bytes = await workbook.xlsx.writeBuffer();
    return Buffer.from(bytes);
  }
}

/** `2026-10-05` → `05.10.2026`, which is how the client's own tabs are named. */
export function sheetNameFor(workDate: string): string {
  const [year, month, day] = workDate.slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

function writeHeader(sheet: ExcelJS.Worksheet, view: DwrWorkbookView): void {
  const span = COLUMNS.length;

  const title = sheet.addRow([view.companyName ?? '']);
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: 'center' };
  sheet.mergeCells(title.number, 1, title.number, span);

  const subtitle = sheet.addRow(['DAILY PROGRESS REPORT']);
  subtitle.font = { bold: true, size: 12 };
  subtitle.alignment = { horizontal: 'center' };
  sheet.mergeCells(subtitle.number, 1, subtitle.number, span);

  sheet.addRow([]);

  // Label-and-value pairs rather than a merged banner, so every fact is readable from a cell
  // reference — which is what makes this form checkable by a test rather than by eye.
  const pairs: [string, string][] = [
    ['Project', view.projectName],
    ['Project Code', view.projectCode],
    ['Client', view.clientName ?? ''],
    ['DPR No.', view.dprNumber],
    ['Date', view.workDate],
    // Kept on the form because it is on **the client's** form, and the recorded history was kept
    // for the same reason (FR-023). Entry no longer collects it; what was recorded still prints.
    ['Weather', view.weather],
    ['Status', view.status],
    ['Location', view.location ?? ''],
    // FR-024, and both of them. On a report returned for correction the person who recorded it and
    // the person who submitted it are different people, and "who filed this" has two answers.
    ['Recorded by', view.recordedByName ?? ''],
    ['Submitted by', view.submittedByName ?? ''],
    ['Workers', String(view.workerCount)],
    ['Machinery', String(view.machineryCount)],
  ];
  for (const [label, value] of pairs) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    sheet.mergeCells(row.number, 2, row.number, span);
  }

  sheet.addRow([]);
}

function writeTable(sheet: ExcelJS.Worksheet, view: DwrWorkbookView): void {
  const head = sheet.addRow(COLUMNS.map((column) => column.header));
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };

  if (view.lines.length === 0) {
    // Said rather than left blank. An empty table and a table that failed to render look the same,
    // and a reader seeing nothing cannot tell which they have.
    const empty = sheet.addRow(['', '', 'No work measured on this report.']);
    sheet.mergeCells(empty.number, 3, empty.number, COLUMNS.length);
    return;
  }

  for (const line of view.lines) {
    const row = sheet.addRow([
      line.srNo,
      line.boqNo ?? '',
      line.activity,
      line.details ?? '',
      line.chainageFrom ?? '',
      line.chainageTo ?? '',
      line.unit ?? '',
      line.side ?? '',
      line.length ?? '',
      line.width ?? '',
      line.depth ?? '',
      line.quantity,
      line.target ?? '',
      line.engineerName ?? '',
      line.remarks ?? '',
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
}

function writeFooter(sheet: ExcelJS.Worksheet, view: DwrWorkbookView): void {
  if (!view.description) return;
  sheet.addRow([]);
  const row = sheet.addRow(['Description', view.description]);
  row.getCell(1).font = { bold: true };
  sheet.mergeCells(row.number, 2, row.number, COLUMNS.length);
  row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
}
