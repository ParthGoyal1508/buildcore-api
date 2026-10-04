import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ClientBillStatus,
  ProjectBudgetCategory,
  RaBillStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { money } from '../billing/bill-totals';
import { ProjectSourcesRegistry } from '../portfolio/project-sources.registry';

/** Every cost category the P&L reports, in the order a reader expects them. */
export const PNL_CATEGORIES: readonly ProjectBudgetCategory[] = [
  ProjectBudgetCategory.labour,
  ProjectBudgetCategory.materials,
  ProjectBudgetCategory.machinery,
  ProjectBudgetCategory.fuel,
  ProjectBudgetCategory.subcontractors,
  ProjectBudgetCategory.overheads,
];

export interface PnlCategoryRow {
  category: ProjectBudgetCategory;
  /** Spend in the selected month. */
  monthly: number;
  /** Spend from the project's start to the end of the selected month. */
  cumulative: number;
  /** Budgeted, where a budget was set. Null means nobody set one — not zero. */
  budget: number | null;
  /** Budget less cumulative. Null when there is no budget to vary from. */
  variance: number | null;
}

export interface ProjectPnl {
  projectId: string;
  projectName: string;
  /** `YYYY-MM`. */
  period: string;
  /** Billed to the client, at gross — see `revenueNote`. */
  revenueMonthly: number;
  revenueCumulative: number;
  /**
   * What `revenue` counts, stated on the response.
   *
   * Billed **gross**, excluding retention, and only on bills that have left draft. A reader comparing
   * this against money received will find a gap, and the gap is retention plus whatever is uncertified
   * — so the response says what it is rather than leaving somebody to discover it.
   */
  revenueNote: string;
  categories: PnlCategoryRow[];
  costMonthly: number;
  costCumulative: number;
  /** Revenue less cost, cumulative. */
  marginCumulative: number;
  /**
   * Categories whose module did not register a source (FR-010).
   *
   * **Named, never reported as zero.** "We could not ask" and "nothing was spent" are different facts,
   * and a director acts differently on each: the first is a deployment problem, the second is a
   * project running under budget. Reporting the first as the second is how a project looks profitable
   * because half its costs are invisible.
   */
  unavailableCategories: string[];
  /** True when any client bill in the period measured past its BOQ scope. */
  revenueIncludesOverScope: boolean;
  /**
   * How much of the revenue above is variation work rather than original BOQ scope (FR-015a).
   *
   * **A part of `revenue`, not an addition to it.** Original scope is `revenueCumulative` less this.
   * Reported as a part rather than as two separate totals because the two must always add up, and a
   * reader who has to add them is a reader who will one day add them wrong.
   *
   * The distinction is the one a director actually asks about: a project at 110% of its contract
   * value is doing well if the extra 10% is approved variations, and is in trouble if it is not —
   * and a single revenue figure cannot tell them which.
   */
  revenueFromVariationsMonthly: number;
  revenueFromVariationsCumulative: number;
  /**
   * Billed and certified for less, cumulatively (FR-005).
   *
   * **Money in dispute**, and kept apart from the figure below it on purpose: a bill certified short
   * is a disagreement somebody has to pursue, while a bill nobody has certified yet is a decision
   * that has not been taken. Summing them into one "uncertified" figure would merge a dispute with
   * a queue, and a project manager acts differently on each — one needs a conversation with the
   * client, the other needs a reminder.
   */
  revenueCertifiedShortfall: number;
  /** Billed, out of draft, and not yet certified by anybody. Not a dispute — a decision outstanding. */
  revenueAwaitingCertification: number;
}

/**
 * The project P&L (018 US3, FR-010 to FR-013) — `bugs.md` item 11's "P&L and Budget Summary".
 *
 * ## Revenue is billed gross, and the response says so
 *
 * Not net, and not money received. Retention is the client's money held back and released later; it is
 * a timing difference, not a reduction in what the project earned. But a reader comparing this figure
 * to the bank will find a gap, so `revenueNote` states what the figure counts rather than leaving
 * somebody to work it out and distrust the whole screen while they do.
 *
 * ## Cost is gross too, for the same reason in the other direction
 *
 * An RA bill's retention and advance recovery are **not costs** — see `bill-totals.ts`. A P&L that read
 * `netPayable` would understate every project by the retention held across it, and the error grows with
 * the project.
 *
 * ## A missing module is named, never zeroed
 *
 * FR-010, and the single most consequential line in this file. A category with no registered source is
 * listed in `unavailableCategories` and **excluded from the totals**. The alternative — counting it as
 * zero — makes a project look profitable because half its costs are invisible, and nothing on the
 * screen says so.
 *
 * ## No cross-schema joins
 *
 * Labour, materials, machinery and fuel are read through `ProjectSourcesRegistry`, never by querying
 * `labour`, `inventory` or `plant` tables from here (Principle I). Subcontractor cost is the one
 * exception and is not an exception at all: RA bills live in `projects`.
 */
