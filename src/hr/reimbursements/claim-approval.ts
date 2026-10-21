import { Permission, type ReimbursementClaim } from '@prisma/client';

import type { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_REIMBURSEMENT_CLAIM } from '../../approvals/default-chains';
import { webRoutes } from '../../common/web-routes';

/**
 * Puts a submitted claim into its approval chain (2026-10-20). Shared by the employee side, which
 * submits it, and the admin side, which puts a claim filed before claims joined the spine into one
 * when it is first decided.
 *
 * The claimant never decides their own claim, whatever roles they hold.
 */
export async function submitClaimForApproval(
  approvals: ApprovalService,
  claim: Pick<
    ReimbursementClaim,
    'id' | 'companyId' | 'amount' | 'description' | 'expenseDate'
  >,
  claimant: {
    userId: string | null;
    firstName: string;
    lastName: string | null;
  },
  originatorUserId: string | null,
): Promise<void> {
  const name = `${claimant.firstName} ${claimant.lastName ?? ''}`.trim();
  const amount = Number(claim.amount).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
  });
  await approvals.submit({
    companyId: claim.companyId,
    actionType: ACTION_REIMBURSEMENT_CLAIM,
    entityType: ACTION_REIMBURSEMENT_CLAIM,
    entityId: claim.id,
    originatorUserId,
    subject: `${name} — ${amount} claim: ${claim.description}`.slice(0, 200),
    // The claims waiting in its expense month — there is no page for one claim.
    href: `${webRoutes.hrReimbursements()}?status=submitted&month=${claim.expenseDate
      .toISOString()
      .slice(0, 7)}`,
    viewPermission: Permission.PAYROLL,
    excludedUserIds: [claimant.userId, originatorUserId],
  });
}
