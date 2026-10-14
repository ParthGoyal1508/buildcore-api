import { Injectable } from '@nestjs/common';
// `import = require` deliberately, not `import * as`. The app is built by SWC
// (nest-cli.json), which gives `import * as` true ESM semantics and hands back a
// namespace object that cannot be constructed; the tests are built by ts-jest, which
// emits a bare require and constructs fine. The namespace form therefore passes every
// test and throws "_pdfkit is not a constructor" in the running server. This form emits
// a bare require under both.
import PDFDocument = require('pdfkit');
import { rupeesFirstInWords } from '../../common/rupees-in-words';
import type { SalarySlipView, SlipIdentity } from './salary.service';

/**
 * The client's payslip, `docs/HR_DOCS/Parth_Realcon_Payslip.docx` (2026-10-13; followed strictly
 * since 2026-10-15).
 *
 * ## The format
 *
 * Not letterhead: the docx's header is the company's name, centred, with its logo at the right —
 * then "Pay slip for the month of …", the employee panel, earnings beside deductions, the bank
 * block with NET PAY and the amount in words in its last row, and the computer-generated note.
 * Every row label the docx prints is printed here, in its order. The values in its yellow cells
 * (the totals and the net pay) and every other value come from the slip.
 *
 * ## Heads the docx names that the system does not hold
 *
 * Dearness Allowance, Medical Reimbursement, Conveyance Reimbursement and Food Allowance among the
 * earnings, Welfare and Mobile Bill among the deductions, and the employee panel's Working Days,
 * Rest Days and Leave / PL. The salary structure and the slip hold none of them, so each prints an
 * em dash — the docx's own mark for an empty cell — rather than a figure nobody computed. The
 * system's own heads the docx has no row for (Site Allowance, Overtime) go in the blank rows the
 * docx leaves under Food Allowance, and the fuel recovery is the docx's "Other Deduction", named
 * as such (020 FR-007: it must appear as itself).
 *
 * ## The rupee sign
 *
 * The docx heads its columns "Rate (₹)". pdfkit's built-in Helvetica is WinAnsi and has no ₹ glyph —
 * it prints a stray character in its place — so the columns say "Rs." until a font that carries the
 * glyph is bundled. A wrong symbol on a wage document is worse than an abbreviation.
 */

/** A4 portrait, in points. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 40, left: 48, right: 48 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/** The docx's palette: navy titles and heading rows, pale blue labels, yellow totals. */
const NAVY = '#1F3755';
const PALE = '#EAF0F6';
const YELLOW = '#FFF59D';
const RULE = '#9AA7B5';

const ROW = 16;
const PAD = 4;
const TYPE = 8.5;
const COLUMN_GAP = 8;

const DASH = '—';

