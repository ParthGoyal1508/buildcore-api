import { Injectable } from '@nestjs/common';
import {
  LeaveApplicationStatus,
  MaintenanceStatus,
  ReimbursementClaimStatus,
} from '@prisma/client';

import type { ListClaimsQueryDto } from '../../payroll/reimbursements-admin/dto/decide-claim.dto';
import { ReimbursementsAdminService } from '../../payroll/reimbursements-admin/reimbursements-admin.service';
import { EmployeesService } from '../../hr/employees/employees.service';
import { LeaveService } from '../../hr/leave/leave.service';
import type { ListMaintenanceDto } from '../../plant/maintenance/dto/maintenance.dto';
import { MaintenanceService } from '../../plant/maintenance/maintenance.service';
import type { DashboardContext } from '../context';
import { CompanyDataService } from './company-data.service';
import type { WidgetProvider } from './widget.types';

/** Total active employees in the caller's company (spec FR-005). */
@Injectable()
export class TotalEmployeesWidget implements WidgetProvider {
  readonly id = 'total-employees';
  readonly displayType = 'kpi' as const;
  readonly title = 'Total Employees';
  readonly section = 'kpi' as const;
  constructor(private readonly employees: EmployeesService) {}
  isAvailable(): boolean {
    return true;
  }
  compute(ctx: DashboardContext): Promise<number> {
    return this.employees.countActiveByCompany(ctx.rls, ctx.companyId);
  }
}

/** Employees present today (a recorded in-punch) (spec FR-005). */
@Injectable()
export class PresentTodayWidget implements WidgetProvider {
  readonly id = 'present-today';
  readonly displayType = 'kpi' as const;
  readonly title = 'Present Today';
  readonly section = 'kpi' as const;
  constructor(private readonly data: CompanyDataService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await this.data.todaySummary(ctx)).present;
  }
}

/** Employees neither present nor on approved leave today (spec FR-005). */
@Injectable()
export class AbsentTodayWidget implements WidgetProvider {
  readonly id = 'absent-today';
  readonly displayType = 'kpi' as const;
  readonly title = 'Absent';
  readonly section = 'kpi' as const;
  constructor(private readonly data: CompanyDataService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await this.data.todaySummary(ctx)).absent;
  }
}

/** Employees on approved leave today (spec FR-005). */
@Injectable()
export class OnLeaveWidget implements WidgetProvider {
  readonly id = 'on-leave';
  readonly displayType = 'kpi' as const;
  readonly title = 'On Leave';
  readonly section = 'kpi' as const;
  constructor(private readonly data: CompanyDataService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await this.data.todaySummary(ctx)).onLeave;
  }
}

/**
 * Pending approvals across the built modules — pending leave applications, open
 * maintenance jobs, and submitted reimbursement claims (spec FR-005, research.md §8,
 * master PRD §7.2.1). Each source is read through its owning module's exported
 * service and summed in parallel.
 */
@Injectable()
export class PendingApprovalsWidget implements WidgetProvider {
  readonly id = 'pending-approvals';
  readonly displayType = 'kpi' as const;
  readonly title = 'Pending Approvals';
  readonly section = 'kpi' as const;
  constructor(
    private readonly leave: LeaveService,
    private readonly maintenance: MaintenanceService,
    private readonly reimbursements: ReimbursementsAdminService,
  ) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    const [pendingLeave, openMaintenance, submittedClaims] = await Promise.all([
      this.leave
        .listForReview(ctx.caller, LeaveApplicationStatus.pending)
        .then((rows) => rows.length),
      this.maintenance
        .findAll(ctx.user, {
          status: MaintenanceStatus.open,
        } as ListMaintenanceDto)
        .then((res) => res.total),
      this.reimbursements
        .listClaims(ctx.caller, ctx.companyId, {
          status: ReimbursementClaimStatus.submitted,
        } as ListClaimsQueryDto)
        .then((res) => res.total),
    ]);
    return pendingLeave + openMaintenance + submittedClaims;
  }
}
