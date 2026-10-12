import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import type { LeaveService } from '../../hr/leave/leave.service';
import type { MaintenanceService } from '../../plant/maintenance/maintenance.service';
import type { ReimbursementsAdminService } from '../../payroll/reimbursements-admin/reimbursements-admin.service';
import type { DashboardContext } from '../context';
import { PendingApprovalsWidget } from './company-kpi.providers';

function contextFor(permissions: Permission[]): DashboardContext {
  return {
    user: { permissions } as AuthenticatedUser,
    caller: {},
    companyId: 'c1',
  } as DashboardContext;
}

/** Each source has something pending, so a zero can only be the filter. */
function widget() {
  const asked: string[] = [];
  const leave = {
    listForReview: async () => {
      asked.push('leave');
      return [{}, {}, {}, {}] as never[];
    },
  } as unknown as LeaveService;
  const maintenance = {
    findAll: async () => {
      asked.push('maintenance');
      return { total: 20 } as never;
    },
  } as unknown as MaintenanceService;
  const reimbursements = {
    listClaims: async () => {
      asked.push('reimbursements');
      return { total: 100 } as never;
    },
  } as unknown as ReimbursementsAdminService;
  return {
    provider: new PendingApprovalsWidget(leave, maintenance, reimbursements),
    asked,
  };
}

/**
 * "Pending Approvals" sums three modules behind three different permissions, so the
 * registry's own one-of-three gate is necessary and not sufficient: a plant supervisor
 * holding only MAINTENANCE passes it, and a single total would hand them the leave and
 * claim counts inside the sum.
 *
 * The counts are 4 / 20 / 100 — distinct orders of magnitude, so the total says which
 * sources were included. A test asserting only "the caller sees a number" would pass
 * against the defect, and so would equal counts.
 */
describe('PendingApprovalsWidget — counts only the caller’s own queues (2026-10-10)', () => {
  it('sums all three for a caller holding all three', async () => {
    const { provider } = widget();
    expect(
      await provider.compute(
        contextFor([
          Permission.ATTENDANCE,
          Permission.MAINTENANCE,
          Permission.EMPLOYEES,
        ]),
      ),
    ).toBe(124);
  });

  it('counts maintenance alone for a plant supervisor', async () => {
    const { provider, asked } = widget();
    expect(await provider.compute(contextFor([Permission.MAINTENANCE]))).toBe(
      20,
    );
    // Not queried, not merely excluded from the sum.
    expect(asked).toEqual(['maintenance']);
  });

  it('counts leave alone for an attendance approver', async () => {
    const { provider } = widget();
    expect(await provider.compute(contextFor([Permission.ATTENDANCE]))).toBe(4);
  });
});
