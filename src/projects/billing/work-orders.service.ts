import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Permission,
  WorkOrderStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
} from '../../approvals/approvals.service';
import { ACTION_WORK_ORDER_AWARD } from '../../approvals/default-chains';
import { webRoutes } from '../../common/web-routes';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';

/** `PRPL-WO-0001`. The slot every other series in this product fills the same way. */
const WORK_ORDER_CODE_INFIX = 'WO';

export interface WorkOrderInput {
  projectId: string;
  /** `partners.Vendor.id`. Optional — a work order can be raised before the vendor is chosen. */
  partnerId?: string | null;
  workDetail: string;
  terms?: string | null;
  requirements?: string | null;
  hireContract?: string | null;
  labourAmount?: number;
  materialAmount?: number;
  /** Retention withheld per RA bill, as a fraction. `0.05` is 5%. */
  retentionPercent?: number;
  status?: WorkOrderStatus;
}

export interface WorkOrderView {
  id: string;
  projectId: string;
  partnerId: string | null;
  code: string | null;
  workDetail: string;
  terms: string | null;
  requirements: string | null;
  hireContract: string | null;
  labourAmount: number;
  materialAmount: number;
  retentionPercent: number;
  status: WorkOrderStatus;
  /** Award lines captured against it. 0 means nothing can be measured against it yet. */
  awardLineCount: number;
  /** RA bills raised against it. */
  billCount: number;
  createdAt: Date;
}

