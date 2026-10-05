import { Injectable, NotFoundException } from '@nestjs/common';
import { BillDirection, BillPackageStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { BillWorkbookRenderer } from '../workbook/bill-workbook.renderer';
import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
} from '../workbook/bill-workbook.types';
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
  ) {}

  /** The workbook, its filename, and the gaps the caller must be told about (FR-027a). */
  async workbookFor(
    ctx: RlsContext,
    packageId: string,
  ): Promise<{ bytes: Buffer; filename: string; missingFields: string[] }> {
    const view = await this.viewFor(ctx, packageId);
    return {
      bytes: await this.renderer.render(view),
      // Named after the parties and the bill, the way the client names the file they are sent.
      filename: `${sanitise(view.header.receiver.name ?? 'Bill')} ${
        view.header.billLabel
      }.xlsx`,
      missingFields: view.header.missingFields,
    };
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
          project: { select: { name: true } },
          clientBill: { select: { billingDate: true } },
          raBill: { select: { billingDate: true } },
        },
      }),
    );
    if (!pkg) throw new NotFoundException('Bill package not found');

    const [packageView, abstract, checkList, register] = await Promise.all([
      this.packages.view(ctx, packageId),
      this.packages.abstractFor(ctx, packageId),
      this.packages.checkListFor(ctx, packageId),
      this.debits.registerFor(ctx, packageId),
    ]);

    // **One per schedule line, in schedule order, including lines with nothing claimed** (FR-030).
    // Sequential rather than parallel: a 312-line tender would otherwise open 312 transactions at
    // once, which is the shape of the problem research §8 records rather than a different one.
    const measurementSheets: WorkbookMeasurementSheet[] = [];
    for (const [index, claim] of packageView.claims.entries()) {
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
          period: `From ${row.periodFrom} to ${row.periodTo}`,
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

    const header = {
      // FR-025's two bindings, resolved **here** and not in the renderer. By the time the sheet
      // builders see it, the direction has already decided who is in which slot — which is what
      // makes it one renderer with two bindings rather than two renderers.
      issuer: {
        name: pkg.issuerName,
        gstin: pkg.issuerGstin,
        pan: pkg.issuerPan,
        state: pkg.issuerState,
        address: pkg.issuerAddress,
        code: null,
      },
      receiver: {
        name: pkg.receiverName,
        gstin: pkg.receiverGstin,
        pan: pkg.receiverPan,
        state: pkg.receiverState,
        address: pkg.receiverAddress,
        code: pkg.receiverCode,
      },
      projectName: pkg.project.name,
      natureOfWork: pkg.natureOfWork,
      location: pkg.location,
      externalWorkOrderNo: pkg.externalWorkOrderNo,
      externalBillNo: pkg.externalBillNo,
      billLabel: packageLabel(pkg.sequenceNo),
      periodFrom: iso(pkg.periodFrom),
      periodTo: iso(pkg.periodTo),
      billDate: iso(
        pkg.clientBill?.billingDate ?? pkg.raBill?.billingDate ?? pkg.periodTo,
      ),
      missingFields: pkg.missingHeaderFields,
    };

    return {
      header,
      checkList: {
        rows: checkList.items.map((item) => ({
          position: item.position,
          text: item.text,
          answer: item.answer,
        })),
        footer: checkList.footer,
        signatories: checkList.signatories,
      },
      abstract: {
        blocks: [
          {
            title: 'A. WORK',
            rows: [
              row('Work Done amount', abstract.columns, 'workDone'),
              row(
                'Release withheld amount',
                abstract.columns,
                'releaseWithheld',
              ),
              row('CGST', abstract.columns, 'cgstAmount'),
              row('SGST', abstract.columns, 'sgstAmount'),
              row('IGST', abstract.columns, 'igstAmount'),
              {
                ...row('Total Amount (A)', abstract.columns, 'workTotal'),
                isTotal: true,
              },
            ],
          },
          {
            title: 'B. RECOVERIES',
            rows: [
              row('Recovery of Diesel', abstract.columns, 'recoveryDiesel'),
              row('Debit against Civil', abstract.columns, 'debitAgainstCivil'),
              row('Other Recoveries', abstract.columns, 'otherRecoveries'),
              row(
                'Mechanical Debit — as per enclosure',
                abstract.columns,
                'mechanicalDebit',
              ),
              {
                ...row(
                  'Total Recoveries (B)',
                  abstract.columns,
                  'recoveriesTotal',
                ),
                isTotal: true,
              },
            ],
          },
          {
            title: 'C. DEDUCTIONS',
            rows: [
              row(
                'Deduction for Mobilization Advance',
                abstract.columns,
                'mobilizationAdvance',
                {
                  fullyRecovered:
                    pkg.mobilizationAdvanceTotal !== null &&
                    pkg.mobilizationAdvance.isZero(),
                },
              ),
              row('Retention money', abstract.columns, 'retentionAmount'),
              row(
                'Performance Security (as per contract)',
                abstract.columns,
                'performanceSecurity',
                {
                  fullyRecovered:
                    pkg.performanceSecurityTotal !== null &&
                    pkg.performanceSecurity.isZero(),
                },
              ),
              row(
                'Amount Withheld for Theft items (Including GST)',
                abstract.columns,
                'theftWithheld',
              ),
              {
                ...row(
                  'Total Deductions (C)',
                  abstract.columns,
                  'deductionsTotal',
                ),
                isTotal: true,
              },
            ],
          },
          {
            title: 'D. TAX DEDUCTIONS',
            rows: [
              row('Income Tax TDS', abstract.columns, 'tdsAmount'),
              {
                ...row('Total (D)', abstract.columns, 'taxDeductionsTotal'),
                isTotal: true,
              },
            ],
          },
        ],
        payable: row('AMOUNT PAYABLE', abstract.columns, 'payable'),
        netPayable: row('NET PAYBLE AMOUNT', abstract.columns, 'payable'),
        taxBasis: abstract.taxBasis,
        taxBasisSource: abstract.taxBasisSource,
      },
      schedule: {
        lines: packageView.claims.map((claim, index) => ({
          srNo: index + 1,
          boqNo: claim.boqNo,
          description: claim.description,
          unit: claim.unit,
          scopeQty: claim.remainingQty,
          rate: claim.rate,
          scopeAmount: claim.amount,
          balanceQty: claim.remainingQty,
          qtyUptoDate:
            measurementSheets[index]?.footer.uptoDateQty ?? claim.claimedQty,
          qtyUptoPrevious:
            measurementSheets[index]?.footer.uptoPreviousQty ?? '0.000',
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
