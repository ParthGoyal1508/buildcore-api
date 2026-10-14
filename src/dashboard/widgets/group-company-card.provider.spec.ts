import { Permission } from '@prisma/client';

import { buildDashboardContext } from '../context';
import { GroupCompanyCardProvider } from './group-company-card.provider';

/**
 * The Group Dashboard's company cards (2026-10-15).
 *
 * What these defend: a metric reaching a caller who could not open the screen it comes
 * from, a figure invented for a company with no data (₹0 payroll instead of "no run
 * yet"), and the Group Total disagreeing with the cards it sums. The services are
 * stubbed with exactly the batched methods the provider may call — one per metric — so a
 * regression to a per-company loop fails to compile against these stubs rather than
 * passing slowly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = (permissions: Permission[]) =>
  buildDashboardContext(
    {
      id: 'u-1',
      companyId: 'co-a',
      permissions: [Permission.DASHBOARD, Permission.EMPLOYEES, ...permissions],
      roleIds: [],
    } as any,
    '127.0.0.1',
  );

function setup() {
  const companies = {
    listAccessible: jest.fn(async () => [
      { id: 'co-a', name: 'Dummy Alpha Test Firm', shortCode: 'DATF' },
      { id: 'co-b', name: 'Dummy Beta Test Firm', shortCode: 'DBTF' },
    ]),
  };
  const employees = {
    countActiveByCompanies: jest.fn(async () => new Map([['co-a', 12]])),
  };
  const projects = {
    ongoingTotalsByCompany: jest.fn(
      async () =>
        new Map([
          ['co-a', { count: 2, contractValue: 1_000_000 }],
          ['co-b', { count: 1, contractValue: 250_000.5 }],
        ]),
    ),
  };
  const challans = {
    latestRunTotals: jest.fn(async () => [
      {
        companyId: 'co-a',
        runId: 'run-1',
        period: '2026-09',
        employees: 12,
        gross: 500_000,
        pf: 40_000.1,
        esic: 5_000.2,
        pt: 2_400,
        tds: 0,
      },
    ]),
  };
  const loans = {
    outstandingByCompany: jest.fn(
      async () => new Map([['co-b', { outstanding: 75_000, count: 3 }]]),
    ),
  };
  const documents = {
    missingCountsByCompany: jest.fn(async () => ({
      required: 8,
      missing: new Map([
        ['co-a', 0],
        ['co-b', 5],
      ]),
    })),
  };
  const provider = new GroupCompanyCardProvider(
    companies as any,
    employees as any,
    projects as any,
    challans as any,
    loans as any,
    documents as any,
  );
  return { provider, employees, projects, challans, loans, documents };
}

const ALL = [
  Permission.PROJECTS,
  Permission.PAYROLL,
  Permission.CHALLANS,
  Permission.LOANS,
  Permission.COMPANY_SETTINGS,
];

const valueOf = (card: any) => card.value;

describe('GroupCompanyCardProvider', () => {
  it('fills every metric from one batched read per metric', async () => {
    const { provider, employees, projects, challans, loans, documents } =
      setup();
    const cards = await provider.buildCards(ctx(ALL));

    for (const batched of [
      employees.countActiveByCompanies,
      projects.ongoingTotalsByCompany,
      challans.latestRunTotals,
      loans.outstandingByCompany,
      documents.missingCountsByCompany,
    ]) {
      expect(batched).toHaveBeenCalledTimes(1);
      expect((batched.mock.calls[0] as any[])[1]).toEqual(['co-a', 'co-b']);
    }

    expect(cards.map((c) => c.id)).toEqual([
      'company-card:co-a',
      'company-card:co-b',
      'group-total',
    ]);
    expect(valueOf(cards[0])).toEqual({
      companyId: 'co-a',
      name: 'Dummy Alpha Test Firm',
      shortCode: 'DATF',
      headcount: 12,
      activeProjects: { count: 2, contractValue: 1_000_000 },
      payroll: { period: '2026-09', gross: 500_000 },
      pfEsic: {
        period: '2026-09',
        pf: 40_000.1,
        esic: 5_000.2,
        total: 45_000.3,
      },
      loans: { outstanding: 0, count: 0 },
      documents: { missing: 0, required: 8 },
    });
    expect(valueOf(cards[0])).not.toHaveProperty('unavailableMetrics');
  });

  it('says "no run yet" with nulls rather than inventing ₹0 payroll', async () => {
    const { provider } = setup();
    const [, beta] = await provider.buildCards(ctx(ALL));
    expect(valueOf(beta).headcount).toBe(0);
    expect(valueOf(beta).payroll).toEqual({ period: null, gross: null });
    expect(valueOf(beta).pfEsic).toEqual({
      period: null,
      pf: null,
      esic: null,
      total: null,
    });
  });

  it('sums the Group Total from the cards, listing each run month', async () => {
    const { provider } = setup();
    const cards = await provider.buildCards(ctx(ALL));
    expect(valueOf(cards[2])).toEqual({
      companies: 2,
      headcount: 12,
      activeProjects: { count: 3, contractValue: 1_250_000.5 },
      payroll: { periods: ['2026-09'], gross: 500_000 },
      pfEsic: {
        periods: ['2026-09'],
        pf: 40_000.1,
        esic: 5_000.2,
        total: 45_000.3,
      },
      loans: { outstanding: 75_000, count: 3 },
      documents: { missing: 5, required: 16 },
    });
  });

  it('omits — and never reads — the metrics the caller may not see', async () => {
    const { provider, projects, challans, loans, documents } = setup();
    const cards = await provider.buildCards(ctx([]));

    for (const card of cards) {
      const value = valueOf(card);
      expect(value).toHaveProperty('headcount');
      for (const key of [
        'activeProjects',
        'payroll',
        'pfEsic',
        'loans',
        'documents',
      ]) {
        expect(value).not.toHaveProperty(key);
      }
    }
    expect(projects.ongoingTotalsByCompany).not.toHaveBeenCalled();
    expect(challans.latestRunTotals).not.toHaveBeenCalled();
    expect(loans.outstandingByCompany).not.toHaveBeenCalled();
    expect(documents.missingCountsByCompany).not.toHaveBeenCalled();
  });

  it('shows PF + ESIC to a CHALLANS-only caller without payroll cost', async () => {
    const { provider } = setup();
    const [alpha] = await provider.buildCards(ctx([Permission.CHALLANS]));
    expect(valueOf(alpha)).toHaveProperty('pfEsic');
    expect(valueOf(alpha)).not.toHaveProperty('payroll');
    expect(valueOf(alpha)).not.toHaveProperty('loans');
  });
});
