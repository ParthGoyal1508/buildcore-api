import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { cashHidingFor } from '../../common/cash/cash-visibility.interceptor';
import { hideCash } from '../../common/cash/cash-visibility.interceptor';
import type { RlsContext } from '../../common/prisma/rls-context';
import {
  formatMeta,
  renderReportExcel,
  renderReportPdf,
} from '../../dashboard/reports/export/export-renderer';
import type { ReportData } from '../../dashboard/reports/report.types';
import { ProjectPnlService } from './project-pnl.service';

/** The two formats the repository's renderer already produces. */
export type PositionExportFormat = 'pdf' | 'excel';

/** A finished document, ready for the controller to send. */
export interface PositionExport {
  buffer: Buffer;
  contentType: string;
  filename: string;
  /** The instant stamped into the document. Returned so a caller can log what it handed over. */
  producedAt: Date;
}

/**
 * What the export needs from a P&L view.
 *
 * Figures are `number | null` where `ProjectPnl`'s are `number`, which is deliberate: a figure can
 * arrive **absent** — hidden by the company's cash setting (019 FR-015) or belonging to a module
 * that registered no cost source (FR-010) — and the whole point of this type is that absent is
 * representable. A `number` with no null would force the formatter to invent a zero.
 */
export interface PositionExportInput {
  projectName: string;
  period: string;
  revenueMonthly: number | null;
  revenueCumulative: number | null;
  revenueNote: string;
  categories: {
    category: string;
    monthly: number | null;
    cumulative: number | null;
    budget: number | null;
    variance: number | null;
  }[];
  costMonthly: number | null;
  costCumulative: number | null;
  marginCumulative: number | null;
  unavailableCategories: string[];
}

export const POSITION_EXPORT_COLUMNS = [
  { key: 'line', label: 'Line' },
  { key: 'monthly', label: 'This month' },
  { key: 'cumulative', label: 'To date' },
  { key: 'budget', label: 'Budget' },
  { key: 'variance', label: 'Variance' },
];

/** What a figure says when there is no figure. Never a zero — see `cell()`. */
export const HIDDEN_CELL = 'Hidden';
export const UNAVAILABLE_CELL = 'Not available';

/**
 * The monthly position export (018 FR-011a, plan D14 — `bugs.md` item 14's second half).
 *
 * ## It carries the date it was produced, and that is not decoration
 *
 * The client's phrase for this document is "for client billing reference", which means it is quoted
 * to somebody in a negotiation, which means it leaves the system and outlives the screen. The spec's
 * edge case is a payment sheet reopened and re-approved after a month was exported, and the
 * production timestamp is **the only thing that lets two exports of the same month be told apart**.
 * Without it the older document is indistinguishable from the current position and somebody quotes
 * it. It is in the document and in the filename, to the second, for that reason.
 *
 * ## An absent figure is marked absent, never zeroed
 *
 * Two different things can make a figure absent: the company has asked for cash amounts hidden (019
 * FR-015), or a module registered no cost source so nobody can say what was spent (FR-010). Both
 * export as words — `Hidden`, `Not available` — because a zero is a figure, and neither a reader nor
 * a spreadsheet summing a column can tell an absent amount from a real one. An export that silently
 * understates a total by every cash payment in it is worse than one that says a figure is hidden.
 *
 * **Cash hiding has to be applied here explicitly.** `CashVisibilityInterceptor` shapes what a
 * handler *returns*, and this document is written to the raw response, so the interceptor never sees
 * it. `cashHidingFor()` is the same rule read from the same place rather than a second copy of it.
 *
 * ## No second export mechanism
 *
 * T068. The same `renderReportPdf` / `renderReportExcel` / `formatMeta` the dashboard's reports use,
 * over the same `ReportData` shape. `ExportJobService`'s sync/async machinery is deliberately not
 * used: it exists because a report can run to tens of thousands of rows, and one project's month is
 * a dozen. Queuing a twelve-row document, storing it and handing back a job to poll would be a
 * second mechanism in everything but name.
 */
