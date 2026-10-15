import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
} from './bill-workbook.types';
import { type DebitNoteView, debitNoteDocx } from './debit-note-document';
import { headerPairs } from './header-pairs';
import { indianFigure, taxBasisLine } from './print-format';
import { billSignatures } from './signature-block';

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
const BORDERS = {
  top: BORDER,
  bottom: BORDER,
  left: BORDER,
  right: BORDER,
};

/**
 * The bill as a Word document (2026-10-13) — the abstract, the priced schedule and the debit
 * register, from the **same view** the workbook and the PDF read.
 *
 * A third reading of one set of already-rounded figures, not a third computation: like the PDF
 * renderer it holds no database client, so it cannot disagree with the other two. Measurement
 * sheets are left to the workbook and the PDF, where their day-by-day tables belong; a Word copy
 * is what somebody edits into a covering letter or a client's own template.
 */
@Injectable()
export class BillDocxRenderer {
  /** `abstractOnly`: the first section alone — a client's *Payment Abstract* as its own document. */
  async render(
    view: BillWorkbookView,
    options: { abstractOnly?: boolean } = {},
  ): Promise<Buffer> {
    const doc = new Document({
      styles: {
        default: { document: { run: { font: 'Arial', size: 18 } } },
      },
      sections: [
        {
          properties: {
            page: {
              margin: { top: 720, bottom: 720, left: 720, right: 720 },
            },
          },
          children: [
            ...this.title(view, view.abstract.title ?? 'ABSTRACT SHEET'),
            this.header(view),
            spacer(),
            this.abstract(view),
            ...(view.abstract.amountInWords
              ? [
                  new Paragraph({
                    spacing: { before: 160 },
                    children: [
                      new TextRun({ text: 'Amount in words: ', bold: true }),
                      new TextRun(view.abstract.amountInWords),
                    ],
                  }),
                ]
              : []),
            new Paragraph({
              spacing: { before: 120 },
              children: [
                new TextRun({
                  text: taxBasisLine(view.abstract),
                  size: 14,
                }),
              ],
            }),
            ...this.signatures(view),
          ],
        },
        ...(options.abstractOnly ? [] : this.annexures(view)),
      ],
    });
    return Packer.toBuffer(doc);
  }

  /**
   * Everything after the abstract, in the order the PDF and the workbook print it (2026-10-15) —
   * the client: "keep all the Abstract Sheet, BOQ Annexure, Measurement Sheet and Debit Note in
   * all the three format". The Word copy used to carry no measurement sheets, and dropped the
   * debit note when the project had no debits; both are now here, the debit note saying so.
   */
  private annexures(view: BillWorkbookView) {
    const margin = { top: 720, bottom: 720, left: 720, right: 720 };
    const landscape = {
      page: { size: { orientation: PageOrientation.LANDSCAPE }, margin },
    };
    return [
      {
        properties: landscape,
        children: [
          ...this.title(view, 'BOQ ANNEXURE-I'),
          this.header(view, LANDSCAPE),
          spacer(),
          this.schedule(view),
        ],
      },
      ...view.measurementSheets.map((sheet) => ({
        properties: { page: { margin } },
        children: this.measurement(view, sheet),
      })),
      // Each note recovered on this bill in the client's own format (2026-10-15); a bill that
      // recovers none says so, so the section is always there.
      ...(view.debitNotes.length > 0
        ? view.debitNotes.map((note) => ({
            properties: { page: { margin } },
            children: debitNoteDocx(note),
          }))
        : [
            {
              properties: { page: { margin } },
              children: [
                ...this.title(view, 'DEBIT NOTE'),
                this.header(view),
                spacer(),
                new Paragraph({
                  children: [
                    new TextRun('No debit note is recovered on this bill.'),
                  ],
                }),
              ],
            },
          ]),
    ];
  }

  /** One debit note on its own, in the client's format (2026-10-15). */
  async renderDebitNote(view: DebitNoteView): Promise<Buffer> {
    const doc = new Document({
      styles: {
        default: { document: { run: { font: 'Arial', size: 18 } } },
      },
      sections: [
        {
          properties: {
            page: {
              margin: { top: 720, bottom: 720, left: 720, right: 720 },
            },
          },
          children: debitNoteDocx(view),
        },
      ],
    });
    return Packer.toBuffer(doc);
  }

