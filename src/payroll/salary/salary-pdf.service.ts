import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import type { SalarySlipView } from './salary.service';

/** Page geometry, in PDF points. Named because a bare `50` scattered through the
 * drawing calls below says nothing about what it measures. */
const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const COLUMN_GAP = 20;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;

const money = (value: number): string =>
  value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** One printed line: its label and the figure beside it. */
export type SlipRow = [label: string, amount: number];

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

    doc.fontSize(18).text('Salary Slip', { align: 'center' });
    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .text(`Period: ${slip.period}`, { align: 'center' })
      .text(`${employeeName} (${slip.employeeCode})`, { align: 'center' });
    doc.moveDown(1);

    this.attendanceSummary(doc, slip);
    doc.moveDown(1);

    const tableTop = doc.y;
    this.amountTable(doc, MARGIN, tableTop, 'Earnings', earningRows(slip));
    this.amountTable(
      doc,
      MARGIN + COLUMN_WIDTH + COLUMN_GAP,
      tableTop,
      'Deductions',
      deductionRows(slip),
    );

    // Both tables were drawn from the same top, so the cursor is wherever the
    // second one ended; reset it below the taller of the two before continuing.
    doc.y = tableTop + 9 * 18 + 20;
    doc.x = MARGIN;

    doc.fontSize(13).text(`Net Pay: INR ${money(slip.netPay)}`);
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

    doc.end();
    return finished;
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
