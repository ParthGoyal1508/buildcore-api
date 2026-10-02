import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import type { SalarySlipView, SlipIdentity } from './salary.service';

/** Page geometry, in PDF points. Named because a bare `50` scattered through the
 * drawing calls below says nothing about what it measures. */
const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const COLUMN_GAP = 20;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;

/** "2026-02" → "February 2026", as the sample's heading reads. */
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

/** One printed line: its label and the figure beside it. */
export type SlipRow = [label: string, amount: number];

/**
 * One earning line with both columns the client's payslip prints (021 FR-008f, T104).
 *
 * `full` is nullable and stays nullable all the way to the page. `docs/NC0060_Payslip_Feb 2026.pdf`
 * has LOP zero throughout, so Full and Actual are identical in every row of it — which makes the
 * sample **no evidence** that the two agree, and is exactly why a null is printed as an em dash
 * rather than as a copy of the actual figure.
 */
export type EarningRow = [label: string, full: number | null, actual: number];

/** The month's earnings with both columns, in the sample's order. */
export function fullAndActualEarningRows(slip: SalarySlipView): EarningRow[] {
  return [
    ['Basic', slip.fullEarnings.basic, slip.earnings.basic],
    ['HRA', slip.fullEarnings.hra, slip.earnings.hra],
    ['Conveyance', slip.fullEarnings.conveyance, slip.earnings.conveyance],
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
    // Overtime has no Full figure and never will: it is hours worked, not an entitlement LOP can
    // reduce. The column is left as an em dash rather than repeating the actual.
    ['Overtime', slip.fullEarnings.ot, slip.earnings.ot],
  ];
}

/**
 * The identity block, as printed label/value pairs in two columns.
 *
 * Read off the sample's own layout, left column then right: Name/Employee No, Joining Date/Bank
 * Name, Designation/Bank Account No, Department/PAN Number, Location/PF No, Effective Work Days/PF
 * UAN, LOP/—.
 *
 * **Every label is printed even when its value is absent**, which the sample does too — its `PF No`
 * is empty and the label is still there. A label that disappears with its value makes a payslip's
 * shape depend on the employee, and two payslips that do not line up invite the question of what
 * else differs.
 */
export function identityRows(
  slip: SalarySlipView,
  identity: SlipIdentity,
): [left: [string, string], right: [string, string]][] {
  const or = (value: string | null | undefined): string => value?.trim() || '—';
  const date = (value: Date | null): string =>
    value
      ? value.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';
  return [
    [
      ['Name', or(identity.employeeName)],
      ['Employee No', or(slip.employeeCode)],
    ],
    [
      ['Joining Date', date(identity.joiningDate)],
      ['Bank Name', or(identity.bankName)],
    ],
    [
      ['Designation', or(identity.designation)],
      ['Bank Account No', or(identity.bankAccountNumberMasked)],
    ],
    [
      ['Department', or(identity.department)],
      ['PAN Number', or(identity.panNumber)],
    ],
    [
      ['Location', or(identity.location)],
      ['PF No', or(identity.pfNumber)],
    ],
    [
      ['Effective Work Days', String(slip.payableDays)],
      ['PF UAN', or(identity.pfUan)],
    ],
    [
      ['LOP', String(slip.lopDays)],
      ['', ''],
    ],
  ];
}

/**
 * The three tables of a payslip, as data.
 *
 * Exported and pure so the mapping from `SalarySlipView` to printed lines can be
 * asserted directly. The risk this guards against is a figure quietly going to the
 * wrong line, or a line being dropped — neither of which is visible from checking
 * that a PDF was produced, and neither of which any amount of drawing-call testing
 * would catch.
 */
export function earningRows(slip: SalarySlipView): SlipRow[] {
  return [
    ['Basic', slip.earnings.basic],
    ['HRA', slip.earnings.hra],
    ['Conveyance', slip.earnings.conveyance],
    ['Site Allowance', slip.earnings.siteAllowance],
    ['Special Allowance', slip.earnings.specialAllowance],
    ['Overtime', slip.earnings.ot],
    ['Total Earnings', slip.earnings.total],
  ];
}