  /** One schedule line's measurement sheet: the history behind its quantity, and its totals. */
  private measurement(
    view: BillWorkbookView,
    sheet: WorkbookMeasurementSheet,
  ): (Paragraph | Table)[] {
    const history: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: (
          [
            ['S.No', false],
            ['Month', false],
            ['Period', false],
            ['Qty', true],
            ['Remarks', false],
            ['RA Bill', false],
          ] as [string, boolean][]
        ).map(([text, right]) => cell(text, { bold: true, right, head: true })),
      }),
      ...sheet.history.map(
        (row, index) =>
          new TableRow({
            children: [
              cell(String(index + 1), {}),
              cell(row.month, {}),
              cell(row.period, {}),
              cell(row.quantity, { right: true }),
              cell(row.remarks ?? '', {}),
              cell(row.billLabel, {}),
            ],
          }),
      ),
    ];
    const parts: (Paragraph | Table)[] = [
      ...this.title(view, 'MEASUREMENT SHEET'),
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: `${sheet.boqNo} — ${sheet.description}`,
            bold: true,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: `Quantities in ${sheet.unit}`, size: 16 }),
        ],
      }),
      table(history, [8, 16, 28, 14, 22, 12], PORTRAIT),
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 120 },
        children: [
          new TextRun({
            bold: true,
            text: [
              `This Bill Qty: ${indianFigure(sheet.footer.thisBillQty)}`,
              `Upto Previous: ${indianFigure(sheet.footer.uptoPreviousQty)}`,
              `Upto Date: ${indianFigure(sheet.footer.uptoDateQty)} ${
                sheet.unit
              }`,
            ].join('     '),
          }),
        ],
      }),
    ];
    if (sheet.dailyRecord.length > 0) {
      parts.push(
        new Paragraph({
          spacing: { before: 240, after: 80 },
          children: [new TextRun({ text: 'Daily record', bold: true })],
        }),
        table(
          [
            new TableRow({
              tableHeader: true,
              children: (
                [
                  ['Sr', false],
                  ['Date', false],
                  ['Start', true],
                  ['End', true],
                  ['Total Run', true],
                  ['Remarks', false],
                ] as [string, boolean][]
              ).map(([text, right]) =>
                cell(text, { bold: true, right, head: true }),
              ),
            }),
            ...sheet.dailyRecord.map(
              (day, index) =>
                new TableRow({
                  children: [
                    cell(String(index + 1), {}),
                    cell(day.date, {}),
                    // "no record", never zeroes (FR-034), as the PDF prints it.
                    cell(day.missing ? 'no record' : day.openingReading ?? '', {
                      right: true,
                    }),
                    cell(day.missing ? '' : day.closingReading ?? '', {
                      right: true,
                    }),
                    cell(day.missing ? '' : day.totalRun ?? '', {
                      right: true,
                    }),
                    cell(day.remarks ?? '', {}),
                  ],
                }),
            ),
          ],
          [8, 18, 14, 14, 14, 32],
          PORTRAIT,
        ),
      );
    }
    return parts;
  }

  private title(view: BillWorkbookView, title: string): Paragraph[] {
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: view.header.issuer.name ?? '',
            bold: true,
            size: 28,
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: title, bold: true, size: 22 })],
      }),
    ];
  }

  private header(view: BillWorkbookView, pageWidth = PORTRAIT): Table {
    const [left, right] = headerPairs(view.header);
    const rows: TableRow[] = [];
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      rows.push(
        new TableRow({
          children: [
            cell(left[i]?.[0] ?? '', { bold: true, width: 20 }),
            cell(left[i]?.[1] ?? '', { width: 30 }),
            cell(right[i]?.[0] ?? '', { bold: true, width: 20 }),
            cell(right[i]?.[1] ?? '', { width: 30 }),
          ],
        }),
      );
    }
    return table(rows, [20, 30, 20, 30], pageWidth);
  }

  private abstract(view: BillWorkbookView): Table {
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          cell('Sr.', { bold: true, width: 6, head: true }),
          cell('Particulars', { bold: true, width: 46, head: true }),
          cell('Upto Date', { bold: true, width: 16, right: true, head: true }),
          cell('Upto Previous', {
            bold: true,
            width: 16,
            right: true,
            head: true,
          }),
          cell('This Bill', { bold: true, width: 16, right: true, head: true }),
        ],
      }),
    ];
    for (const block of view.abstract.blocks) {
      rows.push(
        new TableRow({
          children: [
            cell('', {}),
            cell(block.title, { bold: true }),
            cell('', {}),
            cell('', {}),
            cell('', {}),
          ],
        }),
      );
      block.rows.forEach((row, index) => {
        const bold = row.isTotal ?? false;
        rows.push(
          new TableRow({
            children: [
              cell(row.isTotal ? '' : String(index + 1), {}),
              cell(row.label, { bold }),
              cell(row.uptoDate, { bold, right: true }),
              cell(row.uptoPrevious, { bold, right: true }),
              cell(row.fullyRecovered ? '' : row.thisMonth, {
                bold,
                right: true,
              }),
            ],
          }),
        );
      });
    }
    for (const row of [view.abstract.payable, view.abstract.netPayable]) {
      if (!row) continue;
      rows.push(
        new TableRow({
          children: [
            cell('', {}),
            cell(row.label, { bold: true }),
            cell(row.uptoDate, { bold: true, right: true }),
            cell(row.uptoPrevious, { bold: true, right: true }),
            cell(row.thisMonth, { bold: true, right: true }),
          ],
        }),
      );
    }
    return table(rows, [6, 46, 16, 16, 16], PORTRAIT);
  }

  private schedule(view: BillWorkbookView): Table {
    // Widths in percent (2026-10-15): unset, Word gave every column the same share and the
    // description — the one column with sentences in it — wrapped a word to a line.
    const head: [string, number][] = [
      ['Sr.', 4],
      ['BOQ No.', 7],
      ['Description', 35],
      ['Unit', 6],
      ['Rate', 9],
      ['Qty Upto Date', 9.75],
      ['Qty Upto Prev.', 9.75],
      ['Qty This Bill', 9.75],
      ['Amount This Bill', 9.75],
    ];
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: head.map(([text, width], index) =>
          cell(text, { bold: true, right: index >= 4, width, head: true }),
        ),
      }),
    ];
    for (const line of view.schedule.lines) {
      rows.push(
        new TableRow({
          children: [
            cell(String(line.srNo), {}),
            cell(line.boqNo, {}),
            cell(line.description, {}),
            cell(line.unit, {}),
            cell(line.rate, { right: true }),
            cell(line.qtyUptoDate, { right: true }),
            cell(line.qtyUptoPrevious, { right: true }),
            cell(line.qtyThisBill, { right: true }),
            cell(line.amountThisBill, { right: true }),
          ],
        }),
      );
    }
    rows.push(
      new TableRow({
        children: [
          cell('', {}),
          cell('', {}),
          cell('Total', { bold: true }),
          cell('', {}),
          cell('', {}),
          cell('', {}),
          cell('', {}),
          cell('', {}),
          cell(view.schedule.totals.amountThisBill, {
            bold: true,
            right: true,
          }),
        ],
      }),
    );
    return table(
      rows,
      head.map(([, width]) => width),
      LANDSCAPE,
    );
  }

  /**
   * The sign-off under the abstract.
   *
   * A subcontractor's bill prints the client's own block (2026-10-14): each caption, a space to
   * sign in, and the designation under it — with the subcontractor's name under "Accepted by",
   * since accepting the bill is theirs to do (`billSignatures`). A bill to the client gets the
   * same captions with no designations.
   */
  private signatures(view: BillWorkbookView): Paragraph[] {
    const rows = billSignatures(view.header);
    const pair = (
      left: string,
      right: string,
      options: { bold: boolean; before: number; last?: boolean },
    ) =>
      new Paragraph({
        spacing: { before: options.before },
        tabStops: [{ type: 'left', position: 6000 }],
        // Kept with the paragraph that follows, so Word never breaks the block between a
        // caption and the name signing under it. Not the last line, which would otherwise drag the
        // whole block onto the annexures' page.
        keepNext: !options.last,
        keepLines: true,
        children: [
          new TextRun({ text: left, bold: options.bold }),
          new TextRun({ text: `\t${right}`, bold: options.bold }),
        ],
      });
    return rows.flatMap((row, index) => [
      pair(row.left.caption, row.right.caption, {
        bold: true,
        before: index === 0 ? 480 : 360,
      }),
      // The space a pen needs sits in the spacing above the designation.
      pair(row.left.signatory, row.right.signatory, {
        bold: false,
        before: 720,
        last: index === rows.length - 1,
      }),
    ]);
  }
}