/**
 * Work orders, in the minimal form feature 018 needs (018 US2).
 *
 * ## Why this is here, and what it is not
 *
 * **This is feature 008 User Story 6's surface, delivered in the smallest form that makes 018
 * reachable.** The `WorkOrder` table has existed since 008 and *nothing has ever written to it* —
 * `ProjectsService.getWorkOrderTotalByProject()` says so in its own comment and returns 0. 018's
 * FR-006 to FR-009 are all measured against a work order's award, so without a way to create one,
 * the RA bill sheet, the award capture and the approval invalidation are a screen nobody can reach:
 * half of `bugs.md` item 12, built and unreachable.
 *
 * So this exists, and it is deliberately **not** 008 US6:
 *
 *   * no approval chain on raising one — 008 will decide whether a work order needs one;
 *   * no vendor validation, see below;
 *   * no deletion, because an RA bill references it and a work order with bills against it is a
 *     contract, not a draft;
 *   * no letter issue, no terms templating, none of the document generation 017 gave letters.
 *
 * When 008 US6 is specified properly it should take this over rather than add a second surface.
 *
 * ## `partnerId` is stored, not validated
 *
 * `PartnersService.getVendorById()` exists and is the right way to check it — but `PartnersModule`
 * imports `ProjectsModule` (its vendors resolve project sites), so importing it back would close a
 * cycle across five modules. That is a real cost for a validation the UI already performs by picking
 * from the vendor list it loaded. The id is stored as given and the web resolves the name through
 * the partners endpoints it already calls.
 *
 * The honest consequence: a hand-crafted request can store a partner id that matches no vendor, and
 * it will read back as an unknown partner rather than being refused. Recorded rather than hidden.
 */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codeSeries: CodeSeriesService,
    private readonly approvals: ApprovalService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Sends an award for approval (028 FR-009): `draft` → `pending_approval`.
   *
   * **The control was the wrong way round.** A work order committing the company to several crore
   * went `active` the moment one person saved it, while the first bill raised under it needed an
   * approval. The commitment is made when the award is given; a bill only measures against it.
   *
   * An award with no lines is refused. There is nothing to approve in a work order that awards
   * nothing, and approving one would put a decision on record against a schedule somebody adds
   * afterwards.
   */
  async submitForApproval(
    ctx: RlsContext,
    caller: AuthenticatedUser,
    id: string,
  ): Promise<WorkOrderView> {
    const order = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findFirst({
        where: { id },
        select: {
          id: true,
          companyId: true,
          projectId: true,
          code: true,
          status: true,
          _count: { select: { awardLines: true } },
        },
      }),
    );
    if (!order) throw new NotFoundException('Work order not found');

    if (order.status !== WorkOrderStatus.draft) {
      throw new ConflictException({
        statusCode: 409,
        code: 'WORK_ORDER_WRONG_STATUS',
        message:
          `This work order is already ${order.status.replace(
            '_',
            ' ',
          )}. Only a draft award can ` + 'be sent for approval.',
      });
    }

    if (order._count.awardLines === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'WORK_ORDER_NO_AWARD_LINES',
        message:
          'This work order awards nothing yet, so there is nothing to approve. Capture the award ' +
          'lines first — a decision recorded against an empty schedule would stand against ' +
          'whatever is added afterwards.',
      });
    }

    await this.approvals.submit({
      companyId: order.companyId,
      actionType: ACTION_WORK_ORDER_AWARD,
      entityType: ACTION_WORK_ORDER_AWARD,
      entityId: order.id,
      originatorUserId: caller.id,
      subject: `Work order ${order.code ?? order.id}`,
      href: webRoutes.projectRaBills(order.projectId),
      viewPermission: Permission.PROJECT_FINANCIALS,
    });

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.update({
        where: { id: order.id },
        data: { status: WorkOrderStatus.pending_approval },
      }),
    );
    return this.view(ctx, order.id);
  }

  /**
   * Takes an award back to `draft` so it can be corrected (2026-10-08).
   *
   * ## Why this exists
   *
   * `setAward` used to refuse only once a bill had been measured, so between approval and the
   * first bill the whole award could be rewritten while the work order stayed `active` — the
   * approval standing against figures that no longer existed. Locking `setAward` to a draft closed
   * that, and closing it created a dead end: an award approved with a wrong rate and not yet
   * billed had no route back, because **the "raise a variation instead" the billed path names is
   * advice, not a feature** — `variationRef` exists on client BOQ lines and award lines have no
   * equivalent.
   *
   * This is that route, and it is deliberately **an act of its own rather than a side effect of an
   * edit**. Letting a save quietly cancel an approval would mean the approval could disappear
   * without the person who removed it noticing they had; here they ask for it, and say why.
   *
   * ## What it does not lift
   *
   * A billed award stays frozen. Reopening one would move the remaining quantity under bills the
   * subcontractor already holds, which is the thing the original refusal exists to prevent — so
   * the bill count is checked here too, and reported as the harder refusal it is.
   *
   * The live approval is abandoned rather than left dangling: an instance still waiting on an
   * approver for a schedule that is being rewritten is an item in somebody's queue that means
   * nothing. `abandon` is a no-op where nothing is live, which is the `active` case.
   */
  async reopenAward(
    ctx: RlsContext,
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ): Promise<WorkOrderView> {
    const order = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findFirst({
        where: { id },
        select: {
          id: true,
          companyId: true,
          code: true,
          status: true,
          _count: { select: { awardLines: true } },
        },
      }),
    );
    if (!order) throw new NotFoundException('Work order not found');

    if (order.status === WorkOrderStatus.draft) {
      throw new ConflictException({
        statusCode: 409,
        code: 'WORK_ORDER_WRONG_STATUS',
        message:
          'This award is already a draft, so there is nothing to reopen. Edit it directly.',
      });
    }

    const billed = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABillLine.count({ where: { workOrderBoqItem: { workOrderId: id } } }),
    );
    if (billed > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'WORK_ORDER_AWARD_BILLED',
        message:
          'This award has been measured against, so it cannot be reopened. Changing it would move ' +
          'the remaining quantity on bills the subcontractor already holds.',
      });
    }

    await this.approvals.abandon(
      ACTION_WORK_ORDER_AWARD,
      order.id,
      order.companyId,
      reason,
    );

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.update({
        where: { id: order.id },
        data: { status: WorkOrderStatus.draft },
      }),
    );

    // The reason lives in the audit trail rather than in a column. It is accountability, not
    // correctness — nothing reads it back to decide anything — and this repository's own rule is
    // that making the trail load-bearing for a decision is what turns a gap in it into a
    // permission.
    await this.auditLog.record({
      entityType: AuditEntityType.PROJECT,
      action: AuditAction.UPDATE,
      entityId: order.id,
      accountId: caller.id,
      companyId: order.companyId,
      ipAddress,
      changes: {
        awardReopened: true,
        fromStatus: order.status,
        reason,
      },
    });

    return this.view(ctx, order.id);
  }

  /**
   * The award becomes active when the chain completes — never when somebody saves it.
   *
   * `updateMany` with the status in the `where`, as the RA bill's own handler does: the event can
   * arrive twice, and a second one must not move an order a human has since completed.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_WORK_ORDER_AWARD) return;
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: event.companyId,
    };
    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.updateMany({
        where: {
          id: event.entityId,
          status: WorkOrderStatus.pending_approval,
        },
        data: { status: WorkOrderStatus.active },
      }),
    );
  }

  async listForProject(
    ctx: RlsContext,
    projectId: string,
  ): Promise<WorkOrderView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { awardLines: true, raBills: true } },
        },
      }),
    );
    return rows.map(shape);
  }

  async view(ctx: RlsContext, id: string): Promise<WorkOrderView> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findFirst({
        where: { id },
        include: {
          _count: { select: { awardLines: true, raBills: true } },
        },
      }),
    );
    if (!row) throw new NotFoundException('Work order not found');
    return shape(row);
  }

  async create(
    ctx: RlsContext,
    companyId: string,
    input: WorkOrderInput,
  ): Promise<WorkOrderView> {
    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      // Allocated inside this transaction so a later failure rolls the number back rather than
      // burning it — a gap in the series reads as a deleted work order to anyone auditing it.
      // The same rule project and vendor codes follow.
      const code = await this.codeSeries.next(
        tx,
        companyId,
        CodeSeriesType.WORK_ORDER,
        WORK_ORDER_CODE_INFIX,
      );

      return tx.workOrder.create({
        data: {
          companyId,
          code,
          projectId: input.projectId,
          partnerId: input.partnerId ?? null,
          workDetail: input.workDetail.trim(),
          terms: input.terms ?? null,
          requirements: input.requirements ?? null,
          hireContract: input.hireContract ?? null,
          labourAmount: input.labourAmount ?? 0,
          materialAmount: input.materialAmount ?? 0,
          retentionPercent: input.retentionPercent ?? 0,
          // **Always a draft** (028 FR-009). `CreateWorkOrderDto` no longer carries a status, so
          // there is nothing to honour here — and that is the point: the approval this feature
          // added was being walked around by a caller declaring an award `active` on creation.
          status: WorkOrderStatus.draft,
        },
        select: { id: true },
      });
    });
    return this.view(ctx, created.id);
  }

  /**
   * Edits a work order's details, its retention and its status.
   *
   * **`retentionPercent` is refused once a bill has been raised.** The retention on an issued RA
   * bill is already withheld at the old rate, and changing the basis afterwards would make the
   * subcontractor's copy disagree with ours about money already held — the same reasoning that
   * refuses replacing an award that has been measured against.
   */
  async update(
    ctx: RlsContext,
    id: string,
    input: Partial<WorkOrderInput>,
  ): Promise<WorkOrderView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.workOrder.findFirst({
        where: { id },
        select: {
          id: true,
          retentionPercent: true,
          _count: { select: { raBills: true } },
        },
      });
      if (!existing) throw new NotFoundException('Work order not found');

      if (
        input.retentionPercent !== undefined &&
        existing._count.raBills > 0 &&
        input.retentionPercent !== existing.retentionPercent.toNumber()
      ) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'WORK_ORDER_RETENTION_LOCKED',
          message:
            'Bills have been raised against this work order, so its retention basis cannot be ' +
            'changed. The retention on an issued bill is already withheld at the old rate, and ' +
            'moving the basis would make the subcontractor’s copy disagree with ours about money ' +
            'already held.',
        });
      }

      // 028 FR-009. `completed` is an ordinary edit — closing out a finished award. The other
      // three are not, and each is refused by name rather than ignored, because a status silently
      // dropped is a screen that looks like it saved something it did not.
      if (
        input.status !== undefined &&
        input.status !== WorkOrderStatus.completed
      ) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'WORK_ORDER_STATUS_NOT_SETTABLE',
          message:
            input.status === WorkOrderStatus.active
              ? 'An award becomes active when its approval completes, never by being set. Send ' +
                'it for approval instead.'
              : input.status === WorkOrderStatus.pending_approval
              ? 'Send the award for approval rather than setting this status — submitting is ' +
                'what puts it in front of an approver.'
              : 'An award that has been approved cannot be returned to draft: the approval has ' +
                'already been given, and a draft would carry it silently.',
        });
      }

      await tx.workOrder.update({
        where: { id },
        data: {
          partnerId: input.partnerId ?? undefined,
          workDetail: input.workDetail?.trim(),
          terms: input.terms ?? undefined,
          requirements: input.requirements ?? undefined,
          hireContract: input.hireContract ?? undefined,
          labourAmount: input.labourAmount,
          materialAmount: input.materialAmount,
          retentionPercent: input.retentionPercent,
          status: input.status,
        },
      });
    });
    return this.view(ctx, id);
  }
}

type Row = {
  id: string;
  projectId: string;
  partnerId: string | null;
  code: string | null;
  workDetail: string;
  terms: string | null;
  requirements: string | null;
  hireContract: string | null;
  labourAmount: { toNumber(): number };
  materialAmount: { toNumber(): number };
  retentionPercent: { toNumber(): number };
  status: WorkOrderStatus;
  createdAt: Date;
  _count: { awardLines: number; raBills: number };
};

const shape = (row: Row): WorkOrderView => ({
  id: row.id,
  projectId: row.projectId,
  /** Null only on work orders raised before 027 numbered them. */
  code: row.code,
  partnerId: row.partnerId,
  workDetail: row.workDetail,
  terms: row.terms,
  requirements: row.requirements,
  hireContract: row.hireContract,
  labourAmount: row.labourAmount.toNumber(),
  materialAmount: row.materialAmount.toNumber(),
  retentionPercent: row.retentionPercent.toNumber(),
  status: row.status,
  awardLineCount: row._count.awardLines,
  billCount: row._count.raBills,
  createdAt: row.createdAt,
});
