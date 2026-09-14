import { Logger } from '@nestjs/common';
import { ExceptionResolution } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  ApprovalReconciler,
  ApprovalReconcilerProvider,
  ReconciledItem,
} from '../../approvals/approval-reconciler';
import { ACTION_ATTENDANCE_EXCEPTION } from '../../approvals/default-chains';
import { withRlsContext } from '../../common/prisma/rls-context';

/**
 * Answers the reconciliation sweep on behalf of attendance exceptions (016 T052).
 *
 * Lives in `src/hr/` and reads only `hr` tables. The spine asks; `hr` answers about its
 * own schema. That is research.md §1's "via that module's service, not a join" made
 * literal, and it is why the sweep can cover seven modules without the spine importing
 * any of them.
 *
 * Registered by decorating a provider in this module's own `providers` array. Nothing in
 * `src/approvals/` changes when a module joins the sweep — the same guarantee, and the
 * same mechanism, as `@ReminderRule()`.
 */
@ApprovalReconcilerProvider()
export class AttendanceExceptionReconciler implements ApprovalReconciler {
  readonly entityType = ACTION_ATTENDANCE_EXCEPTION;
  private readonly logger = new Logger(AttendanceExceptionReconciler.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconcile(
    companyId: string,
    entityIds: string[],
    spineStates: Map<string, string>,
  ): Promise<ReconciledItem[]> {
    const punches = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.punchRecord.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, exceptionResolution: true },
        }),
    );

    const byId = new Map(punches.map((p) => [p.id, p]));

    return entityIds.map((entityId): ReconciledItem => {
      const punch = byId.get(entityId);
      if (!punch) {
        // The orphan case. A punch is not hard-deleted by any current path, so this is
        // expected to stay empty — which is exactly why it is worth watching: the day it
        // stops being empty, something changed that nobody meant to change.
        return { entityId, exists: false, inStep: null };
      }

      // The spine's states here are live ones — pending or returned — so the punch should
      // still read `pending`. Anything else means the punch was resolved by a path that
      // did not go through the chain, which is the single-step behaviour this feature
      // replaced and would be a genuine regression rather than a failed write.
      const spineState = spineStates.get(entityId);
      const inStep = punch.exceptionResolution === ExceptionResolution.pending;

      if (!inStep) {
        this.logger.warn(
          `Punch ${entityId} reads "${punch.exceptionResolution}" while its approval is ` +
            `"${spineState}". It was resolved outside the chain.`,
        );
      }

      return { entityId, exists: true, inStep };
    });
  }
}
