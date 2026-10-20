import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { EmployeesService } from '../../hr/employees/employees.service';
import { ChallansService } from '../../payroll/challans/challans.service';
import { LoansService } from '../../payroll/loans/loans.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { CompanyDocumentsService } from '../../settings/company-documents/company-documents.service';
import type { DashboardContext } from '../context';
import type { WidgetResult } from '../widgets/widget.types';

/**
 * The permissions each card metric is the caller's business under — any one of them,
 * the same any-of `WidgetProvider.requires` uses (2026-10-15).
 *
 * Each is what the metric's own screen is gated on, so the card never shows a figure its
 * reader could not open the screen to see:
 *
 * - Projects: the portfolio (`PROJECTS`); the order book also under `PROJECT_FINANCIALS`,
 *   matching the company dashboard's Contract Value card.
 * - Payroll cost: the payroll runs screen (`PAYROLL`).
 * - PF + ESIC: the Challans screen (`CHALLANS`), or `PAYROLL`, whose run carries the
 *   same contributions line by line.
 * - Loans: the Loans screen (`LOANS`), or `PAYROLL`, whose run deducts the instalments.
 * - Documents: the Company Documents screen (`COMPANY_SETTINGS`/`SETTINGS`, as its
 *   reminder rule declares).
 *
 * Headcount needs nothing extra: the endpoint itself requires `EMPLOYEES`.
 */
export const GROUP_METRIC_PERMISSIONS = {
  projects: [Permission.PROJECTS, Permission.PROJECT_FINANCIALS],
  payroll: [Permission.PAYROLL],
  pfEsic: [Permission.CHALLANS, Permission.PAYROLL],
  loans: [Permission.LOANS, Permission.PAYROLL],
  documents: [Permission.COMPANY_SETTINGS, Permission.SETTINGS],
} as const satisfies Record<string, readonly Permission[]>;

type GroupMetric = keyof typeof GROUP_METRIC_PERMISSIONS;

