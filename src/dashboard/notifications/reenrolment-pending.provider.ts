import { Injectable } from '@nestjs/common';
import { Permission, ReEnrolmentRequestStatus } from '@prisma/client';

import { FaceEnrolmentService } from '../../hr/biometrics/face-enrolment.service';
import type { DashboardContext } from '../context';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * Biometric re-enrolment requests awaiting a decision (spec FR-010). Read through
 * `hr`'s exported enrolment service; computed live, so it clears itself once every
 * request is decided.
 */
@Injectable()
export class ReenrolmentPendingProvider implements NotificationProvider {
  readonly type = 'reenrolment_pending';
  /** `EMPLOYEES` — what `/hr/re-enrolment-requests` is gated on. */
  readonly requires = Permission.EMPLOYEES;

  constructor(private readonly enrolment: FaceEnrolmentService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const pending = await this.enrolment.listReEnrolmentRequests(
      ctx.caller,
      ReEnrolmentRequestStatus.pending,
    );
    if (pending.length === 0) return [];
    const occurredAt = pending
      .map((r) => r.createdAt.getTime())
      .reduce((max, t) => Math.max(max, t), 0);
    return [
      {
        type: this.type,
        severity: 'orange',
        title: 'Biometric Re-enrolment Requests',
        subtitle: `${pending.length} request${
          pending.length === 1 ? '' : 's'
        } to review`,
        actionLink: '/dashboard/hr/re-enrolment-requests',
        occurredAt: new Date(occurredAt).toISOString(),
        // 036 D6: unread again when a newer request arrives, not when one is dealt with.
        fingerprint: new Date(occurredAt).toISOString(),
      },
    ];
  }
}
