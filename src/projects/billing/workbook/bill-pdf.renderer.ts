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
import { type DebitNoteView, drawDebitNotePdf } from './debit-note-document';
import { headerPairs } from './header-pairs';
import { indianFigure, taxBasisLine } from './print-format';
import { billSignatures } from './signature-block';

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

/** A table row: its cells, or its cells with emphasis — a block heading, a total. */
type Row = string[] | { cells: string[]; bold?: boolean; rule?: boolean };

interface Column {
  header: string;
  width: number;
  align?: Align;
}

@Injectable()
export class BillPdfRenderer {
  /** `abstractOnly`: the abstract page alone — a client's *Payment Abstract* as its own document. */
  async render(
    view: BillWorkbookView,
    options: { abstractOnly?: boolean } = {},
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      autoFirstPage: false,
      // **Pinned to the bill's own date, never to the clock.** A PDF records when it was written,
      // and FR-028 says a bill produced twice is identical — which has to include the bytes a
      // reader never sees, or "identical" is only true of the parts somebody thought to check.
      info: {
        Title: `${view.header.billLabel} — ${view.header.projectName}`,
        Author: view.header.issuer.name ?? 'Tirupati Groups',
        CreationDate: new Date(`${view.header.billDate}T00:00:00.000Z`),
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.abstractPage(doc, view);
    if (options.abstractOnly) {
      doc.end();
      return finished;
    }
    this.schedulePage(doc, view);
    // **One per schedule line, including lines with nothing claimed this period** (FR-030). The
    // count is the assertion that matters: a PDF missing a sheet opens perfectly, and the item that
    // lost its sheet is the item nobody checks.
    for (const sheet of view.measurementSheets) {
      this.measurementPage(doc, view, sheet);
    }
    this.debitNotePages(doc, view);

    doc.end();
    return finished;
  }

  /**
   * One debit note on its own, in the client's format (2026-10-15) — the same drawing the bill
   * package's "Debit Note" section uses for each note it recovers.
   */
  async renderDebitNote(view: DebitNoteView): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      autoFirstPage: false,
      info: {
        Title: `Debit Note ${view.noteNumber ?? ''} — ${
          view.projectName
        }`.trim(),
        Author: view.company.name,
        // Pinned to the note's own date, never to the clock (FR-028).
        CreationDate: new Date(`${view.noteDate}T00:00:00.000Z`),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    drawDebitNotePdf(doc, view);
    doc.end();
    return finished;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  private abstractPage(doc: PDFKit.PDFDocument, view: BillWorkbookView): void {
    this.page(doc, 'portrait');
    this.title(
      doc,
      view.header.issuer.name,
      view.abstract.title ?? 'ABSTRACT SHEET',
      A4_WIDTH,
    );
    this.headerBlock(doc, ...headerPairs(view.header), A4_WIDTH);

    const width = A4_WIDTH - MARGIN * 2;
    // The particulars get the room (2026-10-15). The figure columns were sized as if the other
    // three columns were 80pt in all, which left "Particulars" 40pt wide — one word a line, and
    // "B. RECOVE / RIES" broken mid-word.
    const PARTICULARS = 215;
    const figure = (width - 22 - PARTICULARS - 24) / 3;
    const columns: Column[] = [
      { header: 'Sr', width: 22, align: 'center' },
      { header: 'Particulars', width: PARTICULARS },
      { header: '', width: 24, align: 'center' },
      { header: 'Upto Date', width: figure, align: 'right' },
      { header: 'Upto Previous', width: figure, align: 'right' },
      { header: 'This Month', width: figure, align: 'right' },
    ];

    const rows: Row[] = [];
    for (const block of view.abstract.blocks) {
      rows.push({
        cells: ['', block.title.toUpperCase(), '', '', '', ''],
        bold: true,
      });
      block.rows.forEach((row, index) => {
        const cells = [
          row.isTotal ? '' : String(index + 1),
          row.label,
          'Rs.',
          row.uptoDate,
          row.uptoPrevious,
          // A row blank this month because it is fully recovered prints blank, not a dash and not
          // a zero (FR-020a): "nothing was recovered this month" and "there is nothing left to
          // recover" are different facts that would otherwise print the same character.
          row.fullyRecovered ? '' : row.thisMonth,
        ];
        rows.push(row.isTotal ? { cells, bold: true } : cells);
      });
    }
    for (const total of [view.abstract.payable, view.abstract.netPayable]) {
      if (!total) continue;
      rows.push({
        cells: [
          '',
          total.label,
          'Rs.',
          total.uptoDate,
          total.uptoPrevious,
          total.thisMonth,
        ],
        bold: true,
        rule: true,
      });
    }

    this.table(doc, columns, rows);

    // From the left margin, explicitly: after the table the cursor's x is the last column's, and
    // the line ran off the right edge of the page from there.
    if (view.abstract.amountInWords) {
      doc
        .moveDown(0.6)
        .font('Helvetica-Bold')
        .fontSize(SIZE.body)
        .text(
          `Amount in words: ${view.abstract.amountInWords}`,
          MARGIN,
          doc.y,
          { width },
        )
        .font('Helvetica');
    }

    // Printed so a reviewer can check the tax decision rather than take it (FR-016a).
    doc
      .moveDown(0.5)
      .fontSize(SIZE.small)
      .text(taxBasisLine(view.abstract), MARGIN, doc.y, { width });

    this.signatureBlock(doc, view);
  }

  /**
   * The subcontractor's sign-off under the abstract (2026-10-14) — see `billSignatures`
   * for who signs where (a bill to the client: the captions alone).
   *
   * **Kept whole on one page.** The block is measured before it is drawn and, if it would cross the
   * bottom margin, starts a fresh page of its own: a "Prepared by" at the foot of one page and its
   * "Approved by" at the head of the next is a signature somebody signs without seeing what it
   * approves.
   */
  private signatureBlock(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
  ): void {
    const rows = billSignatures(view.header);

    const width = doc.page.width - MARGIN * 2;
    const half = width / 2;
    // Caption, the space a pen needs, the designation, and a gap before the next pair.
    const CAPTION = 12;
    const SIGNING_SPACE = 36;
    const SIGNATORY = 12;
    const GAP = 14;
    const rowHeight = CAPTION + SIGNING_SPACE + SIGNATORY + GAP;
    const lead = 18;
    const height = lead + rowHeight * rows.length;

    if (doc.y + height > doc.page.height - MARGIN) {
      this.page(
        doc,
        doc.page.width > doc.page.height ? 'landscape' : 'portrait',
      );
    } else {
      doc.y += lead;
    }

    let y = doc.y;
    doc.fontSize(SIZE.body);
    for (const row of rows) {
      [row.left, row.right].forEach((slot, index) => {
        const x = MARGIN + index * half;
        doc
          .font('Helvetica-Bold')
          .text(slot.caption, x, y, { width: half - 20 });
        doc
          .font('Helvetica')
          .text(slot.signatory, x, y + CAPTION + SIGNING_SPACE, {
            width: half - 20,
          });
      });
      y += rowHeight;
    }
    doc.x = MARGIN;
    doc.y = y;
  }

  private schedulePage(doc: PDFKit.PDFDocument, view: BillWorkbookView): void {
    this.page(doc, 'landscape');
    this.title(doc, view.header.issuer.name, 'BOQ ANNEXURE-I', A4_HEIGHT);
    this.headerBlock(doc, ...headerPairs(view.header), A4_HEIGHT);

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
    this.title(doc, view.header.issuer.name, 'MEASUREMENT SHEET', A4_WIDTH);

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
    );

    // The three totals as a line of their own (2026-10-15). As a table footer they were squeezed
    // into the S.No/Month/Period/Qty columns — "Upto Previous" right-aligned under Qty, "Upto Date"
    // wrapping in the RA Bill column — and printed ungrouped.
    doc
      .moveDown(0.3)
      .font('Helvetica-Bold')
      .fontSize(SIZE.body)
      .text(
        [
          `This Bill Qty: ${indianFigure(sheet.footer.thisBillQty)}`,
          `Upto Previous: ${indianFigure(sheet.footer.uptoPreviousQty)}`,
          `Upto Date: ${indianFigure(sheet.footer.uptoDateQty)} ${sheet.unit}`,
        ].join('      '),
        MARGIN,
        doc.y,
        { width, align: 'right' },
      )
      .font('Helvetica');

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

  /**
   * The bill's "Debit Note" section (2026-10-15): every note recovered on it, each in the client's
   * format on a page of its own. A bill recovering none still carries the section, saying so, so
   * the four sections are always there to be checked.
   */
  private debitNotePages(
    doc: PDFKit.PDFDocument,
    view: BillWorkbookView,
  ): void {
    if (view.debitNotes.length > 0) {
      for (const note of view.debitNotes) drawDebitNotePdf(doc, note);
      return;
    }
    this.page(doc, 'portrait');
    this.title(doc, view.header.issuer.name, 'DEBIT NOTE', A4_WIDTH);
    this.headerBlock(doc, ...headerPairs(view.header), A4_WIDTH);
    doc
      .moveDown(1)
      .fontSize(SIZE.body)
      .text('No debit note is recovered on this bill.', MARGIN, doc.y, {
        width: A4_WIDTH - MARGIN * 2,
      });
  }

  // ── The pieces every page shares ─────────────────────────────────────────

  private page(
    doc: PDFKit.PDFDocument,
    layout: 'portrait' | 'landscape',
  ): void {
    doc.addPage({ size: 'A4', layout, margin: MARGIN });
  }

  /**
   * The issuer's name and the sheet's heading, centred.
   *
   * Takes the **name** rather than a whole bill view so a document that is not a bill package —
   * the standalone debit note (028 FR-018) — can use the same heading block. That is the reason
   * for the parameter: the alternative was a second renderer, and two renderers of one house
   * style drift apart exactly once and then print two different letterheads.
   */
  private title(
    doc: PDFKit.PDFDocument,
    issuerName: string | null,
    heading: string,
    pageWidth: number,
  ): void {
    const width = pageWidth - MARGIN * 2;
    doc.fontSize(SIZE.title).text(issuerName ?? '', MARGIN, MARGIN, {
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
    left: [string, string | null][],
    right: [string, string | null][],
    pageWidth: number,
  ): void {
    const width = pageWidth - MARGIN * 2;
    const half = width / 2;

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
    rows: Row[],
    footer?: string[],
  ): void {
    const bottomLimit = doc.page.height - MARGIN;

    const writeHeader = () => {
      const y = doc.y;
      let x = MARGIN;
      doc.font('Helvetica-Bold').fontSize(SIZE.small);
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
      doc.font('Helvetica');
    };

    writeHeader();

    const tableWidth = columns.reduce(
      (total, column) => total + column.width,
      0,
    );
    // A figure column prints with Indian grouping (2026-10-15): 3,11,581, as the client's own
    // bills do. `indianFigure` leaves anything that is not a bare number alone.
    const shown = (cells: string[]) =>
      cells.map((cell, index) =>
        columns[index]?.align === 'right' ? indianFigure(cell ?? '') : cell,
      );

    const writeRow = (raw: string[], bold: boolean) => {
      const cells = shown(raw);
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? SIZE.body : SIZE.small);
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
      doc.font('Helvetica');
    };

    for (const row of rows) {
      if (Array.isArray(row)) {
        writeRow(row, false);
        continue;
      }
      if (row.rule) {
        doc
          .moveTo(MARGIN, doc.y)
          .lineTo(MARGIN + tableWidth, doc.y)
          .lineWidth(0.5)
          .stroke();
        doc.y += 2;
      }
      writeRow(row.cells, row.bold ?? false);
    }
    if (footer) {
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + tableWidth, doc.y)
        .stroke();
      doc.y += 2;
      writeRow(footer, true);
    }
  }
}