export function deductionRows(slip: SalarySlipView): SlipRow[] {
  return [
    ['PF', slip.deductions.pf],
    ['ESIC', slip.deductions.esic],
    ['Professional Tax', slip.deductions.pt],
    ['TDS', slip.deductions.tds],
    ['Loan EMI', slip.deductions.loanEmi],
    ['Advance Recovery', slip.deductions.advanceRecovery],
    // 020 FR-007: on the payslip itself, under its own name.
    ['Fuel Recovery', slip.deductions.fuelRecovery],
    ['Total Deductions', slip.deductions.total],
  ];
}

export function employerContributionRows(slip: SalarySlipView): SlipRow[] {
  return [
    ['PF', slip.employerContributions.pf],
    ['EPS', slip.employerContributions.eps],
    ['EDLI', slip.employerContributions.edli],
    ['Admin Charges', slip.employerContributions.adminCharges],
    ['Gratuity', slip.employerContributions.gratuity],
    ['Bonus', slip.employerContributions.bonus],
  ];
}

/**
 * Renders a payslip PDF (US5, research.md §7).
 *
 * Takes the very same `SalarySlipView` the JSON endpoint returns, rather than
 * re-reading the database. That is the whole point of the parameter type: two code
 * paths reading the same rows could still format or round them differently, and a
 * PDF that disagrees with the on-screen figures is a wage dispute waiting to
 * happen.
 */
@Injectable()
export class SalaryPdfService {
  async render(slip: SalarySlipView, employeeName: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const identity = slip.identity;

    if (identity) {
      // The client's layout (T104): company name and address, the month, then the two-column
      // employee panel. Centred company block, as the sample has it.
      doc.fontSize(14).text(identity.companyName, { align: 'center' });
      if (identity.companyAddress) {
        doc.fontSize(8).text(identity.companyAddress, {
          align: 'center',
          width: CONTENT_WIDTH,
        });
      }
      doc.moveDown(0.5);
      doc
        .fontSize(11)
        .text(`Payslip for the month of ${periodLabel(slip.period)}`, {
          align: 'center',
        });
      doc.moveDown(0.8);
      this.identityPanel(doc, slip, identity);
      doc.moveDown(0.8);
    } else {
      // The layout this service printed before the client's sample arrived. Kept for a caller that
      // has no identity to supply — a slip can be rendered without one, and a half-drawn header
      // block would be worse than the old heading.
      doc.fontSize(18).text('Salary Slip', { align: 'center' });
      doc.moveDown(0.3);
      doc
        .fontSize(11)
        .text(`Period: ${slip.period}`, { align: 'center' })
        .text(`${employeeName} (${slip.employeeCode})`, { align: 'center' });
      doc.moveDown(1);
      this.attendanceSummary(doc, slip);
      doc.moveDown(1);
    }

    const tableTop = doc.y;
    this.earningsTable(doc, MARGIN, tableTop, slip);
    this.amountTable(
      doc,
      MARGIN + COLUMN_WIDTH + COLUMN_GAP,
      tableTop,
      'Deductions',
      deductionRows(slip),
    );

    // Both tables were drawn from the same top, so the cursor is wherever the
    // second one ended; reset it below the taller of the two before continuing.
    // Earnings is seven lines plus a heading; deductions is eight plus a heading.
    doc.y = tableTop + 10 * 18 + 20;
    doc.x = MARGIN;

    doc
      .fontSize(12)
      .text(
        `Net Pay for the month (Total Earnings - Total Deductions): INR ${money(
          slip.netPay,
        )}`,
      );
    doc.fontSize(10).text(slip.netPayInWords);
    doc.moveDown(1);

    doc.fontSize(11).text('Employer Contributions (informational)');
    doc.fontSize(9);
    for (const [label, value] of employerContributionRows(slip)) {
      doc.text(`${label}: ${money(value)}`, { continued: false });
    }

    if (slip.minimumWagesNote) {
      doc.moveDown(1);
      doc.fontSize(8).text(slip.minimumWagesNote, { width: CONTENT_WIDTH });
    }

    doc.moveDown(1);
    // The sample's closing line, verbatim in substance. It is there to stop somebody sending the
    // payslip back asking for a signature, and that is still a thing people do.
    doc
      .fontSize(8)
      .text(
        'This is a system generated payslip and does not require signature.',
        { width: CONTENT_WIDTH },
      );

    doc.end();
    return finished;
  }

