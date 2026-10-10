import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Permission } from '@prisma/client';

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

  /** Any one of a type's declared permissions, or no declaration at all. */
  private permitted(provider: ReportProvider, held: Permission[]): boolean {
    return (
      !provider.requires ||
      provider.requires.some((required) => held.includes(required))
    );
  }

  /** The types this caller may run (2026-10-10 — see `ReportProvider.requires`). */
  types(held: Permission[]): ReportTypeSummary[] {
    return this.providers
      .filter((p) => this.permitted(p, held))
      .map((p) => ({
        id: p.id,
        name: p.name,
        isAvailable: p.isAvailable(),
        filters: p.filters,
      }));
  }

  /**
   * One type by id, or a 404.
   *
   * **A type the caller may not run is the same 404 as one that does not exist**, on
   * the reasoning `PROJECT_STAGED_DOCUMENT_UNKNOWN` already records: distinguishing
   * them lets a caller enumerate the reports they are not allowed to run. The list
   * above has already omitted it, so there is nothing to tell them it was ever there.
   */
  find(id: string, held: Permission[]): ReportProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider || !this.permitted(provider, held)) {
      throw new NotFoundException('Unknown report type');
    }
    return provider;
  }

  async run(
    ctx: DashboardContext,
    id: string,
    params: ReportRunParams,
  ): Promise<ReportResult> {
    const provider = this.find(id, ctx.user.permissions);
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
