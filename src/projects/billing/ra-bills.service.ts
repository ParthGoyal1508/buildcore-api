import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Permission, Prisma, RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
} from '../../approvals/approvals.service';
import { ACTION_RA_BILL } from '../../approvals/default-chains';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { BILLING_ERRORS } from './billing-error-codes';
import {
  billTotals,
  lineTotals,
  retentionBalance,
  retentionOn,
} from './bill-totals';

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

/** A revision to a bill's measured quantities (FR-009). */
export interface ReviseRaBillInput {
  lines: MeasureLineInput[];
  advanceRecovery?: number;
  otherDeductions?: number;
  /** Why the quantities changed. Required — see `revise`. */
  reason: string;
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
  /**
   * The client BOQ line this award line corresponds to, where it corresponds to one.
   *
   * On the **read** side since 027, because it was accepted on the write side from the start and
   * never returned — so a screen loading an award to edit it could not put back what it had not
   * been told, and every re-save silently unlinked the line. `assertNotBilledBelow` reaches the
   * subcontractor-billed quantity through exactly this id, so an unlink is not cosmetic: it drops
   * that line out of the floor a daily-work reversal is checked against.
   */
  boqTaskItemId: string | null;
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

/** One retention release, as a reader sees it. */
export interface RetentionReleaseView {
  id: string;
  amount: number;
  releasedOn: Date;
  reason: string | null;
  releasedByUserId: string | null;
}

/**
 * A work order's retention position (FR-016a).
 *
 * All three figures, not just the balance. A subcontractor asking "how much are you still holding"
 * is really asking "and how did it get to that", and a single outstanding figure sends somebody to
 * add up bills by hand to answer the second half.
 */
export interface RetentionLedger {
  workOrderId: string;
  retentionPercent: number;
  withheld: number;
  released: number;
  outstanding: number;
  releases: RetentionReleaseView[];
}

export interface ReleaseRetentionInput {
  amount: number;
  /** `YYYY-MM-DD`. The day the money went back, not the day somebody recorded it. */
  releasedOn: string;
  reason: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
  ) {}

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
        boqTaskItemId: item.boqTaskItemId,
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
      const { priced, totals } = await this.priceLines(tx, input.workOrderId, {
        lines: input.lines,
        advanceRecovery: input.advanceRecovery,
        otherDeductions: input.otherDeductions,
      });

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

  /**
   * The award, with what has been measured against it, for the RA bill sheet (FR-007).
   *
   * The three quantities FR-007 asks for, before anybody types: awarded, measured to date, and
   * remaining. A sheet that showed only the award would make the biller work out the remainder from
   * a column they cannot see, which is the arithmetic this feature exists to remove.
   *
   * `excludeBillId` is for the revision sheet: the bill being revised must not count its own
   * existing quantities as measured, or every revision looks like an over-measurement of itself.
   */
  async awardFor(
    ctx: RlsContext,
    workOrderId: string,
    options: { excludeBillId?: string } = {},
  ): Promise<{
    workOrderId: string;
    retentionPercent: number;
    lines: RaBillLineView[];
  }> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const workOrder = await tx.workOrder.findFirst({
        where: { id: workOrderId },
        select: { id: true, retentionPercent: true },
      });
      if (!workOrder) throw new NotFoundException('Work order not found');

      const items = await tx.workOrderBOQItem.findMany({
        where: { workOrderId },
        orderBy: { createdAt: 'asc' },
      });
      const toDate = await this.measuredToDate(
        tx,
        items.map((item) => item.id),
        options.excludeBillId
          ? { excludeBillId: options.excludeBillId }
          : undefined,
      );

