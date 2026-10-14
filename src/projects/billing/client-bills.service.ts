import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillPackageStatus, ClientBillStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { BILLING_ERRORS } from './billing-error-codes';
import { assertCertifiedLines, certifiedAmountOf } from './certified-lines';
import {
  billTotals,
  lineTotals,
  money,
  retentionOn,
  unitRate,
} from './bill-totals';
import { nextClientBillNumber, packageLabel } from './bill-number';
import { balanceColumn } from './package/bill-abstract';
import { compareBoqNo, sortByBoqNo } from '../boq/boq-order';
import {
  contentDispositionFor,
  detectContentType,
} from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';

/** What a certification carries (2026-10-11). */
export interface CertifyBillInput {
  /** Ignored when `lines` are given — the lines are then the single answer. */
  certifiedAmount?: number;
  lines?: { lineId: string; certifiedQty: number }[];
  certificate?: { data: Buffer; fileName: string };
}

/** A line as the caller composes it. */
export interface ComposeBillLineInput {
  boqTaskItemId: string;
  quantity: number;
  overScopeReason?: string | null;
}

export interface ComposeBillInput {
  projectId: string;
  /**
   * Omit to have it allocated: `RA-01`, `RA-02`… in sequence on this project (027).
   *
   * Optional rather than removed, for an importer bringing historical bills across — those numbers
   * already exist on paper. No screen sends it.
   */
  billNumber?: string;
  description?: string | null;
  billingDate: string;
  lines: ComposeBillLineInput[];
  /** As a fraction. Withheld by the client, and **not** a project cost. */
  retentionPercent?: number;
}

/** One line of a bill as read back, with everything the sheet needs beside it. */
export interface ClientBillLineView {
  id: string;
  boqTaskItemId: string;
  boqNo: string;
  taskName: string;
  /**
   * The heading this line sits under, and half of what it says it is.
   *
   * A tender schedule carries the work in the heading and the qualifier in the child: item 12 is
   * *"centering and shuttering … and removal of formwork"* and 12.01 is only *"suspended floors,
   * roofs, landings …"*. Read on its own, that line names a place and no work — a client cannot tell
   * whether the ₹340 a square metre was for shuttering it, concreting it or plastering it.
   *
   * Carried per line rather than returned as a tree because a bill measures an arbitrary handful of
   * lines out of two hundred, and a tree would mean shipping headings with nothing under them.
   */
  groupId: string;
  groupName: string;
  unit: string;
  scopeQty: number;
  quantity: number;
  /** The schedule's own rate, frozen at composition. What the tender document prints. */
  rate: number;
  /**
   * That rate after the project's quoted percentage — **the rate the amount was computed at**
   * (2026-10-13).
   *
   * Reported: a line reading 37.25 Cum at ₹178.00 for ₹5,915.07, where 37.25 × 178 is ₹6,630.50.
   * Both figures were right and the column between them was missing: the project is quoted 10.79%
   * below, `lineTotals` applies that per line, and the rate on screen was the one before it. A
   * document whose own columns do not multiply out is a document the reader stops trusting, and
   * they are right to.
   *
   * Carried rather than left to the reader to derive, for the same reason the rate itself is
   * frozen: the project's percentage can be corrected, and this is the one the bill was priced at.
   */
  quotedRate: number;
  /** `quantity × quotedRate`. */
  amount: number;
  /** Including this bill. */
  cumulativeQty: number;
  remainingQty: number;
  /**
   * What the client certified on this line, or null where they did not say (2026-10-11).
   *
   * Null and zero are different answers: null is "not certified line by line", zero is
   * "certified at nothing", and only the second returns the quantity to the schedule.
   */
  certifiedQty: number | null;
  exceedsScope: boolean;
  overScopeReason: string | null;
  isVariation: boolean;
  variationRef: string | null;
}

/** One BOQ line, priced and positioned, ready to be measured on a bill. */
export interface BillableBoqItem {
  id: string;
  boqNo: string;
  taskName: string;
  unit: string;
  scopeQty: number;
  rate: number;
  /**
   * True when the rate is still 0 — "nobody has priced this", not "this is free".
   *
   * Said here so the sheet can mark the line before somebody measures it, rather than letting them
   * fill a column and meet `BOQ_RATE_MISSING` at submit.
   */
  unpriced: boolean;
  /** Measured on every bill that has left draft. */
  previouslyBilledQty: number;
  /** Scope less previously billed. Negative where the line is already over-measured. */
  remainingQty: number;
  isVariation: boolean;
  variationRef: string | null;
}

/** A BOQ heading and the lines under it. */
export interface BillableBoqGroup {
  id: string;
  boqNo: string;
  name: string;
  items: BillableBoqItem[];
}

