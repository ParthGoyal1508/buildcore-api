import { Injectable } from '@nestjs/common';
// `import = require`, not `import * as` — the form `salary-pdf.service.ts` records the reason for
// and `src/common/swc-interop.spec.ts` guards. `pdfkit`'s export **is** the constructor, and SWC
// gives `import * as` true ESM semantics: a namespace object cannot be constructed. The namespace
// form passes every test under ts-jest and throws "is not a constructor" in the running server.
import PDFDocument = require('pdfkit');

import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
} from './bill-workbook.types';

/**
 * The bill package as a PDF (025 FR-042).
 *
 * ## Why this stands beside the workbook rather than replacing it
 *
 * The `.xlsx` is what the client edits before signing — the source document for this whole feature
 * *is* an Excel workbook. The PDF is what gets attached to an email, filed, and printed: a form
 * nobody can accidentally alter after it was sent. They are two readings of one bill, not two
 * bills, which is the entire reason both take **the same `BillWorkbookView`**.
 *
 * That is the load-bearing decision here. If this renderer took the package id and read its own
 * figures, the PDF and the spreadsheet of one bill could disagree — and a client holding both would
 * be right to believe whichever is worse for us. Taking the view means they cannot: every figure in
 * both came from the same already-rounded strings, computed once.
 *
 * ## It holds no database client either
 *
 * The constructor takes nothing, exactly as `BillWorkbookRenderer`'s does, and for the same reason
 * (FR-028): a renderer that could query could recompute, and a bill produced twice must be
 * identical to the one the client signed. `bill-pdf.renderer.spec.ts` asserts the absence, because
 * an absence nothing checks is an absence somebody adds a constructor parameter to.
 *
 * ## Sections, in the client's own order
 *
 * Check list, abstract, priced schedule, one measurement sheet per schedule line, debit register —
 * the order of the real RA-12 and of the workbook. A reviewer finds each figure by where it sits.
 */

/** A4 in points. Landscape swaps them. */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 28;

/** Font sizes, named because a bare `7` scattered through drawing calls says nothing. */
const SIZE = { title: 12, heading: 9, body: 7.5, small: 6.5 } as const;

type Align = 'left' | 'right' | 'center';

interface Column {
  header: string;
  width: number;
  align?: Align;
}

