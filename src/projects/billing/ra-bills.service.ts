import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { BILLING_ERRORS } from './billing-error-codes';
import { billTotals, lineTotals, retentionOn } from './bill-totals';

/** One award line as the work order captures it. */
export interface AwardLineInput {
  description: string;
  unit: string;
  awardedQty: number;
  /** The **subcontractor's** rate, not the client's BOQ rate. */
  rate: number;
  /** The client-side BOQ line this corresponds to, where it corresponds to one. */
  boqTaskItemId?: string | null;
}

export interface MeasureLineInput {
  workOrderBoqItemId: string;
  /** Measured **this period**. To-date and remaining are aggregates. */
  quantity: number;
}

export interface ComposeRaBillInput {
  projectId: string;
  workOrderId: string;
  billNumber: string;
  description?: string | null;
  billingDate: string;
  lines: MeasureLineInput[];
  /** Money already advanced, coming back. **Not a project cost** — see `bill-totals.ts`. */
  advanceRecovery?: number;
  otherDeductions?: number;
}

/** One measured line, with the three quantities FR-007 asks for. */
export interface RaBillLineView {
  id: string;
  workOrderBoqItemId: string;
  description: string;
  unit: string;
  awardedQty: number;
  /** Measured on this bill. */
  thisPeriodQty: number;
  /** Measured on this bill and every earlier one. */
  toDateQty: number;
  /** Awarded less to-date. Negative when over-measured — reported, not clamped. */
  remainingQty: number;
  rate: number;
  amount: number;
}

export interface RaBillView {
  id: string;
  projectId: string;
  workOrderId: string | null;
  billNumber: string;
  description: string | null;
  billingDate: Date;
  status: RaBillStatus;
  /** Each deduction in its own right (FR-008). */
  grossAmount: number;
  retentionAmount: number;
  advanceRecovery: number;
  otherDeductions: number;
  deductionTotal: number;
  netPayable: number;
  /**
   * What this bill contributes to project **cost** — gross, not net.
   *
   * Exposed on the view rather than left for a consumer to work out, because the consumer that gets it
   * wrong is the P&L, and it gets it wrong by reading the field that looks most like "the amount".
   */
  pnlAmount: number;
  lines: RaBillLineView[];
}

/**
 * Subcontractor bills measured against the award (018 US2) — `bugs.md` item 12.
 *
 * ## The award is a separate set of rates, deliberately
 *
 * `WorkOrderBOQItem` holds the subcontractor's rate; `BOQTaskItem` holds the client's. They are
 * different numbers for the same work, and **the margin between them is what item 11's P&L exists to
 * show.** One column called "the rate" would make that margin unrepresentable, which is why the award
 * is captured rather than inferred from the client's BOQ.
 *
 * The link to a client BOQ line is **optional**. A subcontract can cover work the client's BOQ itemises
 * differently, and requiring a match would make somebody invent one.
 *
 * ## Gross, the three deductions, and net — each visible
 *
 * FR-008, and not a presentational nicety. A subcontractor disputing a payment asks *which deduction*
 * accounts for the difference, and a single `netPayable` cannot answer. The P&L needs the same split for
 * a different reason: retention is money withheld and an advance recovery is money already paid, so
 * **neither is a cost**, and `pnlAmount` says so on the view rather than leaving it to be rediscovered.
 */
