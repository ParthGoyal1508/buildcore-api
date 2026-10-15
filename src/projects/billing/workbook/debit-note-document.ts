import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlign,
  WidthType,
} from 'docx';
import type * as ExcelJS from 'exceljs';

import { letterFontFiles } from '../../../letters/letter-pdf.renderer';
import { indianFigure } from './print-format';

/**
 * A debit note as the client's own document (2026-10-15), drawn from the "Parth Realcon DV-04,
 * debit note" format: the logo and the party, the company with its project, location and "Debit
 * Note of …" title, the note's number and date, the work order, the party's GSTIN and vendor code,
 * the nature of work, the items, Work Done / CGST / SGST (or IGST) / Net Amount, and the four
 * sign-off boxes.
 *
 * **One view, three drawings** — the PDF, the Word copy and the workbook sheet below all read the
 * same strings, already rounded, so the three cannot disagree. The same drawings serve the note on
 * its own and the "Debit Note" section of a bill package, which prints every note recovered on it.
 */
export interface DebitNoteView {
  company: { name: string; address: string | null; logo: Buffer | null };
  projectName: string;
  projectCode: string | null;
  location: string | null;
  /** `2026-27/001`; null only on a debit recorded before numbering existed. */
  noteNumber: string | null;
  /** ISO date. Printed `29-Jun-2026`, as the format does. */
  noteDate: string;
  party: { name: string | null; gstin: string | null; code: string | null };
  workOrderNo: string | null;
  natureOfWork: string | null;
  lines: {
    srNo: number;
    description: string;
    /** The second line under the item — "7 Nos. Water pump location & 4 Nos. Deck Light location". */
    specification: string | null;
    unit: string | null;
    quantity: string | null;
    rate: string;
    amount: string;
  }[];
  /** "Work Done Amount" — the items' total. */
  amount: string;
  /** "CGST 9%" and "SGST 9%", or "IGST 18%", or a single "GST" on a note whose tax was never split. */
  taxes: { label: string; amount: string }[];
  /** Rounded to the rupee, as the format prints it. */
  netAmount: string;
}