@Injectable()
export class BillPdfRenderer {
  async render(view: BillWorkbookView): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      autoFirstPage: false,
      // **Pinned to the bill's own date, never to the clock.** A PDF records when it was written,
      // and FR-028 says a bill produced twice is identical — which has to include the bytes a
      // reader never sees, or "identical" is only true of the parts somebody thought to check.
      info: {
        Title: `${view.header.billLabel} — ${view.header.projectName}`,
        Author: view.header.issuer.name ?? 'BuildCore',
        CreationDate: new Date(`${view.header.billDate}T00:00:00.000Z`),
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.checkListPage(doc, view);
    this.abstractPage(doc, view);
    this.schedulePage(doc, view);
    // **One per schedule line, including lines with nothing claimed this period** (FR-030). The
    // count is the assertion that matters: a PDF missing a sheet opens perfectly, and the item that
    // lost its sheet is the item nobody checks.
    for (const sheet of view.measurementSheets) {
      this.measurementPage(doc, view, sheet);
    }
    this.debitRegisterPage(doc, view);

    doc.end();
    return finished;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  private checkListPage(doc: PDFKit.PDFDocument, view: BillWorkbookView): void {
    this.page(doc, 'portrait');
    this.title(doc, view, 'CHECK LIST for Subcontractor Bill', A4_WIDTH);
    this.headerBlock(doc, view, A4_WIDTH);

    const width = A4_WIDTH - MARGIN * 2;
    this.table(
      doc,
      [
        { header: 'S. No.', width: 40, align: 'center' },
        { header: 'Check list', width: width - 40 - 150 },
        { header: 'Yes', width: 50, align: 'center' },
        { header: 'No', width: 50, align: 'center' },
        { header: 'Not required', width: 50, align: 'center' },
      ],
      view.checkList.rows.map((row) => [
        String(row.position),
        row.text,
        // An unanswered question leaves **every** column blank (FR-042). "We checked and it is not
        // attached" and "nobody has looked" are different facts, and a tick in the No column for
        // the second would be this renderer inventing an answer nobody gave.
        row.answer === 'yes' ? 'Y' : '',
        row.answer === 'no' ? 'N' : '',
        row.answer === 'not_required' ? 'N/R' : '',
      ]),
    );

    doc.moveDown(1).fontSize(SIZE.small).text(view.checkList.footer, {
      width,
      align: 'left',
    });

    doc.moveDown(2).fontSize(SIZE.body);
    const half = width / 2;
    const y = doc.y;
    view.checkList.signatories.forEach((name, index) => {
      doc.text(name, MARGIN + index * half, y, { width: half });
      doc.text('Name & Designation', MARGIN + index * half, y + 28, {
        width: half,
      });
      doc
        .moveTo(MARGIN + index * half, y + 26)
        .lineTo(MARGIN + index * half + half - 20, y + 26)
        .stroke();
    });
  }

  private abstractPage(doc: PDFKit.PDFDocument, view: BillWorkbookView): void {
    this.page(doc, 'portrait');
    this.title(doc, view, 'ABSTRACT SHEET', A4_WIDTH);
    this.headerBlock(doc, view, A4_WIDTH);

    const width = A4_WIDTH - MARGIN * 2;
    const figure = (width - 40 - 40) / 3;
    const columns: Column[] = [
      { header: '', width: 20, align: 'center' },
      { header: 'Particulars', width: width - 20 - 20 - figure * 3 },
      { header: '', width: 20, align: 'center' },
      { header: 'Upto Date', width: figure, align: 'right' },
      { header: 'Upto Previous', width: figure, align: 'right' },
      { header: 'This Month', width: figure, align: 'right' },
    ];

    const rows: string[][] = [];
    for (const block of view.abstract.blocks) {
      rows.push(['', block.title.toUpperCase(), '', '', '', '']);
      block.rows.forEach((row, index) => {
        rows.push([
          row.isTotal ? '' : String(index + 1),
          row.label,
          'Rs.',
          row.uptoDate,
          row.uptoPrevious,
          // A row blank this month because it is fully recovered prints blank, not a dash and not
          // a zero (FR-020a): "nothing was recovered this month" and "there is nothing left to
          // recover" are different facts that would otherwise print the same character.
          row.fullyRecovered ? '' : row.thisMonth,
        ]);
      });
    }
    rows.push([
      '',
      view.abstract.payable.label,
      'Rs.',
      view.abstract.payable.uptoDate,
      view.abstract.payable.uptoPrevious,
      view.abstract.payable.thisMonth,
    ]);
    rows.push([
      '',
      view.abstract.netPayable.label,
      'Rs.',
      view.abstract.netPayable.uptoDate,
      view.abstract.netPayable.uptoPrevious,
      view.abstract.netPayable.thisMonth,
    ]);

    this.table(doc, columns, rows);

    // Printed so a reviewer can check the tax decision rather than take it (FR-016a).
    doc
      .moveDown(0.8)
      .fontSize(SIZE.small)
      .text(
        `Tax basis: ${view.abstract.taxBasis} (${view.abstract.taxBasisSource})`,
        { width },
      );
  }

  private schedulePage(doc: PDFKit.PDFDocument, view: BillWorkbookView): void {
    this.page(doc, 'landscape');
    this.title(doc, view, 'BOQ ANNEXURE-I', A4_HEIGHT);
    this.headerBlock(doc, view, A4_HEIGHT);

    const width = A4_HEIGHT - MARGIN * 2;
    const figure = 62;
    this.table(
      doc,
      [
        { header: 'Sr', width: 22, align: 'center' },
        { header: 'BOQ No.', width: 46 },
        { header: 'Description', width: width - 22 - 46 - 34 - figure * 7 },
        { header: 'UOM', width: 34, align: 'center' },
        { header: 'Qty', width: figure, align: 'right' },
        { header: 'Rate', width: figure, align: 'right' },
        { header: 'Amount', width: figure, align: 'right' },
        { header: 'Balance Qty', width: figure, align: 'right' },
        { header: 'Qty Upto Date', width: figure, align: 'right' },
        { header: 'Qty This Bill', width: figure, align: 'right' },
        { header: 'Amt This Bill', width: figure, align: 'right' },
      ],
      view.schedule.lines.map((line) => [
        String(line.srNo),
        line.boqNo,
        // Carried whole, however long (FR-029). The cell wraps and the row grows; it is never cut,
        // because a specification truncated mid-sentence changes what was agreed.
        line.description,
        line.unit,
        line.scopeQty,
        line.rate,
        line.scopeAmount,
        line.balanceQty,
        line.qtyUptoDate,
        line.qtyThisBill,
        line.amountThisBill,
      ]),
      [
        '',
        '',
        'Total Work Done',
        '',
        '',
        '',
        view.schedule.totals.scopeAmount,
        '',
        view.schedule.totals.amountUptoDate,
        '',
        view.schedule.totals.amountThisBill,
      ],
    );
  }

  private measurementPage(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
    sheet: WorkbookMeasurementSheet,
  ): void {
    this.page(doc, 'portrait');
    this.title(doc, view, 'MEASUREMENT SHEET', A4_WIDTH);

    const width = A4_WIDTH - MARGIN * 2;
    // The item is printed **inside** the sheet, which is what makes naming the sheets by position
    // safe in the workbook and is worth keeping here for the same reason: a reader must be able to
    // tell which item a page belongs to without counting pages.
    doc
      .fontSize(SIZE.heading)
      .text(`${sheet.boqNo} — ${sheet.description}`, MARGIN, doc.y, { width });
    doc.fontSize(SIZE.small).text(`Quantities in ${sheet.unit}`, { width });
    doc.moveDown(0.5);

    this.table(
      doc,
      [
        { header: 'S.No', width: 34, align: 'center' },
        { header: 'Month', width: 70 },
        { header: 'Period', width: 130 },
        { header: 'Qty', width: 60, align: 'right' },
        { header: 'Remarks', width: width - 34 - 70 - 130 - 60 - 60 },
        { header: 'RA Bill', width: 60, align: 'center' },
      ],
      sheet.history.map((row, index) => [
        String(index + 1),
        row.month,
        row.period,
        row.quantity,
        // Verbatim. This column is where a deduction is argued — "30% deduction, shoulder slope,
        // staff not available" — and it is the sentence the document exists to settle.
        row.remarks ?? '',
        row.billLabel,
      ]),
      [
        '',
        'This Bill Qty',
        sheet.footer.thisBillQty,
        'Upto Previous',
        sheet.footer.uptoPreviousQty,
        `Upto Date ${sheet.footer.uptoDateQty}`,
      ],
    );

    if (sheet.dailyRecord.length > 0) {
      doc.moveDown(0.8).fontSize(SIZE.heading).text('Daily record', { width });
      doc.moveDown(0.3);
      this.table(
        doc,
        [
          { header: 'Sr', width: 30, align: 'center' },
          { header: 'Date', width: 70 },
          { header: 'Start', width: 60, align: 'right' },
          { header: 'End', width: 60, align: 'right' },
          { header: 'Total Run', width: 60, align: 'right' },
          { header: 'Remarks', width: width - 30 - 70 - 180 },
        ],
        sheet.dailyRecord.map((day, index) => [
          String(index + 1),
          day.date,
          // A day with no logbook entry prints "no record", never zeroes (FR-034). An unrecorded
          // day and a day the machine did nothing are different facts, and only one of them is
          // somebody to go and ask.
          day.missing ? 'no record' : day.openingReading ?? '',
          day.missing ? '' : day.closingReading ?? '',
          day.missing ? '' : day.totalRun ?? '',
          day.remarks ?? '',
        ]),
      );
    }
  }

  private debitRegisterPage(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
  ): void {
    this.page(doc, 'landscape');
    this.title(doc, view, 'DEBIT NOTE', A4_HEIGHT);
    this.headerBlock(doc, view, A4_HEIGHT);

    const width = A4_HEIGHT - MARGIN * 2;
    const columns: Column[] = [
      { header: 'Sr', width: 24, align: 'center' },
      { header: 'Description', width: width - 24 - 90 - 40 * 4 - 70 * 2 - 80 },
      { header: 'Location', width: 90 },
      { header: 'Nos', width: 40, align: 'right' },
      { header: 'Qty', width: 40, align: 'right' },
      { header: 'UOM', width: 40, align: 'center' },
      { header: 'Rate', width: 40, align: 'right' },
      { header: 'Amount', width: 70, align: 'right' },
      { header: 'Amt with GST', width: 70, align: 'right' },
      { header: 'Remark', width: 80 },
    ];

    const rows: string[][] = [];
    for (const group of view.debitRegister.groups) {
      if (group.heading) {
        rows.push(['', group.heading, '', '', '', '', '', '', '', '']);
      }
      for (const row of group.rows) {
        rows.push([
          String(row.srNo),
          row.description,
          row.location ?? '',
          row.nos ?? '',
          row.quantity ?? '',
          row.unit ?? '',
          row.rate,
          row.amount,
          row.amountWithTax,
          // Which bill it was debited in — the register spans bills, and without this column a
          // reader cannot tell a debit recovered three bills ago from one recovered here.
          row.remark ?? '',
        ]);
      }
    }
    if (rows.length === 0) {
      rows.push([
        '',
        'No debits on this project.',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]);
    }

    this.table(doc, columns, rows, [
      '',
      'Total',
      '',
      '',
      '',
      '',
      '',
      '',
      view.debitRegister.total,
      '',
    ]);
  }

  // ── The pieces every page shares ─────────────────────────────────────────

  private page(
    doc: PDFKit.PDFDocument,
    layout: 'portrait' | 'landscape',
  ): void {
    doc.addPage({ size: 'A4', layout, margin: MARGIN });
  }

  private title(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
    heading: string,
    pageWidth: number,
  ): void {
    const width = pageWidth - MARGIN * 2;
    doc
      .fontSize(SIZE.title)
      .text(view.header.issuer.name ?? '', MARGIN, MARGIN, {
        width,
        align: 'center',
      });
    doc
      .fontSize(SIZE.heading)
      .text(heading, { width, align: 'center' })
      .moveDown(0.4);
  }

  /**
   * The statutory header the client's own sheets repeat on every page.
   *
   * A field the party's record does not carry prints **blank** rather than refusing the document
   * (FR-027): a bill that cannot be produced because a PAN is unrecorded is worse than one produced
   * with a blank somebody fills in by hand. What is missing is listed at the foot of the check
   * list, so the gap is visible rather than merely absent.
   */
  private headerBlock(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
    pageWidth: number,
  ): void {
    const width = pageWidth - MARGIN * 2;
    const half = width / 2;
    const h = view.header;
    const left: [string, string | null][] = [
      ['Name of Sub-Contractor', h.receiver.name],
      ['Nature of Work', h.natureOfWork],
      ['Work Order No.', h.externalWorkOrderNo],
      ['Bill No.', h.externalBillNo],
      ['Bill Period', `${h.periodFrom} to ${h.periodTo}`],
    ];
    const right: [string, string | null][] = [
      ['Location', h.location],
      ['Vendor Code', h.receiver.code],
      ['Vendor GSTIN', h.receiver.gstin],
      ['Vendor PAN', h.receiver.pan],
      ['Bill Date', h.billDate],
    ];

    const top = doc.y;
    doc.fontSize(SIZE.small);
    const column = (pairs: [string, string | null][], x: number) => {
      let y = top;
      for (const [label, value] of pairs) {
        doc.text(`${label}: ${value ?? ''}`, x, y, { width: half - 6 });
        y += 11;
      }
      return y;
    };
    const bottom = Math.max(column(left, MARGIN), column(right, MARGIN + half));
    doc.y = bottom + 4;
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(pageWidth - MARGIN, doc.y)
      .stroke();
    doc.y += 6;
  }

  /**
   * A table, because pdfkit has none.
   *
   * Rows grow to fit their tallest cell, so a multi-paragraph BOQ description is carried whole
   * (FR-029) rather than clipped to a row height chosen in advance. A row that would cross the
   * bottom margin starts a new page and repeats the column headers — a continuation page whose
   * columns are unlabelled is a page a reader has to scroll back from.
   */
  private table(
    doc: PDFKit.PDFDocument,
    columns: Column[],
    rows: string[][],
    footer?: string[],
  ): void {
    const bottomLimit = doc.page.height - MARGIN;

    const writeHeader = () => {
      const y = doc.y;
      let x = MARGIN;
      doc.fontSize(SIZE.small);
      for (const column of columns) {
        doc.text(column.header, x + 2, y + 2, {
          width: column.width - 4,
          align: column.align ?? 'left',
        });
        x += column.width;
      }
      const height = 14;
      doc
        .moveTo(MARGIN, y + height)
        .lineTo(x, y + height)
        .stroke();
      doc.y = y + height + 2;
    };

    writeHeader();

    const writeRow = (cells: string[], bold: boolean) => {
      doc.fontSize(bold ? SIZE.body : SIZE.small);
      // Measured before anything is drawn, so the row can be moved to the next page whole rather
      // than split across the break with its first line orphaned.
      const height =
        Math.max(
          ...columns.map((column, index) =>
            doc.heightOfString(cells[index] ?? '', {
              width: column.width - 4,
            }),
          ),
        ) + 4;

      if (doc.y + height > bottomLimit) {
        doc.addPage({
          size: 'A4',
          layout: doc.page.width > doc.page.height ? 'landscape' : 'portrait',
          margin: MARGIN,
        });
        writeHeader();
      }

      const y = doc.y;
      let x = MARGIN;
      for (const [index, column] of columns.entries()) {
        doc.text(cells[index] ?? '', x + 2, y + 2, {
          width: column.width - 4,
          align: column.align ?? 'left',
        });
        x += column.width;
      }
      doc.y = y + height;
    };

    for (const row of rows) writeRow(row, false);
    if (footer) {
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(
          MARGIN + columns.reduce((total, column) => total + column.width, 0),
          doc.y,
        )
        .stroke();
      doc.y += 2;
      writeRow(footer, true);
    }
  }
}
