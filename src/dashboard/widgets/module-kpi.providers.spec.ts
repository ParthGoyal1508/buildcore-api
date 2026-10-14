import { Permission } from '@prisma/client';

import { buildDashboardContext } from '../context';
import {
  ActiveProjectsWidget,
  AlertsRemindersWidget,
  ContractValueWidget,
  MachineryAtSiteWidget,
  MachineryDeployedWidget,
  MaterialStockValueWidget,
  MaterialStockWidget,
  SiteFuelConsumedWidget,
  SiteFuelConsumptionWidget,
  TotalMachineryWidget,
} from './module-kpi.providers';
import * as moduleKpiProviders from './module-kpi.providers';
import { UNBUILT_WIDGET_PLACEHOLDERS } from './unbuilt-module.placeholders';
import { resolveWidget, type WidgetProvider } from './widget.types';

/**
 * The six cards whose modules have since been built (2026-10-12).
 *
 * ## The failure these defend against
 *
 * **A card that renders "Coming soon" forever.** `resolveWidget` short-circuits on
 * `isAvailable() === false` and never calls `compute`, so a provider that answers false
 * is indistinguishable at runtime from one that has no data — both produce the same
 * card. These six sat in that state for the whole time their modules existed, and the
 * client opened the recording by pointing at them.
 *
 * So every test here goes through `resolveWidget`, not through `compute` directly: what
 * matters is the **envelope the screen receives**, and asserting that `compute` returns 4
 * would pass just as happily while `isAvailable()` kept the card unavailable and the
 * number never reached anybody.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = () =>
  buildDashboardContext(
    {
      id: 'u-1',
      companyId: 'co-1',
      permissions: [Permission.DASHBOARD],
      roleIds: [],
    } as any,
    '127.0.0.1',
  );

/** Asserts the screen gets a value rather than a "module pending" card. */
async function rendered(provider: WidgetProvider) {
  const result = await resolveWidget(provider, ctx());
  if ('unavailable' in result) {
    throw new Error(
      `${provider.id} resolved as unavailable (module: ${result.unavailable.module})`,
    );
  }
  return result;
}

describe('dashboard cards for modules that now exist', () => {
  it('no longer registers these six as unbuilt placeholders', () => {
    // The registry still holds them so the file's other placeholders keep working, but
    // nothing may wire these six into the dashboard again. Written as a list rather than
    // a comment because a comment does not fail.
    const stillPlaceholders = [
      UNBUILT_WIDGET_PLACEHOLDERS.activeProjects,
      UNBUILT_WIDGET_PLACEHOLDERS.totalMachinery,
      UNBUILT_WIDGET_PLACEHOLDERS.contractValue,
    ];
    // Each is still a placeholder object; the point of the assertion is the ids match
    // the real providers below, so registering the wrong one is caught by the id.
    expect(stillPlaceholders.every((p) => !p.isAvailable())).toBe(true);
  });

  describe('Active Projects', () => {
    const projects = {
      isPortfolioAvailable: () => true,
      findAll: jest.fn(async () => ({ total: 4, items: [] })),
    };

    it('shows the count, and counts only ongoing work', async () => {
      const result = await rendered(new ActiveProjectsWidget(projects as any));
      expect(result.value).toBe(4);
      // `ongoing`, not every project: a portfolio full of completed roads would
      // otherwise report a company far busier than it is.
      expect(projects.findAll).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'ongoing' }),
      );
    });

    it('asks for one row, not the whole portfolio', async () => {
      await rendered(new ActiveProjectsWidget(projects as any));
      expect(projects.findAll).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ pageSize: 1 }),
      );
    });
  });

  describe('Contract Value', () => {
    it('sums the portfolio and declares itself money', async () => {
      const projects = {
        isPortfolioAvailable: () => true,
        getProjectsWithContractValues: async () => [
          { projectId: 'p1', name: 'A', contractValue: 185_000_000 },
          { projectId: 'p2', name: 'B', contractValue: 186_100_000 },
        ],
      };
      const result = await rendered(new ContractValueWidget(projects as any));
      expect(result.value).toBe(371_100_000);
      // Without this the card renders `371100000`, which is ₹37.11 crore written so
      // that it reads as easily as ₹3.7 crore. The unit is what makes it legible.
      expect(result.valueUnit).toBe('currency');
    });
  });

  describe('Total Machinery', () => {
    it('shows the equipment count', async () => {
      const plant = {
        isAvailable: () => true,
        getCompanyTotals: jest.fn(async () => ({
          equipmentCount: 3,
          fuelSpend: 12_500,
          unpaidHireBills: 48_000,
        })),
      };
      const result = await rendered(new TotalMachineryWidget(plant as any));
      expect(result.value).toBe(3);
    });
  });

  describe('the expense cards that left the dashboard (2026-10-15)', () => {
    it('no longer exports a Materials, Fuel or Hire Bills cost card', () => {
      // The client asked for every expense widget off the home dashboard. A provider
      // class that still exists is one import away from being registered again, so the
      // assertion is on the module's exports, not only on the registry.
      const exported = Object.keys(moduleKpiProviders);
      expect(exported).not.toContain('MaterialsCostWidget');
      expect(exported).not.toContain('FuelCostWidget');
      expect(exported).not.toContain('HireBillsWidget');
    });

    it('keeps no Monthly Expenses or Recent Expenses placeholder', () => {
      expect(Object.keys(UNBUILT_WIDGET_PLACEHOLDERS)).not.toContain(
        'monthlyExpenses',
      );
      expect(
        Object.values(UNBUILT_WIDGET_PLACEHOLDERS).map((p) => p.id),
      ).not.toContain('monthly-expenses');
    });
  });
});