@Injectable()
export class RaBillsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Captures or replaces the award lines on a work order (FR-006).
   *
   * Replaces rather than merges, and refuses once anything has been billed against it. An award that
   * could change under a measured bill would move the `remaining` figure on a document already issued —
   * and the subcontractor's copy would then disagree with ours.
   */
  async setAward(
    ctx: RlsContext,
    companyId: string,
    workOrderId: string,
    lines: AwardLineInput[],
  ): Promise<RaBillLineView[]> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const workOrder = await tx.workOrder.findFirst({
        where: { id: workOrderId },
        select: { id: true },
      });
      if (!workOrder) throw new NotFoundException('Work order not found');

      const billed = await tx.rABillLine.count({
        where: { workOrderBoqItem: { workOrderId } },
      });
      if (billed > 0) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.notDraft,
          message:
            'This award has been measured against and cannot be replaced. Changing it would move the ' +
            'remaining quantity on bills already issued, and the subcontractor’s copy would then ' +
            'disagree with ours. Raise a variation instead.',
        });
      }

      await tx.workOrderBOQItem.deleteMany({ where: { workOrderId } });
      await tx.workOrderBOQItem.createMany({
        data: lines.map((line) => ({
          companyId,
          workOrderId,
          boqTaskItemId: line.boqTaskItemId ?? null,
          description: line.description.trim(),
          unit: line.unit.trim(),
          awardedQty: line.awardedQty,
          rate: line.rate,
        })),
      });

      const stored = await tx.workOrderBOQItem.findMany({
        where: { workOrderId },
        orderBy: { createdAt: 'asc' },
      });
      return stored.map((item) => ({
        id: item.id,
        workOrderBoqItemId: item.id,
        description: item.description,
        unit: item.unit,
        awardedQty: item.awardedQty.toNumber(),
        thisPeriodQty: 0,
        toDateQty: 0,
        remainingQty: item.awardedQty.toNumber(),
        rate: item.rate.toNumber(),
        amount: 0,
      }));
    });
  }

  /**
   * Composes a measured bill against the award (FR-007, FR-008).
   *
   * Retention comes from the work order's own `retentionPercent`, computed on **gross** — the deduction
   * most likely to be taken on the wrong base, which is why `retentionOn` exists rather than a
   * multiplication here.
   */
  async compose(
    ctx: RlsContext,
    companyId: string,
    input: ComposeRaBillInput,
  ): Promise<RaBillView> {
    if (input.lines.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.noLines,
        message: 'A measured bill needs at least one line.',
      });
    }

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const workOrder = await tx.workOrder.findFirst({
        where: { id: input.workOrderId },
        select: { id: true, retentionPercent: true },
      });
      if (!workOrder) throw new NotFoundException('Work order not found');

      const award = await tx.workOrderBOQItem.findMany({
        where: {
          id: { in: input.lines.map((line) => line.workOrderBoqItemId) },
          workOrderId: input.workOrderId,
        },
      });
      if (award.length !== input.lines.length) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.boqRequired,
          message:
            'Some measured lines are not on this work order’s award. A bill can only measure work the ' +
            'order awarded.',
        });
      }
      const awardById = new Map(award.map((item) => [item.id, item]));
      const toDate = await this.measuredToDate(
        tx,
        input.lines.map((line) => line.workOrderBoqItemId),
      );

      const priced = input.lines.map((line) => {
        const item = awardById.get(
          line.workOrderBoqItemId,
        ) as (typeof award)[0];
        return {
          line,
          item,
          totals: lineTotals({
            quantity: line.quantity,
            // The awarded rate, frozen onto the bill line — same reasoning as a client bill's.
            rate: item.rate.toNumber(),
            previouslyBilledQty: toDate.get(item.id) ?? 0,
            scopeQty: item.awardedQty.toNumber(),
          }),
        };
      });

      // Over-measurement against an **award** is refused, unlike against a client BOQ.
      //
      // The asymmetry is deliberate and it is about who is owed what. Over-measuring a client BOQ is a
      // claim the client can reject; over-measuring an award is the company agreeing to pay for work it
      // never ordered, and there is nobody downstream to catch it. A variation to the award is the
      // route, which is why the refusal names it.
      const over = priced.filter((p) => p.totals.exceedsScope);
      if (over.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.exceedsAward,
          message:
            `These lines measure more than the work order awarded: ${over
              .map((p) => p.item.description)
              .join(
                '; ',
              )}. Raise a variation to the award first — paying above an award is the ` +
            `company agreeing to work it never ordered, and there is nobody downstream to catch it.`,
        });
      }

      const grossOnly = billTotals(priced.map((p) => p.totals));
      const retention = retentionOn(
        grossOnly.gross,
        workOrder.retentionPercent.toNumber(),
      );
      const totals = billTotals(
        priced.map((p) => p.totals),
        {
          retention,
          advanceRecovery: input.advanceRecovery,
          other: input.otherDeductions,
        },
      );

      return tx.rABill.create({
        data: {
          companyId,
          projectId: input.projectId,
          workOrderId: input.workOrderId,
          billNumber: input.billNumber.trim(),
          description: input.description ?? null,
          billingDate: new Date(input.billingDate),
          // `amount` is the pre-018 column. Set to **gross**, matching the migration's backfill, so a
          // screen still reading it sees the work rather than the net — and the two cannot disagree
          // about what `amount` meant for bills raised either side of this change.
          amount: totals.gross,
          grossAmount: totals.gross,
          retentionAmount: totals.retention,
          advanceRecovery: totals.advanceRecovery,
          otherDeductions: totals.otherDeductions,
          netPayable: totals.net,
          status: RaBillStatus.draft,
          lines: {
            create: priced.map(({ line, item, totals: lineAmount }) => ({
              companyId,
              workOrderBoqItemId: item.id,
              quantity: line.quantity,
              rate: item.rate,
              amount: lineAmount.amount,
            })),
          },
        },
      });
    });

    return this.view(ctx, created.id);
  }

  /** One bill, with this-period / to-date / remaining per line (FR-007). */
  async view(ctx: RlsContext, billId: string): Promise<RaBillView> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.rABill.findFirst({
        where: { id: billId },
        include: {
          lines: { include: { workOrderBoqItem: true } },
        },
      });
      if (!bill) throw new NotFoundException('RA bill not found');

      // To-date **as at this bill's date**, so a historical bill reads as it did when it was raised.
      const toDate = await this.measuredToDate(
        tx,
        bill.lines.map((line) => line.workOrderBoqItemId),
        { upToBillDate: bill.billingDate, includeBillId: bill.id },
      );

      const lines: RaBillLineView[] = bill.lines.map((line) => {
        const awarded = line.workOrderBoqItem.awardedQty.toNumber();
        const toDateQty = toDate.get(line.workOrderBoqItemId) ?? 0;
        return {
          id: line.id,
          workOrderBoqItemId: line.workOrderBoqItemId,
          description: line.workOrderBoqItem.description,
          unit: line.workOrderBoqItem.unit,
          awardedQty: awarded,
          thisPeriodQty: line.quantity.toNumber(),
          toDateQty,
          remainingQty: Math.round((awarded - toDateQty) * 1000) / 1000,
          rate: line.rate.toNumber(),
          amount: line.amount.toNumber(),
        };
      });

      const gross = bill.grossAmount.toNumber();
      const retention = bill.retentionAmount.toNumber();
      const advance = bill.advanceRecovery.toNumber();
      const other = bill.otherDeductions.toNumber();
      return {
        id: bill.id,
        projectId: bill.projectId,
        workOrderId: bill.workOrderId,
        billNumber: bill.billNumber,
        description: bill.description,
        billingDate: bill.billingDate,
        status: bill.status,
        grossAmount: gross,
        retentionAmount: retention,
        advanceRecovery: advance,
        otherDeductions: other,
        deductionTotal: Math.round((retention + advance + other) * 100) / 100,
        netPayable: bill.netPayable.toNumber(),
        // Gross, never net. See the class docblock and `bill-totals.ts`.
        pnlAmount: gross,
        lines,
      };
    });
  }

  /**
   * Quantity measured per award line, as an aggregate.
   *
   * Draft bills excluded for the reason client bills exclude them: a draft is a working document, and
   * counting it would make two people measuring simultaneously each see the other's unfinished work as
   * billed — which on an award means one of them is refused for exceeding it.
   */
  private async measuredToDate(
    tx: Prisma.TransactionClient,
    awardItemIds: string[],
    options?: { upToBillDate?: Date; includeBillId?: string },
  ): Promise<Map<string, number>> {
    if (awardItemIds.length === 0) return new Map();
    const grouped = await tx.rABillLine.groupBy({
      by: ['workOrderBoqItemId'],
      where: {
        workOrderBoqItemId: { in: awardItemIds },
        OR: [
          {
            raBill: {
              status: { not: RaBillStatus.draft },
              ...(options?.upToBillDate
                ? { billingDate: { lte: options.upToBillDate } }
                : {}),
            },
          },
          ...(options?.includeBillId
            ? [{ raBillId: options.includeBillId }]
            : []),
        ],
      },
      _sum: { quantity: true },
    });
    return new Map(
      grouped.map((row) => [
        row.workOrderBoqItemId,
        row._sum.quantity?.toNumber() ?? 0,
      ]),
    );
  }
}
