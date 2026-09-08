import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { DashboardContext } from '../context';
import {
  REPORT_PROVIDERS,
  type ReportProvider,
  type ReportResult,
  type ReportRunParams,
} from './report.types';

/** One report type's summary, as `GET /reports/types` lists it. */
export interface ReportTypeSummary {
  id: string;
  name: string;
  isAvailable: boolean;
  filters: ReportProvider['filters'];
}

/**
 * The report-type registry (spec FR-018, US7). Injects every registered
 * {@link ReportProvider}; lists them and runs one by id — an unavailable type yields
 * the widget-style `unavailable` envelope rather than an error (contracts).
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(REPORT_PROVIDERS) private readonly providers: ReportProvider[],
  ) {}

  types(): ReportTypeSummary[] {
    return this.providers.map((p) => ({
      id: p.id,
      name: p.name,
      isAvailable: p.isAvailable(),
      filters: p.filters,
    }));
  }

  find(id: string): ReportProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new NotFoundException('Unknown report type');
    return provider;
  }

  async run(
    ctx: DashboardContext,
    id: string,
    params: ReportRunParams,
  ): Promise<ReportResult> {
    const provider = this.find(id);
    if (!provider.isAvailable()) {
      return {
        unavailable: {
          reason: 'module_pending',
          module: provider.unavailableModule ?? 'unknown',
        },
      };
    }
    return provider.run(ctx, params);
  }
}