@Injectable()
export class ProjectPositionExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pnl: ProjectPnlService,
  ) {}

  async export(
    caller: AuthenticatedUser,
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    period: string,
    format: PositionExportFormat,
    producedAt: Date = new Date(),
  ): Promise<PositionExport> {
    const pnl = await this.pnl.summaryFor(ctx, companyId, projectId, period);

    // The same figures the screen is served, with the same hiding applied — so the document and
    // the screen cannot disagree (SC-008).
    const { hidden, maySeeBreakup } = await cashHidingFor(this.prisma, caller);
    const view = (
      hidden ? hideCash(pnl, false, maySeeBreakup) : pnl
    ) as PositionExportInput;

    const report = positionReport(view, producedAt);
    const { contentType, extension } = formatMeta(
      format === 'pdf' ? 'pdf' : 'excel',
    );
    const buffer =
      format === 'pdf'
        ? await renderReportPdf(documentTitle(view), report)
        : await renderReportExcel(documentTitle(view), report);

    return {
      buffer,
      contentType,
      filename: `${filenameStem(view, producedAt)}.${extension}`,
      producedAt,
    };
  }
}

/**
 * The document's own title.
 *
 * Deliberately free of `: / \ * ? [ ]`: `renderReportExcel` uses the title as the worksheet name,
 * and a colon in a worksheet name is rejected by the format itself. The production timestamp is a
 * row rather than part of the title for exactly that reason — a time needs a colon.
 */
export function documentTitle(view: {
  projectName: string;
  period: string;
}): string {
  return `${view.projectName} monthly position ${view.period}`;
}

/** Carries the project, the month and the production instant, so two exports never collide. */
export function filenameStem(
  view: { projectName: string; period: string },
  producedAt: Date,
): string {
  const slug = view.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stamp = producedAt.toISOString().replace(/[:.]/g, '-');
  return `position-${slug || 'project'}-${view.period}-produced-${stamp}`;
}

/**
 * The position as rows, with the project, the month and the production date on the face of it.
 *
 * Pure, so the two assertions that matter can be made without rendering a PDF: that the document
 * carries the screen's figures unchanged (SC-008), and that two exports taken either side of a
 * correction are distinguishable (plan D14).
 */
export function positionReport(
  view: PositionExportInput,
  producedAt: Date,
): ReportData {
  const rows: Record<string, unknown>[] = [
    { line: `Project: ${view.projectName}` },
    { line: `Month: ${view.period}` },
    // To the second. Two exports of the same month taken on the same day either side of a
    // correction must be tellable apart, and a date alone would not do it.
    { line: `Produced at: ${producedAt.toISOString()}` },
    { line: '' },
    {
      line: 'Revenue billed',
      monthly: cell(view.revenueMonthly),
      cumulative: cell(view.revenueCumulative),
    },
    { line: '' },
  ];

  for (const row of view.categories) {
    rows.push({
      line: categoryLabel(row.category),
      monthly: cell(
        row.monthly,
        view.unavailableCategories.includes(row.category),
      ),
      cumulative: cell(
        row.cumulative,
        view.unavailableCategories.includes(row.category),
      ),
      budget: cell(row.budget),
      variance: cell(row.variance),
    });
  }

  rows.push(
    { line: '' },
    {
      line: 'Total cost',
      monthly: cell(view.costMonthly),
      cumulative: cell(view.costCumulative),
    },
    { line: 'Margin', cumulative: cell(view.marginCumulative) },
    { line: '' },
    { line: `Revenue basis: ${view.revenueNote}` },
  );

  if (view.unavailableCategories.length > 0) {
    rows.push({
      line:
        `Not available, and therefore excluded from the totals above: ` +
        `${view.unavailableCategories.map(categoryLabel).join(', ')}. ` +
        `Nobody can say what was spent on these, which is not the same as nothing having been spent.`,
    });
  }

  return { columns: POSITION_EXPORT_COLUMNS, rows };
}

/**
 * One figure, or the word that says why there isn't one.
 *
 * `null` is the hidden case and `unavailable` the unregistered-module case, and **neither becomes a
 * zero**. The renderer stringifies a missing key to an empty cell, which in a spreadsheet column of
 * numbers reads as nothing spent — so the absence is spelled out instead.
 */
export function cell(
  value: number | null | undefined,
  unavailable = false,
): string {
  if (unavailable) return UNAVAILABLE_CELL;
  if (value === null || value === undefined) return HIDDEN_CELL;
  return value.toFixed(2);
}

const CATEGORY_LABELS: Record<string, string> = {
  labour: 'Labour',
  materials: 'Materials',
  machinery: 'Machinery',
  fuel: 'Fuel',
  subcontractors: 'Subcontractors',
  overheads: 'Overheads',
};

const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category] ?? category;