/** One company card's figures. A metric the caller may not see is absent, not null. */
export interface CompanyCardValue {
  companyId: string;
  name: string;
  shortCode: string;
  headcount: number;
  activeProjects?: { count: number; contractValue: number };
  /** Null figures mean the company has no processed payroll run yet. */
  payroll?: { period: string | null; gross: number | null };
  pfEsic?: {
    period: string | null;
    pf: number | null;
    esic: number | null;
    total: number | null;
  };
  loans?: { outstanding: number; count: number };
  documents?: { missing: number; required: number };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The Group Dashboard's per-company cards and Group Total (spec FR-014, FR-015).
 *
 * One card per accessible company — one for an ordinary user, all of them for a Super
 * Admin — and a Group Total summing them.
 *
 * ## Real figures since 2026-10-15
 *
 * Until then a card carried only headcount and listed four "coming soon" metrics. Each is
 * now read through the service that owns it, so a card cannot disagree with the screen
 * behind it: payroll cost and PF + ESIC from the challans derivation over each company's
 * latest processed run, loans from the Loans screen's own outstanding arithmetic, and
 * documents from the Company Documents completeness rule.
 *
 * **"PF + ESIC", never "pending".** Nothing records whether a challan was filed — there is
 * deliberately no `Challan` table — so the figure is what the latest run's challans come
 * to, labelled with its month, not a claim that it is unpaid.
 *
 * ## One statement per metric, not per company
 *
 * The production database is remote, so every round trip is felt. Each metric is one
 * grouped or batched read across every accessible company, and the six run in parallel —
 * the card count does not change how many queries a load costs.
 *
 * ## Hiding cash (038)
 *
 * With `hideCashTransactions` on, a company's cash transactions must not show or count on its
 * card (FR-006: each company's own setting). None of these metrics is built from one — gross
 * salary, statutory contributions, salary-loan balances, contract value, headcount and document
 * counts read no vendor payment, bill payment, labour sheet or advance, or disposal — so there is
 * nothing to leave out. A metric added here that sums any of those must apply
 * `CashPolicyService.hiddenAmong(ids)` per company.
 */
@Injectable()
export class GroupCompanyCardProvider {
  constructor(
    private readonly companies: CompaniesService,
    private readonly employees: EmployeesService,
    private readonly projects: ProjectsService,
    private readonly challans: ChallansService,
    private readonly loans: LoansService,
    private readonly companyDocuments: CompanyDocumentsService,
  ) {}

  async buildCards(ctx: DashboardContext): Promise<WidgetResult[]> {
    const companies = await this.companies.listAccessible(ctx.user);
    const ids = companies.map((c) => c.id);
    const may = (metric: GroupMetric) =>
      GROUP_METRIC_PERMISSIONS[metric].some((p) =>
        ctx.user.permissions.includes(p),
      );
    const showPayroll = may('payroll');
    const showPfEsic = may('pfEsic');

    const [headcounts, projects, runs, loans, documents] = await Promise.all([
      this.employees.countActiveByCompanies(ctx.rls, ids),
      may('projects')
        ? this.projects.ongoingTotalsByCompany(ctx.rls, ids)
        : null,
      // One read serves both payroll metrics; skipped when the caller may see neither.
      showPayroll || showPfEsic
        ? this.challans.latestRunTotals(ctx.rls, ids)
        : null,
      may('loans') ? this.loans.outstandingByCompany(ctx.rls, ids) : null,
      may('documents')
        ? this.companyDocuments.missingCountsByCompany(ctx.rls, ids)
        : null,
    ]);
    const runByCompany = new Map((runs ?? []).map((r) => [r.companyId, r]));

    const values: CompanyCardValue[] = companies.map((c) => {
      const run = runByCompany.get(c.id);
      return {
        companyId: c.id,
        name: c.name,
        shortCode: c.shortCode,
        headcount: headcounts.get(c.id) ?? 0,
        ...(projects
          ? {
              activeProjects: projects.get(c.id) ?? {
                count: 0,
                contractValue: 0,
              },
            }
          : {}),
        ...(showPayroll
          ? {
              payroll: {
                period: run?.period ?? null,
                gross: run?.gross ?? null,
              },
            }
          : {}),
        ...(showPfEsic
          ? {
              pfEsic: {
                period: run?.period ?? null,
                pf: run?.pf ?? null,
                esic: run?.esic ?? null,
                total: run ? r2(run.pf + run.esic) : null,
              },
            }
          : {}),
        ...(loans
          ? { loans: loans.get(c.id) ?? { outstanding: 0, count: 0 } }
          : {}),
        ...(documents
          ? {
              documents: {
                missing: documents.missing.get(c.id) ?? 0,
                required: documents.required,
              },
            }
          : {}),
      };
    });

    const cards: WidgetResult[] = values.map((value) => ({
      id: `company-card:${value.companyId}`,
      displayType: 'kpi',
      title: value.name,
      section: 'group',
      value,
    }));

    return [...cards, groupTotal(values)];
  }
}

/**
 * The Group Total card: each metric summed across the companies, present exactly when it
 * is present on the company cards.
 *
 * Payroll and PF + ESIC sum each company's **latest** run, which need not be the same
 * month everywhere — so the months are listed rather than one being claimed, and a
 * company with no run adds nothing rather than turning the total null.
 */
export function groupTotal(values: CompanyCardValue[]): WidgetResult {
  const first = values[0];
  const sum = (pick: (v: CompanyCardValue) => number | null | undefined) =>
    r2(values.reduce((total, v) => total + (pick(v) ?? 0), 0));
  const periods = (pick: (v: CompanyCardValue) => string | null | undefined) =>
    [
      ...new Set(
        values.map(pick).filter((p): p is string => typeof p === 'string'),
      ),
    ].sort();

  return {
    id: 'group-total',
    displayType: 'kpi',
    title: 'Group Total',
    section: 'group',
    value: {
      companies: values.length,
      headcount: sum((v) => v.headcount),
      ...(first?.activeProjects
        ? {
            activeProjects: {
              count: sum((v) => v.activeProjects?.count),
              contractValue: sum((v) => v.activeProjects?.contractValue),
            },
          }
        : {}),
      ...(first?.payroll
        ? {
            payroll: {
              periods: periods((v) => v.payroll?.period),
              gross: sum((v) => v.payroll?.gross),
            },
          }
        : {}),
      ...(first?.pfEsic
        ? {
            pfEsic: {
              periods: periods((v) => v.pfEsic?.period),
              pf: sum((v) => v.pfEsic?.pf),
              esic: sum((v) => v.pfEsic?.esic),
              total: sum((v) => v.pfEsic?.total),
            },
          }
        : {}),
      ...(first?.loans
        ? {
            loans: {
              outstanding: sum((v) => v.loans?.outstanding),
              count: sum((v) => v.loans?.count),
            },
          }
        : {}),
      ...(first?.documents
        ? {
            documents: {
              missing: sum((v) => v.documents?.missing),
              required: sum((v) => v.documents?.required),
            },
          }
        : {}),
    },
  };
}
