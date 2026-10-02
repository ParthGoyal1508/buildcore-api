import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ClientBillStatus, RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { money } from '../billing/bill-totals';
import {
  ProjectSourcesRegistry,
  type ProjectCostRecord,
} from '../portfolio/project-sources.registry';
import { periodRange } from './project-pnl.service';

/** Every figure on the project summary that can be opened (FR-012). */
export const DRILLABLE_FIGURES = [
  'revenue',
  'subcontractors',
  'labour',
  'materials',
  'machinery',
  'fuel',
  'overheads',
] as const;

export type DrillableFigure = (typeof DRILLABLE_FIGURES)[number];

export interface PnlDrillDown {
  projectId: string;
  period: string;
  figure: DrillableFigure;
  /** Cumulative or just the month — which the caller asked for, restated. */
  scope: 'month' | 'cumulative';
  /**
   * Summed from `records`, so the total a reader adds up by hand is the total shown.
   *
   * `null` when the records could not be listed — never 0, which would read as "nothing here".
   */
  total: number | null;
  /** `null`, with `unavailableReason` set, when this figure cannot be itemised. */
  records: ProjectCostRecord[] | null;
  /**
   * Where the fuller itemisation lives, when one exists elsewhere.
   *
   * Labour's per-worker register is one request away rather than copied in here; a second copy
   * would be a second thing to keep in step with the sheets.
   */
  itemisedFurtherAt: { endpoint: string; query: Record<string, string> } | null;
  unavailableReason: string | null;
}

/**
 * Opening a figure on the project summary (018 FR-012, T031).
 *
 * ## The records must add up to the figure they were opened from
 *
 * Every total here is **summed from the records returned**, never queried separately. A drill-down
 * whose rows do not add up to the total is worse than no drill-down: it tells the reader the number
 * is wrong without telling them how, and from then on they check everything by hand.
 *
 * That is also why a cost source's apportionment is honoured here — a payment sheet straddling the
 * month contributes what the month took from it, not its own total.
 *
 * ## "Cannot be itemised" and "nothing to itemise" are different answers
 *
 * `ProjectCostSource.recordsByProject` is optional. A module that exposes only a total declines to
 * implement it, and this service reports that in `unavailableReason`, naming the category. Returning
 * an empty list instead would make a module with no drill-down indistinguishable from a month with
 * no spend — the same mistake `unavailableCategories` exists to avoid one level up, arriving by a
 * different route.
 *
 * ## Revenue and subcontractor cost are read here directly
 *
 * Client bills and RA bills live in the `projects` schema, so this is not a cross-module read
 * (Principle I). Every other category arrives through the registry.
 */