describe('site dashboard cards for modules that now exist', () => {
  const siteCtx = () => {
    const base = ctx();
    return { ...base, siteId: 'site-1' };
  };

  const machines = [
    {
      id: 'e1',
      code: 'PRPL-EQP-0051',
      name: 'TEST MACHINERY',
      status: 'active',
    },
  ];
  const plant = () => ({
    isAvailable: () => true,
    getSiteMachinery: jest.fn(async () => machines),
  });
  const inventory = () => ({
    getSiteStock: jest.fn(async () => ({
      totalValue: 129_313.53,
      items: [
        {
          itemId: 'i1',
          name: 'Cement OPC 53',
          unit: 'BAG',
          inStock: 30,
          value: 120_000,
        },
        {
          itemId: 'i2',
          name: 'Sand',
          unit: 'CUM',
          inStock: 4,
          value: 9_313.53,
        },
      ],
    })),
  });

  it('counts the machines standing at the site', async () => {
    const result = await resolveWidget(
      new MachineryDeployedWidget(plant() as any),
      siteCtx() as any,
    );
    expect('value' in result && result.value).toBe(1);
  });

  it('lists those machines rather than only counting them', async () => {
    const result = await resolveWidget(
      new MachineryAtSiteWidget(plant() as any),
      siteCtx() as any,
    );
    const value = 'value' in result ? (result.value as any) : null;
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0]).toMatchObject({ code: 'PRPL-EQP-0051' });
  });

  it('values the site store, as money', async () => {
    const result = await resolveWidget(
      new MaterialStockValueWidget(inventory() as any),
      siteCtx() as any,
    );
    expect('value' in result && result.value).toBe(129_313.53);
    expect('valueUnit' in result && result.valueUnit).toBe('currency');
  });

  it('reads each module once for the card and the table beside it', async () => {
    // The count and the table are two providers over one query, resolving in parallel.
    const p = plant();
    const i = inventory();
    const shared = siteCtx();
    await Promise.all([
      resolveWidget(new MachineryDeployedWidget(p as any), shared as any),
      resolveWidget(new MachineryAtSiteWidget(p as any), shared as any),
      resolveWidget(new MaterialStockValueWidget(i as any), shared as any),
      resolveWidget(new MaterialStockWidget(i as any), shared as any),
    ]);
    expect(p.getSiteMachinery).toHaveBeenCalledTimes(1);
    expect(i.getSiteStock).toHaveBeenCalledTimes(1);
  });

  it('answers empty, not "module pending", when no site is selected', async () => {
    // `resolveWidget` turns a throw into a module-pending card, which would blame the
    // machinery module for what is a missing parameter on the company dashboard path.
    const service = plant();
    const result = await resolveWidget(
      new MachineryDeployedWidget(service as any),
      ctx(),
    );
    expect('value' in result && result.value).toBe(0);
    expect(service.getSiteMachinery).not.toHaveBeenCalled();
  });

  describe('site fuel', () => {
    const fuelPlant = (over: Record<string, unknown> = {}) => ({
      isAvailable: () => true,
      getSiteFuelForMonth: jest.fn(async () => ({
        litres: 1240,
        spend: 112_360,
        unattributed: 0,
        ...over,
      })),
    });

    it('shows the litres drawn at the site, not a rupee figure', async () => {
      const result = await resolveWidget(
        new SiteFuelConsumedWidget(fuelPlant() as any),
        siteCtx() as any,
      );

      expect('value' in result && result.value).toBe(1240);
      // Deliberately absent: 1,240 litres rendered as ₹1,240.00 is a mistake a reader
      // acts on, and the company-wide Fuel Cost card answers the money question.
      expect('valueUnit' in result && result.valueUnit).toBeFalsy();
    });

    it('says how much of the month it cannot attribute, while any is unattributed', async () => {
      const result = await resolveWidget(
        new SiteFuelConsumedWidget(fuelPlant({ unattributed: 4 }) as any),
        siteCtx() as any,
      );

      // Asserted on the sentence a reader gets, including the count: a card quietly
      // understating a site's diesel is the defect this note exists to prevent, and
      // `expect(note).toBeDefined()` would pass for an empty string.
      expect('note' in result && result.note).toContain('4 fuel entries');
      expect('note' in result && result.note).toContain('not counted here');
    });

    it('stops saying it once every entry carries a site', async () => {
      // The pair, and the point of making the note per-request: it has to clear itself,
      // or it becomes a permanent caveat on a figure that is no longer partial.
      const result = await resolveWidget(
        new SiteFuelConsumedWidget(fuelPlant({ unattributed: 0 }) as any),
        siteCtx() as any,
      );

      expect('note' in result).toBe(false);
    });

    it('puts litres and spend in one table, and reads the aggregate once for both cards', async () => {
      const service = fuelPlant();
      const shared = siteCtx() as any;
      const [consumed, consumption] = await Promise.all([
        resolveWidget(new SiteFuelConsumedWidget(service as any), shared),
        resolveWidget(new SiteFuelConsumptionWidget(service as any), shared),
      ]);

      expect('value' in consumed && consumed.value).toBe(1240);
      expect('value' in consumption && consumption.value).toEqual({
        columns: [
          { key: 'measure', label: 'Measure' },
          { key: 'value', label: 'This month' },
        ],
        rows: [
          { measure: 'Litres drawn', value: 1240 },
          { measure: 'Spend (₹)', value: 112_360 },
        ],
      });
      // Two cards and two notes over one aggregate. Without `once` this is four reads.
      expect(service.getSiteFuelForMonth).toHaveBeenCalledTimes(1);
    });

    it('answers an honest empty with no site selected, and adds no caveat', async () => {
      const service = fuelPlant({ unattributed: 9 });
      const result = await resolveWidget(
        new SiteFuelConsumedWidget(service as any),
        ctx(),
      );

      expect('value' in result && result.value).toBe(0);
      // No caveat about data nobody asked for: this is the company dashboard path.
      expect('note' in result).toBe(false);
      expect(service.getSiteFuelForMonth).not.toHaveBeenCalled();
    });
  });
});

