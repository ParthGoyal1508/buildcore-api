import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { CashPolicyService } from '../../common/cash/cash-policy';
import { CASH_MODE_FIELDS, isCashMode } from '../../common/cash/cash-surfaces';

import { parseDateOnly } from '../../hr/leave/leave-days';
import type { Permission } from '@prisma/client';

import type { DashboardContext } from '../context';
import {
  REPORT_PROVIDERS,
  type ReportData,
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
    @Optional() private readonly cash?: CashPolicyService,
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
    assertReportRange(params);
    if (!provider.isAvailable()) {
      return {
        unavailable: {
          reason: 'module_pending',
          module: provider.unavailableModule ?? 'unknown',
        },
      };
    }
    const data = await provider.run(ctx, params);
    // 038 backstop, for the run and the export alike (the export calls this, and its `@Res()`
    // response never reaches the masking interceptor). The sources these reports read already
    // leave cash out; a row that still says it is cash is dropped, so a total summed from the rows
    // leaves it out too.
    return this.cash && (await this.cash.isHidden(ctx.companyId))
      ? withoutCashRows(data)
      : data;
  }
}

/** The report without any row whose payment mode names cash (038 FR-001, FR-002). */
export function withoutCashRows(data: ReportData): ReportData {
  const rows = data.rows.filter(
    (row) => !CASH_MODE_FIELDS.some((field) => isCashMode(row[field])),
  );
  return rows.length === data.rows.length ? data : { ...data, rows };
}

/** The longest range one report run covers (036 E2) — the attendance report reads one day per day. */
export const REPORT_MAX_RANGE_DAYS = 366;

/**
 * A report's range must be real dates, From not after To, and at most a year (036 E2). The DTO only
 * checks the shape: `2026-02-30` matches it and rolled silently into March, and a From after the To
 * produced an empty report that read as "no data" rather than as a mistake.
 */
export function assertReportRange(params: ReportRunParams): void {
  const parse = (value: string, label: string): Date => {
    try {
      return parseDateOnly(value);
    } catch {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `${label} is not a real calendar date.`,
      });
    }
  };
  const from = params.fromDate ? parse(params.fromDate, 'From') : null;
  const to = params.toDate ? parse(params.toDate, 'To') : null;
  if (from && to) {
    if (from > to) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'The From date must not be after the To date.',
      });
    }
    if ((to.getTime() - from.getTime()) / 86_400_000 >= REPORT_MAX_RANGE_DAYS) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `A report covers at most ${REPORT_MAX_RANGE_DAYS} days. Choose a shorter range.`,
      });
    }
  }
}