function spacer(): Paragraph {
  return new Paragraph({ text: '' });
}

/** The text width of an A4 page with half-inch margins, in twentieths of a point. */
const PORTRAIT = 11906 - 1440;
const LANDSCAPE = 16838 - 1440;

/**
 * A table with fixed column widths, given as percentages of the page's text width (2026-10-15).
 *
 * Absolute widths and a fixed layout, not percentages: Word honours percentage widths, but
 * Pages, Google Docs and the macOS preview do not, and there every column collapsed to one
 * character wide — the header printed "C / o / m / p / a / n / y" down the page.
 */
function table(rows: TableRow[], percents: number[], pageWidth: number): Table {
  const columnWidths = percents.map((pct) =>
    Math.round((pct / 100) * pageWidth),
  );
  return new Table({
    width: { size: pageWidth, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    rows,
  });
}

function cell(
  text: string,
  options: { bold?: boolean; right?: boolean; width?: number; head?: boolean },
): TableCell {
  // A figure column prints with Indian grouping (2026-10-15), as the PDF does; a column header is
  // shaded so the table reads as one at a glance.
  if (options.right) text = indianFigure(text);
  return new TableCell({
    borders: BORDERS,
    shading: options.head
      ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E7ECF2' }
      : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: options.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, bold: options.bold })],
      }),
    ],
  });
}
