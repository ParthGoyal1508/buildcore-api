import { Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { CompanyDataService } from './company-data.service';
import type { WidgetProvider } from './widget.types';

/**
 * Employees on muster — present against total headcount for the day (spec Acceptance
 * Scenario 5). A `stat` widget: two numbers the sidebar renders as "present / total".
 */
@Injectable()
export class MusterStatWidget implements WidgetProvider {
  readonly id = 'employees-on-muster';
  readonly displayType = 'stat' as const;
  readonly title = 'Employees on Muster';
  readonly section = 'sidebar' as const;

  constructor(private readonly data: CompanyDataService) {}

  isAvailable(): boolean {
    return true;
  }

  async compute(
    ctx: DashboardContext,
  ): Promise<{ present: number; total: number }> {
    const summary = await this.data.todaySummary(ctx);
    return { present: summary.present, total: summary.total };
  }
}
