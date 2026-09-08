import { Injectable } from '@nestjs/common';
import { ReimbursementClaimStatus } from '@prisma/client';

import type { ListClaimsQueryDto } from '../../payroll/reimbursements-admin/dto/decide-claim.dto';
import { ReimbursementsAdminService } from '../../payroll/reimbursements-admin/reimbursements-admin.service';
import type { DashboardContext } from '../context';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * Payroll pending (spec FR-010): submitted reimbursement claims awaiting review, the
 * payroll-side approval this dashboard can see through `payroll`'s exported service.
 * Computed live, so it clears once the queue is empty.
 */
@Injectable()
export class PayrollPendingProvider implements NotificationProvider {
  readonly type = 'payroll_pending';

  constructor(private readonly reimbursements: ReimbursementsAdminService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const { total } = await this.reimbursements.listClaims(
      ctx.caller,
      ctx.companyId,
      { status: ReimbursementClaimStatus.submitted } as ListClaimsQueryDto,
    );
    if (total === 0) return [];
    return [
      {
        type: this.type,
        severity: 'blue',
        title: 'Payroll Pending',
        subtitle: `${total} reimbursement claim${
          total === 1 ? '' : 's'
        } to review`,
        actionLink: '/dashboard/hr/reimbursements',
        occurredAt: new Date().toISOString(),
      },
    ];
  }
}
