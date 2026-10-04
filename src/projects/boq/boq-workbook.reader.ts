import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import * as XLSX from 'xlsx';

import config from '../../common/configs/config';

/**
 * Codes for the conditions that refuse a whole workbook (008 FR-036, FR-056).
 *
 * Each names its own condition because the person who hit it needs a different action for each:
 * a too-large file needs splitting, an unreadable one needs re-exporting, and a workbook with no
 * sheets is usually a file that was saved wrong. "Import failed" sends all three to the same
 * place, which is nowhere.
 */
export const BOQ_WORKBOOK_ERRORS = {
  fileTooLarge: 'BOQ_FILE_TOO_LARGE',
  unreadable: 'BOQ_WORKBOOK_UNREADABLE',
  empty: 'BOQ_WORKBOOK_EMPTY',
} as const;

/** One row, as plain data. Never a library cell object — see the class note. */
export interface WorkbookRow {
  /** 1-based, matching what the spreadsheet application shows, so an error can be acted on. */
  rowNumber: number;
  cells: (string | number | null)[];
}

export interface WorkbookSheet {
  name: string;
  rows: WorkbookRow[];
}

/** `PK\x03\x04` — a zip, which is what an OOXML `.xlsx` is. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** The OLE2 / Compound File header every legacy BIFF `.xls` begins with. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Turns workbook bytes into plain rows, and is **the only place SheetJS is imported**
 * (constitution v1.5.0).
 *
 * **Nothing leaves here but strings, numbers and nulls.** No caller receives a workbook, a
 * worksheet or a cell object, which is what makes replacing the library one file's work rather
 * than a search through the codebase. `boq-workbook.reader.spec.ts` asserts that no other file
 * imports `xlsx`, because the constraint decays silently: a second import would work perfectly
 * and nobody would notice until the day it mattered.
 *
 * **Two libraries, on purpose.** `exceljs` reads `.xlsx` and cannot read legacy `.xls` — handed
 * the client's real tender it returns a workbook with **zero worksheets and throws nothing**
 * (research §15, measured 2026-10-03). An importer built on it alone would report a successful
 * import of 0 rows against a ₹3 crore tender: the worst available shape for a failure, because it
 * is indistinguishable from a working import of an empty project. That measurement is the reason
 * SheetJS is here and the reason `empty` is a refusal rather than an empty result.
 *
 * **Routed by content, not by extension.** A renamed file is the common case, not the exception —
 * portals issue `.xls`, people save as `.xlsx` and keep the old name, and the reverse. The magic
 * bytes are the only thing that cannot be wrong.
 */
@Injectable()
export class BoqWorkbookReader {
  /**
   * @throws BadRequestException with one of `BOQ_WORKBOOK_ERRORS`. Never returns an empty result
   *   for a workbook it could not read — that distinction is the point of this class.
   */
  async read(buffer: Buffer): Promise<WorkbookSheet[]> {
    const { maxFileBytes } = config().boqImport;
    if (buffer.length > maxFileBytes) {
      throw new BadRequestException({
        statusCode: 400,
        code: BOQ_WORKBOOK_ERRORS.fileTooLarge,
        message:
          `This file is ${Math.round(
            buffer.length / 1024 / 1024,
          )}MB. The limit is ` +
          `${Math.round(
            maxFileBytes / 1024 / 1024,
          )}MB — a BOQ schedule is normally well under 1MB, ` +
          `so a file this size usually holds something other than a schedule.`,
      });
    }

    const sheets = await this.parse(buffer);

    // FR-036. The condition `exceljs` reports as success for a `.xls`, refused here by name.
    const withRows = sheets.filter((sheet) => sheet.rows.length > 0);
    if (withRows.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: BOQ_WORKBOOK_ERRORS.empty,
        message:
          'This workbook opened but contains no sheets with any content. If it came from a ' +
          'tender portal, open it in Excel and save it again before uploading.',
      });
    }
    return withRows;
  }

  private async parse(buffer: Buffer): Promise<WorkbookSheet[]> {
    try {
      if (buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
        return await this.readXlsx(buffer);
      }
      if (buffer.subarray(0, CFB_MAGIC.length).equals(CFB_MAGIC)) {
        return this.readLegacyXls(buffer);
      }
    } catch {
      // Both libraries throw a variety of shapes for a corrupt file, and none of them is worth
      // showing to whoever uploaded it. The condition is the same in every case: the bytes are
      // not a workbook we can read.
      throw this.unreadable();
    }
    throw this.unreadable();
  }

  private unreadable(): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      code: BOQ_WORKBOOK_ERRORS.unreadable,
      message:
        'This file is not an Excel workbook. Upload the .xls or .xlsx file itself — a PDF, a CSV ' +
        'or a renamed file of another kind cannot be read.',
    });
  }

  /** `.xlsx`, which stays with `exceljs` per constitution v1.5.0. */
  private async readXlsx(buffer: Buffer): Promise<WorkbookSheet[]> {
    const workbook = new Workbook();
    // `as never` matching `transaction-sheet.service.ts`: exceljs's bundled Buffer typing does
    // not accept Node's generic Buffer, and the cast is the convention already used here.
    await workbook.xlsx.load(buffer as never);
    return workbook.worksheets.map((worksheet) => {
      const rows: WorkbookRow[] = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const cells: (string | number | null)[] = [];
        // `row.values` is 1-based with a hole at index 0, which is an exceljs quirk rather than
        // a fact about spreadsheets — normalised here so no caller has to know it.
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        for (const value of values) cells.push(normaliseCell(value));
        rows.push({ rowNumber, cells });
      });
      return { name: worksheet.name, rows };
    });
  }

  /** Legacy binary `.xls`, the only thing SheetJS is approved for. */
  private readLegacyXls(buffer: Buffer): WorkbookSheet[] {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      // Values, not formatted text: the arithmetic is recomputed downstream (FR-044) and a
      // formatted string would have to be parsed back out of its own thousands separators.
      raw: true,
      // Formulas are not evaluated and not needed — every figure this import keeps is recomputed.
      cellFormula: false,
      cellHTML: false,
    });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const matrix: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });
      const rows: WorkbookRow[] = [];
      matrix.forEach((cells, index) => {
        const normalised = cells.map(normaliseCell);
        if (normalised.some((cell) => cell !== null && cell !== '')) {
          // `sheet_to_json` drops blank rows but keeps the array dense, so the index is not the
          // sheet's own row number. `!ref` gives the origin; rows start there.
          rows.push({ rowNumber: index + 1, cells: normalised });
        }
      });
      return { name, rows };
    });
  }
}

/**
 * One cell to a string, a number or null.
 *
 * Dates become ISO strings rather than `Date` objects: a BOQ schedule carries no dates, so any
 * date-typed cell here is something else formatted as one, and keeping it as text leaves the
 * decision about what it means to the code that knows which column it sits in.
 */
function normaliseCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  // exceljs hands back objects for formulas, rich text and hyperlinks.
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('result' in record) return normaliseCell(record.result);
    if ('text' in record) return normaliseCell(record.text);
    if ('richText' in record && Array.isArray(record.richText)) {
      return record.richText
        .map((part) => String((part as { text?: string }).text ?? ''))
        .join('');
    }
    if ('hyperlink' in record) return normaliseCell(record.text ?? null);
  }
  return null;
}
