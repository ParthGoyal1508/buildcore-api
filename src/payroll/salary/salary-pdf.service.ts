import { Injectable } from '@nestjs/common';
// `import = require` deliberately, not `import * as`. The app is built by SWC
// (nest-cli.json), which gives `import * as` true ESM semantics and hands back a
// namespace object that cannot be constructed; the tests are built by ts-jest, which
// emits a bare require and constructs fine. The namespace form therefore passes every
// test and throws "_pdfkit is not a constructor" in the running server. This form emits
// a bare require under both.
import PDFDocument = require('pdfkit');
import type { SalarySlipView, SlipIdentity } from './salary.service';

/**
 * The client's revised payslip (2026-10-13), `docs/HR_DOCS/Parth_Realcon_Payslip.docx`, printed on
 * the company's letterhead.
 *
 * ## Geometry
 *
 * The letterhead is whole-page artwork, drawn edge to edge exactly as `letter-pdf.renderer.ts` draws
 * it for letters, and everything here is laid inside the same clear band (`SAFE`). The numbers are
 * that renderer's, measured off both letterheads the client supplied; they are repeated rather than
 * imported because `letters` is a module payroll has no business depending on, and the two documents
 * must agree with the paper, not with each other.
 *
 * Without a letterhead the band's top is reclaimed by the company's name and address — the header
 * this payslip has always printed — so a company that never uploaded stationery still issues a
 * payslip that says whose it is.
 *
 * ## The rupee sign
 *
 * The docx heads its columns "Rate (₹)". pdfkit's built-in Helvetica is WinAnsi and has no ₹ glyph —
 * it prints a stray character in its place — so the columns say "Rs." until a font that carries the
 * glyph is bundled. A wrong symbol on a wage document is worse than an abbreviation.
 */

/** A4 portrait, in points. */
const PAGE = { width: 595.28, height: 841.89 };
/** The letterhead's clear band — `letter-pdf.renderer.ts`'s `SAFE`, for the reason given above. */
const SAFE = { top: 118, bottom: 168, left: 56, right: 56 };
/** Where the content starts on plain paper, below the company block this service draws itself. */
const PLAIN_TOP = 48;
const CONTENT_WIDTH = PAGE.width - SAFE.left - SAFE.right;

/** The docx's palette: navy section bars with white type, pale blue label cells. */
const NAVY = '#1F3755';
const PALE = '#EAF0F6';
const RULE = '#9AA7B5';

const ROW = 17;
const PAD = 4;
const TYPE = 9;
const COLUMN_GAP = 10;
const HALF = (CONTENT_WIDTH - COLUMN_GAP) / 2;

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

const or = (value: string | null | undefined): string => value?.trim() || DASH;

const date = (value: Date | null | undefined): string =>
  value
    ? value.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : DASH;

/** One deduction line: its label and the figure beside it. */
export type SlipRow = [label: string, amount: number];

/**
 * One earning line: label, **Rate** (the full-month figure) and **Amount** (what was paid).
 *
 * `rate` is nullable and stays nullable all the way to the page. Rate equal to Amount is a real and
 * common statement — no LOP this month — so it must not also be what "never recorded" looks like;
 * null prints as an em dash.
 */
export type EarningRow = [label: string, rate: number | null, amount: number];

/**
 * The earnings table, in the docx's order, holding only heads this system pays.
 *
 * The docx lists Basic, Dearness Allowance, House Rent Allowance, Conveyance Allowance, Special
 * Allowance, Medical Reimbursement, Conveyance Reimbursement and Food Allowance. Of those, the
 * salary structure holds Basic, HRA, Conveyance and Special; it also holds **Site Allowance** and
 * **Overtime**, which the docx does not name. The rest are omitted rather than printed as dashes:
 * a payslip naming a Dearness Allowance asserts the employee is entitled to one, and the client has
 * not confirmed any head beyond the system's own (see the note atop
 * `src/letters/standard-letter-templates.ts`). Site Allowance sits with the other allowances and
 * Overtime last, because it is earned by the hour rather than fixed by the month.
 *
 * Every held head is printed, zero or not, so two employees' payslips have the same shape.
 */
export function earningRows(slip: SalarySlipView): EarningRow[] {
  return [
    ['Basic', slip.fullEarnings.basic, slip.earnings.basic],
    ['House Rent Allowance', slip.fullEarnings.hra, slip.earnings.hra],
    [
      'Conveyance Allowance',
      slip.fullEarnings.conveyance,
      slip.earnings.conveyance,
    ],
    [
      'Site Allowance',
      slip.fullEarnings.siteAllowance,
      slip.earnings.siteAllowance,
    ],
    [
      'Special Allowance',
      slip.fullEarnings.specialAllowance,
      slip.earnings.specialAllowance,
    ],
    // No Rate, ever: overtime is hours worked, not an entitlement LOP can reduce.
    ['Overtime', slip.fullEarnings.ot, slip.earnings.ot],
    ['Gross Earnings', slip.fullEarnings.total, slip.earnings.total],
  ];
}

