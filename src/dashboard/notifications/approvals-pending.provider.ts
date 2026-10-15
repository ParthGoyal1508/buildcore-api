import { Injectable } from '@nestjs/common';

import { ApprovalService } from '../../approvals/approvals.service';
import type { DashboardContext } from '../context';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * Approvals awaiting the caller, one row per kind of item (2026-10-15) — "3 RA bills", "1 payroll
 * run". The client: "we are not seeing all the notifications, like notifications for different
 * approvals". Until this the bell knew only leave and reimbursement claims, which do not travel
 * through the approvals spine, so a bill or a payroll run waiting on someone told them nothing.
 *
 * No `requires`: the queue is already the caller's own — what their roles' steps hold, and what
 * was delegated to them — so it needs no permission beyond reaching it.
 */
@Injectable()
export class ApprovalsPendingProvider implements NotificationProvider {
  readonly type = 'approvals_pending';

  constructor(private readonly approvals: ApprovalService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const { items } = await this.approvals.queueFor(ctx.user, { limit: 100 });
    const byKind = new Map<string, typeof items>();
    for (const item of items) {
      byKind.set(item.actionType, [
        ...(byKind.get(item.actionType) ?? []),
        item,
      ]);
    }
    return [...byKind.values()].map((group) => {
      const oldest = group.reduce((a, b) =>
        a.requestedAt < b.requestedAt ? a : b,
      );
      const one = group.length === 1;
      return {
        type: this.type,
        // A day waiting is long enough to read as overdue in a queue meant to move.
        severity: oldest.ageHours >= 24 ? 'orange' : 'yellow',
        title: `${group.length} ${kindLabel(
          oldest.actionType,
          oldest.moduleLabel,
        )}${one ? '' : 's'} awaiting your approval`,
        subtitle: one
          ? `${oldest.subject} — from ${oldest.requestedByName}`
          : `Oldest: ${oldest.subject}`,
        actionLink: '/dashboard/approvals',
        occurredAt: oldest.requestedAt.toISOString(),
      };
    });
  }
}

/** What one item of a kind is called in a sentence. */
const KIND_LABELS: Record<string, string> = {
  ra_bill: 'RA bill',
  client_bill: 'client bill',
  payroll_run: 'payroll run',
  payment_release: 'payment release',
  dwr: 'daily work report',
  work_order_award: 'work order',
  letter_work_order: 'work order letter',
  letter_loi: 'letter of intent',
  letter_purchase_order: 'purchase order',
  final_settlement: 'final settlement',
  attendance_exception: 'attendance exception',
  attendance_correction: 'attendance correction',
  operator_fuel_recovery: 'fuel recovery',
  exit_clearance_waiver: 'exit clearance waiver',
  purchase_rate_change: 'purchase rate change',
  director_final_set_change: 'director final change',
};

function kindLabel(actionType: string, moduleLabel: string): string {
  return KIND_LABELS[actionType] ?? `${moduleLabel} item`;
}
