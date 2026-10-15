import { Injectable, NotFoundException } from '@nestjs/common';
import { printDate } from '../workbook/print-format';
import { BillDirection, BillPackageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { rupeesInWords } from '../../../common/rupees-in-words';
import { BillDocxRenderer } from '../workbook/bill-docx.renderer';
import { BillPdfRenderer } from '../workbook/bill-pdf.renderer';
import { BillWorkbookRenderer } from '../workbook/bill-workbook.renderer';
import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
} from '../workbook/bill-workbook.types';
import type { FrozenRates } from './bill-package.service';
import { BillPackageService, packageLabel } from './bill-package.service';
import { DebitNoteService } from './debit-note.service';
import { MeasurementSheetService } from './measurement-sheet.service';

/**
 * Assembles the view the renderer consumes, and only then renders (023 FR-024 to FR-030a).
 *
 * ## Why this is a separate class
 *
 * The renderer must hold no database client (FR-028, T078) — that is what makes "every figure comes
 * from the stored bill" a property of its inputs rather than a rule somebody remembers. So
 * *something* has to read the stored bill and shape it, and if that something were the renderer the
 * guarantee would be gone. This is that something: it queries, it reads the services, it rounds
 * nothing, and it hands over a view of strings.
 *
 * Every figure it passes through has already been rounded once, by `displayRupees` inside
 * `abstractFor`. Nothing here computes a total, applies a rate or sums a column.
 */
