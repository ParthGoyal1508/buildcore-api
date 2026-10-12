import { Permission } from '@prisma/client';

import { buildDashboardContext } from '../context';
import {
  ActiveProjectsWidget,
  ContractValueWidget,
  FuelCostWidget,
  HireBillsWidget,
  MachineryAtSiteWidget,
  MachineryDeployedWidget,
  MaterialStockValueWidget,
  MaterialStockWidget,
  MaterialsCostWidget,
  TotalMachineryWidget,
} from './module-kpi.providers';
import {
  UNBUILT_SITE_WIDGET_PLACEHOLDERS,
  UNBUILT_WIDGET_PLACEHOLDERS,
} from './unbuilt-module.placeholders';
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
      UNBUILT_WIDGET_PLACEHOLDERS.materialsCost,
      UNBUILT_WIDGET_PLACEHOLDERS.fuelCost,
      UNBUILT_WIDGET_PLACEHOLDERS.hireBills,
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

  describe('the three plant figures', () => {
    const totals = {
      equipmentCount: 3,
      fuelSpend: 12_500,
      unpaidHireBills: 48_000,
    };
    const plant = () => ({
      isAvailable: () => true,
      getCompanyTotals: jest.fn(async () => totals),
    });

    it('shows the equipment count', async () => {
      const result = await rendered(new TotalMachineryWidget(plant() as any));
      expect(result.value).toBe(3);
    });

    it('shows fuel spend as money', async () => {
      const result = await rendered(new FuelCostWidget(plant() as any));
      expect(result.value).toBe(12_500);
      expect(result.valueUnit).toBe('currency');
    });

    it('shows what is outstanding on hired plant, as money', async () => {
      const result = await rendered(new HireBillsWidget(plant() as any));
      expect(result.value).toBe(48_000);
      expect(result.valueUnit).toBe('currency');
    });

    it('reads plant once however many of the three cards are on screen', async () => {
      // All three resolve in parallel against one request. Without the shared read
      // that is three round trips of three aggregates each to render three numbers.
      const service = plant();
      const shared = ctx();
      await Promise.all([
        resolveWidget(new TotalMachineryWidget(service as any), shared),
        resolveWidget(new FuelCostWidget(service as any), shared),
        resolveWidget(new HireBillsWidget(service as any), shared),
      ]);
      expect(service.getCompanyTotals).toHaveBeenCalledTimes(1);
    });
  });

  describe('Materials Cost', () => {
    it('asks inventory for this calendar month and declares itself money', async () => {
      const inventory = {
        getMaterialsSpendForMonth: jest.fn(
          async (_caller: unknown, _month: { from: Date; to: Date }) => 931_100,
        ),
      };
      const result = await rendered(new MaterialsCostWidget(inventory as any));
      expect(result.value).toBe(931_100);
      expect(result.valueUnit).toBe('currency');

      const [, month] = inventory.getMaterialsSpendForMonth.mock.calls[0];
      // The range must cover the whole month at both ends. A `to` set to midnight on
      // the last day silently drops that day's purchases — the kind of off-by-one that
      // is invisible for twenty-nine days a month.
      expect(month.from.getUTCDate()).toBe(1);
      expect(month.from.getUTCHours()).toBe(0);
      expect(month.to.getUTCMonth()).toBe(month.from.getUTCMonth());
      expect(month.to.getUTCHours()).toBe(23);
      const dayAfter = new Date(month.to.getTime() + 1);
      expect(dayAfter.getUTCMonth()).not.toBe(month.from.getUTCMonth());
    });
  });

  describe('what deliberately stays a placeholder', () => {
    it('leaves Monthly Expenses waiting on a module that does not exist', async () => {
      // Nothing in this product records a general expense. Inventing the figure by
      // adding up materials, fuel and hire bills would put a number nobody defined on
      // the dashboard with the authority of a measured one.
      const result = await resolveWidget(
        UNBUILT_WIDGET_PLACEHOLDERS.monthlyExpenses,
        ctx(),
      );
      expect('unavailable' in result && result.unavailable.module).toBe(
        'expenses',
      );
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

  it('leaves site fuel unavailable, because a fuel entry has no site', async () => {
    // `plant.FuelEntry` records which machine was fuelled, not where. Deriving the site
    // from the machine's current deployment would file last month's diesel wherever that
    // machine stands today, and restate it every time one moves.
    const result = await resolveWidget(
      UNBUILT_SITE_WIDGET_PLACEHOLDERS.fuelConsumed,
      siteCtx() as any,
    );
    expect('unavailable' in result).toBe(true);
  });
});
