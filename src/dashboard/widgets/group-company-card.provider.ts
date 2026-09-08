import { Injectable } from '@nestjs/common';

import { EmployeesService } from '../../hr/employees/employees.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { DashboardContext } from '../context';
import type { WidgetResult } from '../widgets/widget.types';

/**
 * The Group Dashboard's per-company cards and Group Total (spec FR-014, FR-015).
 *
 * One card per accessible company, its Headcount computed for real via `hr`'s
 * exported service; the payroll/PF-ESIC/loans/docs sub-metrics are unavailable until
 * those figures can be aggregated cross-company. A single Group Total card sums the
 * headcounts. Scope is the caller's accessible companies — one card for an ordinary
 * user, all of them for a Super Admin.
 */
@Injectable()
export class GroupCompanyCardProvider {
  /** The sub-metrics named by the PRD but not yet computable cross-company. */
  private static readonly UNAVAILABLE_METRICS = [
    'payrollCost',
    'pfEsicPending',
    'loansOutstanding',
    'docsPending',
  ];

  constructor(
    private readonly companies: CompaniesService,
    private readonly employees: EmployeesService,
  ) {}

  async buildCards(ctx: DashboardContext): Promise<WidgetResult[]> {
    const companies = await this.companies.listAccessible(ctx.user);
    const headcounts = await Promise.all(
      companies.map((c) => this.employees.countActiveByCompany(ctx.rls, c.id)),
    );

    const cards: WidgetResult[] = companies.map((c, i) => ({
      id: `company-card:${c.id}`,
      displayType: 'kpi',
      title: c.name,
      section: 'group',
      value: {
        companyId: c.id,
        name: c.name,
        shortCode: c.shortCode,
        headcount: headcounts[i],
        unavailableMetrics: GroupCompanyCardProvider.UNAVAILABLE_METRICS,
      },
    }));

    const groupTotal: WidgetResult = {
      id: 'group-total',
      displayType: 'kpi',
      title: 'Group Total',
      section: 'group',
      value: {
        companies: companies.length,
        headcount: headcounts.reduce((sum, n) => sum + n, 0),
        unavailableMetrics: GroupCompanyCardProvider.UNAVAILABLE_METRICS,
      },
    };

    return [...cards, groupTotal];
  }
}