/**
 * A project's BOQ as the billing sheet needs it (018 FR-001).
 *
 * **Two totals, not one** (web T058). The estimated total is the schedule at its own rates; the
 * quoted total is that figure with the bidder's percentage applied **once, to the total**. The
 * client's own file carries both — ₹2,99,61,506.78 becoming ₹3,06,98,559.85 at 2.46% excess — and
 * that is the figure the tender document states, so it is the one this summary must reproduce.
 *
 * **A bill applies the same percentage per line instead, and that is also right.** `lineTotals` in
 * `bill-totals.ts` does so because the total printed on a document a client reads must equal the
 * column above it. The two differ by rounding — at most half a paisa a line — and
 * `test/client-bills.e2e-spec.ts` measures that divergence rather than asserting it away. An earlier
 * version of this comment and of `lineTotals`' each described the other's choice as the wrong one;
 * they serve different documents.
 */
export interface BillableBoq {
  projectId: string;
  /** The bidder's quoted excess as a fraction — `0.0246` is 2.46%. */
  quotedPercentage: number;
  estimatedTotal: number;
  quotedTotal: number;
  groups: BillableBoqGroup[];
  /** Lines with no rate yet. A bill cannot be composed from these (`BOQ_RATE_MISSING`). */
  unpricedCount: number;
}

/**
 * Every figure between the work done and the payable, for a bill settled through a package.
 *
 * ## Why this exists
 *
 * Reported 2026-10-12: a bill showing Gross ₹50,837.21, Retention ₹2,033.49 and Net ₹56,937.68.
 * All three were correct and the three together are unreadable — net is **larger** than gross, and
 * subtracting as the layout invites gives ₹48,803.72, a figure that appears nowhere on the bill.
 *
 * The missing rows were the tax added and the tax deducted: ₹4,575.35 CGST, ₹4,575.35 SGST and
 * ₹1,016.74 TDS. `netAmount` on a packaged bill is the abstract's **payable** — work plus tax, less
 * recoveries, deductions and TDS — not gross less retention.
 *
 * ## In paise, unlike the printed abstract
 *
 * `GET /bill-packages/:id/abstract` already serves these, rounded to whole rupees because that is
 * the client's own document format. Reading it here would put ₹56,938 beside the ₹56,937.68 the
 * same screen shows for the same bill, which is a worse answer than none. So the figures are taken
 * from the stored columns and totalled by `balanceColumn` — the one function that forms a block
 * total — rather than re-added on the way out.
 */
export interface BillSettlementView {
  /** The work at the frozen rates, before any tax. The same figure as `grossAmount`. */
  workDone: number;
  releaseWithheld: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** Block A — work done, release and the taxes added. */
  workTotal: number;
  recoveryDiesel: number;
  debitAgainstCivil: number;
  otherRecoveries: number;
  mechanicalDebit: number;
  /** Block B. */
  recoveriesTotal: number;
  mobilizationAdvance: number;
  retentionAmount: number;
  performanceSecurity: number;
  theftWithheld: number;
  /** Block C. */
  deductionsTotal: number;
  /** Block D — tax deducted at source. */
  tdsAmount: number;
  /** A − B − C − D. The same figure as `netAmount`, and the reason it is not gross less retention. */
  payable: number;
}

export interface ClientBillView {
  /** The bill package it is approved, issued and certified through. Null for an old sheet bill. */
  package?: { id: string; label: string; status: BillPackageStatus } | null;
  id: string;
  projectId: string;
  billNumber: string;
  description: string | null;
  billingDate: Date;
  status: ClientBillStatus;
  quotedPercentage: number;
  /**
   * These lines at the **schedule's** rates, before the quoted percentage (2026-10-13).
   *
   * With `quoteAdjustment` it is the two rows above the work done: what the schedule says the work
   * comes to, what the quote takes off or adds, and the gross. The client's own abstract prints the
   * same three — `TOTAL`, `Total Amount after 14.92% below`, `Total Payable Amount` — because a
   * reader checking a bill against the tender starts from the schedule figure and needs to see
   * where it went.
   *
   * Formed per line and then summed, exactly as the gross is, so that
   * `boqGrossAmount + quoteAdjustment === grossAmount` holds to the paisa rather than nearly.
   */
  boqGrossAmount: number;
  /**
   * `grossAmount − boqGrossAmount`. **Negative where the quote is below the schedule**, which is
   * the common case and the one a reader must not have to infer from two totals.
   */
  quoteAdjustment: number;
  grossAmount: number;
  retentionAmount: number;
  /**
   * **Null while the figures are not yet frozen** — a bill composed through a bill package whose
   * package is still a draft. See `RaBillView.netPayable`, which carries the same rule for the
   * other direction.
   */
  netAmount: number | null;
  certifiedAmount: number | null;
  certifiedAt: Date | null;
  /** The client's certification document, where one was filed (2026-10-11). */
  certificate: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  } | null;
  /**
   * The shortfall between billed and certified, where there is one (FR-005).
   *
   * Derived rather than stored, and **reported rather than resolved**: a client certifying less than
   * was billed is the single most consequential thing on this screen, and it must not be reachable
   * only by subtracting two columns somebody might not notice are different.
   */
  certificationVariance: number | null;
  submittedAt: Date | null;
  /**
   * How `netAmount` was arrived at, where it came from an issued package (2026-10-12).
   *
   * Null for a bill composed on the bill sheet, which carries no tax at all — there `netAmount`
   * really is gross less retention, and three rows say everything there is to say. Null too while a
   * package is still a draft, matching `netAmount`, which is also null then: nothing is frozen yet
   * and a breakdown of figures that are still moving is a breakdown somebody would quote.
   */
  settlement: BillSettlementView | null;
  lines: ClientBillLineView[];
  /** True when any line is past its BOQ scope. */
  exceedsScope: boolean;
}