@Injectable()
export class ProjectPnlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /**
   * One project's position for one month, with cumulative beside it.
   *
   * Monthly and cumulative are produced from **two date ranges over the same sources**, rather than by
   * summing months — a project with a cost recorded before its first billed month would otherwise be
   * missing from cumulative, and nobody would notice until a total disagreed with a bank statement.
   */
  async summaryFor(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    period: string,
  ): Promise<ProjectPnl> {
    const summaries = await this.summariesFor(
      ctx,
      companyId,
      [projectId],
      period,
    );
    const only = summaries.get(projectId);
    if (!only) throw new NotFoundException('Project not found');
    return only;
  }

  /**
   * The same figures for several projects, in one pass per source (task T046).
   *
   * **The group view calls this, not `summaryFor` in a loop.** Each cost source is asked once for every
   * project, which is what the batched `ProjectCostSource` interface exists for — and the group total is
   * then the sum of these rows rather than a second aggregate query, so the total and the rows cannot
   * disagree (research §7).
   */
  async summariesFor(
    ctx: RlsContext,
    companyId: string,
    projectIds: string[],
    period: string,
  ): Promise<Map<string, ProjectPnl>> {
    const { monthStart, monthEnd, projectStart } = periodRange(period);

    const projects = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true },
      }),
    );
    if (projects.length === 0) return new Map();
    const ids = projects.map((project) => project.id);

    const [revenue, subcontract, budgets] = await Promise.all([
      this.revenueFor(ctx, ids, monthStart, monthEnd, projectStart),
      this.subcontractCostFor(ctx, ids, monthStart, monthEnd, projectStart),
      this.budgetsFor(ctx, ids),
    ]);

    // Every registry-backed category, batched. `unavailable` accumulates the ones with no source —
    // which is the list FR-010 asks be named rather than zeroed.
    const unavailable: string[] = [];
    const monthlyCosts = new Map<string, Map<string, number>>();
    const cumulativeCosts = new Map<string, Map<string, number>>();

    for (const category of [
      'labour',
      'materials',
      'machinery',
      'fuel',
      'overheads',
    ] as const) {
      const source = this.sources.costSource(category);
      if (!source) {
        unavailable.push(category);
        continue;
      }
      monthlyCosts.set(
        category,
        await source.costsByProject(ids, companyId, {
          from: monthStart,
          to: monthEnd,
        }),
      );
      cumulativeCosts.set(
        category,
        await source.costsByProject(ids, companyId, {
          from: projectStart,
          to: monthEnd,
        }),
      );
    }

    const out = new Map<string, ProjectPnl>();
    for (const project of projects) {
      const categories: PnlCategoryRow[] = PNL_CATEGORIES.map((category) => {
        if (category === ProjectBudgetCategory.subcontractors) {
          const monthly = subcontract.monthly.get(project.id) ?? 0;
          const cumulative = subcontract.cumulative.get(project.id) ?? 0;
          return this.row(category, monthly, cumulative, budgets, project.id);
        }
        // An unavailable category is reported at zero **and listed as unavailable**, so a reader sees a
        // row rather than a gap where a row should be — a missing row reads as a category this project
        // has none of.
        const monthly = monthlyCosts.get(category)?.get(project.id) ?? 0;
        const cumulative = cumulativeCosts.get(category)?.get(project.id) ?? 0;
        return this.row(category, monthly, cumulative, budgets, project.id);
      });

      // Totals **exclude** unavailable categories. Including them at zero is what makes a project look
      // profitable because half its costs are invisible.
      const counted = categories.filter(
        (row) => !unavailable.includes(row.category),
      );
      const costMonthly = money(
        counted.reduce((sum, row) => sum + row.monthly, 0),
      );
      const costCumulative = money(
        counted.reduce((sum, row) => sum + row.cumulative, 0),
      );
      const revenueCumulative = revenue.cumulative.get(project.id) ?? 0;

      out.set(project.id, {
        projectId: project.id,
        projectName: project.name,
        period,
        revenueMonthly: revenue.monthly.get(project.id) ?? 0,
        revenueCumulative,
        revenueNote:
          'Billed gross on submitted and certified bills, before retention. Money received will be ' +
          'lower by retention held and by anything not yet certified.',
        categories,
        costMonthly,
        costCumulative,
        marginCumulative: money(revenueCumulative - costCumulative),
        unavailableCategories: [...unavailable],
        revenueIncludesOverScope: revenue.overScope.get(project.id) ?? false,
        revenueFromVariationsMonthly:
          revenue.variationMonthly.get(project.id) ?? 0,
        revenueFromVariationsCumulative:
          revenue.variationCumulative.get(project.id) ?? 0,
        revenueCertifiedShortfall:
          revenue.certifiedShortfall.get(project.id) ?? 0,
        revenueAwaitingCertification:
          revenue.awaitingCertification.get(project.id) ?? 0,
      });
    }
    return out;
  }

  private row(
    category: ProjectBudgetCategory,
    monthly: number,
    cumulative: number,
    budgets: Map<string, Map<ProjectBudgetCategory, number>>,
    projectId: string,
  ): PnlCategoryRow {
    const budget = budgets.get(projectId)?.get(category) ?? null;
    return {
      category,
      monthly: money(monthly),
      cumulative: money(cumulative),
      // Null, not zero. "Nobody set a budget" and "the budget is nil" lead to different conversations,
      // and a zero budget makes every rupee spent read as an overrun.
      budget,
      variance: budget === null ? null : money(budget - cumulative),
    };
  }

  /**
   * Revenue from client bills (FR-012's drill-down source).
   *
   * **Drafts excluded.** A draft is a working document; counting it would report revenue from a bill
   * that may never go out, which is the one direction a P&L must not err in.
   */
  private async revenueFor(
    ctx: RlsContext,
    projectIds: string[],
    monthStart: Date,
    monthEnd: Date,
    projectStart: Date,
  ): Promise<{
    monthly: Map<string, number>;
    cumulative: Map<string, number>;
    overScope: Map<string, boolean>;
    variationMonthly: Map<string, number>;
    variationCumulative: Map<string, number>;
    certifiedShortfall: Map<string, number>;
    awaitingCertification: Map<string, number>;
  }> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bills = await tx.clientBill.findMany({
        where: {
          projectId: { in: projectIds },
          status: { not: ClientBillStatus.draft },
          billingDate: { gte: projectStart, lte: monthEnd },
        },
        select: {
          projectId: true,
          billingDate: true,
          grossAmount: true,
          certifiedAmount: true,
          lines: {
            select: {
              exceedsScope: true,
              amount: true,
              // FR-015a. The flag lives on the BOQ line, which is the whole point of the client's
              // 2026-10-03 answer: a variation is an ordinary line carrying a mark, so it prices and
              // bills through machinery that already exists and every report can still separate it.
              boqTaskItem: { select: { isVariation: true } },
            },
          },
        },
      });

      const monthly = new Map<string, number>();
      const cumulative = new Map<string, number>();
      const overScope = new Map<string, boolean>();
      const variationMonthly = new Map<string, number>();
      const variationCumulative = new Map<string, number>();
      const certifiedShortfall = new Map<string, number>();
      const awaitingCertification = new Map<string, number>();
      for (const bill of bills) {
        const amount = bill.grossAmount.toNumber();
        // Summed from the bill's own lines rather than apportioned from its total. On a client bill
        // the quoted percentage is applied per line, so the line amounts add up to `grossAmount`
        // exactly and this partitions it rather than estimating a share of it.
        const variation = money(
          bill.lines
            .filter((line) => line.boqTaskItem.isVariation)
            .reduce((sum, line) => sum + line.amount.toNumber(), 0),
        );
        cumulative.set(
          bill.projectId,
          (cumulative.get(bill.projectId) ?? 0) + amount,
        );
        variationCumulative.set(
          bill.projectId,
          (variationCumulative.get(bill.projectId) ?? 0) + variation,
        );
        if (bill.billingDate >= monthStart) {
          monthly.set(
            bill.projectId,
            (monthly.get(bill.projectId) ?? 0) + amount,
          );
          variationMonthly.set(
            bill.projectId,
            (variationMonthly.get(bill.projectId) ?? 0) + variation,
          );
        }
        // Carried up to the summary because **a total over a bill containing an over-quantity line is
        // arithmetically right and materially misleading** — it reports revenue against scope that was
        // never awarded, and nothing else on this screen would say so.
        if (bill.lines.some((line) => line.exceedsScope)) {
          overScope.set(bill.projectId, true);
        }
        // FR-005, in aggregate. Per bill the gap is already visible; across a project it was not,
        // and a project manager asking "how much of what we have billed is actually agreed" had no
        // way to find out short of opening every bill.
        if (bill.certifiedAmount === null) {
          awaitingCertification.set(
            bill.projectId,
            (awaitingCertification.get(bill.projectId) ?? 0) + amount,
          );
        } else {
          const shortfall = money(amount - bill.certifiedAmount.toNumber());
          // Only a shortfall. A client certifying *more* than was billed is refused at
          // certification, so this can only be zero or positive — and summing a negative would
          // quietly offset a real dispute on another bill.
          if (shortfall > 0) {
            certifiedShortfall.set(
              bill.projectId,
              (certifiedShortfall.get(bill.projectId) ?? 0) + shortfall,
            );
          }
        }
      }
      return {
        monthly,
        cumulative,
        overScope,
        variationMonthly,
        variationCumulative,
        certifiedShortfall,
        awaitingCertification,
      };
    });
  }

  /**
   * Subcontractor cost from RA bills — **gross**, not `netPayable`.
   *
   * Reading net would understate every project by the retention held across it, and the understatement
   * grows with the project. See `bill-totals.ts`.
   */
  private async subcontractCostFor(
    ctx: RlsContext,
    projectIds: string[],
    monthStart: Date,
    monthEnd: Date,
    projectStart: Date,
  ): Promise<{
    monthly: Map<string, number>;
    cumulative: Map<string, number>;
  }> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bills = await tx.rABill.findMany({
        where: {
          projectId: { in: projectIds },
          status: { not: RaBillStatus.draft },
          billingDate: { gte: projectStart, lte: monthEnd },
        },
        select: {
          projectId: true,
          billingDate: true,
          grossAmount: true,
          amount: true,
        },
      });

      const monthly = new Map<string, number>();
      const cumulative = new Map<string, number>();
      for (const bill of bills) {
        // `grossAmount` where it was set, falling back to the pre-018 `amount`. A bill raised before
        // this feature has gross 0 and an `amount` that is the only figure it ever had; reading gross
        // alone would silently drop every historical subcontractor cost from the P&L.
        const gross = bill.grossAmount.toNumber() || bill.amount.toNumber();
        cumulative.set(
          bill.projectId,
          (cumulative.get(bill.projectId) ?? 0) + gross,
        );
        if (bill.billingDate >= monthStart) {
          monthly.set(
            bill.projectId,
            (monthly.get(bill.projectId) ?? 0) + gross,
          );
        }
      }
      return { monthly, cumulative };
    });
  }

  private async budgetsFor(
    ctx: RlsContext,
    projectIds: string[],
  ): Promise<Map<string, Map<ProjectBudgetCategory, number>>> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectBudget.findMany({
        where: { projectId: { in: projectIds } },
      }),
    );
    const out = new Map<string, Map<ProjectBudgetCategory, number>>();
    for (const row of rows) {
      const byCategory =
        out.get(row.projectId) ?? new Map<ProjectBudgetCategory, number>();
      byCategory.set(row.category, row.amount.toNumber());
      out.set(row.projectId, byCategory);
    }
    return out;
  }
}

/**
 * The month's bounds, and a start-of-time for cumulative.
 *
 * `projectStart` is a fixed early date rather than the project's own start: a cost recorded before a
 * project's nominal start date is a real cost (mobilisation, advance payments), and anchoring cumulative
 * to the start date would silently drop it. Erring early costs nothing — there is no data before it.
 */
export function periodRange(period: string): {
  monthStart: Date;
  monthEnd: Date;
  projectStart: Date;
} {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new NotFoundException(`period must be YYYY-MM, got "${period}"`);
  }
  return {
    monthStart: new Date(Date.UTC(year, month - 1, 1)),
    // Last millisecond of the month, so a bill dated the 31st is inside it. `Date.UTC(y, m, 0)` is the
    // last day of month `m`, which is why the month index is not decremented here.
    monthEnd: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
    projectStart: new Date(Date.UTC(2000, 0, 1)),
  };
}
