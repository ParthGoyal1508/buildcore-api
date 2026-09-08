import { Injectable } from '@nestjs/common';
import { LeaveApplicationStatus } from '@prisma/client';

import { LeaveService } from '../../hr/leave/leave.service';
import type { DashboardContext } from '../context';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * Pending leave approvals (spec FR-010). One aggregate row while any application
 * awaits a decision; it disappears on its own once the queue is cleared, since the
 * row is computed live, not stored (research.md §5).
 */
@Injectable()
export class LeavePendingProvider implements NotificationProvider {
  readonly type = 'leave_pending';

  constructor(private readonly leave: LeaveService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const pending = await this.leave.listForReview(
      ctx.caller,
      LeaveApplicationStatus.pending,
    );
    if (pending.length === 0) return [];
    const occurredAt = pending
      .map((a) => a.createdAt.getTime())
      .reduce((max, t) => Math.max(max, t), 0);
    return [
      {
        type: this.type,
        severity: 'yellow',
        title: 'Pending Leave Approvals',
        subtitle: `${pending.length} application${
          pending.length === 1 ? '' : 's'
        } awaiting your decision`,
        actionLink: '/dashboard/hr/leave',
        occurredAt: new Date(occurredAt).toISOString(),
      },
    ];
  }
}
