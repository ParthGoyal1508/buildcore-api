import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import PDFDocument = require('pdfkit');

import type { PaymentAdviceView } from './payment-advice.service';

const A4_WIDTH = 595.28;
const MARGIN = 40;

/**
 * A payment advice as PDF and as Word, from one view (2026-10-13).
 *
 * Laid out on the company's own advice: logo and registered address in a band at the top, the
 * transaction in a four-by-two grid, the covering sentence, and one row per bill paid. Holds no
 * database client — every figure arrives formatted, so the two files cannot disagree.
 */
@Injectable()
export class PaymentAdviceRenderer {
  async pdf(view: PaymentAdviceView): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `${view.title} — ${view.vendorName}`,
        Author: view.company.name,
        CreationDate: new Date(`${view.transactionDate}T00:00:00.000Z`),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const width = A4_WIDTH - MARGIN * 2;
    const x = MARGIN;
    let y = MARGIN;

    // ── Band: logo | name and address ────────────────────────────────────
    const bandHeight = 80;
    const logoWidth = 170;
    doc.rect(x, y, width, bandHeight).stroke();
    doc
      .moveTo(x + logoWidth, y)
      .lineTo(x + logoWidth, y + bandHeight)
      .stroke();
    if (view.company.logo) {
      try {
        doc.image(view.company.logo, x + 10, y + 10, {
          fit: [logoWidth - 20, bandHeight - 20],
          align: 'center',
          valign: 'center',
        });
      } catch {
        // An image pdfkit cannot decode prints the name alone rather than refusing the advice.
      }
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(view.company.name.toUpperCase(), x + logoWidth + 10, y + 14, {
        width: width - logoWidth - 20,
      });
    if (view.company.address) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(
          `Registered Address: - ${view.company.address}`,
          x + logoWidth + 10,
          y + 44,
          { width: width - logoWidth - 20 },
        );
    }
    y += bandHeight;

    // ── Title ────────────────────────────────────────────────────────────
    doc.rect(x, y, width, 28).stroke();
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(view.title, x, y + 8, { width, align: 'center' });
    y += 28;

    // ── Detail grid ──────────────────────────────────────────────────────
    const col = [x, x + 110, x + width / 2, x + width / 2 + 120];
    const colWidth = [110, width / 2 - 110, 120, width / 2 - 120];
    const rowHeight = 20;
    for (let i = 0; i < view.details.left.length; i += 1) {
      const cells = [
        ...view.details.left[i],
        ...(view.details.right[i] ?? ['', '']),
      ];
      cells.forEach((text, c) => {
        doc.rect(col[c], y, colWidth[c], rowHeight).stroke();
        doc
          .font(c % 2 === 0 ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5)
          .text(text, col[c] + 4, y + 6, {
            width: colWidth[c] - 8,
            lineBreak: false,
            ellipsis: true,
          });
      });
      y += rowHeight;
    }

    // ── Covering sentence ────────────────────────────────────────────────
    const bodyTop = y;
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(view.salutation, x + 8, y + 10, { width: width - 16 })
      .moveDown(0.8)
      .text(view.body, { width: width - 16 });
    y = doc.y + 10;
    doc.rect(x, bodyTop, width, y - bodyTop).stroke();

