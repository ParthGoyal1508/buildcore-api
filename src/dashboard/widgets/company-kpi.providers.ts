import { Injectable } from '@nestjs/common';
import {
  LeaveApplicationStatus,
  MaintenanceStatus,
  Permission,
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
  /** `EMPLOYEES` — the headcount is the roster's figure, and the roster is gated. */
  readonly requires = [Permission.EMPLOYEES];
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
  /** `ATTENDANCE` — what every attendance and leave screen is gated on. */
  readonly requires = [Permission.ATTENDANCE];
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
  /** `ATTENDANCE` — what every attendance and leave screen is gated on. */
  readonly requires = [Permission.ATTENDANCE];
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
  /** `ATTENDANCE` — what every attendance and leave screen is gated on. */
  readonly requires = [Permission.ATTENDANCE];
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
  /**
   * Any one of the three areas it sums. The widget then counts only that caller's
   * share — see `compute`, where the filter is repeated per source, because a single
   * gate on a figure made of three modules would disclose the other two.
   */
  readonly requires = [
    Permission.ATTENDANCE,
    Permission.MAINTENANCE,
    Permission.EMPLOYEES,
  ];
  constructor(
    private readonly leave: LeaveService,
    private readonly maintenance: MaintenanceService,
    private readonly reimbursements: ReimbursementsAdminService,
  ) {}
  isAvailable(): boolean {
    return true;
  }
  /**
   * Counts only the sources the caller may act on.
   *
   * The registry's own filter admits anyone holding *one* of the three, which is right —
   * a plant supervisor should see their open maintenance jobs. It is not sufficient: a
   * single total would then carry the leave and claim counts they cannot see, and a KPI
   * is no less a disclosure for being a sum. So each source is asked for separately,
   * and a source the caller holds nothing for is **not queried at all**.
   */
  async compute(ctx: DashboardContext): Promise<number> {
    const holds = (permission: Permission): boolean =>
      ctx.user.permissions.includes(permission);

    const counts = await Promise.all([
      holds(Permission.ATTENDANCE)
        ? this.leave
            .listForReview(ctx.caller, LeaveApplicationStatus.pending)
            .then((rows) => rows.length)
        : 0,
      holds(Permission.MAINTENANCE)
        ? this.maintenance
            .findAll(ctx.user, {
              status: MaintenanceStatus.open,
            } as ListMaintenanceDto)
            .then((res) => res.total)
        : 0,
      holds(Permission.EMPLOYEES)
        ? this.reimbursements
            .listClaims(ctx.caller, ctx.companyId, {
              status: ReimbursementClaimStatus.submitted,
            } as ListClaimsQueryDto)
            .then((res) => res.total)
        : 0,
    ]);
    return counts.reduce((sum, n) => sum + n, 0);
  }
}