/** The four boxes along the foot, caption over designation. */
const SIGN_OFF: [string, string][] = [
  ['Prepared By', 'Site In-charge'],
  ['Accepted By', 'Contractor'],
  ['Checked By', 'Site In-charge'],
  ['Approved By', 'Project Manager'],
];

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `2026-06-29` → `29-Jun-2026`. */
export function noteDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[3]}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`;
}

/** "PARTH REALCON PVT.LTD. / Project (code) / Location / Debit Note of …" — the centre block. */
function titleLines(view: DebitNoteView) {
  return {
    company: view.company.name,
    project: view.projectCode
      ? `${view.projectName} (${view.projectCode})`
      : view.projectName,
    location: view.location,
    title: `Debit Note of ${view.natureOfWork ?? 'Work'}`,
  };
}

function isPng(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const A4 = { width: 595.28, height: 841.89 };
const M = 28;
const RED = '#C00000';
const SHADE = '#D9D9D9';

/**
 * Draws one note on a fresh A4 portrait page of `doc`.
 *
 * Laid out as the format's grid: every block is a ruled box, so the printed note reads like the
 * Word original rather than like a report.
 */
export function drawDebitNotePdf(
  doc: PDFKit.PDFDocument,
  view: DebitNoteView,
): void {
  doc.addPage({ size: 'A4', layout: 'portrait', margin: M });

  // Helvetica, as every other page of a bill. Inter is embedded for the one glyph Helvetica lacks —
  // the "₹" before the net amount — and where it is missing that prints "Rs.".
  const regular = 'Helvetica';
  const bold = 'Helvetica-Bold';
  const files = letterFontFiles();
  if (files) doc.registerFont('DN-Rupee', files.bold);

  const W = A4.width - M * 2;
  const x0 = M;
  let y = M;

  const box = (x: number, top: number, w: number, h: number, fill?: string) => {
    if (fill) doc.rect(x, top, w, h).fillAndStroke(fill, '#000');
    else doc.rect(x, top, w, h).stroke();
    doc.fillColor('#000');
  };
  const write = (
    text: string,
    x: number,
    top: number,
    w: number,
    o: {
      bold?: boolean;
      size?: number;
      align?: 'left' | 'center' | 'right';
      color?: string;
      underline?: boolean;
    } = {},
  ) => {
    doc
      .font(o.bold ? bold : regular)
      .fontSize(o.size ?? 8)
      .fillColor(o.color ?? '#000')
      .text(text, x + 4, top, {
        width: w - 8,
        align: o.align ?? 'left',
        underline: o.underline,
      });
    doc.fillColor('#000');
  };
  const height = (text: string, w: number, size = 8, isBold = false) =>
    doc
      .font(isBold ? bold : regular)
      .fontSize(size)
      .heightOfString(text, { width: w - 8 });

  doc.lineWidth(0.6);

  // ── Band: logo + party | company, project, location, title | note number ──
  const c1 = W * 0.36;
  const c2 = W * 0.38;
  const c3 = W - c1 - c2;
  const t = titleLines(view);
  const bandH = 96;
  box(x0, y, c1, bandH);
  box(x0 + c1, y, c2, bandH);
  box(x0 + c1 + c2, y, c3, bandH);
  if (view.company.logo) {
    try {
      doc.image(view.company.logo, x0 + 6, y + 6, { fit: [c1 - 12, 44] });
    } catch {
      // An image pdfkit cannot read leaves the box blank rather than failing the note.
    }
  }
  write(
    `Party Name:- ${view.party.name ? `M/s ${view.party.name}` : ''}`,
    x0,
    y + 56,
    c1,
    { bold: true, size: 8.5 },
  );
  let ty = y + 8;
  write(t.company.toUpperCase(), x0 + c1, ty, c2, { bold: true, size: 11 });
  ty += height(t.company.toUpperCase(), c2, 11, true) + 2;
  write(t.project, x0 + c1, ty, c2, {
    bold: true,
    size: 8.5,
    align: 'center',
    color: RED,
  });
  ty += height(t.project, c2, 8.5, true) + 1;
  if (t.location) {
    write(t.location, x0 + c1, ty, c2, {
      bold: true,
      size: 8.5,
      align: 'center',
      color: RED,
    });
    ty += height(t.location, c2, 8.5, true) + 1;
  }
  write(t.title, x0 + c1, ty, c2, {
    bold: true,
    size: 8.5,
    align: 'center',
    underline: true,
  });
  write('Debit Note No :', x0 + c1 + c2, y + 30, c3, { bold: true, size: 8.5 });
  write(view.noteNumber ?? '', x0 + c1 + c2, y + 46, c3, {
    bold: true,
    size: 10,
  });
  y += bandH;

  // ── Details: label | value | right label | right value ──
  const d1 = W * 0.17;
  const d2 = W * 0.4;
  const d3 = W * 0.23;
  const d4 = W - d1 - d2 - d3;
  const details: [string, string, string, string][] = [
    [
      'Work Order No.:-',
      view.workOrderNo ?? '',
      'Debit Note Date',
      noteDateLabel(view.noteDate),
    ],
    ['GST No.', view.party.gstin ?? '', 'Vendor Code:', view.party.code ?? ''],
    ['Nature of Work', view.natureOfWork ?? '', '', ''],
  ];
  for (const [l1, v1, l2, v2] of details) {
    const h = Math.max(18, height(v1, d2) + 8);
    box(x0, y, d1, h);
    box(x0 + d1, y, d2, h);
    box(x0 + d1 + d2, y, d3, h);
    box(x0 + d1 + d2 + d3, y, d4, h);
    write(l1, x0, y + 5, d1, { bold: true });
    write(v1, x0 + d1, y + 5, d2, { bold: true });
    write(l2, x0 + d1 + d2, y + 5, d3, { bold: true });
    write(v2, x0 + d1 + d2 + d3, y + 5, d4, { bold: true });
    y += h;
  }

  // ── Items ──
  const cols = [
    { head: 'Sr. No.', w: 36, align: 'center' as const },
    { head: 'Item Name with Specification', w: 0, align: 'left' as const },
    { head: 'Unit', w: 40, align: 'center' as const },
    { head: 'Qty.', w: 56, align: 'right' as const },
    { head: 'Rate', w: 72, align: 'right' as const },
    { head: 'Total Amount', w: 86, align: 'right' as const },
  ];
  cols[1].w = W - cols.reduce((sum, c) => sum + c.w, 0);
  const headH = 16;
  let cx = x0;
  for (const c of cols) {
    box(cx, y, c.w, headH, SHADE);
    write(c.head, cx, y + 4, c.w, { bold: true, align: 'center' });
    cx += c.w;
  }
  y += headH;

  for (const line of view.lines) {
    const item = line.specification
      ? `${line.description}\n${line.specification}`
      : line.description;
    const cells = [
      String(line.srNo),
      item,
      line.unit ?? '',
      line.quantity ? indianFigure(line.quantity) : '',
      indianFigure(line.rate),
      indianFigure(line.amount),
    ];
    const h = Math.max(16, height(item, cols[1].w) + 8);
    if (y + h > A4.height - M - 150) {
      doc.addPage({ size: 'A4', layout: 'portrait', margin: M });
      y = M;
    }
    cx = x0;
    cols.forEach((c, i) => {
      box(cx, y, c.w, h);
      write(cells[i], cx, y + 4, c.w, { align: c.align });
      cx += c.w;
    });
    y += h;
  }

  // ── Totals, right-aligned under Rate | Total Amount ──
  const labelW = cols[4].w + cols[3].w;
  const valueW = cols[5].w;
  const leftW = W - labelW - valueW;
  const totals: [string, string, boolean][] = [
    ['Work Done Amount', indianFigure(view.amount), true],
    ...view.taxes.map(
      (tax) =>
        [tax.label, indianFigure(tax.amount), false] as [
          string,
          string,
          boolean,
        ],
    ),
    ['Net Amount', indianFigure(view.netAmount), true],
  ];
  for (const [label, value, shaded] of totals) {
    box(x0, y, leftW, 16, shaded ? SHADE : undefined);
    box(x0 + leftW, y, labelW, 16, shaded ? SHADE : undefined);
    box(x0 + leftW + labelW, y, valueW, 16, SHADE);
    write(label, x0 + leftW, y + 4, labelW, { bold: true, align: 'right' });
    write(value, x0 + leftW + labelW, y + 4, valueW, {
      bold: true,
      align: 'right',
    });
    if (label === 'Net Amount') {
      doc
        .font(files ? 'DN-Rupee' : bold)
        .fontSize(8)
        .text(files ? '₹' : 'Rs.', x0 + leftW + labelW + 4, y + 4);
    }
    y += 16;
  }

  // ── Sign-off: four boxes, caption at the top, designation at the foot ──
  const signH = 92;
  const sw = W / SIGN_OFF.length;
  SIGN_OFF.forEach(([caption, who], i) => {
    const sx = x0 + i * sw;
    box(sx, y, sw, signH);
    write(caption, sx, y + 10, sw, { bold: true, size: 9, align: 'center' });
    write(who, sx, y + signH - 20, sw, {
      bold: true,
      size: 9,
      align: 'center',
    });
  });
  y += signH;

  doc.font('Helvetica').fontSize(8);
  doc.x = M;
  doc.y = y + 6;
}

// ── Word ─────────────────────────────────────────────────────────────────────

const LINE = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
const ALL = { top: LINE, bottom: LINE, left: LINE, right: LINE };
/** A4 portrait text width with half-inch margins, in twentieths of a point. */
const TEXT_WIDTH = 11906 - 1440;

function para(
  text: string,
  o: {
    bold?: boolean;
    size?: number;
    align?: 'left' | 'center' | 'right';
    color?: string;
    underline?: boolean;
    italics?: boolean;
  } = {},
): Paragraph {
  const lines = text.split('\n');
  return new Paragraph({
    alignment:
      o.align === 'right'
        ? AlignmentType.RIGHT
        : o.align === 'center'
        ? AlignmentType.CENTER
        : AlignmentType.LEFT,
    children: lines.map(
      (value, index) =>
        new TextRun({
          text: value,
          break: index > 0 ? 1 : undefined,
          bold: o.bold,
          italics: o.italics,
          size: o.size ?? 18,
          color: o.color,
          underline: o.underline ? { type: UnderlineType.SINGLE } : undefined,
        }),
    ),
  });
}

function box(
  children: Paragraph[],
  o: { span?: number; shade?: boolean; center?: boolean; width?: number } = {},
): TableCell {
  return new TableCell({
    borders: ALL,
    columnSpan: o.span,
    // Each cell's own width as well as the grid's: Word reads the grid, but Pages and the macOS
    // preview size a row from its cells and collapsed the sign-off row to half the page.
    width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
    verticalAlign: o.center ? VerticalAlign.CENTER : VerticalAlign.TOP,
    shading: o.shade
      ? { type: ShadingType.CLEAR, color: 'auto', fill: 'D9D9D9' }
      : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children,
  });
}

/**
 * The note as Word content — one table carrying the whole format, so it prints as the original
 * does and survives being opened in Pages or Google Docs (fixed column widths, not percentages).
 */
export function debitNoteDocx(view: DebitNoteView): (Paragraph | Table)[] {
  // Six columns: Sr | Item | Unit | Qty | Rate | Total.
  const pct = [7, 43, 8, 11, 14, 17];
  const widths = pct.map((p) => Math.round((p / 100) * TEXT_WIDTH));
  const t = titleLines(view);
  const b = (text: string, o: Parameters<typeof para>[1] = {}) =>
    para(text, { bold: true, ...o });

  const logo = view.company.logo
    ? [
        new Paragraph({
          children: [
            new ImageRun({
              type: isPng(view.company.logo) ? 'png' : 'jpg',
              data: view.company.logo,
              transformation: { width: 150, height: 50 },
            }),
          ],
        }),
      ]
    : [];

  const rows: TableRow[] = [
    new TableRow({
      children: [
        box(
          [
            ...logo,
            b(
              `Party Name:- ${view.party.name ? `M/s ${view.party.name}` : ''}`,
            ),
          ],
          { span: 2, width: widths[0] + widths[1] },
        ),
        box(
          [
            b(t.company.toUpperCase(), { size: 24, italics: true }),
            b(t.project, { align: 'center', color: 'C00000' }),
            ...(t.location
              ? [b(t.location, { align: 'center', color: 'C00000' })]
              : []),
            b(t.title, { align: 'center', underline: true }),
          ],
          { span: 3, width: widths[2] + widths[3] + widths[4] },
        ),
        box([b('Debit Note No :'), para(''), b(view.noteNumber ?? '')], {
          center: true,
          width: widths[5],
        }),
      ],
    }),
    new TableRow({
      children: [
        box([b(`Work Order No.:- ${view.workOrderNo ?? ''}`)], { span: 4 }),
        box([b('Debit Note Date')]),
        box([b(noteDateLabel(view.noteDate))]),
      ],
    }),
    new TableRow({
      children: [
        box([b('GST No.')]),
        box([b(view.party.gstin ?? '')], { span: 3 }),
        box([b(`Vendor Code: ${view.party.code ?? ''}`)], { span: 2 }),
      ],
    }),
    new TableRow({
      children: [
        box([b('Nature of Work')]),
        box([b(view.natureOfWork ?? '')], { span: 5 }),
      ],
    }),
    new TableRow({
      tableHeader: true,
      children: [
        'Sr. No.',
        'Item Name with Specification',
        'Unit',
        'Qty.',
        'Rate',
        'Total Amount',
      ].map((head) => box([b(head, { align: 'center' })], { shade: true })),
    }),
    ...view.lines.map(
      (line) =>
        new TableRow({
          children: [
            box([para(String(line.srNo), { align: 'center' })]),
            box([
              para(
                line.specification
                  ? `${line.description}\n${line.specification}`
                  : line.description,
              ),
            ]),
            box([para(line.unit ?? '', { align: 'center' })]),
            box([
              para(line.quantity ? indianFigure(line.quantity) : '', {
                align: 'right',
              }),
            ]),
            box([para(indianFigure(line.rate), { align: 'right' })]),
            box([para(indianFigure(line.amount), { align: 'right' })]),
          ],
        }),
    ),
    ...(
      [
        ['Work Done Amount', indianFigure(view.amount)],
        ...view.taxes.map((tax) => [tax.label, indianFigure(tax.amount)]),
        ['Net Amount', `₹ ${indianFigure(view.netAmount)}`],
      ] as [string, string][]
    ).map(
      ([label, value], index, all) =>
        new TableRow({
          children: [
            box([para('')], {
              span: 3,
              shade: index === 0 || index === all.length - 1,
            }),
            box([b(label, { align: 'right' })], {
              span: 2,
              shade: index === 0 || index === all.length - 1,
            }),
            box([b(value, { align: 'right' })], { shade: true }),
          ],
        }),
    ),
  ];

  // The sign-off is the table's last row, as in the original — boxes spanning the item grid's
  // columns, Prepared By the widest.
  const spans: [number, number][] = [
    [0, 2],
    [2, 4],
    [4, 5],
    [5, 6],
  ];
  rows.push(
    new TableRow({
      height: { value: 1800, rule: 'atLeast' },
      children: SIGN_OFF.map(([caption, who], index) => {
        const [from, to] = spans[index];
        return box(
          [
            b(caption, { align: 'center' }),
            para(''),
            para(''),
            para(''),
            para(''),
            b(who, { align: 'center' }),
          ],
          {
            span: to - from,
            width: widths.slice(from, to).reduce((sum, w) => sum + w, 0),
          },
        );
      }),
    }),
  );

  return [
    new Table({
      width: { size: TEXT_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      rows,
    }),
  ];
}

// ── Excel ────────────────────────────────────────────────────────────────────

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' },
  right: { style: 'thin' },
};
const GREY: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFD9D9D9' },
};

/**
 * The note on a worksheet, in the format's grid: columns A–F are Sr | Item | Unit | Qty | Rate |
 * Total. Figures are written as the same grouped strings the PDF prints, so the sheet reads the
 * same and a BOQ-style number is never reinterpreted.
 */
export function writeDebitNoteSheet(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  view: DebitNoteView,
  startRow = 1,
): number {
  const t = titleLines(view);
  let r = startRow;
  const cell = (ref: string) => sheet.getCell(ref);
  const frame = (from: string, to: string) => {
    if (from !== to) sheet.mergeCells(`${from}:${to}`);
    cell(from).border = THIN;
  };

  // Band.
  sheet.getRow(r).height = 22;
  sheet.getRow(r + 1).height = 22;
  sheet.getRow(r + 2).height = 22;
  sheet.getRow(r + 3).height = 30;
  // The logo over rows 1–3, the party in row 4 — the format's left box.
  frame(`A${r}`, `B${r + 2}`);
  if (view.company.logo) {
    const image = workbook.addImage({
      buffer: view.company.logo as unknown as ExcelJS.Buffer,
      extension: isPng(view.company.logo) ? 'png' : 'jpeg',
    });
    sheet.addImage(image, {
      tl: { col: 0.1, row: r - 1 + 0.15 },
      ext: { width: 160, height: 48 },
    });
  }
  frame(`A${r + 3}`, `B${r + 3}`);
  cell(`A${r + 3}`).value = `Party Name:- ${
    view.party.name ? `M/s ${view.party.name}` : ''
  }`;
  cell(`A${r + 3}`).font = { bold: true };
  cell(`A${r + 3}`).alignment = { vertical: 'middle', wrapText: true };

  frame(`C${r}`, `D${r + 3}`);
  cell(`C${r}`).value = {
    richText: [
      { text: `${t.company.toUpperCase()}\n`, font: { bold: true, size: 13 } },
      {
        text: `${t.project}\n`,
        font: { bold: true, color: { argb: 'FFC00000' } },
      },
      ...(t.location
        ? [
            {
              text: `${t.location}\n`,
              font: { bold: true, color: { argb: 'FFC00000' } },
            },
          ]
        : []),
      { text: t.title, font: { bold: true, underline: true } },
    ],
  };
  cell(`C${r}`).alignment = {
    horizontal: 'center',
    vertical: 'middle',
    wrapText: true,
  };
  frame(`E${r}`, `E${r + 3}`);
  cell(`E${r}`).value = 'Debit Note No :';
  frame(`F${r}`, `F${r + 3}`);
  cell(`F${r}`).value = view.noteNumber ?? '';
  for (const ref of [`E${r}`, `F${r}`]) {
    cell(ref).font = { bold: true };
    cell(ref).alignment = { vertical: 'middle' };
  }
  r += 4;

  // Details.
  const detail = (
    label: string,
    value: string,
    rightLabel: string,
    rightValue: string,
  ) => {
    frame(`A${r}`, `A${r}`);
    cell(`A${r}`).value = label;
    frame(`B${r}`, `D${r}`);
    cell(`B${r}`).value = value;
    frame(`E${r}`, `E${r}`);
    cell(`E${r}`).value = rightLabel;
    frame(`F${r}`, `F${r}`);
    cell(`F${r}`).value = rightValue;
    for (const ref of [`A${r}`, `B${r}`, `E${r}`, `F${r}`]) {
      cell(ref).font = { bold: true };
      cell(ref).alignment = { vertical: 'top', wrapText: true };
    }
    r += 1;
  };
  detail(
    'Work Order No.',
    view.workOrderNo ?? '',
    'Debit Note Date',
    noteDateLabel(view.noteDate),
  );
  detail(
    'GST No.',
    view.party.gstin ?? '',
    'Vendor Code:',
    view.party.code ?? '',
  );
  detail('Nature of Work', view.natureOfWork ?? '', '', '');

  // Items.
  const heads = [
    'Sr. No.',
    'Item Name with Specification',
    'Unit',
    'Qty.',
    'Rate',
    'Total Amount',
  ];
  heads.forEach((head, i) => {
    const c = sheet.getRow(r).getCell(i + 1);
    c.value = head;
    c.font = { bold: true };
    c.fill = GREY;
    c.border = THIN;
    c.alignment = { horizontal: 'center' };
  });
  r += 1;
  for (const line of view.lines) {
    const values = [
      line.srNo,
      line.specification
        ? `${line.description}\n${line.specification}`
        : line.description,
      line.unit ?? '',
      line.quantity ? indianFigure(line.quantity) : '',
      indianFigure(line.rate),
      indianFigure(line.amount),
    ];
    values.forEach((value, i) => {
      const c = sheet.getRow(r).getCell(i + 1);
      c.value = value;
      c.border = THIN;
      c.alignment = {
        horizontal: i >= 3 ? 'right' : i === 1 ? 'left' : 'center',
        vertical: 'top',
        wrapText: i === 1,
      };
    });
    r += 1;
  }

  // Totals.
  const totals: [string, string, boolean][] = [
    ['Work Done Amount', indianFigure(view.amount), true],
    ...view.taxes.map(
      (tax) =>
        [tax.label, indianFigure(tax.amount), false] as [
          string,
          string,
          boolean,
        ],
    ),
    ['Net Amount', `₹ ${indianFigure(view.netAmount)}`, true],
  ];
  for (const [label, value, shaded] of totals) {
    frame(`A${r}`, `C${r}`);
    frame(`D${r}`, `E${r}`);
    cell(`D${r}`).value = label;
    cell(`D${r}`).font = { bold: true };
    cell(`D${r}`).alignment = { horizontal: 'right' };
    frame(`F${r}`, `F${r}`);
    cell(`F${r}`).value = value;
    cell(`F${r}`).font = { bold: true };
    cell(`F${r}`).alignment = { horizontal: 'right' };
    cell(`F${r}`).fill = GREY;
    if (shaded) {
      cell(`A${r}`).fill = GREY;
      cell(`D${r}`).fill = GREY;
    }
    r += 1;
  }

  // Sign-off: four boxes across A–B, C–D, E, F.
  const spans: [string, string][] = [
    ['A', 'B'],
    ['C', 'D'],
    ['E', 'E'],
    ['F', 'F'],
  ];
  SIGN_OFF.forEach(([caption, who], i) => {
    const [from, to] = spans[i];
    frame(`${from}${r}`, `${to}${r + 4}`);
    cell(`${from}${r}`).value = `${caption}\n\n\n\n${who}`;
    cell(`${from}${r}`).font = { bold: true };
    cell(`${from}${r}`).alignment = {
      horizontal: 'center',
      vertical: 'top',
      wrapText: true,
    };
  });
  r += 5;

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 44;
  sheet.getColumn(3).width = 18;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 22;
  sheet.getColumn(6).width = 18;
  return r;
}