/** The stored package columns the payable was settled from, as `view` selects them. */
type SettlementColumns = Omit<
  Parameters<typeof balanceColumn>[0],
  'workDone' | 'releaseWithheld'
> & {
  status: BillPackageStatus;
  workDone: Prisma.Decimal;
  releaseWithheld: Prisma.Decimal;
};

/** Whether a package's figures are frozen — issued, or certified after issue. */
function isFrozen(status: BillPackageStatus): boolean {
  return (
    status === BillPackageStatus.issued ||
    status === BillPackageStatus.certified
  );
}

/**
 * The abstract column behind a bill's payable, in paise.
 *
 * Null for a bill with no package, and null while its package is a draft — the same rule
 * `netAmount` follows above, because the two must never disagree about whether the figures are
 * frozen. Totalled by `balanceColumn` rather than summed here: the printed abstract and this screen
 * then cannot differ by a rounding step.
 */
function settlementOf(
  columns: SettlementColumns | null | undefined,
): BillSettlementView | null {
  if (!columns || !isFrozen(columns.status)) return null;
  const column = balanceColumn(columns);
  return {
    workDone: column.workDone.toNumber(),
    releaseWithheld: column.releaseWithheld.toNumber(),
    cgstAmount: column.cgstAmount.toNumber(),
    sgstAmount: column.sgstAmount.toNumber(),
    igstAmount: column.igstAmount.toNumber(),
    workTotal: column.workTotal.toNumber(),
    recoveryDiesel: column.recoveryDiesel.toNumber(),
    debitAgainstCivil: column.debitAgainstCivil.toNumber(),
    otherRecoveries: column.otherRecoveries.toNumber(),
    mechanicalDebit: column.mechanicalDebit.toNumber(),
    recoveriesTotal: column.recoveriesTotal.toNumber(),
    mobilizationAdvance: column.mobilizationAdvance.toNumber(),
    retentionAmount: column.retentionAmount.toNumber(),
    performanceSecurity: column.performanceSecurity.toNumber(),
    theftWithheld: column.theftWithheld.toNumber(),
    deductionsTotal: column.deductionsTotal.toNumber(),
    tdsAmount: column.tdsAmount.toNumber(),
    payable: column.payable.toNumber(),
  };
}

/**
 * Bills raised to the client, measured against the project's BOQ (018 US1) — `bugs.md` item 11.
 *
 * ## What was wrong before
 *
 * `RABill` held a single `amount`. Note 12's complaint is exactly that: a bill that is one figure
 * cannot be reconciled against a BOQ, so "support reconciliation against BOQ work order amounts and
 * quantities" was unanswerable — not partly answered, unanswerable.
 *
 * ## The rate is frozen onto the line, and that is the whole feature
 *
 * `compose()` reads the BOQ rate **once** and writes it to the line. Revise the BOQ afterwards and a
 * submitted bill does not move. A bill is a document that was sent; a rate table is a current opinion,
 * and rendering the first from the second makes every historical bill a lie that changes shape each
 * time somebody corrects a rate.
 *
 * The **quoted percentage** is frozen the same way, for the same reason — and it exists at all because
 * `docs/BOQ_794578.xls` is a percentage BoQ: the client quotes one percentage against the schedule,
 * and a bill priced from line rates alone is short by it on every line.
 *
 * ## Cumulative quantity is an aggregate, never a counter
 *
 * How much of a BOQ line has been billed to date is summed from the lines each time (research §3). A
 * stored counter is a second copy of a derivable fact, and the two diverge the first time a bill is
 * deleted or two are composed concurrently — at which point the over-scope check is wrong in whichever
 * direction nobody notices.
 */
