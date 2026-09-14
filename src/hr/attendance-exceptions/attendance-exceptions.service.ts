import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ApprovalDecisionAction,
  AuditAction,
  AuditEntityType,
  ExceptionResolution,
  Prisma,
  PunchRecord,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  ApprovalCompletedEvent,
  ApprovalService,
} from '../../approvals/approvals.service';
import { ACTION_ATTENDANCE_EXCEPTION } from '../../approvals/default-chains';
import type { ApprovalInstanceView } from '../../approvals/approval.types';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';

/** A flagged punch with the spine's view of where it has got to (FR-007, FR-008). */
export interface AttendanceExceptionRow {
  punch: PunchRecord;
  /**
   * Null when the punch never entered a chain — a pre-016 row, or one whose submission
   * failed. Rendered as the legacy single-step state rather than as an error.
   */
  approval: ApprovalInstanceView | null;
}

/**
 * Attendance exceptions on the approval spine (016 US1, FR-012).
 *
 * Before this feature, a flagged punch was resolved by one person in one step. It now
 * travels Employer → HR → Director, and this service is the seam: it translates the
 * existing `/resolve` contract into a decision on the chain, and applies the chain's
 * outcome back onto the punch.
 *
 * **`ApprovalInstance.state` is the source of truth** (research.md §8).
 * `PunchRecord.exceptionResolution` is kept in step as a derived convenience — it is what
 * the payroll and attendance read paths already query — but where the two disagree, the
 * spine is right and the punch is stale.
 */
