import * as ExcelJS from 'exceljs';
// `import = require` deliberately, not `import * as`. The app is built by SWC
// (nest-cli.json), which gives `import * as` true ESM semantics and hands back a
// namespace object that cannot be constructed; the tests are built by ts-jest, which
// emits a bare require and constructs fine. The namespace form therefore passes every
// test and throws "_pdfkit is not a constructor" in the running server. This form emits
// a bare require under both.
import PDFDocument = require('pdfkit');

import {
  type CompanyHeader,
  drawCompanyHeader,
} from '../../../common/document-header/company-header';
import type { ReportData } from '../report.types';

const stringify = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/**
 * A report as a PDF (055 — reworked at the client's request to format every generated PDF): the
 * company band, the title, then a ruled table whose heading row repeats on each page, with page
 * numbers at the foot. Until then a row was its values joined by " | " in one line of text, which
 * ran off the page on any report wider than four columns.
 *
 * Landscape once there are more than six columns. Column widths follow the widest value in each
 * column, capped so one long name cannot crowd the rest out; a cell too long for its column wraps.
 */
export function renderReportPdf(
  title: string,
  report: ReportData,
  brand?: CompanyHeader,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = report.columns.length > 6;
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: title },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const bottom = doc.page.height - MARGIN - 16;
    let y = MARGIN;
    if (brand) {
      y = drawCompanyHeader(doc, brand, {
        x: MARGIN,
        y,
        width,
        regular: REGULAR,
        bold: BOLD,
      });
    }
    doc
      .font(BOLD)
      .fontSize(14)
      .fillColor('#000000')
      .text(title, MARGIN, y, { width, align: 'center' });
    y = doc.y + 10;

    const cells = report.rows.map((row) =>
      report.columns.map((c) => stringify(row[c.key])),
    );
    const widths = reportColumnWidths(
      report.columns.map((c) => c.label),
      cells,
      width,
      (text, bold) =>
        doc
          .font(bold ? BOLD : REGULAR)
          .fontSize(SIZE)
          .widthOfString(text),
    );

    const rowHeight = (values: string[], bold: boolean) =>
      Math.max(
        ...values.map((value, i) =>
          doc
            .font(bold ? BOLD : REGULAR)
            .fontSize(SIZE)
            .heightOfString(value, { width: widths[i] - PAD * 2 }),
        ),
        SIZE,
      ) +
      PAD * 2;

    const drawRow = (values: string[], heading: boolean, shade: boolean) => {
      const h = rowHeight(values, heading);
      let x = MARGIN;
      values.forEach((value, i) => {
        if (heading || shade) {
          doc
            .save()
            .rect(x, y, widths[i], h)
            .fill(heading ? '#E5E7EB' : '#F9FAFB')
            .restore();
        }
        doc
          .lineWidth(0.5)
          .strokeColor('#9CA3AF')
          .rect(x, y, widths[i], h)
          .stroke();
        doc
          .font(heading ? BOLD : REGULAR)
          .fontSize(SIZE)
          .fillColor('#111111')
          .text(value, x + PAD, y + PAD, {
            width: widths[i] - PAD * 2,
            align: !heading && isFigure(value) ? 'right' : 'left',
          });
        x += widths[i];
      });
      y += h;
    };

    const labels = report.columns.map((c) => c.label);
    drawRow(labels, true, false);
    cells.forEach((values, index) => {
      if (y + rowHeight(values, false) > bottom) {
        doc.addPage();
        y = MARGIN;
        drawRow(labels, true, false);
      }
      drawRow(values, false, index % 2 === 1);
    });
    if (cells.length === 0) {
      doc
        .font(REGULAR)
        .fontSize(SIZE)
        .text('No rows for the chosen filters.', MARGIN, y + 8, { width });
    }

    // "Page 1 of 3" at the foot of every page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font(REGULAR)
        .fontSize(7.5)
        .fillColor('#6B7280')
        .text(
          `Page ${i - range.start + 1} of ${range.count}`,
          MARGIN,
          doc.page.height - MARGIN,
          { width, align: 'right', lineBreak: false },
        );
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}

const MARGIN = 32;
const PAD = 4;
const SIZE = 8.5;
const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

/** An amount or a count, set right — not a date, which is made of the same characters. */
function isFigure(value: string): boolean {
  return (
    /^-?(Rs\.?|₹)?\s*[\d,]+(\.\d+)?%?$/.test(value.trim()) &&
    !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(value.trim())
  );
}

/**
 * Each column's width: its widest value (heading included), capped at a third of the page, then
 * scaled to fill the page exactly. Exported for its test.
 */
export function reportColumnWidths(
  labels: string[],
  rows: string[][],
  width: number,
  measure: (text: string, bold: boolean) => number,
): number[] {
  const cap = width / 3;
  const natural = labels.map((label, i) =>
    Math.min(
      cap,
      Math.max(
        measure(label, true),
        ...rows.slice(0, 500).map((row) => measure(row[i] ?? '', false)),
        24,
      ) +
        PAD * 2,
    ),
  );
  const total = natural.reduce((a, b) => a + b, 0);
  return natural.map((w) => (w / total) * width);
}

/** Renders a report's columns and rows into an .xlsx workbook buffer. */
export async function renderReportExcel(
  title: string,
  report: ReportData,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || 'Report');

  sheet.columns = report.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: 20,
  }));
  sheet.getRow(1).font = { bold: true };

  for (const row of report.rows) {
    const record: Record<string, unknown> = {};
    for (const col of report.columns) {
      record[col.key] = stringify(row[col.key]);
    }
    sheet.addRow(record);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/** The MIME type and filename extension for an export format. */
export function formatMeta(format: 'pdf' | 'excel'): {
  contentType: string;
  extension: string;
} {
  return format === 'pdf'
    ? { contentType: 'application/pdf', extension: 'pdf' }
    : {
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
}