@Injectable()
export class ClientBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Prices a draft bill from the BOQ and freezes what it read.
   *
   * Over-scope is **flagged, not refused** here (FR-003). The refusal is at submit, and only for a
   * flagged line with no reason — because a measurement that cannot be entered is a measurement that
   * goes in a notebook instead.
   */
  async compose(
    ctx: RlsContext,
    companyId: string,
    input: ComposeBillInput,
  ): Promise<ClientBillView> {
    if (input.lines.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.noLines,
        message: 'A bill needs at least one measured line.',
      });
    }

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId },
        select: { id: true, quotedPercentage: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      const items = await tx.bOQTaskItem.findMany({
        where: {
          id: { in: input.lines.map((line) => line.boqTaskItemId) },
          group: { projectId: input.projectId },
        },
      });
      if (items.length === 0) {
        // Distinct from "this line is not on the BOQ": the project has no priced scope at all, and the
        // remedy is to enter a BOQ rather than to correct a line.
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.boqRequired,
          message:
            'This project has no BOQ lines to bill against. Enter the BOQ first — a bill that ' +
            'references nothing cannot be reconciled against anything.',
        });
      }
      const itemById = new Map(items.map((item) => [item.id, item]));

      // 008 US4 AC6. The schedule endpoint never offers these, so reaching here means a line id was
      // supplied directly — and the consequence is a client billed at the company's own costing.
      // Named, like every other refusal on this path: "this line cannot be billed" without saying
      // which sends somebody down the schedule looking for it.
      const estimates = items.filter((item) => item.isEstimate);
      if (estimates.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.lineIsEstimate,
          message: `These lines belong to this project's internal estimate and cannot be billed to the client: ${estimates
            .map((item) => item.boqNo)
            .join(
              ', ',
            )}. An estimate is costed at your own rates, not at the rates the client agreed.`,
          boqNumbers: estimates.map((item) => item.boqNo),
        });
      }

      const unpriced = items.filter((item) => item.rate.toNumber() === 0);
      if (unpriced.length > 0) {
        // Refused rather than billed at zero. The column defaults to 0 because the table was already
        // populated, so 0 means "nobody has priced this" far more often than "free" — and a bill
        // carrying a zero line is quietly short while looking finished.
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.rateMissing,
          message: `These BOQ lines have no rate and cannot be billed: ${unpriced
            .map((item) => item.boqNo)
            .join(
              ', ',
            )}. A zero rate is almost always an unpriced line rather than free work.`,
          boqNumbers: unpriced.map((item) => item.boqNo),
        });
      }

      const quotedPercentage = project.quotedPercentage.toNumber();
      const previously = await this.previouslyBilled(
        tx,
        input.lines.map((line) => line.boqTaskItemId),
      );

      const priced = input.lines.map((line) => {
        const item = itemById.get(line.boqTaskItemId);
        if (!item) {
          throw new BadRequestException(
            `BOQ line ${line.boqTaskItemId} is not on this project.`,
          );
        }
        const totals = lineTotals(
          {
            quantity: line.quantity,
            rate: item.rate.toNumber(),
            previouslyBilledQty: previously.get(line.boqTaskItemId) ?? 0,
            scopeQty: item.scopeQty.toNumber(),
          },
          quotedPercentage,
        );
        return { line, item, totals };
      });

      const gross = billTotals(priced.map((p) => p.totals)).gross;
      const retention = retentionOn(gross, input.retentionPercent ?? 0);
      const totals = billTotals(
        priced.map((p) => p.totals),
        {
          retention,
        },
      );

      // Allocated rather than typed, and inside the transaction so a failed compose does not
      // consume a number. See `nextClientBillNumber` for why it counts bills rather than a counter.
      const billNumber =
        input.billNumber?.trim() ||
        (await nextClientBillNumber(tx, input.projectId));

      try {
        return await tx.clientBill.create({
          data: {
            companyId,
            projectId: input.projectId,
            billNumber,
            description: input.description ?? null,
            billingDate: new Date(input.billingDate),
            // Frozen, like the rates. The project's percentage can be corrected; a bill that was
            // priced at the old one keeps it.
            quotedPercentage,
            grossAmount: totals.gross,
            retentionAmount: totals.retention,
            netAmount: totals.net,
            status: ClientBillStatus.draft,
            lines: {
              create: priced.map(({ line, item, totals: lineAmount }) => ({
                companyId,
                boqTaskItemId: item.id,
                quantity: line.quantity,
                // The frozen rate. Read once, here.
                rate: item.rate,
                amount: lineAmount.amount,
                exceedsScope: lineAmount.exceedsScope,
                overScopeReason: line.overScopeReason ?? null,
              })),
            },
          },
          include: { lines: true },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          throw new ConflictException({
            statusCode: 409,
            code: BILLING_ERRORS.duplicateNumber,
            message:
              `This project already has a bill numbered ${billNumber}. It was raised while ` +
              'this one was being composed — compose it again and it will take the next number.',
          });
        }
        throw error;
      }
    });

    return this.view(ctx, created.id);
  }

  /**
   * Sends the bill. Refuses a flagged line with no reason (FR-003).
   *
   * **Names the lines.** "Some lines exceed scope" sends somebody scanning three hundred rows for the
   * ones that do.
   */
  async submit(ctx: RlsContext, billId: string): Promise<ClientBillView> {
    await this.refuseIfPackaged(ctx, billId, 'sent for approval and issued');
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.clientBill.findFirst({
        where: { id: billId },
        include: { lines: { include: { boqTaskItem: true } } },
      });
      if (!bill) throw new NotFoundException('Bill not found');

      if (bill.status !== ClientBillStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.notDraft,
          message: `This bill is ${bill.status} and can no longer be submitted.`,
        });
      }
      if (bill.lines.length === 0) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.noLines,
          message:
            'This bill has no lines. Submitting it would send the client a document saying nothing.',
        });
      }

      const unjustified = bill.lines.filter(
        (line) => line.exceedsScope && !line.overScopeReason?.trim(),
      );
      if (unjustified.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.overScopeReasonRequired,
          message:
            `These lines measure past their BOQ scope and need a reason before the bill can go ` +
            `out: ${unjustified
              .map((line) => line.boqTaskItem.boqNo)
              .join(', ')}.`,
          boqNumbers: unjustified.map((line) => line.boqTaskItem.boqNo),
        });
      }

      await tx.clientBill.update({
        where: { id: billId },
        data: {
          status: ClientBillStatus.submitted,
          submittedAt: new Date(),
        },
      });
    });

    return this.view(ctx, billId);
  }

  /**
   * Records what the client certified (FR-005).
   *
   * **Both figures are kept.** The billed amount is not overwritten, and cumulative billed quantity is
   * untouched — a shortfall is a dispute to pursue, not a correction to absorb, and a system that
   * silently reduced what was billed would lose the only record that there was one.
   */
  async certify(
    ctx: RlsContext,
    billId: string,
    input: CertifyBillInput,
  ): Promise<ClientBillView> {
    await this.refuseIfPackaged(ctx, billId, 'certified');
    // Stored before the transaction, like every other upload in this product: a blob
    // written inside one is orphaned by a rollback, and the reference below is what
    // makes it findable.
    const certificate = input.certificate
      ? await this.storeCertificate(ctx, billId, input.certificate)
      : null;

    await withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.clientBill.findFirst({
        where: { id: billId },
        include: { lines: true },
      });
      if (!bill) throw new NotFoundException('Bill not found');
      if (bill.status === ClientBillStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.notSubmitted,
          message:
            'This bill has not been submitted, so there is nothing for the client to have certified.',
        });
      }

      const certifiedLines = input.lines ?? [];
      // The checks and the pricing are shared with the bill package's Certify (2026-10-15) —
      // see `certified-lines.ts`.
      const billLines = bill.lines.map((line) => ({
        id: line.id,
        quantity: line.quantity.toNumber(),
        rate: line.rate.toNumber(),
      }));
      assertCertifiedLines(billLines, certifiedLines);

      // **Derived from the lines when there are lines**, never taken alongside them. A
      // certified total and a set of certified lines that disagree is two answers to one
      // question, and the lines are the ones the outstanding BOQ is counted from.
      const certifiedAmount = certifiedLines.length
        ? certifiedAmountOf(
            billLines,
            certifiedLines,
            bill.quotedPercentage.toNumber(),
          )
        : input.certifiedAmount ?? 0;

      if (certifiedAmount > bill.grossAmount.toNumber()) {
        // A client cannot certify work nobody claimed. More likely a typo than a windfall, and the
        // typo is the one worth catching.
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.certifiedExceedsBilled,
          message:
            `Certified (${certifiedAmount}) is more than billed ` +
            `(${bill.grossAmount.toNumber()}). Raise a further bill for the extra work rather than ` +
            `certifying above this one.`,
        });
      }

      for (const line of certifiedLines) {
        await tx.clientBillLine.update({
          where: { id: line.lineId },
          data: { certifiedQty: line.certifiedQty },
        });
      }

      await tx.clientBill.update({
        where: { id: billId },
        data: {
          status: ClientBillStatus.certified,
          certifiedAmount,
          certifiedAt: new Date(),
          ...(certificate
            ? {
                certificateFileRef: certificate.fileRef,
                certificateFileName: certificate.fileName,
                certificateMimeType: certificate.mimeType,
                certificateSizeBytes: certificate.sizeBytes,
              }
            : {}),
        },
      });
    });

    return this.view(ctx, billId);
  }

  /** The client's certification document, through `StorageService` like every other upload. */
  /**
   * Files the client's certification document against a bill certified on its bill package
   * (2026-10-14) — the bill package's Certify carries it, so the certificate is kept where it
   * always was and the existing download serves it.
   */
  async attachCertificate(
    ctx: RlsContext,
    billId: string,
    file: { data: Buffer; fileName: string },
  ): Promise<void> {
    const certificate = await this.storeCertificate(ctx, billId, file);
    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.clientBill.update({
        where: { id: billId },
        data: {
          certificateFileRef: certificate.fileRef,
          certificateFileName: certificate.fileName,
          certificateMimeType: certificate.mimeType,
          certificateSizeBytes: certificate.sizeBytes,
        },
      }),
    );
  }

  /**
   * Refuses the old submit and certify on a bill raised through a bill package (2026-10-14).
   * The package is where it is approved, issued and certified; a second route here started a
   * second, unrelated decision on the same bill.
   */
  private async refuseIfPackaged(
    ctx: RlsContext,
    billId: string,
    action: string,
  ): Promise<void> {
    const pkg = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackage.findFirst({
        where: { clientBillId: billId },
        select: { sequenceNo: true },
      }),
    );
    if (pkg) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_ERRORS.raisedThroughPackage,
        message:
          `This bill is ${packageLabel(
            pkg.sequenceNo,
          )} on the RA bills page, which is where it ` +
          `is ${action}. Open it there.`,
      });
    }
  }

  private async storeCertificate(
    ctx: RlsContext,
    billId: string,
    file: { data: Buffer; fileName: string },
  ): Promise<{
    fileRef: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const bill = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.clientBill.findFirst({
        where: { id: billId },
        select: { companyId: true },
      }),
    );
    if (!bill) throw new NotFoundException('Bill not found');

    // From the bytes, never the client's claim — the rule 022 established and 017
    // before it. A certificate served as octet-stream downloads instead of opening.
    const mimeType =
      detectContentType(file.data)?.contentType ?? 'application/octet-stream';
    const fileRef = await this.storage.put(
      `client-bill-certificates/${bill.companyId}`,
      file.data,
      mimeType,
    );
    return {
      fileRef,
      fileName: file.fileName,
      mimeType,
      sizeBytes: file.data.length,
    };
  }

  /** Every bill on a project, newest first. */
  async listForProject(
    ctx: RlsContext,
    projectId: string,
  ): Promise<ClientBillView[]> {
    const bills = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.clientBill.findMany({
        where: { projectId },
        orderBy: { billingDate: 'desc' },
        select: { id: true },
      }),
    );
    // Sequential rather than `Promise.all`: each `view` opens its own RLS transaction, and a hundred
    // concurrent ones would exhaust the pool on a project with a long billing history.
    const out: ClientBillView[] = [];
    for (const bill of bills) out.push(await this.view(ctx, bill.id));
    return out;
  }

  /**
   * The project's BOQ, priced and positioned, for the billing sheet (FR-001).
   *
   * Headings and their lines, because a BOQ is **two levels** and always was: `BOQTaskGroup` is the
   * heading ("12 — Earthwork") and `BOQTaskItem` is the numbered sub-item ("12.01"). The client's own
   * file is 83 headings across 312 rows, and a flat list cannot represent it. A heading carries no
   * quantity and no rate here, so a sheet cannot render it as a measured line of zero.
   *
   * `previouslyBilledQty` comes from the same aggregate composition uses, so the remaining quantity a
   * reader sees before measuring is the one the server will apply.
   */
  async billableBoq(ctx: RlsContext, projectId: string): Promise<BillableBoq> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, quotedPercentage: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      // **Excludes the estimate variant** (008 US4 AC6). A project may hold its own costing beside
      // the client's tender, and offering both on one billing sheet would present the company's
      // internal rates as billable scope — doubled quantities at the wrong prices, on a document
      // that looks correct.
      const groups = await tx.bOQTaskGroup.findMany({
        where: { projectId, isEstimate: false },
        include: {
          items: { where: { isEstimate: false }, orderBy: { boqNo: 'asc' } },
        },
        orderBy: { boqNo: 'asc' },
      });

      // Text order puts 10 before 2 — see `boq-order.ts`.
      sortByBoqNo(groups);
      for (const group of groups) sortByBoqNo(group.items);

      const allItemIds = groups.flatMap((group) =>
        group.items.map((item) => item.id),
      );
      const previously = await this.previouslyBilled(tx, allItemIds);

      let estimatedTotal = 0;
      let unpricedCount = 0;
      const shaped: BillableBoqGroup[] = groups.map((group) => ({
        id: group.id,
        boqNo: group.boqNo,
        name: group.name,
        items: group.items.map((item) => {
          const scopeQty = item.scopeQty.toNumber();
          const rate = item.rate.toNumber();
          const billed = previously.get(item.id) ?? 0;
          if (rate === 0) unpricedCount += 1;
          estimatedTotal += scopeQty * rate;
          return {
            id: item.id,
            boqNo: item.boqNo,
            taskName: item.taskName,
            unit: item.unit,
            scopeQty,
            rate,
            unpriced: rate === 0,
            previouslyBilledQty: billed,
            // Negative where the line is already over-measured. Reported, not clamped — the same
            // decision `bill-totals.ts` makes, for the same reason.
            remainingQty: Math.round((scopeQty - billed) * 1000) / 1000,
            isVariation: item.isVariation,
            variationRef: item.variationRef,
          };
        }),
      }));

      const quotedPercentage = project.quotedPercentage.toNumber();
      return {
        projectId,
        quotedPercentage,
        estimatedTotal: money(estimatedTotal),
        // The percentage applied **once, to the total**. Per line it rounds differently and the
        // grand total stops matching the tender document it came from.
        quotedTotal: money(estimatedTotal * (1 + quotedPercentage)),
        groups: shaped,
        unpricedCount,
      };
    });
  }

  /** One bill, with its lines and their cumulative position against the BOQ. */
  async view(ctx: RlsContext, billId: string): Promise<ClientBillView> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.clientBill.findFirst({
        where: { id: billId },
        include: {
          lines: {
            include: {
              boqTaskItem: {
                include: { group: { select: { id: true, name: true } } },
              },
            },
            orderBy: { boqTaskItem: { boqNo: 'asc' } },
          },
          // The status, and the columns the payable was settled from (2026-10-12) — so the screen
          // can show what stands between gross and net instead of three rows that will not
          // subtract. See `BillSettlementView`.
          package: {
            select: {
              id: true,
              sequenceNo: true,
              status: true,
              workDone: true,
              workDeduction: true,
              releaseWithheld: true,
              cgstAmount: true,
              sgstAmount: true,
              igstAmount: true,
              labourCessAmount: true,
              gstTdsAmount: true,
              recoveryDiesel: true,
              debitAgainstCivil: true,
              otherRecoveries: true,
              mechanicalDebit: true,
              mobilizationAdvance: true,
              retentionAmount: true,
              performanceSecurity: true,
              theftWithheld: true,
              customRecoveries: true,
              customDeductions: true,
              tdsAmount: true,
            },
          },
        },
      });
      if (!bill) throw new NotFoundException('Bill not found');

      // Through the schedule line each one measures. The `orderBy` above is the database's text
      // order, which puts 10 before 2 — see `boq-order.ts`. This is the read every screen uses,
      // `listForProject` included, so it is the one place the order has to be right.
      bill.lines.sort((a, b) =>
        compareBoqNo(a.boqTaskItem.boqNo, b.boqTaskItem.boqNo),
      );

      // Cumulative **up to and including** this bill, so a historical bill reads as it did when it was
      // raised rather than showing today's running total against a figure from last quarter.
      const cumulative = await this.previouslyBilled(
        tx,
        bill.lines.map((line) => line.boqTaskItemId),
        { upToBillDate: bill.billingDate, includeBillId: bill.id },
      );

      // Frozen onto the bill at composition, so a correction to the project's percentage does not
      // restate a bill already raised.
      const quoted = bill.quotedPercentage.toNumber();

      const lines: ClientBillLineView[] = bill.lines.map((line) => {
        const scopeQty = line.boqTaskItem.scopeQty.toNumber();
        const cumulativeQty = cumulative.get(line.boqTaskItemId) ?? 0;
        return {
          id: line.id,
          boqTaskItemId: line.boqTaskItemId,
          boqNo: line.boqTaskItem.boqNo,
          taskName: line.boqTaskItem.taskName,
          groupId: line.boqTaskItem.group.id,
          groupName: line.boqTaskItem.group.name,
          unit: line.boqTaskItem.unit,
          scopeQty,
          quantity: line.quantity.toNumber(),
          rate: line.rate.toNumber(),
          quotedRate: unitRate(line.rate.toNumber() * (1 + quoted)),
          amount: line.amount.toNumber(),
          cumulativeQty,
          remainingQty: Math.round((scopeQty - cumulativeQty) * 1000) / 1000,
          certifiedQty: line.certifiedQty?.toNumber() ?? null,
          exceedsScope: line.exceedsScope,
          overScopeReason: line.overScopeReason,
          isVariation: line.boqTaskItem.isVariation,
          variationRef: line.boqTaskItem.variationRef,
        };
      });

      // The same lines at the schedule's own rates. Rounded per line and then summed, which is how
      // the gross was formed — sum first and the two totals disagree by a paisa or two, on the one
      // screen whose whole purpose is that figures reconcile.
      const boqGrossAmount = money(
        bill.lines.reduce(
          (sum, line) =>
            sum + money(line.quantity.toNumber() * line.rate.toNumber()),
          0,
        ),
      );

      const certified = bill.certifiedAmount?.toNumber() ?? null;
      return {
        id: bill.id,
        projectId: bill.projectId,
        billNumber: bill.billNumber,
        description: bill.description,
        billingDate: bill.billingDate,
        status: bill.status,
        quotedPercentage: quoted,
        boqGrossAmount,
        // Derived from the stored gross rather than re-applying the percentage: the gross is what
        // the bill was raised at, and a second multiplication is a second opinion about it.
        quoteAdjustment: money(bill.grossAmount.toNumber() - boqGrossAmount),
        grossAmount: bill.grossAmount.toNumber(),
        retentionAmount: bill.retentionAmount.toNumber(),
        // No net until the package that decides the recoveries, deductions and tax is issued.
        netAmount:
          bill.package && !isFrozen(bill.package.status)
            ? null
            : bill.netAmount.toNumber(),
        settlement: settlementOf(bill.package),
        // Where this bill is approved, issued and certified (2026-10-14) — the tab links there.
        package: bill.package
          ? {
              id: bill.package.id,
              label: packageLabel(bill.package.sequenceNo),
              status: bill.package.status,
            }
          : null,
        certifiedAmount: certified,
        certifiedAt: bill.certifiedAt,
        /**
         * The client's own certification document, where one was filed (2026-10-11).
         *
         * The name and the type, never the storage reference — a reference on the wire
         * is a handle to somebody else's bytes, and the download route takes the bill's
         * id rather than the ref for exactly that reason.
         */
        certificate: bill.certificateFileRef
          ? {
              fileName: bill.certificateFileName ?? 'certificate',
              mimeType: bill.certificateMimeType ?? 'application/octet-stream',
              sizeBytes: bill.certificateSizeBytes ?? 0,
            }
          : null,
        certificationVariance:
          certified === null
            ? null
            : Math.round((bill.grossAmount.toNumber() - certified) * 100) / 100,
        submittedAt: bill.submittedAt,
        lines,
        exceedsScope: lines.some((line) => line.exceedsScope),
      };
    });
  }

  /**
   * The stored certification document, for the download route (2026-10-11).
   *
   * Addressed by the **bill's** id, not the storage reference: the reference is an
   * internal handle, and an endpoint that took one would serve any blob whose ref a
   * caller could guess or had once been shown.
   */
  async readCertificate(
    ctx: RlsContext,
    billId: string,
  ): Promise<{ bytes: Buffer; mimeType: string; contentDisposition: string }> {
    const bill = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.clientBill.findFirst({
        where: { id: billId },
        select: {
          certificateFileRef: true,
          certificateFileName: true,
          certificateMimeType: true,
        },
      }),
    );
    if (!bill?.certificateFileRef) {
      throw new NotFoundException('No certification document on this bill.');
    }
    return {
      bytes: await this.storage.get(bill.certificateFileRef),
      mimeType: bill.certificateMimeType ?? 'application/octet-stream',
      // `contentDispositionFor`, never a hand-built header: a file name carrying a
      // character outside latin1 makes `res.setHeader` throw `ERR_INVALID_CHAR`, which
      // is a 500 on a download — a defect this repository shipped and fixed in 2026-10.
      contentDisposition: contentDispositionFor(
        bill.certificateFileName ?? 'certificate',
      ),
    };
  }

  /**
   * How much of each BOQ line has been billed, as an **aggregate** (research §3).
   *
   * Draft bills are excluded: a draft is a working document, and counting it toward cumulative would
   * make two people composing bills simultaneously each see the other's unfinished work as billed.
   *
   * `upToBillDate` lets a historical bill show the position as at its own date — otherwise opening a
   * bill from last quarter would show today's running total beside figures from then, which reads as
   * an arithmetic error in the bill.
   *
   * ponytail: rows fetched and summed here rather than `groupBy … _sum`, because what is
   * counted is `certifiedQty ?? quantity` and Prisma cannot group on a coalesce. Bounded by
   * bills × lines per BOQ item, which is single digits per item on a real project. A
   * database-side `COALESCE` sum would need raw SQL, which this repository has none of.
   */
  private async previouslyBilled(
    tx: Prisma.TransactionClient,
    boqTaskItemIds: string[],
    options?: { upToBillDate?: Date; includeBillId?: string },
  ): Promise<Map<string, number>> {
    if (boqTaskItemIds.length === 0) return new Map();
    const rows = await tx.clientBillLine.findMany({
      where: {
        boqTaskItemId: { in: boqTaskItemIds },
        OR: [
          {
            clientBill: {
              status: { not: ClientBillStatus.draft },
              ...(options?.upToBillDate
                ? { billingDate: { lte: options.upToBillDate } }
                : {}),
            },
          },
          // The bill being viewed, included even while it is a draft: its own lines belong in its own
          // cumulative figure, or the column would read as though this bill had not happened.
          ...(options?.includeBillId
            ? [{ clientBillId: options.includeBillId }]
            : []),
        ],
      },
      select: { boqTaskItemId: true, quantity: true, certifiedQty: true },
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      // **What the client certified, where they said** (2026-10-11). The reported case:
      // nine items billed, eight certified, and the ninth stayed deducted from what was
      // left to bill — so it could never be claimed again without over-measuring.
      //
      // `null` is "not said line by line", and the billed quantity stands: before
      // certification, and for a bill certified only as a single figure. **Zero is not
      // null** — a line certified at nothing returns its quantity to the schedule, and
      // that distinction is the whole of the column.
      const counted = row.certifiedQty ?? row.quantity;
      totals.set(
        row.boqTaskItemId,
        (totals.get(row.boqTaskItemId) ?? 0) + counted.toNumber(),
      );
    }
    return totals;
  }
}
