import { Inject, Injectable } from '@nestjs/common';

import type { DashboardContext } from '../dashboard/context';
import {
  WIDGET_PROVIDERS,
  resolveWidgets,
  type WidgetProvider,
  type WidgetResult,
} from './widgets/widget.types';

/**
 * The generic widget-resolution engine (spec FR-001, FR-002). Injects every
 * registered {@link WidgetProvider} and resolves the relevant section in parallel —
 * it neither knows nor names any individual widget, which is what lets a new one be
 * added by registering a provider and nothing here (research.md §1).
 */
@Injectable()
export class DashboardService {
  private static readonly COMPANY_SECTIONS: ReadonlySet<string> = new Set([
    'kpi',
    'sidebar',
    'alerts',
    'table',
  ]);

  constructor(
    @Inject(WIDGET_PROVIDERS) private readonly providers: WidgetProvider[],
  ) {}

  /** The company dashboard's widgets (spec FR-001), in registration order. */
  companyWidgets(ctx: DashboardContext): Promise<WidgetResult[]> {
    return resolveWidgets(
      this.providers.filter((p) =>
        DashboardService.COMPANY_SECTIONS.has(p.section),
      ),
      ctx,
    );
  }

  /** The site dashboard's widgets (spec FR-012), in registration order. */
  siteWidgets(ctx: DashboardContext): Promise<WidgetResult[]> {
    return resolveWidgets(
      this.providers.filter((p) => p.section === 'site'),
      ctx,
    );
  }
}
