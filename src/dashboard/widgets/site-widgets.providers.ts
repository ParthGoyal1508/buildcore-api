import { Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { CompanyDataService } from './company-data.service';
import type { WidgetProvider } from './widget.types';

/**
 * Workers present at the selected site today (spec FR-012). Reads the same day's
 * attendance the company dashboard does, narrowed to `ctx.siteId`.
 */
@Injectable()
export class WorkersTodayWidget implements WidgetProvider {
  readonly id = 'workers-today';
  readonly displayType = 'kpi' as const;
  readonly title = 'Workers Today';
  readonly section = 'site' as const;

  constructor(private readonly data: CompanyDataService) {}

  isAvailable(): boolean {
    return true;
  }

  async compute(ctx: DashboardContext): Promise<number> {
    return (await this.data.todaySummary(ctx)).present;
  }
}

/** The selected site's attendance for today, as a table (spec FR-012). */
@Injectable()
export class SiteAttendanceTableWidget implements WidgetProvider {
  readonly id = 'site-today-attendance';
  readonly displayType = 'table' as const;
  readonly title = "Today's Attendance";
  readonly section = 'site' as const;

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
      rows: rows.map((r) => ({
        employeeCode: r.employeeCode,
        name: r.name,
        inTime: r.inTime,
        outTime: r.outTime,
        status: r.statusOverride ?? (r.inTime ? 'present' : 'absent'),
      })),
    };
  }
}
