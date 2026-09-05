import { Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { CompanyDataService } from './company-data.service';
import type { WidgetProvider } from './widget.types';

/** The first rows of today's attendance, for the dashboard's table strip (FR-006). */
@Injectable()
export class TodayAttendanceTableWidget implements WidgetProvider {
  readonly id = 'today-attendance';
  readonly displayType = 'table' as const;
  readonly title = "Today's Attendance";
  readonly section = 'table' as const;
  private static readonly LIMIT = 8;

  constructor(private readonly data: CompanyDataService) {}

  isAvailable(): boolean {
    return true;
  }

  async compute(ctx: DashboardContext): Promise<{
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  }> {
    const rows = await this.data.todayAttendance(ctx);
    return {
      columns: [
        { key: 'employeeCode', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'inTime', label: 'In' },
        { key: 'outTime', label: 'Out' },
        { key: 'status', label: 'Status' },
      ],
      rows: rows.slice(0, TodayAttendanceTableWidget.LIMIT).map((r) => ({
        employeeCode: r.employeeCode,
        name: r.name,
        inTime: r.inTime,
        outTime: r.outTime,
        status: r.statusOverride ?? (r.inTime ? 'present' : 'absent'),
      })),
    };
  }
}