@Injectable()
export class AttendanceExceptionsService {
  private readonly logger = new Logger(AttendanceExceptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * The pending queue, each row carrying the chain state the interface renders (T026).
   *
   * Uses `statesOf`, never `stateOf` per row. Calling the single form in this loop is the
   * obvious mistake and produces an N+1 against the spine from a list that grows with the
   * workforce (contract Part 1).
   */
  async listPending(
    caller: Caller,
    viewer: AuthenticatedUser,
  ): Promise<AttendanceExceptionRow[]> {
    const punches = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: { exceptionResolution: ExceptionResolution.pending },
        orderBy: { capturedAt: 'desc' },
      }),
    );
    if (punches.length === 0) return [];

    const states = await this.approvals.statesOf(
      ACTION_ATTENDANCE_EXCEPTION,
      punches.map((p) => p.id),
      viewer,
    );

    return punches.map((punch) => ({
      punch,
      approval: states.get(punch.id) ?? null,
    }));
  }

  /** One flagged punch and its chain state. */
  async getOne(
    caller: Caller,
    viewer: AuthenticatedUser,
    punchId: string,
  ): Promise<AttendanceExceptionRow> {
    const punch = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findFirst({ where: { id: punchId } }),
    );
    if (!punch) throw new NotFoundException('Punch record not found');

    return {
      punch,
      approval: await this.approvals.stateOf(
        ACTION_ATTENDANCE_EXCEPTION,
        punchId,
        viewer,
      ),
    };
  }

  /**
   * Records one decision on a flagged punch (T024).
   *
   * The route and the verb names are unchanged, so the interface changes once rather than
   * twice — but what happens underneath is now a decision at one level of a chain, not the
   * end of the matter. `confirmed` at the final level is what actually confirms the punch.
   *
   * Every refusal comes back from the spine with its own code, so the interface can tell
   * "somebody else's turn" from "you already decided" from "nobody has been given this
   * level yet" (FR-011).
   */
  async decide(
    caller: Caller,
    viewer: AuthenticatedUser,
    punchId: string,
    resolution: 'confirmed' | 'rejected' | 'returned',
    reason: string | null,
  ): Promise<AttendanceExceptionRow> {
    const existing = await this.approvals.stateOf(
      ACTION_ATTENDANCE_EXCEPTION,
      punchId,
      viewer,
    );
    if (!existing) {
      throw new NotFoundException(
        'This punch has no approval chain. It was either never flagged, or it predates ' +
          'approval chains and has already been resolved.',
      );
    }

    const view = await this.approvals.decide(
      {
        instanceId: existing.instanceId,
        action: ACTION_FOR_RESOLUTION[resolution],
        reason,
      },
      viewer,
      caller.ipAddress,
    );

    // The synchronous half of keeping the punch in step. The event handler below covers
    // decisions taken elsewhere — through the cross-module approval queue, say — and both
    // are idempotent, so the two converging on the same punch is harmless.
    await this.applyToPunch(punchId, view.state, caller.userId);

    await this.auditLog.record({
      entityType: AuditEntityType.PUNCH,
      action: AuditAction.UPDATE,
      entityId: punchId,
      changes: {
        decision: resolution,
        approvalState: view.state,
        atLevel: existing.currentPosition,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: caller.companyId,
      ipAddress: caller.ipAddress,
    });

    return { punch: await this.requirePunch(caller, punchId), approval: view };
  }

  /**
   * Applies a completed chain to its punch (T025).
   *
   * **Idempotent by construction**, because it will be redelivered: the event bus offers
   * no once-only guarantee, a decision can also reach the punch through `decide()` above,
   * and research.md §8 makes redelivery an explicit expectation rather than a hazard. The
   * `where` clause below only matches a punch still pending, so applying the same event
   * twice writes once.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_ATTENDANCE_EXCEPTION) return;

    try {
      await this.applyToPunch(
        event.entityId,
        'approved',
        null,
        event.companyId,
      );
    } catch (error) {
      // A handler that throws takes nothing with it — the decision is already committed
      // and the spine is authoritative — so this is logged rather than rethrown, and the
      // drift is what Phase 6's reconciliation sweep exists to report.
      this.logger.error(
        `Approval ${event.instanceId} completed but punch ${event.entityId} could not ` +
          `be updated: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /**
   * Writes the chain's outcome onto the punch's own column.
   *
   * Only terminal states touch the punch: a chain still travelling has not decided
   * anything, and writing `confirmed` at level 1 of 3 would be the single-step behaviour
   * this feature replaces.
   */
  private async applyToPunch(
    punchId: string,
    state: ApprovalInstanceView['state'],
    actorUserId: string | null,
    companyId?: string,
  ): Promise<void> {
    const resolution = RESOLUTION_FOR_STATE[state];
    if (!resolution) return;

    await withRlsContext(
      this.prisma,
      // The event path has no authenticated caller — it is the system reacting to a
      // decision that has already been authorised by the spine.
      companyId ? { isSuperAdmin: false, companyId } : { isSuperAdmin: true },
      (tx) =>
        tx.punchRecord.updateMany({
          // Idempotency lives here: a punch already resolved matches nothing.
          where: {
            id: punchId,
            exceptionResolution: ExceptionResolution.pending,
          },
          data: {
            exceptionResolution: resolution,
            resolvedByUserId: actorUserId,
            resolvedAt: new Date(),
          },
        }),
    );
  }

  private async requirePunch(
    caller: Caller,
    punchId: string,
  ): Promise<PunchRecord> {
    const punch = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findFirst({ where: { id: punchId } }),
    );
    if (!punch) throw new NotFoundException('Punch record not found');
    return punch;
  }
}

/** The existing endpoint's vocabulary, mapped onto the chain's. */
const ACTION_FOR_RESOLUTION: Record<string, ApprovalDecisionAction> = {
  confirmed: ApprovalDecisionAction.approve,
  rejected: ApprovalDecisionAction.reject,
  returned: ApprovalDecisionAction.return,
};

/**
 * And back again — but only for the states that settle the matter.
 *
 * `pending` and `returned` map to nothing: the chain is still in motion, and the punch
 * must stay pending. `abandoned` likewise leaves the punch alone; a chain closed because
 * the item was cancelled has not judged the punch.
 */
const RESOLUTION_FOR_STATE: Partial<
  Record<ApprovalInstanceView['state'], ExceptionResolution>
> = {
  approved: ExceptionResolution.confirmed,
  rejected: ExceptionResolution.rejected,
};
