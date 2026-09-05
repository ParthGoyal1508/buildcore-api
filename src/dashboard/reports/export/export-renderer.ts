import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';

import type { ReportData } from '../report.types';

const stringify = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** Renders a report's columns and rows into a simple tabular A4 PDF buffer. */
export function renderReportPdf(
  title: string,
  report: ReportData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();

    const header = report.columns.map((c) => c.label).join('  |  ');
    doc.fontSize(10).text(header);
    doc.moveTo(doc.x, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.3);

    for (const row of report.rows) {
      const line = report.columns
        .map((c) => stringify(row[c.key]))
        .join('  |  ');
      doc.fontSize(9).text(line);
    }

    doc.end();
  });
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