/** "2026-02" → "February 2026", as the heading reads. */
export function periodLabel(period: string): string {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const money = (value: number): string =>
  value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** A figure, or the em dash for a head the system does not hold. */
const figure = (value: number | null): string =>
  value === null ? DASH : money(value);

const or = (value: string | null | undefined): string => value?.trim() || DASH;

const date = (value: Date | null | undefined): string =>
  value
    ? value.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : DASH;

/** One deduction line: its label and the figure beside it — null where the system holds none. */
export type SlipRow = [label: string, amount: number | null];

/**
 * One earning line: label, **Rate** (the full-month figure) and **Amount** (what was paid).
 *
 * `rate` is nullable and stays nullable all the way to the page. Rate equal to Amount is a real and
 * common statement — no LOP this month — so it must not also be what "never recorded" looks like;
 * null prints as an em dash. `amount` is null only for a docx head the system does not pay.
 */
export type EarningRow = [
  label: string,
  rate: number | null,
  amount: number | null,
];

/**
 * The earnings table, the docx's rows in the docx's order, ending with gross.
 *
 * Dearness Allowance, Medical Reimbursement, Conveyance Reimbursement and Food Allowance are rows
 * of the client's format the salary structure has no head for: printed, with dashes. Site
 * Allowance and Overtime are this system's heads the docx has no row for: they take the blank rows
 * the docx leaves before Gross Earnings, Overtime last because it is earned by the hour rather
 * than fixed by the month.
 */
export function earningRows(slip: SalarySlipView): EarningRow[] {
  return [
    ['Basic', slip.fullEarnings.basic, slip.earnings.basic],
    ['Dearness Allowance', null, null],
    ['House Rent Allowance', slip.fullEarnings.hra, slip.earnings.hra],
    [
      'Conveyance Allowance',
      slip.fullEarnings.conveyance,
      slip.earnings.conveyance,
    ],
    [
      'Special Allowance',
      slip.fullEarnings.specialAllowance,
      slip.earnings.specialAllowance,
    ],
    ['Medical Reimbursement', null, null],
    ['Conveyance Reimbursement', null, null],
    ['Food Allowance', null, null],
    [
      'Site Allowance',
      slip.fullEarnings.siteAllowance,
      slip.earnings.siteAllowance,
    ],
    // No Rate, ever: overtime is hours worked, not an entitlement LOP can reduce.
    ['Overtime', slip.fullEarnings.ot, slip.earnings.ot],
    ['Gross Earnings', slip.fullEarnings.total, slip.earnings.total],
  ];
}

/**
 * The deductions table, the docx's rows in its order, ending with the total.
 *
 * Welfare and Mobile Bill have no counterpart here and print dashes. "Other Deduction" carries the
 * **fuel recovery** and says so: 020 FR-007 requires the recovery to appear on the payslip as
 * itself, and a line called only "Other" leaves somebody unable to find out why their pay fell
 * short.
 *
 * A nil deduction the system does hold is still printed as 0.00. A payslip that drops nil rows
 * makes an employee wonder whether TDS was deducted and not shown, or genuinely nil.
 */
export function deductionRows(slip: SalarySlipView): SlipRow[] {
  return [
    ['Provident Fund', slip.deductions.pf],
    ['ESI', slip.deductions.esic],
    ['Professional Tax', slip.deductions.pt],
    ['Welfare', null],
    ['Loan', slip.deductions.loanEmi],
    ['Advance', slip.deductions.advanceRecovery],
    ['Mobile Bill', null],
    ['Other Deduction (Fuel Recovery)', slip.deductions.fuelRecovery],
    ['T.D.S.', slip.deductions.tds],
    ['Total Deduction', slip.deductions.total],
  ];
}

type Pair = [label: string, value: string];

/**
 * The employee panel, as label/value pairs in two columns, in the docx's own pairing — its six
 * rows and no others.
 *
 * Working, rest and leave days are printed as em dashes: the slip stores **paid** days and LOP, not
 * the breakdown of the month into worked days, weekly offs and leave, and inventing that split
 * would put figures on a wage document nobody computed.
 *
 * Every label is printed even when its value is absent: a label that disappears with its value
 * makes a payslip's shape depend on the employee.
 */
export function identityRows(
  slip: SalarySlipView,
  identity: SlipIdentity,
): [left: Pair, right: Pair][] {
  return [
    [
      ['Employee Name', or(identity.employeeName)],
      ['Working Days', DASH],
    ],
    [
      ["Father's / Spouse's Name", or(identity.fatherName)],
      ['Rest Days', DASH],
    ],
    [
      ['Employee Code', or(slip.employeeCode)],
      ['Leave / PL', DASH],
    ],
    [
      ['Designation', or(identity.designation)],
      ['Total Days', String(slip.monthDays)],
    ],
    [
      ['P.F. No.', or(identity.pfNumber)],
      ['E.S.I. No.', or(identity.esiNumber)],
    ],
    [
      ['O.T. Hours', String(slip.otHours)],
      ['Date of Joining', date(identity.joiningDate)],
    ],
  ];
}

/**
 * The bank block. The account number arrives **already masked** (`SlipIdentity`); a payslip is
 * emailed, forwarded and printed, and carries only enough for the employee to recognise the account.
 *
 * Payment mode is "Bank Transfer" when an account is on file, because the bank sheet is how this
 * product pays; without one, nothing is asserted.
 */
export function bankRows(identity: SlipIdentity): [left: Pair, right: Pair][] {
  return [
    [
      ['Bank Name', or(identity.bankName)],
      ['Branch', or(identity.bankBranch)],
    ],
    [
      [
        'Account Holder',
        or(identity.bankAccountHolderName ?? identity.employeeName),
      ],
      ['Account No.', or(identity.bankAccountNumberMasked)],
    ],
    [
      ['IFSC Code', or(identity.ifscCode)],
      [
        'Payment Mode',
        identity.bankAccountNumberMasked ? 'Bank Transfer' : DASH,
      ],
    ],
  ];
}

type Doc = PDFKit.PDFDocument;

/** A cell's box and text. `fill` paints the box first; `bold` and `color` style the text. */
interface Cell {
  text: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  bold?: boolean;
  fill?: string;
  color?: string;
}

/**
 * Renders a payslip PDF (US5, research.md §7).
 *
 * Takes the very same `SalarySlipView` the JSON endpoint returns, rather than re-reading the
 * database: a PDF that disagrees with the on-screen figures is a wage dispute waiting to happen.
 */
@Injectable()
export class SalaryPdfService {
  /**
   * @param logo the company's logo for the header, or null/absent to print the name alone. A logo
   * pdfkit cannot decode is left out rather than losing the payslip.
   */
  async render(
    slip: SalarySlipView,
    employeeName: string,
    logo?: Buffer | null,
  ): Promise<Buffer> {
    const doc: Doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // A slip rendered without an identity — an older caller — still gets the client's layout, with
    // dashes where the identity would be, rather than a second layout to keep alive.
    const identity: SlipIdentity = slip.identity ?? {
      employeeName,
      companyName: '',
      companyAddress: null,
      joiningDate: null,
      designation: null,
      department: null,
      location: null,
      bankName: null,
      bankAccountNumberMasked: null,
      panNumber: null,
      pfNumber: null,
      pfUan: null,
    };

    const x = MARGIN.left;
    let y = this.header(doc, identity, logo ?? null);

    // "Pay slip for the month of September 2026" — navy, bold, centred.
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(NAVY)
      .text(`Pay slip for the month of ${periodLabel(slip.period)}`, x, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    y = doc.y + 12;

    // Employee panel: four columns, labels shaded.
    const labelW = 120;
    const valueW = CONTENT_WIDTH / 2 - labelW;
    for (const [left, right] of identityRows(slip, identity)) {
      y = this.row(doc, x, y, [
        { text: left[0], width: labelW, fill: PALE, bold: true },
        { text: left[1], width: valueW },
        { text: right[0], width: labelW, fill: PALE, bold: true },
        { text: right[1], width: valueW },
      ]);
    }
    y += 14;

    // Earnings and deductions side by side, each under its navy title, as the docx nests them.
    const half = (CONTENT_WIDTH - COLUMN_GAP) / 2;
    const earnings = earningRows(slip);
    const deductions = deductionRows(slip);
    // Both columns end on the same line: the shorter one is padded with empty rows, so the two
    // totals sit level and the block reads as one table.
    const bodyRows = Math.max(earnings.length, deductions.length) - 1;

    const rateW = 58;
    const amountW = 64;
    const eLabel = half - rateW - amountW;
    let ey = this.title(doc, x, y, half, 'EARNINGS / ALLOWANCES');
    ey = this.row(doc, x, ey, [
      {
        text: 'Particulars',
        width: eLabel,
        bold: true,
        fill: NAVY,
        color: '#FFFFFF',
      },
      {
        text: 'Rate (Rs.)',
        width: rateW,
        bold: true,
        fill: NAVY,
        color: '#FFFFFF',
        align: 'right',
      },
      {
        text: 'Amount (Rs.)',
        width: amountW,
        bold: true,
        fill: NAVY,
        color: '#FFFFFF',
        align: 'right',
      },
    ]);
    for (let i = 0; i < bodyRows; i++) {
      const line = earnings.slice(0, -1)[i];
      ey = this.row(doc, x, ey, [
        { text: line?.[0] ?? '', width: eLabel },
        { text: line ? figure(line[1]) : '', width: rateW, align: 'right' },
        { text: line ? figure(line[2]) : '', width: amountW, align: 'right' },
      ]);
    }
    const [grossLabel, grossRate, grossAmount] = earnings[earnings.length - 1];
    ey = this.row(doc, x, ey, [
      { text: grossLabel, width: eLabel, bold: true, fill: YELLOW },
      {
        text: figure(grossRate),
        width: rateW,
        bold: true,
        fill: YELLOW,
        align: 'right',
      },
      {
        text: figure(grossAmount),
        width: amountW,
        bold: true,
        fill: YELLOW,
        align: 'right',
      },
    ]);

    const dx = x + half + COLUMN_GAP;
    const dAmountW = 70;
    const dLabel = half - dAmountW;
    let dy = this.title(doc, dx, y, half, 'DEDUCTIONS');
    dy = this.row(doc, dx, dy, [
      {
        text: 'Particulars',
        width: dLabel,
        bold: true,
        fill: NAVY,
        color: '#FFFFFF',
      },
      {
        text: 'Amount (Rs.)',
        width: dAmountW,
        bold: true,
        fill: NAVY,
        color: '#FFFFFF',
        align: 'right',
      },
    ]);
    for (let i = 0; i < bodyRows; i++) {
      const line = deductions.slice(0, -1)[i];
      dy = this.row(doc, dx, dy, [
        { text: line?.[0] ?? '', width: dLabel },
        { text: line ? figure(line[1]) : '', width: dAmountW, align: 'right' },
      ]);
    }
    const [totalLabel, totalAmount] = deductions[deductions.length - 1];
    dy = this.row(doc, dx, dy, [
      { text: totalLabel, width: dLabel, bold: true, fill: YELLOW },
      {
        text: figure(totalAmount),
        width: dAmountW,
        bold: true,
        fill: YELLOW,
        align: 'right',
      },
    ]);
    y = Math.max(ey, dy) + 14;

    // Bank, with NET PAY and the amount in words as its last row.
    y = this.title(doc, x, y, CONTENT_WIDTH, 'BANK ACCOUNT DETAILS');
    for (const [left, right] of bankRows(identity)) {
      y = this.row(doc, x, y, [
        { text: left[0], width: labelW, fill: PALE, bold: true },
        { text: left[1], width: valueW },
        { text: right[0], width: labelW, fill: PALE, bold: true },
        { text: right[1], width: valueW },
      ]);
    }
    // "Rupees Twenty Thousand Only", as the docx words it — from the same net pay the row beside
    // it prints, so the two cannot disagree.
    y = this.row(
      doc,
      x,
      y,
      [
        {
          text: 'NET PAY',
          width: labelW,
          bold: true,
          fill: NAVY,
          color: '#FFFFFF',
        },
        {
          text: `Rs. ${money(slip.netPay)}`,
          width: valueW,
          bold: true,
          fill: YELLOW,
          color: NAVY,
        },
        {
          text: 'Amount in Words',
          width: labelW,
          bold: true,
          fill: NAVY,
          color: '#FFFFFF',
        },
        {
          text: rupeesFirstInWords(slip.netPay),
          width: valueW,
          bold: true,
          fill: YELLOW,
          color: NAVY,
        },
      ],
      { wrap: true, minHeight: 24 },
    );
    y += 10;

    doc.font('Helvetica').fontSize(8).fillColor('#000000');
    if (slip.minimumWagesNote) {
      doc.text(slip.minimumWagesNote, x, y, { width: CONTENT_WIDTH });
      y = doc.y + 3;
    }
    // The docx's closing line, verbatim. It stops somebody sending the payslip back for a signature.
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .text(
        'Note: This is a computer-generated salary slip and does not require a signature.',
        x,
        y,
        { width: CONTENT_WIDTH },
      );

    doc.end();
    return finished;
  }

  /**
   * The docx's header: the company's name centred in navy, its logo at the right. Returns where the
   * payslip itself begins. A missing or unreadable logo leaves the name alone.
   */
  private header(
    doc: Doc,
    identity: SlipIdentity,
    logo: Buffer | null,
  ): number {
    const top = MARGIN.top;
    let bottom = top;
    if (logo) {
      try {
        const image = (
          doc as unknown as {
            openImage(b: Buffer): { width: number; height: number };
          }
        ).openImage(logo);
        const scale = Math.min(110 / image.width, 44 / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        // The decoded image, not the bytes: pdfkit would decode and embed them a second time.
        doc.image(image as never, MARGIN.left + CONTENT_WIDTH - width, top, {
          width,
          height,
        });
        bottom = top + height;
      } catch {
        // Not an image pdfkit can read; the name stands alone.
      }
    }
    if (identity.companyName) {
      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor(NAVY)
        .text(identity.companyName, MARGIN.left + 120, top + 12, {
          width: CONTENT_WIDTH - 240,
          align: 'center',
        });
      bottom = Math.max(bottom, doc.y);
    }
    return Math.max(bottom, top + 30) + 16;
  }

  /** A section title in navy bold, as the docx sets "EARNINGS / ALLOWANCES". Returns the y below. */
  private title(doc: Doc, x: number, y: number, width: number, text: string) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(NAVY)
      .text(text, x, y, { width, lineBreak: false });
    return y + 14;
  }

  /**
   * One ruled row of cells. Text is a single line, clipped, unless `wrap` is set — the amount in
   * words, which runs to two lines for most salaries — in which case the row grows to fit.
   */
  private row(
    doc: Doc,
    x: number,
    y: number,
    cells: Cell[],
    options: { wrap?: boolean; minHeight?: number } = {},
  ): number {
    let height = options.minHeight ?? ROW;
    if (options.wrap) {
      for (const cell of cells) {
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPE);
        height = Math.max(
          height,
          doc.heightOfString(cell.text, { width: cell.width - 2 * PAD }) +
            2 * PAD,
        );
      }
    }
    let cx = x;
    for (const cell of cells) {
      if (cell.fill) {
        doc.rect(cx, y, cell.width, height).fill(cell.fill);
      }
      doc
        .rect(cx, y, cell.width, height)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TYPE);
      const textHeight = options.wrap
        ? doc.heightOfString(cell.text, { width: cell.width - 2 * PAD })
        : TYPE;
      doc.fillColor(cell.color ?? '#000000').text(
        cell.text,
        cx + PAD,
        y + (height - textHeight) / 2 + 0.5,
        options.wrap
          ? { width: cell.width - 2 * PAD, align: cell.align ?? 'left' }
          : {
              width: cell.width - 2 * PAD,
              align: cell.align ?? 'left',
              lineBreak: false,
              ellipsis: true,
              height: TYPE + 2,
            },
      );
      cx += cell.width;
    }
    return y + height;
  }
}