@Injectable()
export class BillPackageViewBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: BillPackageService,
    private readonly sheets: MeasurementSheetService,
    private readonly debits: DebitNoteService,
    private readonly renderer: BillWorkbookRenderer,
    private readonly pdf: BillPdfRenderer,
    private readonly docx: BillDocxRenderer,
  ) {}

  /**
   * The package in one of three formats, with its filename and the gaps the caller must be told
   * about (FR-027a).
   *
   * **All three call `viewFor`.** The spreadsheet, the PDF and the Word copy of one bill are three
   * readings of a single set of already-rounded figures, so they cannot disagree — a client holding
   * two of them would otherwise be right to believe whichever is worse for us.
   *
   * `abstractOnly` gives the abstract alone: on a bill to the client, the *Payment Abstract* the
   * authority asks for as its own sheet.
   */
  async documentFor(
    ctx: RlsContext,
    packageId: string,
    format: 'xlsx' | 'pdf' | 'docx',
    options: { abstractOnly?: boolean } = {},
  ): Promise<{ bytes: Buffer; filename: string; missingFields: string[] }> {
    const view = await this.viewFor(ctx, packageId);
    const bytes =
      format === 'xlsx'
        ? await this.renderer.render(view, options)
        : format === 'pdf'
        ? await this.pdf.render(view, options)
        : await this.docx.render(view, options);
    const party =
      view.header.direction === 'to_client'
        ? view.header.issuer.name
        : view.header.receiver.name;
    // Named after the party and the bill, the way the client names the file they are sent.
    return {
      bytes,
      filename: `${sanitise(party ?? 'Bill')} ${view.header.billLabel}${
        options.abstractOnly
          ? view.header.direction === 'to_client'
            ? ' Payment Abstract'
            : ' Abstract'
          : ''
      }.${format}`,
      missingFields: view.header.missingFields,
    };
  }

  /** The workbook (FR-024). Kept for its callers; `documentFor` is the general form. */
  async workbookFor(ctx: RlsContext, packageId: string) {
    return this.documentFor(ctx, packageId, 'xlsx');
  }

  /** The PDF (025 FR-042). Kept for its callers; `documentFor` is the general form. */
  async pdfFor(ctx: RlsContext, packageId: string) {
    return this.documentFor(ctx, packageId, 'pdf');
  }

  /**
   * The whole package as the renderer needs it.
   *
   * Reads: the package row, its claims, the abstract (already rounded), one measurement sheet per
   * schedule line, the check list, and the debit register — which is live for a draft and *as at
   * issue* for an issued bill, a distinction `DebitNoteService` has already applied.
   */
  async viewFor(ctx: RlsContext, packageId: string): Promise<BillWorkbookView> {
    const pkg = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackage.findFirst({
        where: { id: packageId },
        include: {
          project: {
            select: {
              name: true,
              location: true,
              orderNumber: true,
              description: true,
            },
          },
          clientBill: { select: { billingDate: true } },
          raBill: {
            select: {
              billingDate: true,
              workOrder: { select: { code: true, workDetail: true } },
            },
          },
        },
      }),
    );
    if (!pkg) throw new NotFoundException('Bill package not found');

    // A bill not yet issued has no frozen header (it is copied at issue), so its documents take
    // the parties as they stand today (2026-10-15) rather than printing them blank.
    const frozen = pkg.issuerName !== null || pkg.receiverName !== null;
    const [packageView, abstract, register, live] = await Promise.all([
      this.packages.view(ctx, packageId),
      this.packages.abstractFor(ctx, packageId),
      this.debits.registerFor(ctx, packageId),
      frozen
        ? Promise.resolve(null)
        : this.packages.previewHeader(ctx, packageId),
    ]);
    const party = (key: string, stored: string | null) =>
      stored ?? live?.[key] ?? null;
    const workOrder = pkg.raBill?.workOrder ?? null;

    // **One per line claimed on this bill, in schedule order** (FR-030, amended 2026-10-05).
    //
    // Was one per schedule line, claimed or not. That is right for the three-line bill the format
    // was drawn from and wrong at any real scale: a 231-line tender with six lines measured
    // produced a 246-page PDF of which 225 pages carried a nil claim. A measurement sheet argues a
    // quantity being claimed, and there is nothing to argue about a line this bill does not claim —
    // the schedule annexure still lists every line, which is where a reader checks nothing is
    // missing.
    //
    // Sequential rather than parallel: a 312-line tender would otherwise open 312 transactions at
    // once, which is the shape of the problem research §8 records rather than a different one.
    const claimed = packageView.claims.filter(
      (claim) => claim.claimedQty != null && Number(claim.claimedQty) !== 0,
    );
    const measurementSheets: WorkbookMeasurementSheet[] = [];
    for (const [index, claim] of claimed.entries()) {
      const sheet = await this.sheets.sheetFor(
        ctx,
        packageId,
        claim.scheduleLineId,
      );
      measurementSheets.push({
        scheduleLineId: claim.scheduleLineId,
        srNo: index + 1,
        boqNo: sheet.boqNo,
        description: sheet.description,
        unit: sheet.unit,
        history: sheet.history.map((row) => ({
          month: row.month,
          period: `From ${printDate(row.periodFrom)} to ${printDate(
            row.periodTo,
          )}`,
          quantity: row.quantity,
          remarks: row.reason,
          billLabel: row.billLabel,
          overClaimed: row.overClaimed,
        })),
        dailyRecord: sheet.dailyRecord.map((day) => ({
          date: day.date,
          openingReading: day.openingReading,
          closingReading: day.closingReading,
          totalRun: day.totalHours,
          remarks: day.remarks,
          missing: day.logbookMissing,
        })),
        footer: sheet.footer,
      });
    }

    const sheetByLine = new Map(
      measurementSheets.map((sheet) => [sheet.scheduleLineId, sheet]),
    );

    const header = {
      // FR-025's two bindings, resolved **here** and not in the renderer. By the time the sheet
      // builders see it, the direction has already decided who is in which slot — which is what
      // makes it one renderer with two bindings rather than two renderers.
      issuer: {
        name: party('issuerName', pkg.issuerName),
        gstin: party('issuerGstin', pkg.issuerGstin),
        pan: party('issuerPan', pkg.issuerPan),
        state: party('issuerState', pkg.issuerState),
        address: party('issuerAddress', pkg.issuerAddress),
        code: null,
      },
      receiver: {
        name: party('receiverName', pkg.receiverName),
        gstin: party('receiverGstin', pkg.receiverGstin),
        pan: party('receiverPan', pkg.receiverPan),
        state: party('receiverState', pkg.receiverState),
        address: party('receiverAddress', pkg.receiverAddress),
        code: party('receiverCode', pkg.receiverCode),
      },
      projectName: pkg.project.name,
      // Nothing records these three on the package itself, so every bill printed them blank
      // (2026-10-15). They come from what does record them: the work order on a subcontractor's
      // bill, the project on the client's.
      natureOfWork:
        pkg.natureOfWork ??
        workOrder?.workDetail ??
        pkg.project.description ??
        pkg.project.name,
      location: pkg.location ?? pkg.project.location,
      externalWorkOrderNo:
        pkg.externalWorkOrderNo ??
        (pkg.direction === BillDirection.to_client
          ? pkg.project.orderNumber
          : workOrder?.code ?? null),
      externalBillNo: pkg.externalBillNo,
      billLabel: packageLabel(pkg.sequenceNo),
      periodFrom: iso(pkg.periodFrom),
      periodTo: iso(pkg.periodTo),
      billDate: iso(
        pkg.clientBill?.billingDate ?? pkg.raBill?.billingDate ?? pkg.periodTo,
      ),
      missingFields: pkg.missingHeaderFields,
      direction: pkg.direction,
    };

    return {
      header,
      abstract: {
        blocks:
          pkg.direction === BillDirection.to_client
            ? clientBlocks(abstract)
            : subcontractorBlocks(abstract, pkg),
        title:
          pkg.direction === BillDirection.to_client
            ? 'PAYMENT ABSTRACT'
            : 'ABSTRACT SHEET',
        payable:
          pkg.direction === BillDirection.to_client
            ? row('Payable Amount (1-2)', abstract.columns, 'payable')
            : row(
                'AMOUNT PAYABLE (A - B - C - D)',
                abstract.columns,
                'payable',
              ),
        netPayable:
          pkg.direction === BillDirection.to_client
            ? null
            : row('NET PAYABLE AMOUNT', abstract.columns, 'payable'),
        amountInWords: `Rupees ${rupeesInWords(
          Number(abstract.columns.thisBill.payable ?? 0),
        ).replace(/ Rupees/, '')}`,
        taxBasis: abstract.taxBasis,
        taxBasisSource: abstract.taxBasisSource,
      },
      schedule: {
        // Keyed by schedule line, never by position. The sheets are now a subset of the claims, and
        // `measurementSheets[index]` would have silently handed each line a different line's
        // cumulative figures — a wrong number on a money document that reads as a right one.
        //
        // **Only the lines this bill claims** (2026-10-15) — the client: "only show those items
        // whose value are non zero in the downloaded bill, instead of all the BOQ items". The same
        // set the measurement sheets already use; the totals are the abstract's, so they do not
        // move.
        lines: claimed.map((claim, index) => ({
          srNo: index + 1,
          boqNo: claim.boqNo,
          description: claim.description,
          unit: claim.unit,
          scopeQty: claim.remainingQty,
          rate: claim.rate,
          scopeAmount: claim.amount,
          balanceQty: claim.remainingQty,
          qtyUptoDate:
            sheetByLine.get(claim.scheduleLineId)?.footer.uptoDateQty ??
            claim.claimedQty,
          qtyUptoPrevious:
            sheetByLine.get(claim.scheduleLineId)?.footer.uptoPreviousQty ??
            '0.000',
          qtyThisBill: claim.claimedQty,
          amountUptoDate: claim.amount,
          amountUptoPrevious: '0.00',
          amountThisBill: claim.amount,
        })),
        totals: {
          scopeAmount: abstract.columns.thisBill.workDone,
          amountUptoDate: abstract.columns.uptoDate.workDone,
          amountUptoPrevious: abstract.columns.uptoPrevious.workDone,
          amountThisBill: abstract.columns.thisBill.workDone,
        },
      },
      measurementSheets,
      debitRegister: {
        groups: register.groups.map((group) => ({
          heading: group.heading,
          rows: group.rows.map((debit, index) => ({
            srNo: index + 1,
            description: debit.description,
            location: debit.location,
            nos: debit.nos,
            length: debit.length,
            width: debit.width,
            quantity: debit.quantity,
            rate: debit.rate,
            unit: debit.unit,
            amount: debit.amount,
            amountWithTax: debit.amountWithTax,
            remark: debit.recoveredOn,
          })),
        })),
        total: register.total,
      },
    };
  }

  /** Whether the package can still be edited — used by the controller's guards' callers. */
  static isDraft(status: BillPackageStatus): boolean {
    return status === BillPackageStatus.draft;
  }

  /** Which direction's schedule a package measures, for a caller that needs to know. */
  static scheduleOf(direction: BillDirection): 'boq' | 'award' {
    return direction === BillDirection.to_client ? 'boq' : 'award';
  }
}