@Injectable()
export class PnlDrillDownService {
  private readonly logger = new Logger(PnlDrillDownService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  async drillInto(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    period: string,
    figure: string,
    scope: 'month' | 'cumulative' = 'month',
  ): Promise<PnlDrillDown> {
    if (!DRILLABLE_FIGURES.includes(figure as DrillableFigure)) {
      throw new BadRequestException(
        `figure must be one of ${DRILLABLE_FIGURES.join(', ')}`,
      );
    }
    const chosen = figure as DrillableFigure;
    const { monthStart, monthEnd, projectStart } = periodRange(period);
    const from = scope === 'cumulative' ? projectStart : monthStart;
    const range = { from, to: monthEnd };

    const base = {
      projectId,
      period,
      figure: chosen,
      scope,
      itemisedFurtherAt: null,
      unavailableReason: null,
    } satisfies Omit<PnlDrillDown, 'total' | 'records'>;

    if (chosen === 'revenue') {
      const records = await this.clientBills(ctx, projectId, range);
      return { ...base, records, total: sum(records) };
    }
    if (chosen === 'subcontractors') {
      const records = await this.raBills(ctx, projectId, range);
      return { ...base, records, total: sum(records) };
    }

    const source = this.sources.costSource(chosen);
    if (!source) {
      return {
        ...base,
        records: null,
        total: null,
        unavailableReason:
          `No module has registered a source for ${chosen}, so this figure is not in the ` +
          `summary's totals either — see unavailableCategories on the summary.`,
      };
    }
    if (!source.recordsByProject) {
      return {
        ...base,
        records: null,
        total: null,
        unavailableReason:
          `The ${chosen} module reports a total for a period but does not list the records ` +
          `behind it, so this figure cannot be opened here yet. The total on the summary is a ` +
          `measured figure; only the itemisation is missing.`,
      };
    }

    try {
      const records = await source.recordsByProject(
        projectId,
        companyId,
        range,
      );
      return {
        ...base,
        records,
        total: sum(records),
        itemisedFurtherAt:
          chosen === 'labour'
            ? {
                endpoint: 'labour/reports/monthly-wage-rollup',
                query: {
                  projectId,
                  year: period.slice(0, 4),
                  month: String(Number(period.slice(5, 7))),
                },
              }
            : null,
      };
    } catch (error) {
      this.logger.warn(
        `Drill-down into ${chosen} for project ${projectId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ...base,
        records: null,
        total: null,
        unavailableReason:
          `The ${chosen} records could not be read just now. The figure on the summary stands; ` +
          `this is a failure to list it, not a failure to measure it.`,
      };
    }
  }

  /** Revenue: the client bills billed in the range, gross, excluding drafts — as the summary counts it. */
  private async clientBills(
    ctx: RlsContext,
    projectId: string,
    range: { from: Date; to: Date },
  ): Promise<ProjectCostRecord[]> {
    const bills = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.clientBill.findMany({
        where: {
          projectId,
          status: { not: ClientBillStatus.draft },
          billingDate: { gte: range.from, lte: range.to },
        },
        select: {
          id: true,
          billNumber: true,
          billingDate: true,
          grossAmount: true,
          status: true,
          description: true,
          certifiedAmount: true,
        },
        orderBy: { billingDate: 'asc' },
      }),
    );
    return bills.map((bill) => ({
      id: bill.id,
      reference: bill.billNumber,
      date: isoDate(bill.billingDate),
      amount: bill.grossAmount.toNumber(),
      status: bill.status,
      // The certified shortfall is said here rather than left for somebody to find by comparing two
      // screens: it is the figure a project manager chases, and the whole reason FR-005 keeps both.
      description:
        bill.certifiedAmount !== null &&
        !bill.certifiedAmount.equals(bill.grossAmount)
          ? `${
              bill.description ? `${bill.description}. ` : ''
            }Certified ${bill.certifiedAmount
              .toNumber()
              .toFixed(2)} of ${bill.grossAmount.toNumber().toFixed(2)}`
          : bill.description,
    }));
  }

  /**
   * Subcontractor cost: RA bills out of draft, at **gross**.
   *
   * Gross for the reason `bill-totals.ts` gives: retention is money withheld and advance recovery
   * is money already paid, so neither is a cost, and a drill-down reading `netPayable` would not
   * add up to the summary's figure.
   */
  private async raBills(
    ctx: RlsContext,
    projectId: string,
    range: { from: Date; to: Date },
  ): Promise<ProjectCostRecord[]> {
    const bills = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.findMany({
        where: {
          projectId,
          status: { not: RaBillStatus.draft },
          billingDate: { gte: range.from, lte: range.to },
        },
        select: {
          id: true,
          billNumber: true,
          billingDate: true,
          grossAmount: true,
          amount: true,
          status: true,
          description: true,
        },
        orderBy: { billingDate: 'asc' },
      }),
    );
    return bills.map((bill) => ({
      id: bill.id,
      reference: bill.billNumber,
      date: isoDate(bill.billingDate),
      // The same fallback the summary uses: a bill raised before 018 has only `amount`, and
      // `grossAmount` defaulted to 0 for it. Reading gross alone would silently drop every
      // pre-018 bill out of a drill-down whose total is supposed to match the summary.
      amount: bill.grossAmount.toNumber() || bill.amount.toNumber(),
      status: bill.status,
      description: bill.description,
    }));
  }
}

const sum = (records: ProjectCostRecord[]): number =>
  money(records.reduce((total, record) => total + record.amount, 0));

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