      return {
        workOrderId,
        retentionPercent: workOrder.retentionPercent.toNumber(),
        lines: items.map((item) => {
          const awarded = item.awardedQty.toNumber();
          const measured = toDate.get(item.id) ?? 0;
          return {
            id: item.id,
            workOrderBoqItemId: item.id,
            boqTaskItemId: item.boqTaskItemId,
            description: item.description,
            unit: item.unit,
            awardedQty: awarded,
            // Nothing measured on *this* sheet yet — the biller is about to type it.
            thisPeriodQty: 0,
            toDateQty: measured,
            // Negative where already over-measured. Reported, not clamped.
            remainingQty: Math.round((awarded - measured) * 1000) / 1000,
            rate: item.rate.toNumber(),
            amount: 0,
          };
        }),
      };
    });
  }

  /**
   * What a work order still holds back, and every release against it (018 FR-016a).
   *
   * **Withheld counts only bills that have left draft.** A draft is a working document and its
   * retention has been withheld from nobody; counting it would let somebody release money against a
   * bill that may never be issued.
   */
  async retentionFor(
    ctx: RlsContext,
    workOrderId: string,
  ): Promise<RetentionLedger> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const workOrder = await tx.workOrder.findFirst({
        where: { id: workOrderId },
        select: { id: true, retentionPercent: true },
      });
      if (!workOrder) throw new NotFoundException('Work order not found');

      const [withheld, releases] = await Promise.all([
        tx.rABill.aggregate({
          where: { workOrderId, status: { not: RaBillStatus.draft } },
          _sum: { retentionAmount: true },
        }),
        tx.retentionRelease.findMany({
          where: { workOrderId },
          orderBy: { releasedOn: 'desc' },
        }),
      ]);

      const balance = retentionBalance({
        withheld: withheld._sum.retentionAmount?.toNumber() ?? 0,
        released: releases.reduce(
          (sum, release) => sum + release.amount.toNumber(),
          0,
        ),
      });

      return {
        workOrderId,
        retentionPercent: workOrder.retentionPercent.toNumber(),
        ...balance,
        releases: releases.map((release) => ({
          id: release.id,
          amount: release.amount.toNumber(),
          releasedOn: release.releasedOn,
          reason: release.reason,
          releasedByUserId: release.releasedByUserId,
        })),
      };
    });
  }

  /**
   * Records retention going back to the subcontractor (FR-016a, Phase 7).
   *
   * **An act somebody performs, never a schedule the system runs.** Confirmed by the client on
   * 2026-10-03, who were offered two automatic schedules and chose this. The reasoning survives
   * their answer: contract terms vary, and a schedule guessed wrong does not fail loudly — it
   * quietly withholds money that was due or releases money that was not, and nobody notices until
   * the subcontractor does.
   *
   * Append-only. Correcting a release by editing its row would leave no trace that it had been for
   * a different amount yesterday, on a path where the row *is* the evidence that money moved.
   */
  async releaseRetention(
    ctx: RlsContext,
    workOrderId: string,
    input: ReleaseRetentionInput,
    releasedByUserId: string,
  ): Promise<RetentionLedger> {
    if (!input.reason?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.retentionReasonRequired,
        message:
          'Say what this release is against. Six months from now the first question asked of ' +
          'it will be which milestone it settled.',
      });
    }

    await withRlsContext(this.prisma, ctx, async (tx) => {
      const workOrder = await tx.workOrder.findFirst({
        where: { id: workOrderId },
        select: { id: true, companyId: true },
      });
      if (!workOrder) throw new NotFoundException('Work order not found');

      // Read inside the same transaction as the write. Two releases submitted together would
      // otherwise each see the balance before the other and both pass — the classic read-then-write
      // race, and on this path it pays out money that was never held.
      const [withheld, released] = await Promise.all([
        tx.rABill.aggregate({
          where: { workOrderId, status: { not: RaBillStatus.draft } },
          _sum: { retentionAmount: true },
        }),
        tx.retentionRelease.aggregate({
          where: { workOrderId },
          _sum: { amount: true },
        }),
      ]);

      const balance = retentionBalance({
        withheld: withheld._sum.retentionAmount?.toNumber() ?? 0,
        released: released._sum.amount?.toNumber() ?? 0,
      });

      if (input.amount <= 0) {
        throw new BadRequestException(
          'A retention release must be a positive amount.',
        );
      }

      if (input.amount > balance.outstanding) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.retentionExceedsHeld,
          message:
            `This work order holds ${balance.outstanding.toFixed(
              2,
            )} in retention, and ` +
            `${input.amount.toFixed(
              2,
            )} is being released. Releasing more than was withheld pays ` +
            `out money the company never held.`,
        });
      }

      await tx.retentionRelease.create({
        data: {
          companyId: workOrder.companyId,
          workOrderId,
          amount: input.amount,
          releasedOn: new Date(input.releasedOn),
          reason: input.reason.trim(),
          releasedByUserId,
        },
      });
    });

    return this.retentionFor(ctx, workOrderId);
  }

  /**
   * Every RA bill on a project, newest first.
   *
   * Sequential rather than `Promise.all`, matching `ClientBillsService.listForProject`: each `view`
   * opens its own RLS transaction, and a hundred concurrent ones would exhaust the pool on a project
   * with a long billing history.
   */
  async listForProject(
    ctx: RlsContext,
    projectId: string,
  ): Promise<RaBillView[]> {
    const bills = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.findMany({
        where: { projectId },
        orderBy: { billingDate: 'desc' },
        select: { id: true },
      }),
    );
    const out: RaBillView[] = [];
    for (const bill of bills) out.push(await this.view(ctx, bill.id));
    return out;
  }

  /**
   * Sends a bill for certification (018 Phase 4, FR-009's precondition).
   *
   * The bill becomes `submitted` and enters the `ra_bill` chain. **Nothing is approved here** — the
   * spine decides, and `onApprovalCompleted` below is what marks the bill certified.
   *
   * Order matters: the spine is asked **first**, and the bill's own status is written only once the
   * instance exists. A bill flipped to `submitted` with no instance behind it is a bill waiting on
   * nobody, sitting in no queue, that looks to its author as though it were submitted — the exact
   * silent failure T022 is about, arriving on the happy path instead of the error path.
   */
  async submitForCertification(
    ctx: RlsContext,
    caller: AuthenticatedUser,
    billId: string,
  ): Promise<RaBillView> {
    const bill = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.findFirst({
        where: { id: billId },
        select: {
          id: true,
          companyId: true,
          status: true,
          billNumber: true,
          projectId: true,
        },
      }),
    );
    if (!bill) throw new NotFoundException('RA bill not found');
    if (bill.status !== RaBillStatus.draft) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_ERRORS.notDraft,
        message:
          `This bill is already ${bill.status}. A bill out of draft is either waiting on somebody ` +
          `or certified; revising its quantities is the way to change it.`,
      });
    }

    await this.approvals.submit({
      companyId: bill.companyId,
      actionType: ACTION_RA_BILL,
      entityType: ACTION_RA_BILL,
      entityId: bill.id,
      originatorUserId: caller.id,
      subject: `RA bill ${bill.billNumber}`,
      href: `/projects/${bill.projectId}/ra-bills/${bill.id}`,
      viewPermission: Permission.PROJECT_FINANCIALS,
    });

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.update({
        where: { id: bill.id },
        data: {
          status: RaBillStatus.submitted,
          submittedAt: new Date(),
        },
      }),
    );
    return this.view(ctx, bill.id);
  }

  /**
   * Revises a bill's measured quantities, invalidating any approval it had (FR-009, research §6).
   *
   * ## A completed approval is never touched
   *
   * 016's chain records *what was approved*. Editing quantities under a completed approval would
   * leave a recorded decision describing a bill that no longer exists — the approver's name against
   * numbers they never saw. So the completed instance stays exactly as it is, as history, and a
   * **new** one is raised. `ApprovalService.abandon()` is still called first and is a deliberate
   * no-op on a completed instance by the spine's own design; it is what closes a *pending* one, so
   * nobody is left deciding a version that has been replaced.
   *
   * ## The spine is asked before anything is written
   *
   * T022. If the chain is unreachable or unconfigured, this throws and **nothing has changed** — the
   * bill keeps its quantities and its certification. The failure mode to design against is the other
   * order: quantities edited, approval invalidation lost, and a bill that reads as certified against
   * numbers nobody signed. If the write then fails, the fresh instance is abandoned, which leaves at
   * worst a visible pending approval on an unchanged bill rather than an invisible lie about a
   * certified one.
   *
   * ## A reason is required
   *
   * FR-016 asks for the actor and time of every edit. A certified bill going round again costs
   * somebody a second decision, and "why" is the first thing they will ask.
   */
  async revise(
    ctx: RlsContext,
    caller: AuthenticatedUser,
    billId: string,
    input: ReviseRaBillInput,
  ): Promise<RaBillView> {
    if (input.lines.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.noLines,
        message: 'A measured bill needs at least one line.',
      });
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.revisionReasonRequired,
        message:
          'Say why the quantities changed. A certified bill going round again costs somebody a ' +
          'second decision, and “why” is the first thing they will ask.',
      });
    }

    const bill = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.findFirst({
        where: { id: billId },
        select: {
          id: true,
          companyId: true,
          status: true,
          billNumber: true,
          projectId: true,
          workOrderId: true,
          revisionCount: true,
        },
      }),
    );
    if (!bill) throw new NotFoundException('RA bill not found');
    if (!bill.workOrderId) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_ERRORS.awardRequired,
        message:
          'This bill predates work-order awards and has no award to measure against, so its ' +
          'quantities cannot be revised here. Raise a new bill against the award instead.',
      });
    }

    const wasDecided = bill.status !== RaBillStatus.draft;

    if (wasDecided) {
      // Closes a *pending* instance so nobody is left deciding a superseded version. A completed
      // one is untouched — the spine ignores a non-live instance, which is the behaviour research §6
      // depends on rather than a coincidence.
      await this.approvals.abandon(
        ACTION_RA_BILL,
        bill.id,
        bill.companyId,
        `Quantities revised: ${input.reason.trim()}`,
      );

      // Asked before anything is written. A throw here leaves the bill exactly as it was.
      await this.approvals.submit({
        companyId: bill.companyId,
        actionType: ACTION_RA_BILL,
        entityType: ACTION_RA_BILL,
        entityId: bill.id,
        originatorUserId: caller.id,
        subject: `RA bill ${bill.billNumber} (revised)`,
        href: `/projects/${bill.projectId}/ra-bills/${bill.id}`,
        viewPermission: Permission.PROJECT_FINANCIALS,
      });
    }

    try {
      await withRlsContext(this.prisma, ctx, async (tx) => {
        const { priced, totals } = await this.priceLines(
          tx,
          bill.workOrderId as string,
          {
            lines: input.lines,
            advanceRecovery: input.advanceRecovery,
            otherDeductions: input.otherDeductions,
            excludeBillId: bill.id,
          },
        );

        await tx.rABillLine.deleteMany({ where: { raBillId: bill.id } });
        await tx.rABill.update({
          where: { id: bill.id },
          data: {
            amount: totals.gross,
            grossAmount: totals.gross,
            retentionAmount: totals.retention,
            advanceRecovery: totals.advanceRecovery,
            otherDeductions: totals.otherDeductions,
            netPayable: totals.net,
            // Back to `submitted` when it had been decided, because it is waiting on the new
            // instance; a revised draft stays a draft.
            status: wasDecided ? RaBillStatus.submitted : RaBillStatus.draft,
            // Cleared, not kept. A certification naming an approver against quantities they never
            // saw is the precise thing FR-009 exists to prevent, and leaving these set would leave
            // the screen saying exactly that.
            approvedByUserId: null,
            approvedAt: null,
            submittedAt: wasDecided ? new Date() : null,
            revisionCount: wasDecided
              ? bill.revisionCount + 1
              : bill.revisionCount,
            lastRevisedAt: new Date(),
            lastRevisedByUserId: caller.id,
            rejectionRemark: null,
            lines: {
              create: priced.map(({ line, item, totals: lineAmount }) => ({
                companyId: bill.companyId,
                workOrderBoqItemId: item.id,
                quantity: line.quantity,
                rate: item.rate,
                amount: lineAmount.amount,
              })),
            },
          },
        });
      });
    } catch (error) {
      if (wasDecided) {
        // The instance was raised and the edit did not land. Close it rather than leaving somebody
        // asked to certify a revision that does not exist.
        await this.approvals.abandon(
          ACTION_RA_BILL,
          bill.id,
          bill.companyId,
          'The revision that raised this approval failed to save.',
        );
      }
      throw error;
    }

    return this.view(ctx, bill.id);
  }

  /**
   * Marks a bill certified when its chain completes (FR-009, FR-016).
   *
   * The spine announces completion and never calls back, so this is the only place a bill becomes
   * `approved`. Guarded on the bill still being `submitted`: a second delivery of the same event is
   * a normal thing for an event bus to do, and a revision raced against a completion must not
   * re-certify quantities that have since changed.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_RA_BILL) return;
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: event.companyId,
    };

    // Who signed, read back through the spine rather than queried from its tables — `projects` must
    // not read `shared.ApprovalDecision` (Principle I, and `spine-boundary.spec.ts` enforces it).
    const state = await this.approvals.stateOfSystem(
      ACTION_RA_BILL,
      event.entityId,
      event.companyId,
    );

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.updateMany({
        where: { id: event.entityId, status: RaBillStatus.submitted },
        data: {
          status: RaBillStatus.approved,
          approvedAt: new Date(),
          approvedByUserId: state?.latestDecision?.actorUserId ?? null,
        },
      }),
    );
  }

  /**
   * Prices a set of measured lines against the award and totals them.
   *
   * Shared by `compose` and `revise` rather than written twice. Two of the three things it does are
   * easy to get subtly wrong on the second attempt — the over-measurement refusal and the retention
   * base — and a revision that priced differently from a composition would be a bill whose total
   * changed for no reason anybody could point at.
   *
   * `excludeBillId` is what makes a revision possible at all: without it, the bill's own existing
   * quantities count as previously-billed and every revision looks like an over-measurement of
   * itself.
   */
  private async priceLines(
    tx: Prisma.TransactionClient,
    workOrderId: string,
    input: {
      lines: MeasureLineInput[];
      advanceRecovery?: number;
      otherDeductions?: number;
      excludeBillId?: string;
    },
  ) {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: workOrderId },
      select: { id: true, retentionPercent: true },
    });
    if (!workOrder) throw new NotFoundException('Work order not found');

    const award = await tx.workOrderBOQItem.findMany({
      where: {
        id: { in: input.lines.map((line) => line.workOrderBoqItemId) },
        workOrderId,
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
      input.excludeBillId ? { excludeBillId: input.excludeBillId } : undefined,
    );

    const priced = input.lines.map((line) => {
      const item = awardById.get(line.workOrderBoqItemId) as (typeof award)[0];
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

    return { workOrder, priced, totals };
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
          boqTaskItemId: line.workOrderBoqItem.boqTaskItemId,
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
    options?: {
      upToBillDate?: Date;
      includeBillId?: string;
      /**
       * The bill being revised, left out of its own to-date figure (FR-009).
       *
       * Without this a revision measures itself: the bill's existing lines count as previously
       * billed, and reducing a quantity on a fully-measured award would be refused for exceeding
       * the award it is reducing.
       */
      excludeBillId?: string;
    },
  ): Promise<Map<string, number>> {
    if (awardItemIds.length === 0) return new Map();
    const grouped = await tx.rABillLine.groupBy({
      by: ['workOrderBoqItemId'],
      where: {
        workOrderBoqItemId: { in: awardItemIds },
        ...(options?.excludeBillId
          ? { raBillId: { not: options.excludeBillId } }
          : {}),
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
