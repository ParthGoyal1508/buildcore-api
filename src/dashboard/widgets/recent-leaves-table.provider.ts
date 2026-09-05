import { Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { CompanyDataService } from './company-data.service';
import type { WidgetProvider } from './widget.types';

/** The most recently applied leaves, applicant names resolved (spec FR-006). */
@Injectable()
export class RecentLeavesTableWidget implements WidgetProvider {
  readonly id = 'recent-leaves';
  readonly displayType = 'table' as const;
  readonly title = 'Recent Leaves';
  readonly section = 'table' as const;

  constructor(private readonly data: CompanyDataService) {}

  isAvailable(): boolean {
    return true;
  }

  async compute(ctx: DashboardContext): Promise<{
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  }> {
    const rows = await this.data.recentLeaves(ctx);
    return {
      columns: [
        { key: 'employeeName', label: 'Employee' },
        { key: 'leaveType', label: 'Type' },
        { key: 'fromDate', label: 'From' },
        { key: 'toDate', label: 'To' },
        { key: 'dayCount', label: 'Days' },
        { key: 'status', label: 'Status' },
      ],
      rows: rows.map((r) => ({ ...r })),
    };
  }
}