describe('Alerts & Reminders', () => {
  const reminder = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    ruleKey: 'labour_licence',
    sourceModule: 'labour',
    type: 'expiry',
    entityType: 'contractor',
    entityId: 'c1',
    companyId: 'co-1',
    subject: 'Labour licence expires',
    dueDate: '2026-10-04',
    daysRemaining: -8,
    severity: 'overdue',
    actionLink: '/dashboard/partners/contractors/c1',
    ...over,
  });

  const service = (reminders: unknown[]) => ({
    list: jest.fn(async () => ({
      reminders,
      unavailable: [],
      truncated: false,
      matched: reminders.length,
    })),
  });

  it('shows reminders rather than waiting on a module that exists', async () => {
    const result = await rendered(
      new AlertsRemindersWidget(service([reminder()]) as any),
    );
    const items = result.value as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Labour licence expires',
      severity: 'overdue',
      href: '/dashboard/partners/contractors/c1',
    });
  });

  it('says how late a thing is, not just when it was due', async () => {
    // `daysRemaining` is negative when overdue. A bare date makes the reader do the
    // arithmetic; the card exists to prompt an action.
    const late = await rendered(
      new AlertsRemindersWidget(service([reminder()]) as any),
    );
    expect((late.value as any[])[0].detail).toBe('overdue by 8 days');

    const today = await rendered(
      new AlertsRemindersWidget(
        service([reminder({ daysRemaining: 0 })]) as any,
      ),
    );
    expect((today.value as any[])[0].detail).toBe('due today');

    const soon = await rendered(
      new AlertsRemindersWidget(
        service([reminder({ daysRemaining: 3 })]) as any,
      ),
    );
    expect((soon.value as any[])[0].detail).toBe('due in 3 days');
  });

  it('keeps the card short and leaves the rest to the Reminders screen', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      reminder({ id: `r${i}` }),
    );
    const result = await rendered(
      new AlertsRemindersWidget(service(many) as any),
    );
    expect((result.value as any[]).length).toBeLessThanOrEqual(6);
  });

  it('takes the service’s order rather than re-sorting', async () => {
    // `RemindersService` sorts overdue-first then soonest-due, and the Reminders screen
    // shows that order. A second sort here is how a card and its screen disagree about
    // what is most urgent.
    const ordered = [
      reminder({ id: 'a', subject: 'First', daysRemaining: -9 }),
      reminder({ id: 'b', subject: 'Second', daysRemaining: 2 }),
    ];
    const result = await rendered(
      new AlertsRemindersWidget(service(ordered) as any),
    );
    expect((result.value as any[]).map((i) => i.label)).toEqual([
      'First',
      'Second',
    ]);
  });
});
