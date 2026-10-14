import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type { BillWorkbookView } from './bill-workbook.types';
import { headerPairs } from './header-pairs';

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
                  text: `Tax basis: ${view.abstract.taxBasis} (${view.abstract.taxBasisSource})`,
                  size: 14,
                }),
              ],
            }),
            ...this.signatures(),
          ],
        },
        ...(options.abstractOnly ? [] : [this.annexures(view)]),
      ],
    });
    return Packer.toBuffer(doc);
  }

  private annexures(view: BillWorkbookView) {
    return {
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
          margin: { top: 720, bottom: 720, left: 720, right: 720 },
        },
      },
      children: [
        ...this.title(view, 'BOQ ANNEXURE-I'),
        this.schedule(view),
        ...(view.debitRegister.groups.length > 0
          ? [...this.title(view, 'DEBIT NOTE REGISTER'), this.debits(view)]
          : []),
      ],
    };
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

  private header(view: BillWorkbookView): Table {
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
    return table(rows);
  }

  private abstract(view: BillWorkbookView): Table {
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          cell('Sr.', { bold: true, width: 6 }),
          cell('Particulars', { bold: true, width: 46 }),
          cell('Upto Date', { bold: true, width: 16, right: true }),
          cell('Upto Previous', { bold: true, width: 16, right: true }),
          cell('This Bill', { bold: true, width: 16, right: true }),
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
    return table(rows);
  }

  private schedule(view: BillWorkbookView): Table {
    const head = [
      'Sr.',
      'BOQ No.',
      'Description',
      'Unit',
      'Rate',
      'Qty Upto Date',
      'Qty Upto Prev.',
      'Qty This Bill',
      'Amount This Bill',
    ];
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: head.map((text, index) =>
          cell(text, { bold: true, right: index >= 4 }),
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
    return table(rows);
  }

  private debits(view: BillWorkbookView): Table {
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          'Sr.',
          'Description',
          'Location',
          'Qty',
          'Unit',
          'Rate',
          'Amount (incl. tax)',
          'Remark',
        ].map((text) => cell(text, { bold: true })),
      }),
    ];
    for (const group of view.debitRegister.groups) {
      if (group.heading) {
        rows.push(
          new TableRow({
            children: [
              cell('', {}),
              cell(group.heading, { bold: true }),
              ...Array.from({ length: 6 }, () => cell('', {})),
            ],
          }),
        );
      }
      for (const debit of group.rows) {
        rows.push(
          new TableRow({
            children: [
              cell(String(debit.srNo), {}),
              cell(debit.description, {}),
              cell(debit.location ?? '', {}),
              cell(debit.quantity ?? '', { right: true }),
              cell(debit.unit ?? '', {}),
              cell(debit.rate, { right: true }),
              cell(debit.amountWithTax, { right: true }),
              cell(debit.remark ?? '', {}),
            ],
          }),
        );
      }
    }
    return table(rows);
  }

  private signatures(): Paragraph[] {
    const line = (left: string, right: string) =>
      new Paragraph({
        spacing: { before: 480 },
        tabStops: [{ type: 'left', position: 6000 }],
        children: [
          new TextRun({ text: left, bold: true }),
          new TextRun({ text: `\t${right}`, bold: true }),
        ],
      });
    return [
      line('Prepared by', 'Checked by'),
      line('Accepted by', 'Approved by'),
    ];
  }
}

function spacer(): Paragraph {
  return new Paragraph({ text: '' });
}

function table(rows: TableRow[]): Table {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function cell(
  text: string,
  options: { bold?: boolean; right?: boolean; width?: number },
): TableCell {
  return new TableCell({
    borders: BORDERS,
    width: options.width
      ? { size: options.width, type: WidthType.PERCENTAGE }
      : undefined,
    children: [
      new Paragraph({
        alignment: options.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, bold: options.bold })],
      }),
    ],
  });
}