/**
 * The deductions table, in the docx's order, ending with the total.
 *
 * The docx's Welfare and Mobile Bill have no counterpart here and are omitted for the same reason
 * as the earnings above. Its "Other Deduction" slot carries the **fuel recovery**, under that name:
 * 020 FR-007 requires the recovery to appear on the payslip as itself, and a line called "Other"
 * leaves somebody unable to find out why their pay fell short.
 *
 * A nil deduction is still printed. A payslip that drops nil rows makes an employee wonder whether
 * TDS was deducted and not shown, or genuinely nil.
 */
export function deductionRows(slip: SalarySlipView): SlipRow[] {
  return [
    ['Provident Fund', slip.deductions.pf],
    ['ESI', slip.deductions.esic],
    ['Professional Tax', slip.deductions.pt],
    ['Loan', slip.deductions.loanEmi],
    ['Advance', slip.deductions.advanceRecovery],
    ['Fuel Recovery', slip.deductions.fuelRecovery],
    ['T.D.S.', slip.deductions.tds],
    ['Total Deduction', slip.deductions.total],
  ];
}

type Pair = [label: string, value: string];

/**
 * The employee panel, as label/value pairs in two columns, in the docx's own pairing.
 *
 * Working, rest and leave days are printed as em dashes: the slip stores **paid** days and LOP, not
 * the breakdown of the paid days into worked, weekly off and leave, and inventing that split would
 * put figures on a wage document nobody computed. The two figures it does store are printed on a
 * row of their own beneath the docx's, because they are what the Rate and Amount columns differ by.
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
    [
      ['Paid Days', String(slip.payableDays)],
      ['LOP Days', String(slip.lopDays)],
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
   * @param letterhead the company's stationery, or null/absent for plain paper. A letterhead pdfkit
   * cannot decode prints on plain paper rather than losing the payslip.
   */
  async render(
    slip: SalarySlipView,
    employeeName: string,
    letterhead?: Buffer | null,
  ): Promise<Buffer> {
    const doc: Doc = new PDFDocument({
      size: 'A4',
      // Zero: the letterhead is drawn edge to edge and everything is positioned against SAFE.
      margin: 0,
    });
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

    let onStationery = false;
    if (letterhead) {
      try {
        doc.image(letterhead, 0, 0, {
          width: PAGE.width,
          height: PAGE.height,
        });
        onStationery = true;
      } catch {
        onStationery = false;
      }
    }

    let y = onStationery ? SAFE.top : this.companyBlock(doc, identity);
    const x = SAFE.left;

    // Heading.
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(NAVY)
      .text(`Pay slip for the month of ${periodLabel(slip.period)}`, x, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    y += 22;

    // Employee panel: four columns, labels shaded.
    const labelW = 124;
    const valueW = CONTENT_WIDTH / 2 - labelW;
    for (const [left, right] of identityRows(slip, identity)) {
      y = this.row(doc, x, y, [
        { text: left[0], width: labelW, fill: PALE, bold: true },
        { text: left[1], width: valueW },
        { text: right[0], width: labelW, fill: PALE, bold: true },
        { text: right[1], width: valueW },
      ]);
    }
    y += 10;

    // Earnings and deductions side by side, as the docx nests them.
    const top = y;
    const earnings = earningRows(slip);
    const deductions = deductionRows(slip);
    // Both columns end on the same line: the shorter one is padded with empty rows, so the two
    // totals sit level and the block reads as one table.
    const bodyRows = Math.max(earnings.length, deductions.length) - 1;
    const earningBody = earnings.slice(0, -1);
    const deductionBody = deductions.slice(0, -1);

    const rateW = 64;
    const amountW = 68;
    const eLabel = HALF - rateW - amountW;
    let ey = this.bar(doc, x, top, HALF, 'EARNINGS / ALLOWANCES');
    ey = this.row(doc, x, ey, [
      { text: 'Particulars', width: eLabel, bold: true, fill: PALE },
      {
        text: 'Rate (Rs.)',
        width: rateW,
        bold: true,
        fill: PALE,
        align: 'right',
      },
      {
        text: 'Amount (Rs.)',
        width: amountW,
        bold: true,
        fill: PALE,
        align: 'right',
      },
    ]);
    for (let i = 0; i < bodyRows; i++) {
      const line = earningBody[i];
      ey = this.row(doc, x, ey, [
        { text: line?.[0] ?? '', width: eLabel },
        {
          text: line ? (line[1] === null ? DASH : money(line[1])) : '',
          width: rateW,
          align: 'right',
        },
        { text: line ? money(line[2]) : '', width: amountW, align: 'right' },
      ]);
    }
    const [grossLabel, grossRate, grossAmount] = earnings[earnings.length - 1];
    ey = this.row(doc, x, ey, [
      { text: grossLabel, width: eLabel, bold: true, fill: PALE },
      {
        text: grossRate === null ? DASH : money(grossRate),
        width: rateW,
        bold: true,
        fill: PALE,
        align: 'right',
      },
      {
        text: money(grossAmount),
        width: amountW,
        bold: true,
        fill: PALE,
        align: 'right',
      },
    ]);

    const dx = x + HALF + COLUMN_GAP;
    const dLabel = HALF - 80;
    let dy = this.bar(doc, dx, top, HALF, 'DEDUCTIONS');
    dy = this.row(doc, dx, dy, [
      { text: 'Particulars', width: dLabel, bold: true, fill: PALE },
      {
        text: 'Amount (Rs.)',
        width: 80,
        bold: true,
        fill: PALE,
        align: 'right',
      },
    ]);
    for (let i = 0; i < bodyRows; i++) {
      const line = deductionBody[i];
      dy = this.row(doc, dx, dy, [
        { text: line?.[0] ?? '', width: dLabel },
        { text: line ? money(line[1]) : '', width: 80, align: 'right' },
      ]);
    }
    const [totalLabel, totalAmount] = deductions[deductions.length - 1];
    dy = this.row(doc, dx, dy, [
      { text: totalLabel, width: dLabel, bold: true, fill: PALE },
      {
        text: money(totalAmount),
        width: 80,
        bold: true,
        fill: PALE,
        align: 'right',
      },
    ]);
    y = Math.max(ey, dy) + 10;

    // Bank.
    y = this.bar(doc, x, y, CONTENT_WIDTH, 'BANK ACCOUNT DETAILS');
    for (const [left, right] of bankRows(identity)) {
      y = this.row(doc, x, y, [
        { text: left[0], width: labelW, fill: PALE, bold: true },
        { text: left[1], width: valueW },
        { text: right[0], width: labelW, fill: PALE, bold: true },
        { text: right[1], width: valueW },
      ]);
    }
    y += 10;

    // Net pay.
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
          width: CONTENT_WIDTH - labelW,
          bold: true,
        },
      ],
      20,
    );
    y = this.row(doc, x, y, [
      { text: 'Amount in Words', width: labelW, bold: true, fill: PALE },
      { text: slip.netPayInWords, width: CONTENT_WIDTH - labelW },
    ]);
    y += 8;

    doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
    if (slip.minimumWagesNote) {
      doc.text(slip.minimumWagesNote, x, y, { width: CONTENT_WIDTH });
      y = doc.y + 3;
    }
    // The docx's closing line, verbatim. It stops somebody sending the payslip back for a signature.
    doc
      .font('Helvetica-Oblique')
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
   * The plain-paper header: company name and address, centred, above a rule. Returns where the
   * payslip itself begins. Skipped to a bare top margin when the company is unknown.
   */
  private companyBlock(doc: Doc, identity: SlipIdentity): number {
    let y = PLAIN_TOP;
    if (!identity.companyName) return y;
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(NAVY)
      .text(identity.companyName, SAFE.left, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    y = doc.y + 2;
    if (identity.companyAddress) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#000000')
        .text(identity.companyAddress, SAFE.left, y, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
      y = doc.y;
    }
    y += 6;
    doc
      .moveTo(SAFE.left, y)
      .lineTo(SAFE.left + CONTENT_WIDTH, y)
      .lineWidth(0.8)
      .strokeColor(NAVY)
      .stroke();
    return y + 12;
  }

  /** A navy section bar with its title in white. Returns the y below it. */
  private bar(
    doc: Doc,
    x: number,
    y: number,
    width: number,
    title: string,
  ): number {
    return this.row(doc, x, y, [
      { text: title, width, bold: true, fill: NAVY, color: '#FFFFFF' },
    ]);
  }

  /**
   * One ruled row of cells. Text is clipped to a single line — every value on a payslip is short,
   * and a row that grew to fit an overlong value would push the page into the letterhead's footer.
   */
  private row(
    doc: Doc,
    x: number,
    y: number,
    cells: Cell[],
    height = ROW,
  ): number {
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
      doc
        .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(TYPE)
        .fillColor(cell.color ?? '#000000')
        .text(cell.text, cx + PAD, y + (height - TYPE) / 2 + 0.5, {
          width: cell.width - 2 * PAD,
          align: cell.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
          height: TYPE + 2,
        });
      cx += cell.width;
    }
    return y + height;
  }
}
