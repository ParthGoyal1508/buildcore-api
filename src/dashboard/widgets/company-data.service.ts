import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeaveApplicationStatus, type LeaveApplication } from '@prisma/client';

import type { SettingsConfig } from '../../common/configs/config.interface';
import {
  AttendanceAdminService,
  type DailyAttendanceRow,
} from '../../hr/attendance/attendance-admin.service';
import type { DailyAttendanceQueryDto } from '../../hr/attendance/dto/mark-attendance.dto';
import { EmployeesService } from '../../hr/employees/employees.service';
import { LeaveService } from '../../hr/leave/leave.service';
import { once, type DashboardContext } from '../context';

/** The day's attendance headcount, as the KPI cards read it. */
export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  onLeave: number;
}

/** One Recent-Leaves row, applicant name already resolved. */
export interface RecentLeaveRow {
  employeeCode: string;
  employeeName: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  dayCount: number;
  status: string;
}

/**
 * The reads several company / site widgets share, computed through `hr`'s exported
 * services (Principle I) and memoised per request via {@link once} so eight cards
 * resolving in parallel do not each re-query the day's attendance (spec SC-001).
 */
@Injectable()
export class CompanyDataService {
  private readonly timezone: string;

  constructor(
    private readonly attendance: AttendanceAdminService,
    private readonly leave: LeaveService,
    private readonly employees: EmployeesService,
    configService: ConfigService,
  ) {
    this.timezone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** Today, as a `YYYY-MM-DD` string in the configured business timezone. */
  today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
    }).format(new Date());
  }

  /** The day's attendance rows for the company, or one site when `ctx.siteId` is set. */
  todayAttendance(ctx: DashboardContext): Promise<DailyAttendanceRow[]> {
    const key = `todayAttendance:${ctx.siteId ?? 'all'}`;
    return once(ctx, key, () =>
      this.attendance.daily(ctx.caller, ctx.companyId, {
        date: this.today(),
        siteId: ctx.siteId,
      } as DailyAttendanceQueryDto),
    );
  }

  /** Total / present / absent / on-leave for today (spec FR-005). */
  todaySummary(ctx: DashboardContext): Promise<AttendanceSummary> {
    const key = `todaySummary:${ctx.siteId ?? 'all'}`;
    return once(ctx, key, async () => {
      const today = this.today();
      const rows = await this.todayAttendance(ctx);
      const activeIds = new Set(rows.map((r) => r.employeeId));
      const presentIds = new Set(
        rows.filter((r) => r.inTime).map((r) => r.employeeId),
      );
      const approved = await this.approvedLeaves(ctx);
      const onLeaveIds = new Set(
        approved
          .filter((a) => this.covers(a, today))
          .map((a) => a.employeeId)
          .filter((id) => activeIds.has(id) && !presentIds.has(id)),
      );
      const total = rows.length;
      const present = presentIds.size;
      const onLeave = onLeaveIds.size;
      return {
        total,
        present,
        absent: Math.max(0, total - present - onLeave),
        onLeave,
      };
    });
  }

  /** The most recently applied leaves, applicant names resolved (spec FR-006). */
  recentLeaves(ctx: DashboardContext, limit = 5): Promise<RecentLeaveRow[]> {
    return once(ctx, `recentLeaves:${limit}`, async () => {
      const all = await this.leave.listForReview(ctx.caller);
      const recent = [...all]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
      const names = await this.employees.namesByIds(
        ctx.rls,
        recent.map((a) => a.employeeId),
      );
      return recent.map((a) => {
        const who = names.get(a.employeeId);
        return {
          employeeCode: who?.employeeCode ?? '',
          employeeName: who?.name ?? '',
          leaveType: a.leaveType,
          fromDate: this.dateOnly(a.fromDate),
          toDate: this.dateOnly(a.toDate),
          dayCount: Number(a.dayCount),
          status: a.status,
        };
      });
    });
  }

  private approvedLeaves(ctx: DashboardContext): Promise<LeaveApplication[]> {
    return once(ctx, 'approvedLeaves', () =>
      this.leave.listForReview(ctx.caller, LeaveApplicationStatus.approved),
    );
  }

  private covers(a: LeaveApplication, today: string): boolean {
    const from = this.dateOnly(a.fromDate);
    const to = this.dateOnly(a.toDate);
    return from <= today && today <= to;
  }

  /** A `@db.Date` column comes back as UTC midnight; its stored day is its ISO date. */
  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