type Columns = {
  thisBill: Record<string, string>;
  uptoPrevious: Record<string, string>;
  uptoDate: Record<string, string>;
};

/** The rates an abstract was computed at, for the labels that state them. */
type Abstract = {
  columns: Columns;
  rates: FrozenRates;
  deductionLines: {
    section: 'recovery' | 'deduction';
    label: string;
    thisBill: string;
    uptoPrevious: string;
    uptoDate: string;
  }[];
};

/** The user's own lines in one section, as abstract rows. */
function customRows(abstract: Abstract, section: 'recovery' | 'deduction') {
  return abstract.deductionLines
    .filter((line) => line.section === section)
    .map((line) => ({
      label: line.label,
      uptoDate: line.uptoDate,
      uptoPrevious: line.uptoPrevious,
      thisMonth: line.thisBill,
    }));
}

/**
 * A rate as a label says it: `0.090000` → `9%`, `0.010000` → `1%`, `0.020000` → `2%`.
 *
 * **Built from the frozen fraction, never typed into the label.** The client's own abstract heads
 * each row with the rate it was computed at — *CGST 9%*, *Labour Cess @ 1%* — and a heading typed
 * as text would go on saying nine per cent after somebody changed the rate to eight, on a document
 * whose whole purpose is that the arithmetic can be checked against the heading.
 */
