import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { ClientReceiptsService } from '../../projects/billing/client-receipts.service';
import { ProjectPnlService } from '../../projects/pnl/project-pnl.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import type { DashboardContext } from '../context';
import type {
  FilterSpec,
  ReportData,
  ReportProvider,
  ReportRunParams,
} from './report.types';

/**
 * The two project money reports (spec FR-019), both read through
 * `ProjectPnlService` — the service behind the P&L screen (Principle I).
 *
 * They were placeholders blaming "the projects module", built since 008. Worse than
 * stale for the P&L one: a working P&L screen has existed at
 * `/dashboard/projects/pnl` the whole time, so the report told a reader the figures
 * were unavailable while a page two clicks away showed them.
 *
 * **Reusing that service rather than re-deriving.** Revenue here is billed gross
 * excluding retention on bills that have left draft, and cost is the five registry-backed
 * categories plus subcontract. A second implementation would be a second answer to the
 * same question, and the one a director quotes would be whichever they opened last.
 *
 * `unavailableCategories` is carried through to its own column rather than silently
 * zeroed — the distinction `ProjectPnl` exists to preserve: "we could not ask" is not
 * "nothing was spent", and a project looks profitable when half its costs are invisible.
 */

/** The `YYYY-MM` a run was asked for, defaulting to the current month. */
function periodOf(params: ReportRunParams): string {
  if (params.fromDate && /^\d{4}-\d{2}/.test(params.fromDate)) {
    return params.fromDate.slice(0, 7);
  }
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

/** Shared by both reports: every project in the company, with its position. */
async function positions(
  ctx: DashboardContext,
  projects: ProjectsService,
  pnl: ProjectPnlService,
  period: string,
) {
  const all = await projects.getProjectsWithContractValues(ctx.companyId);
  if (all.length === 0) return { all, summaries: new Map() };
  const summaries = await pnl.summariesFor(
    ctx.rls,
    ctx.companyId,
    all.map((project) => project.projectId),
    period,
  );
  return { all, summaries };
}

/** Revenue, cost and margin per project (spec FR-019). */
@Injectable()
export class PnlReportProvider implements ReportProvider {
  readonly id = 'pnl';
  readonly name = 'P&L';
  /** The same permission `/projects/pnl` is gated on — this is the same data. */
  readonly requires = [Permission.PROJECT_FINANCIALS];
  readonly filters: FilterSpec[] = [
    { key: 'fromDate', label: 'Month', type: 'date' },
  ];

  constructor(
    private readonly projects: ProjectsService,
    private readonly pnl: ProjectPnlService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async run(
    ctx: DashboardContext,
    params: ReportRunParams,
  ): Promise<ReportData> {
    const period = periodOf(params);
    const { all, summaries } = await positions(
      ctx,
      this.projects,
      this.pnl,
      period,
    );

    return {
      columns: [
        { key: 'project', label: 'Project' },
        { key: 'contractValue', label: 'Contract value', type: 'money' },
        { key: 'revenueMonthly', label: `Billed in ${period}`, type: 'money' },
        { key: 'revenueCumulative', label: 'Billed to date', type: 'money' },
        { key: 'costCumulative', label: 'Cost to date', type: 'money' },
        { key: 'marginCumulative', label: 'Margin to date', type: 'money' },
        { key: 'notCounted', label: 'Cost sources unavailable' },
      ],
      rows: all.map((project) => {
        const position = summaries.get(project.projectId);
        return {
          project: project.name,
          contractValue: project.contractValue,
          revenueMonthly: position?.revenueMonthly ?? 0,
          revenueCumulative: position?.revenueCumulative ?? 0,
          costCumulative: position?.costCumulative ?? 0,
          marginCumulative: position?.marginCumulative ?? 0,
          // Named, never zeroed. A blank here means every source answered.
          notCounted: position?.unavailableCategories.join(', ') ?? '',
        };
      }),
    };
  }
}

/**
 * Cost per project per category, against budget (spec FR-019).
 *
 * One row per project **per category**, not a wide row with a column each: the
 * categories are registry-backed and a module registering a sixth would otherwise need
 * this file edited to appear at all.
 */
@Injectable()
export class ProjectCostReportProvider implements ReportProvider {
  readonly id = 'project-cost';
  readonly name = 'Project Cost';
  readonly requires = [Permission.PROJECT_FINANCIALS];
  readonly filters: FilterSpec[] = [
    { key: 'fromDate', label: 'Month', type: 'date' },
  ];

  constructor(
    private readonly projects: ProjectsService,
    private readonly pnl: ProjectPnlService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async run(
    ctx: DashboardContext,
    params: ReportRunParams,
  ): Promise<ReportData> {
    const period = periodOf(params);
    const { all, summaries } = await positions(
      ctx,
      this.projects,
      this.pnl,
      period,
    );

    const rows: Record<string, unknown>[] = [];
    for (const project of all) {
      const position = summaries.get(project.projectId);
      if (!position) continue;
      for (const category of position.categories) {
        rows.push({
          project: project.name,
          category: category.category,
          monthly: category.monthly,
          cumulative: category.cumulative,
          // Blank, not zero: null means nobody set a budget, which is a different
          // fact from a budget of nothing and leads somewhere different.
          budget: category.budget ?? '',
          variance: category.variance ?? '',
        });
      }
    }

    return {
      columns: [
        { key: 'project', label: 'Project' },
        { key: 'category', label: 'Category' },
        { key: 'monthly', label: `Spent in ${period}`, type: 'money' },
        { key: 'cumulative', label: 'Spent to date', type: 'money' },
        { key: 'budget', label: 'Budget', type: 'money' },
        { key: 'variance', label: 'Variance', type: 'money' },
      ],
      rows,
    };
  }
}

/**
 * What each client is holding of ours, per project (048): retention withheld and released, CPBG
 * deducted and refunded, and whether a PBG is running while CPBG is still held.
 *
 * Read through `ClientReceiptsService`, the service behind the project screen's held-by-client
 * panel, so the report and the screen cannot disagree.
 */
@Injectable()
export class ClientHoldingsReportProvider implements ReportProvider {
  readonly id = 'client-holdings';
  readonly name = 'Held by client (retention & CPBG)';
  readonly requires = [Permission.PROJECT_FINANCIALS];
  readonly filters: FilterSpec[] = [];

  constructor(
    private readonly projects: ProjectsService,
    private readonly receipts: ClientReceiptsService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async run(ctx: DashboardContext): Promise<ReportData> {
    const all = await this.projects.getProjectsWithContractValues(
      ctx.companyId,
    );
    const holdings = await this.receipts.holdingsForProjects(
      ctx.rls,
      all.map((project) => project.projectId),
    );
    return {
      columns: [
        { key: 'project', label: 'Project' },
        { key: 'received', label: 'Received from client', type: 'money' },
        {
          key: 'retentionWithheld',
          label: 'Retention withheld',
          type: 'money',
        },
        {
          key: 'retentionReleased',
          label: 'Retention released',
          type: 'money',
        },
        { key: 'retentionHeld', label: 'Retention held', type: 'money' },
        { key: 'cpbgDeducted', label: 'CPBG deducted', type: 'money' },
        { key: 'cpbgRefunded', label: 'CPBG refunded', type: 'money' },
        { key: 'cpbgHeld', label: 'CPBG held', type: 'money' },
        { key: 'totalHeld', label: 'Total held by client', type: 'money' },
        { key: 'pbg', label: 'PBG running' },
      ],
      rows: all.map((project) => {
        const h = holdings.get(project.projectId);
        return {
          project: project.name,
          received: Number(h?.received ?? 0),
          retentionWithheld: Number(h?.retention.withheld ?? 0),
          retentionReleased: Number(h?.retention.released ?? 0),
          retentionHeld: Number(h?.retention.held ?? 0),
          cpbgDeducted: Number(h?.cpbg.deducted ?? 0),
          cpbgRefunded: Number(h?.cpbg.refunded ?? 0),
          cpbgHeld: Number(h?.cpbg.held ?? 0),
          totalHeld: Number(h?.totalHeld ?? 0),
          pbg: !h?.runningPbgs.length
            ? ''
            : h.cpbgRefundDue
            ? 'Yes — CPBG refund due'
            : 'Yes',
        };
      }),
    };
  }
}
