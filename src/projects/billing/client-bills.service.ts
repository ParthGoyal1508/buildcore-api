import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClientBillStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { BILLING_ERRORS } from './billing-error-codes';
import { billTotals, lineTotals, money, retentionOn } from './bill-totals';

/** A line as the caller composes it. */
export interface ComposeBillLineInput {
  boqTaskItemId: string;
  quantity: number;
  overScopeReason?: string | null;
}

export interface ComposeBillInput {
  projectId: string;
  billNumber: string;
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
  unit: string;
  scopeQty: number;
  quantity: number;
  rate: number;
  amount: number;
  /** Including this bill. */
  cumulativeQty: number;
  remainingQty: number;
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
 * applying the percentage per line instead gives a figure close enough to pass a glance and wrong by
 * rounding, which is the worst available outcome for a tender document.
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

export interface ClientBillView {
  id: string;
  projectId: string;
  billNumber: string;
  description: string | null;
  billingDate: Date;
  status: ClientBillStatus;
  quotedPercentage: number;
  grossAmount: number;
  retentionAmount: number;
  netAmount: number;
  certifiedAmount: number | null;
  certifiedAt: Date | null;
  /**
   * The shortfall between billed and certified, where there is one (FR-005).
   *
   * Derived rather than stored, and **reported rather than resolved**: a client certifying less than
   * was billed is the single most consequential thing on this screen, and it must not be reachable
   * only by subtracting two columns somebody might not notice are different.
   */
  certificationVariance: number | null;
  submittedAt: Date | null;
  lines: ClientBillLineView[];
  /** True when any line is past its BOQ scope. */
  exceedsScope: boolean;
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
  constructor(private readonly prisma: PrismaService) {}

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

      try {
        return await tx.clientBill.create({
          data: {
            companyId,
            projectId: input.projectId,
            billNumber: input.billNumber.trim(),
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
            message: `This project already has a bill numbered ${input.billNumber}.`,
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
    certifiedAmount: number,
  ): Promise<ClientBillView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.clientBill.findFirst({ where: { id: billId } });
      if (!bill) throw new NotFoundException('Bill not found');
      if (bill.status === ClientBillStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.notSubmitted,
          message:
            'This bill has not been submitted, so there is nothing for the client to have certified.',
        });
      }
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

      await tx.clientBill.update({
        where: { id: billId },
        data: {
          status: ClientBillStatus.certified,
          certifiedAmount,
          certifiedAt: new Date(),
        },
      });
    });

    return this.view(ctx, billId);
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

      const groups = await tx.bOQTaskGroup.findMany({
        where: { projectId },
        include: { items: { orderBy: { boqNo: 'asc' } } },
        orderBy: { boqNo: 'asc' },
      });

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
            include: { boqTaskItem: true },
            orderBy: { boqTaskItem: { boqNo: 'asc' } },
          },
        },
      });
      if (!bill) throw new NotFoundException('Bill not found');

      // Cumulative **up to and including** this bill, so a historical bill reads as it did when it was
      // raised rather than showing today's running total against a figure from last quarter.
      const cumulative = await this.previouslyBilled(
        tx,
        bill.lines.map((line) => line.boqTaskItemId),
        { upToBillDate: bill.billingDate, includeBillId: bill.id },
      );

      const lines: ClientBillLineView[] = bill.lines.map((line) => {
        const scopeQty = line.boqTaskItem.scopeQty.toNumber();
        const cumulativeQty = cumulative.get(line.boqTaskItemId) ?? 0;
        return {
          id: line.id,
          boqTaskItemId: line.boqTaskItemId,
          boqNo: line.boqTaskItem.boqNo,
          taskName: line.boqTaskItem.taskName,
          unit: line.boqTaskItem.unit,
          scopeQty,
          quantity: line.quantity.toNumber(),
          rate: line.rate.toNumber(),
          amount: line.amount.toNumber(),
          cumulativeQty,
          remainingQty: Math.round((scopeQty - cumulativeQty) * 1000) / 1000,
          exceedsScope: line.exceedsScope,
          overScopeReason: line.overScopeReason,
          isVariation: line.boqTaskItem.isVariation,
          variationRef: line.boqTaskItem.variationRef,
        };
      });

      const certified = bill.certifiedAmount?.toNumber() ?? null;
      return {
        id: bill.id,
        projectId: bill.projectId,
        billNumber: bill.billNumber,
        description: bill.description,
        billingDate: bill.billingDate,
        status: bill.status,
        quotedPercentage: bill.quotedPercentage.toNumber(),
        grossAmount: bill.grossAmount.toNumber(),
        retentionAmount: bill.retentionAmount.toNumber(),
        netAmount: bill.netAmount.toNumber(),
        certifiedAmount: certified,
        certifiedAt: bill.certifiedAt,
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
   * How much of each BOQ line has been billed, as an **aggregate** (research §3).
   *
   * Draft bills are excluded: a draft is a working document, and counting it toward cumulative would
   * make two people composing bills simultaneously each see the other's unfinished work as billed.
   *
   * `upToBillDate` lets a historical bill show the position as at its own date — otherwise opening a
   * bill from last quarter would show today's running total beside figures from then, which reads as
   * an arithmetic error in the bill.
   */
  private async previouslyBilled(
    tx: Prisma.TransactionClient,
    boqTaskItemIds: string[],
    options?: { upToBillDate?: Date; includeBillId?: string },
  ): Promise<Map<string, number>> {
    if (boqTaskItemIds.length === 0) return new Map();
    const grouped = await tx.clientBillLine.groupBy({
      by: ['boqTaskItemId'],
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
      _sum: { quantity: true },
    });
    return new Map(
      grouped.map((row) => [
        row.boqTaskItemId,
        row._sum.quantity?.toNumber() ?? 0,
      ]),
    );
  }
}
