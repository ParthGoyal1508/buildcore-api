import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/** One measured line, already formatted, as the client's form lays it out. */
export interface DwrWorkbookLine {
  srNo: number;
  /** The BOQ number where the line has one; a freeform line has none. */
  boqNo: string | null;
  activity: string;
  details: string | null;
  /** `21+300`, already in the client's own notation — see `chainage.ts`. */
  chainageFrom: string | null;
  chainageTo: string | null;
  unit: string | null;
  side: string | null;
  /** The count. The client's sheet leads its arithmetic with it and so does this. */
  nos: string | null;
  length: string | null;
  width: string | null;
  /**
   * Their column reads **Hight** (height). Stored as `DWRTask.depth`, which is the same
   * multiplicand under a different word — depth for an excavation, height for a wall — and the
   * client's sheet is the document, so the column is theirs to name.
   */
  height: string | null;
  quantity: string;
  target: string | null;
  engineerName: string | null;
  remarks: string | null;
  /**
   * The evidence filed against this measurement (2026-10-12).
   *
   * Bytes, already scaled, for the same reason every figure above is already formatted: a renderer
   * that could fetch could also decide how big a picture should be, and the form would then be
   * free to differ from what the caller asked for.
   *
   * `image` is null for an attachment that is not a picture — a signed PDF, say. Those are named
   * rather than dropped, because a form that silently omits an attachment disagrees with the
   * screen the reader was looking at.
   */
  photos: DwrWorkbookPhoto[];
}

/** One file filed against a measurement, ready to place. */
export interface DwrWorkbookPhoto {
  fileName: string;
  /** JPEG bytes and the size to draw them at, or null where the file is not a picture. */
  image: { data: Buffer; width: number; height: number } | null;
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

/**
 * The columns of the client's own measurement sheet, in its order and under its words.
 *
 * Taken from `docs/4280 -DPR -Medshi to Washim 05.10.2026.xlsx` and amended 2026-10-07 when the
 * client sent the sheet they actually keep: **Chainage (From, To), Side, Nos, Length, Width in
 * Meter, Hight, Qty, Remark**. `Nos` was missing and `Depth` was this system's word for their
 * `Hight`.
 *
 * Their spelling of "Hight" is **not** reproduced. The column is theirs to name and the
 * misspelling is not a name — printing it back would look like a system that cannot spell.
 */
const COLUMNS: { header: string; width: number }[] = [
  { header: 'Sr. No.', width: 7 },
  { header: 'BOQ No.', width: 12 },
  { header: 'Works', width: 34 },
  { header: 'Details of works', width: 30 },
  { header: 'Chainage from', width: 13 },
  { header: 'Chainage to', width: 13 },
  { header: 'Side', width: 10 },
  { header: 'Nos.', width: 8 },
  { header: 'Length in Meter', width: 13 },
  { header: 'Width in Meter', width: 13 },
  { header: 'Height', width: 10 },
  { header: 'UOM', width: 8 },
  { header: 'Qty.', width: 12 },
  { header: 'Target', width: 10 },
  { header: 'Engineer', width: 18 },
  { header: 'Remark', width: 26 },
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
    writePhotographs(workbook, sheet, view);

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
      line.side ?? '',
      line.nos ?? '',
      line.length ?? '',
      line.width ?? '',
      line.height ?? '',
      line.unit ?? '',
      line.quantity,
      line.target ?? '',
      line.engineerName ?? '',
      line.remarks ?? '',
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
}

/**
 * The photographs, under the table, each captioned with the measurement it is evidence for.
 *
 * ## Why a block below rather than a column beside
 *
 * The table above is the client's own measurement sheet, column for column and under their words
 * — that is what makes it a document they recognise. A picture in a row forces that row to the
 * height of the picture, so a report with photographs on five of its lines becomes a measurement
 * sheet whose figures are a screen apart from each other, and the column that carries them is one
 * the client's form does not have.
 *
 * So the measurements stay exactly as they were and the pictures follow, each under a caption
 * naming its serial number and chainage. The binding a reader needs — *which* line this is of —
 * is stated in words rather than implied by a row position, which also survives the sheet being
 * printed across two pages.
 *
 * Each picture gets a row of its own, sized to the picture, so two photographs on one line cannot
 * overlap: `exceljs` floats an image over the grid at a fixed size and does nothing to make room
 * for it.
 */
function writePhotographs(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  view: DwrWorkbookView,
): void {
  const withPhotos = view.lines.filter((line) => line.photos.length > 0);
  if (withPhotos.length === 0) return;

  sheet.addRow([]);
  const heading = sheet.addRow(['Photographs']);
  heading.font = { bold: true, size: 12 };
  sheet.mergeCells(heading.number, 1, heading.number, COLUMNS.length);

  for (const line of withPhotos) {
    const where = [
      `Sr. No. ${line.srNo}`,
      line.boqNo,
      chainageCaption(line),
      line.activity,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    const caption = sheet.addRow([where]);
    caption.font = { bold: true };
    sheet.mergeCells(caption.number, 1, caption.number, COLUMNS.length);

    for (const photo of line.photos) {
      // Named and nothing else where the file is not a picture — the PDF, or whatever libvips
      // could not read. Saying so is the difference between "there is no photograph" and "there
      // is one you cannot see here", and only the second sends the reader to the screen for it.
      const name = sheet.addRow([
        photo.image
          ? photo.fileName
          : `${photo.fileName} — attached to this line, not a picture`,
      ]);
      name.font = { size: 9, color: { argb: 'FF666666' } };
      sheet.mergeCells(name.number, 1, name.number, COLUMNS.length);

      if (!photo.image) continue;

      const id = workbook.addImage({
        buffer: photo.image.data as unknown as ExcelJS.Buffer,
        extension: 'jpeg',
      });
      const row = sheet.addRow([]);
      // Excel row heights are points; an image is placed in pixels, at 96 dpi against 72 pt/inch.
      row.height = photo.image.height * (POINTS_PER_INCH / PIXELS_PER_INCH);
      sheet.addImage(id, {
        tl: { col: 0, row: row.number - 1 },
        ext: { width: photo.image.width, height: photo.image.height },
      });
    }
  }
}

/** Excel measures a row's height in points and places a picture in pixels at 96 dpi. */
const POINTS_PER_INCH = 72;
const PIXELS_PER_INCH = 96;

/** `13+000 – 14+000`, or the single end where only one was recorded. */
function chainageCaption(line: DwrWorkbookLine): string | null {
  if (line.chainageFrom && line.chainageTo) {
    return `${line.chainageFrom} – ${line.chainageTo}`;
  }
  return line.chainageFrom ?? line.chainageTo ?? null;
}

function writeFooter(sheet: ExcelJS.Worksheet, view: DwrWorkbookView): void {
  if (!view.description) return;
  sheet.addRow([]);
  const row = sheet.addRow(['Description', view.description]);
  row.getCell(1).font = { bold: true };
  sheet.mergeCells(row.number, 2, row.number, COLUMNS.length);
  row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
}
