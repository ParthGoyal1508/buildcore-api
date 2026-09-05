import { Injectable } from '@nestjs/common';

import {
  AttendanceAdminService,
  type DailyAttendanceRow,
} from '../../hr/attendance/attendance-admin.service';
import type { DailyAttendanceQueryDto } from '../../hr/attendance/dto/mark-attendance.dto';
import { LeaveService } from '../../hr/leave/leave.service';
import { LeaveApplicationStatus, type LeaveApplication } from '@prisma/client';
import type { DashboardContext } from '../context';
import type {
  FilterSpec,
  ReportData,
  ReportProvider,
  ReportRunParams,
} from './report.types';

/** How many days a single attendance report may span, to bound the day-by-day scan. */
const MAX_RANGE_DAYS = 92;

/**
 * The Attendance report (spec FR-019, US7): a company-wide present/absent/on-leave
 * headcount for each day in the requested range, computed through `hr`'s exported
 * services (Principle I).
 */
@Injectable()
export class AttendanceReportProvider implements ReportProvider {
  readonly id = 'attendance';
  readonly name = 'Attendance';
  readonly filters: FilterSpec[] = [
    { key: 'fromDate', label: 'From', type: 'date', required: true },
    { key: 'toDate', label: 'To', type: 'date', required: true },
  ];

  constructor(
    private readonly attendance: AttendanceAdminService,
    private readonly leave: LeaveService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async run(
    ctx: DashboardContext,
    params: ReportRunParams,
  ): Promise<ReportData> {
    const days = this.dateRange(params.fromDate, params.toDate);
    const approved = await this.leave.listForReview(
      ctx.caller,
      LeaveApplicationStatus.approved,
    );

    const rows = await Promise.all(
      days.map(async (date) => {
        const dayRows = await this.attendance.daily(ctx.caller, ctx.companyId, {
          date,
        } as DailyAttendanceQueryDto);
        return this.summariseDay(date, dayRows, approved);
      }),
    );

    return {
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'present', label: 'Present' },
        { key: 'absent', label: 'Absent' },
        { key: 'onLeave', label: 'On Leave' },
        { key: 'total', label: 'Total' },
      ],
      rows,
    };
  }

  private summariseDay(
    date: string,
    dayRows: DailyAttendanceRow[],
    approved: LeaveApplication[],
  ): Record<string, unknown> {
    const activeIds = new Set(dayRows.map((r) => r.employeeId));
    const presentIds = new Set(
      dayRows.filter((r) => r.inTime).map((r) => r.employeeId),
    );
    const onLeave = new Set(
      approved
        .filter(
          (a) =>
            a.fromDate.toISOString().slice(0, 10) <= date &&
            date <= a.toDate.toISOString().slice(0, 10),
        )
        .map((a) => a.employeeId)
        .filter((id) => activeIds.has(id) && !presentIds.has(id)),
    ).size;
    const total = dayRows.length;
    const present = presentIds.size;
    return {
      date,
      present,
      absent: Math.max(0, total - present - onLeave),
      onLeave,
      total,
    };
  }

  private dateRange(from?: string, to?: string): string[] {
    const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date();
    const end = to ? new Date(`${to}T00:00:00.000Z`) : start;
    const days: string[] = [];
    for (
      let d = new Date(start);
      d <= end && days.length < MAX_RANGE_DAYS;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10));
    }
    return days.length > 0 ? days : [new Date().toISOString().slice(0, 10)];
  }
}