function percent(fraction: string | undefined): string {
  const value = Number(fraction ?? 0) * 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(4))}%`;
}

/**
 * The payment abstract a **government client** reads (2026-10-13).
 *
 * Shaped on the authority's own sheet — *Value of Work Done* with the bill of quantities and a
 * deduction, then the taxes, then four statutory recoveries and one total. Two documents, one
 * arithmetic: every figure here comes from the same column the subcontractor's four blocks come
 * from, and only the grouping differs.
 *
 * Two rows show the same figure on purpose. *Total Value of Work Done (1A-1B)* and *Taxable Amount*
 * are the same number, and the client's sheet prints both — the first is what the work came to, the
 * second is what the tax was computed on, and they are equal only because nothing here is exempt.
 */
function clientBlocks(abstract: Abstract) {
  const { columns, rates } = abstract;
  return [
    {
      title: '1. VALUE OF WORK DONE',
      rows: [
        row('A) Bill of Quantities', columns, 'workDone'),
        row('B) Deduction', columns, 'workDeduction'),
        {
          ...row('Total Value of Work Done (1A-1B)', columns, 'taxableAmount'),
          isTotal: true,
        },
        row('Taxable Amount', columns, 'taxableAmount'),
        row(`CGST ${percent(rates.cgstFraction)}`, columns, 'cgstAmount'),
        row(`SGST ${percent(rates.sgstFraction)}`, columns, 'sgstAmount'),
        row(`IGST ${percent(rates.igstFraction)}`, columns, 'igstAmount'),
        {
          ...row('Invoice Value / Work Done Value', columns, 'invoiceValue'),
          isTotal: true,
        },
      ],
    },
    {
      title: '2. RECOVERIES',
      rows: [
        row(
          `(A) Labour Cess @ ${percent(rates.labourCessFraction)}`,
          columns,
          'labourCessAmount',
        ),
        row(
          `(B) Advance Income Tax @ ${percent(rates.tdsFraction)}`,
          columns,
          'tdsAmount',
        ),
        row(
          `(C) GST TDS @ ${percent(rates.gstTdsFraction)}`,
          columns,
          'gstTdsAmount',
        ),
        row(
          `(D) Security Deposit/Retention Money @ ${percent(
            rates.retentionFraction,
          )}`,
          columns,
          'retentionAmount',
        ),
        row('(E) Amount Withheld', columns, 'theftWithheld'),
        // Printed only where it is non-zero: it holds a figure recorded against a client bill under
        // the subcontractor shape before the client format existed, and leaving it out then would
        // make the total below unreachable from the rows above it.
        ...(isNil(columns, 'unlistedWithheld')
          ? []
          : [
              row('(F) Other recoveries recorded', columns, 'unlistedWithheld'),
            ]),
        {
          // **Everything withheld, not block B.** The client's sheet has one recoveries total and
          // its payable is the invoice value less that figure plus anything released.
          ...row('Total Recoveries (2A+2B+2C+2D+2E)', columns, 'totalWithheld'),
          isTotal: true,
        },
        // A withholding from an earlier bill paid out on this one — screenshot 3's *Released
        // Amount*. Added back to the payable, beneath the total it is not part of.
        row('Released Amount', columns, 'releaseWithheld'),
      ],
    },
  ];
}

/** True when a row is zero in all three columns. */
function isNil(columns: Columns, key: string): boolean {
  return [columns.thisBill, columns.uptoPrevious, columns.uptoDate].every(
    (column) => Number(column[key] ?? 0) === 0,
  );
}

/** The four blocks a subcontractor's abstract has always had (023 FR-012 to FR-023). */
function subcontractorBlocks(
  abstract: Abstract,
  pkg: {
    mobilizationAdvanceTotal: Prisma.Decimal | null;
    mobilizationAdvance: Prisma.Decimal;
    performanceSecurityTotal: Prisma.Decimal | null;
    performanceSecurity: Prisma.Decimal;
  },
) {
  const { columns } = abstract;
  return [
    {
      title: 'A. WORK',
      rows: [
        row('Work Done amount', columns, 'workDone'),
        row('Release withheld amount', columns, 'releaseWithheld'),
        row('CGST', columns, 'cgstAmount'),
        row('SGST', columns, 'sgstAmount'),
        row('IGST', columns, 'igstAmount'),
        { ...row('Total Amount (A)', columns, 'workTotal'), isTotal: true },
      ],
    },
    {
      title: 'B. RECOVERIES',
      rows: [
        row('Recovery of Diesel', columns, 'recoveryDiesel'),
        row('Debit against Civil', columns, 'debitAgainstCivil'),
        row('Other Recoveries', columns, 'otherRecoveries'),
        row('Mechanical Debit — as per enclosure', columns, 'mechanicalDebit'),
        ...customRows(abstract, 'recovery'),
        {
          ...row('Total Recoveries (B)', columns, 'recoveriesTotal'),
          isTotal: true,
        },
      ],
    },
    {
      title: 'C. DEDUCTIONS',
      rows: [
        row(
          'Deduction for Mobilization Advance',
          columns,
          'mobilizationAdvance',
          {
            fullyRecovered:
              pkg.mobilizationAdvanceTotal !== null &&
              pkg.mobilizationAdvance.isZero(),
          },
        ),
        row('Retention money', columns, 'retentionAmount'),
        row(
          'Performance Security (as per contract)',
          columns,
          'performanceSecurity',
          {
            fullyRecovered:
              pkg.performanceSecurityTotal !== null &&
              pkg.performanceSecurity.isZero(),
          },
        ),
        row(
          'Amount Withheld for Theft items (Including GST)',
          columns,
          'theftWithheld',
        ),
        ...customRows(abstract, 'deduction'),
        {
          ...row('Total Deductions (C)', columns, 'deductionsTotal'),
          isTotal: true,
        },
      ],
    },
    {
      title: 'D. TAX DEDUCTIONS',
      rows: [
        row('Income Tax TDS', columns, 'tdsAmount'),
        { ...row('Total (D)', columns, 'taxDeductionsTotal'), isTotal: true },
      ],
    },
  ];
}

function row(
  label: string,
  columns: Columns,
  key: string,
  extra: { fullyRecovered?: boolean } = {},
) {
  return {
    label,
    uptoDate: columns.uptoDate[key] ?? '0',
    uptoPrevious: columns.uptoPrevious[key] ?? '0',
    thisMonth: columns.thisBill[key] ?? '0',
    ...extra,
  };
}

/** A filename the operating system will accept, from a party's name. */
function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9 .&-]/g, '').trim() || 'Bill';
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