    // ── Particulars ──────────────────────────────────────────────────────
    const tcols = [40, 95, 85, 95, 105, width - 420];
    const theads = [
      'S.No.',
      'Particulars',
      'Document Date',
      'Site Name',
      'Payment Amount',
      'TDS Amount',
    ];
    const cellRow = (texts: string[], height: number, bold: boolean) => {
      let cx = x;
      texts.forEach((text, c) => {
        doc.rect(cx, y, tcols[c], height).stroke();
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5)
          .text(text, cx + 4, y + 5, {
            width: tcols[c] - 8,
            align: c >= 4 ? 'right' : c === 0 ? 'center' : 'left',
          });
        cx += tcols[c];
      });
      y += height;
    };
    cellRow(theads, 20, false);
    view.rows.forEach((row, index) => {
      const texts = [
        String(index + 1),
        row.particulars,
        row.documentDate,
        row.siteName,
        row.paymentAmount,
        row.tdsAmount,
      ];
      // Tall enough for the longest cell — a site named in full wraps to four lines.
      doc.font('Helvetica').fontSize(8.5);
      const tallest = Math.max(
        ...texts.map((text, c) =>
          doc.heightOfString(text, { width: tcols[c] - 8 }),
        ),
      );
      cellRow(texts, Math.max(44, tallest + 12), false);
    });
    // Total spans the first four columns.
    const spanWidth = tcols[0] + tcols[1] + tcols[2] + tcols[3];
    doc.rect(x, y, spanWidth, 20).stroke();
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text('TOTAL', x, y + 6, { width: spanWidth, align: 'center' });
    doc.rect(x + spanWidth, y, tcols[4], 20).stroke();
    doc.text(view.totalAmount, x + spanWidth + 4, y + 6, {
      width: tcols[4] - 8,
      align: 'right',
    });
    doc.rect(x + spanWidth + tcols[4], y, tcols[5], 20).stroke();
    doc.text(view.totalTds, x + spanWidth + tcols[4] + 4, y + 6, {
      width: tcols[5] - 8,
      align: 'right',
    });
    y += 20;

    // ── Footer ───────────────────────────────────────────────────────────
    const footerTop = y;
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(view.footer, x + 8, y + 14, { width: width - 16 });
    doc.rect(x, footerTop, width, 160).stroke();

    doc.end();
    return finished;
  }

  async docx(view: PaymentAdviceView): Promise<Buffer> {
    const border = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
    const borders = {
      top: border,
      bottom: border,
      left: border,
      right: border,
    };
    const cell = (
      children: Paragraph[],
      options: { width?: number; span?: number } = {},
    ) =>
      new TableCell({
        borders,
        columnSpan: options.span,
        verticalAlign: VerticalAlign.CENTER,
        width: options.width
          ? { size: options.width, type: WidthType.PERCENTAGE }
          : undefined,
        children,
      });
    const text = (
      value: string,
      options: {
        bold?: boolean;
        size?: number;
        right?: boolean;
        center?: boolean;
      } = {},
    ) =>
      new Paragraph({
        alignment: options.right
          ? AlignmentType.RIGHT
          : options.center
          ? AlignmentType.CENTER
          : AlignmentType.LEFT,
        children: [
          new TextRun({
            text: value,
            bold: options.bold,
            size: options.size ?? 18,
          }),
        ],
      });

    const logo = view.company.logo
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: isPng(view.company.logo) ? 'png' : 'jpg',
                data: view.company.logo,
                transformation: { width: 170, height: 60 },
              }),
            ],
          }),
        ]
      : [text('')];

    const band = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            cell(logo, { width: 30 }),
            cell(
              [
                text(view.company.name.toUpperCase(), { bold: true, size: 32 }),
                ...(view.company.address
                  ? [
                      text(`Registered Address: - ${view.company.address}`, {
                        bold: true,
                        size: 17,
                      }),
                    ]
                  : []),
              ],
              { width: 70 },
            ),
          ],
        }),
        new TableRow({
          children: [
            cell([text(view.title, { bold: true, size: 26, center: true })], {
              span: 2,
            }),
          ],
        }),
      ],
    });

    const details = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: view.details.left.map(
        (left, i) =>
          new TableRow({
            children: [
              cell([text(left[0], { bold: true })], { width: 20 }),
              cell([text(left[1])], { width: 30 }),
              cell([text(view.details.right[i]?.[0] ?? '', { bold: true })], {
                width: 22,
              }),
              cell([text(view.details.right[i]?.[1] ?? '')], { width: 28 }),
            ],
          }),
      ),
    });

    const letter = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            cell([
              text(view.salutation, { size: 20 }),
              text(''),
              text(view.body, { size: 20 }),
              text(''),
            ]),
          ],
        }),
      ],
    });

    const head = [
      'S.No.',
      'Particulars',
      'Document Date',
      'Site Name',
      'Payment Amount',
      'TDS Amount',
    ];
    const particulars = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: head.map((h) => cell([text(h, { center: true })])),
        }),
        ...view.rows.map(
          (row, index) =>
            new TableRow({
              children: [
                cell([text(String(index + 1), { center: true })]),
                cell([text(row.particulars)]),
                cell([text(row.documentDate, { center: true })]),
                cell([text(row.siteName)]),
                cell([text(row.paymentAmount, { right: true })]),
                cell([text(row.tdsAmount, { right: true })]),
              ],
            }),
        ),
        new TableRow({
          children: [
            cell([text('TOTAL', { bold: true, center: true })], { span: 4 }),
            cell([text(view.totalAmount, { bold: true, right: true })]),
            cell([text(view.totalTds, { bold: true, right: true })]),
          ],
        }),
      ],
    });

    const footer = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          height: { value: 2400, rule: 'atLeast' },
          children: [cell([text(''), text(view.footer, { size: 20 })])],
        }),
      ],
    });

    const doc = new Document({
      styles: { default: { document: { run: { font: 'Arial' } } } },
      sections: [
        {
          properties: {
            page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } },
          },
          children: [band, details, letter, particulars, footer],
        },
      ],
    });
    return Packer.toBuffer(doc);
  }
}

function isPng(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
}