  /**
   * The two-column employee panel, in the sample's own pairing (T104).
   *
   * Labels are printed whether or not their value is known — see `identityRows`. Absent values are
   * an em dash, never a gap.
   */
  private identityPanel(
    doc: PDFKit.PDFDocument,
    slip: SalarySlipView,
    identity: SlipIdentity,
  ): void {
    const rightX = MARGIN + COLUMN_WIDTH + COLUMN_GAP;
    let cursor = doc.y;
    doc.fontSize(9);
    for (const [left, right] of identityRows(slip, identity)) {
      if (left[0]) {
        doc.text(`${left[0]}:`, MARGIN, cursor, { width: COLUMN_WIDTH * 0.55 });
        doc.text(left[1], MARGIN + COLUMN_WIDTH * 0.55, cursor, {
          width: COLUMN_WIDTH * 0.45,
        });
      }
      if (right[0]) {
        doc.text(`${right[0]}:`, rightX, cursor, {
          width: COLUMN_WIDTH * 0.55,
        });
        doc.text(right[1], rightX + COLUMN_WIDTH * 0.55, cursor, {
          width: COLUMN_WIDTH * 0.45,
        });
      }
      cursor += 14;
    }
    doc.x = MARGIN;
    doc.y = cursor;
  }

  /**
   * Earnings as **Full and Actual side by side** (T104, T105).
   *
   * An em dash where Full is unrecorded, rather than a repeat of Actual. The two being equal is a
   * real and common statement — it means no LOP this month — so it must not also be what "we do not
   * know" looks like.
   */
  private earningsTable(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    slip: SalarySlipView,
  ): void {
    const labelWidth = COLUMN_WIDTH * 0.46;
    const figureWidth = COLUMN_WIDTH * 0.27;
    doc.fontSize(11).text('Earnings', x, y, { width: COLUMN_WIDTH });
    doc.fontSize(8);
    doc.text('Full', x + labelWidth, y + 4, {
      width: figureWidth,
      align: 'right',
    });
    doc.text('Actual', x + labelWidth + figureWidth, y + 4, {
      width: figureWidth,
      align: 'right',
    });

    let cursor = y + 18;
    doc.fontSize(9);
    const rows = fullAndActualEarningRows(slip);
    for (const [label, full, actual] of rows) {
      doc.text(label, x, cursor, { width: labelWidth });
      doc.text(full === null ? '—' : money(full), x + labelWidth, cursor, {
        width: figureWidth,
        align: 'right',
      });
      doc.text(money(actual), x + labelWidth + figureWidth, cursor, {
        width: figureWidth,
        align: 'right',
      });
      cursor += 18;
    }

    // The rule separates the sum from the items it sums.
    doc
      .moveTo(x, cursor - 3)
      .lineTo(x + COLUMN_WIDTH, cursor - 3)
      .stroke();
    doc.text('Total Earnings', x, cursor, { width: labelWidth });
    doc.text(
      slip.fullEarnings.total === null ? '—' : money(slip.fullEarnings.total),
      x + labelWidth,
      cursor,
      { width: figureWidth, align: 'right' },
    );
    doc.text(money(slip.earnings.total), x + labelWidth + figureWidth, cursor, {
      width: figureWidth,
      align: 'right',
    });
  }

  private attendanceSummary(
    doc: PDFKit.PDFDocument,
    slip: SalarySlipView,
  ): void {
    doc
      .fontSize(10)
      .text(
        `Month Days: ${slip.monthDays}    Payable Days: ${slip.payableDays}    LOP Days: ${slip.lopDays}    OT Hours: ${slip.otHours}`,
      );
  }

  private amountTable(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    heading: string,
    rows: SlipRow[],
  ): void {
    doc.fontSize(11).text(heading, x, y, { width: COLUMN_WIDTH });
    let cursor = y + 18;
    doc.fontSize(9);
    rows.forEach(([label, value], index) => {
      // The last row is the total; a rule above it is what separates a sum from
      // the items it sums.
      if (index === rows.length - 1) {
        doc
          .moveTo(x, cursor - 3)
          .lineTo(x + COLUMN_WIDTH, cursor - 3)
          .stroke();
      }
      doc.text(label, x, cursor, { width: COLUMN_WIDTH * 0.6 });
      doc.text(money(value), x, cursor, {
        width: COLUMN_WIDTH,
        align: 'right',
      });
      cursor += 18;
    });
  }
}
