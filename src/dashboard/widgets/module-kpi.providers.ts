import { Injectable } from '@nestjs/common';
import { Permission, ProjectStatus } from '@prisma/client';

import { InventoryService } from '../../inventory/inventory.service';
import { PlantService } from '../../plant/plant.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { RemindersService } from '../reminders/reminders.service';
import type { DashboardContext } from '../context';
import { once } from '../context';
import type { WidgetListItem, WidgetProvider } from './widget.types';

/**
 * The dashboard cards whose modules have since been built (2026-10-12).
 *
 * ## Why these existed as placeholders, and why they stopped being acceptable
 *
 * `unbuilt-module.placeholders.ts` registers a widget that reports `isAvailable(): false`
 * and names the module a reader is waiting on. That was right when the dashboard shipped:
 * Projects, Inventory and Plant did not exist, and a card reading "Coming soon — waiting
 * on the projects module" is an honest answer.
 *
 * Its own docblock set the expectation: *"When that module is built, its own feature is
 * expected to replace the specific placeholder it makes real."* All three modules were
 * built; none of them came back. So the main dashboard carried seven "Coming soon" cards
 * naming modules sitting in the sidebar directly above them — which reads as a product
 * that does not know what it contains, and was the first thing the client pointed at.
 *
 * ## Each reads through the owning module's service
 *
 * None of these touch Prisma. `projects.Project`, `inventory.Purchase`, `plant.Equipment`,
 * `plant.FuelEntry` and `plant.HireBill` belong to their own modules and the dashboard may
 * not query them (Principle I) — the same route `TotalEmployeesWidget` takes through
 * `EmployeesService` and `PendingApprovalsWidget` takes through three services at once.
 *
 * Each goes through the **façade its module exports** — `PlantService`,
 * `InventoryService`, `ProjectsService` — rather than reaching for `EquipmentService`,
 * `FuelService`, `HireBillsService` or `PurchasesService`. Plant exports three things on
 * purpose and says so where it does; adding four exports to render four numbers would
 * widen that surface further than the numbers justify.
 *
 * ## What is NOT made real here
 *
 * `monthlyExpenses` and `recentExpenses` stay placeholders. There is no expenses module:
 * nothing in this product records a general expense, and a "Monthly Expenses" card
 * invented by adding up materials, fuel and hire bills would be a figure with no
 * definition anybody agreed, presented with the authority of a measured one. "Coming
 * soon — waiting on the expenses module" remains the true answer for those two.
 */

/** The calendar month `when` falls in, as a UTC range. */
function monthRange(when: Date): { from: Date; to: Date } {
  const year = when.getUTCFullYear();
  const month = when.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)),
    // Day 0 of the next month is the last day of this one, so a 28-, 30- or 31-day
    // month needs no special case.
    to: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

/**
 * Plant's three company figures, fetched **once per request** however many of the three
 * cards are on screen.
 *
 * Without this the machinery, fuel and hire-bill cards would each run the same three
 * aggregates — nine queries to render three numbers — because every provider resolves in
 * parallel and none knows the others exist. `once` is the mechanism the attendance cards
 * already share for the same reason.
 */
function plantTotals(ctx: DashboardContext, plant: PlantService) {
  return once(ctx, 'plant:companyTotals', () =>
    plant.getCompanyTotals(ctx.companyId, monthRange(new Date())),
  );
}

/**
 * This site's fuel for the current month, fetched once for both fuel cards and their
 * notes — four reads of the same aggregate otherwise.
 *
 * Returns zeroes with nothing unattributed when no site is selected, so the two cards
 * render an honest empty rather than a caveat about data they were never asked for.
 */
function siteFuel(ctx: DashboardContext, plant: PlantService) {
  if (!ctx.siteId) {
    return Promise.resolve({ litres: 0, spend: 0, unattributed: 0 });
  }
  const siteId = ctx.siteId;
  return once(ctx, `plant:siteFuel:${siteId}`, () =>
    plant.getSiteFuelForMonth(ctx.companyId, siteId, monthRange(new Date())),
  );
}

/**
 * The sentence both fuel cards show while the month still holds entries with no site.
 *
 * One function because the two cards must not describe the same gap differently, and
 * `undefined` once the gap closes — which is what makes this self-clearing rather than a
 * string somebody has to delete on a date nobody will remember.
 */
async function fuelAttributionNote(
  ctx: DashboardContext,
  plant: PlantService,
): Promise<string | undefined> {
  const { unattributed } = await siteFuel(ctx, plant);
  if (unattributed === 0) return undefined;
  return (
    `${unattributed} fuel ${
      unattributed === 1 ? 'entry' : 'entries'
    } this month ` +
    `${unattributed === 1 ? 'was' : 'were'} recorded without a site and ` +
    `${
      unattributed === 1 ? 'is' : 'are'
    } not counted here. Entries made before ` +
    `12 Oct 2026 carry none, and the machine's present deployment is not evidence of ` +
    `where its diesel went.`
  );
}

/**
 * Projects currently being executed (spec FR-005).
 *
 * `ongoing` only. "Active" on this card means work is happening — a project still in
 * planning has been created but nobody is on site, and counting it would overstate what
 * the company is running. `on_hold` and `completed` are excluded for the same reason.
 */
@Injectable()
export class ActiveProjectsWidget implements WidgetProvider {
  readonly id = 'active-projects';
  readonly displayType = 'kpi' as const;
  readonly title = 'Active Projects';
  readonly section = 'kpi' as const;
  /** `PROJECTS` — what the portfolio screen itself is gated on. */
  readonly requires = [Permission.PROJECTS];
  constructor(private readonly projects: ProjectsService) {}
  isAvailable(): boolean {
    return this.projects.isPortfolioAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    // `pageSize: 1` — only the count is wanted, and asking for a page of rows to read
    // `total` off it would fetch the whole portfolio to render one number.
    const page = await this.projects.findAll(ctx.user, {
      status: ProjectStatus.ongoing,
      pageSize: 1,
    });
    return page.total;
  }
}

/**
 * The company's committed contract value (spec FR-005).
 *
 * `PROJECT_FINANCIALS`, not `PROJECTS`: the order book is a commercial figure, and 009
 * established that a site engineer who may open the portfolio has no business reading
 * what the company is worth. Someone holding either may see it, matching how the
 * portfolio screen shows contract value to both.
 */
@Injectable()
export class ContractValueWidget implements WidgetProvider {
  readonly id = 'contract-value';
  readonly displayType = 'kpi' as const;
  readonly title = 'Contract Value';
  readonly valueUnit = 'currency' as const;
  readonly section = 'sidebar' as const;
  readonly requires = [Permission.PROJECT_FINANCIALS, Permission.PROJECTS];
  constructor(private readonly projects: ProjectsService) {}
  isAvailable(): boolean {
    return this.projects.isPortfolioAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    const rows = await once(ctx, 'projects:contractValues', () =>
      this.projects.getProjectsWithContractValues(ctx.companyId),
    );
    return rows.reduce((total, row) => total + row.contractValue, 0);
  }
}

/** Equipment on the register (spec FR-005). */
@Injectable()
export class TotalMachineryWidget implements WidgetProvider {
  readonly id = 'total-machinery';
  readonly displayType = 'kpi' as const;
  readonly title = 'Total Machinery';
  readonly section = 'kpi' as const;
  readonly requires = [Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await plantTotals(ctx, this.plant)).equipmentCount;
  }
}

/**
 * What is owed on hired plant (spec FR-005).
 *
 * The **unpaid** total, not the month's billing. A dashboard figure answers "what needs
 * attention", and a bill already paid needs none.
 *
 * It counts unverified bills too, which `getMachineryCostByProject` deliberately does not:
 * a P&L must not book an unverified claim as a cost, but money the company expects to pay
 * is exactly what an outstanding figure is for. `PlantService.getCompanyTotals` records
 * the same distinction where it computes it.
 */
@Injectable()
export class HireBillsWidget implements WidgetProvider {
  readonly id = 'hire-bills';
  readonly displayType = 'kpi' as const;
  readonly title = 'Hire Bills Outstanding';
  readonly valueUnit = 'currency' as const;
  readonly section = 'sidebar' as const;
  readonly requires = [Permission.HIRE_BILLS, Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await plantTotals(ctx, this.plant)).unpaidHireBills;
  }
}

/**
 * Materials bought this month (spec FR-005).
 *
 * The period is in the title because the figure is meaningless without it: this
 * company has ₹93 lakh of purchases on record and none dated this month, so a card
 * reading "Materials Cost ₹0.00" says "we buy nothing" when it means "nothing yet in
 * October".
 */
@Injectable()
export class MaterialsCostWidget implements WidgetProvider {
  readonly id = 'materials-cost';
  readonly displayType = 'kpi' as const;
  readonly title = 'Materials Cost (This Month)';
  readonly valueUnit = 'currency' as const;
  readonly section = 'sidebar' as const;
  readonly requires = [Permission.INVENTORY];
  constructor(private readonly inventory: InventoryService) {}
  isAvailable(): boolean {
    return true;
  }
  compute(ctx: DashboardContext): Promise<number> {
    return this.inventory.getMaterialsSpendForMonth(
      ctx.user,
      monthRange(new Date()),
    );
  }
}

/** Fuel issued this month (spec FR-005). */
@Injectable()
export class FuelCostWidget implements WidgetProvider {
  readonly id = 'fuel-cost';
  readonly displayType = 'kpi' as const;
  readonly title = 'Fuel Cost (This Month)';
  readonly valueUnit = 'currency' as const;
  readonly section = 'sidebar' as const;
  readonly requires = [Permission.FUEL, Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await plantTotals(ctx, this.plant)).fuelSpend;
  }
}

// ─────────────────────────────────────────────────────────── site dashboard ──
//
// The Site Dashboard's own placeholders, same story as the company ones above.
//
// **Fuel Consumed and Fuel Consumption became real on 2026-10-12**, once
// `FuelEntry.siteId` existed. They could not before, and not for the reason their
// placeholder gave: the entry recorded which *machine* was fuelled and carried no site,
// so the only way to attribute fuel to a site was through the machine's **current**
// deployment — which would file last month's diesel wherever that machine stands today
// and silently restate the figure every time one moved.
//
// The column is nullable and permanently so for the rows that predate it, because the
// only candidate for a backfill is exactly that inference. So both cards carry a `note`
// while the month still holds unattributed entries, and the note stops appearing on its
// own once it does not.

/** The machines standing at the selected site, as a count (spec FR-012). */
@Injectable()
export class MachineryDeployedWidget implements WidgetProvider {
  readonly id = 'machinery-deployed';
  readonly displayType = 'kpi' as const;
  readonly title = 'Machinery Deployed';
  readonly section = 'site' as const;
  readonly requires = [Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await siteMachinery(ctx, this.plant)).length;
  }
}

/** The same machines, listed (spec FR-012). */
@Injectable()
export class MachineryAtSiteWidget implements WidgetProvider {
  readonly id = 'machinery-at-site';
  readonly displayType = 'table' as const;
  readonly title = 'Machinery at Site';
  readonly section = 'site' as const;
  readonly requires = [Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<{
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  }> {
    const machines = await siteMachinery(ctx, this.plant);
    return {
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Machine' },
        { key: 'status', label: 'Status' },
      ],
      rows: machines.map((m) => ({
        code: m.code,
        name: m.name,
        status: m.status,
      })),
    };
  }
}

/**
 * Litres drawn at the selected site this month (spec FR-012).
 *
 * Litres, not rupees — the company-wide Fuel Cost card beside it answers the money
 * question, and a site engineer reading this one is checking consumption against hours
 * run. `valueUnit` is therefore deliberately absent: formatting 1,240 litres as
 * ₹1,240.00 is the kind of mistake a reader acts on.
 */
@Injectable()
export class SiteFuelConsumedWidget implements WidgetProvider {
  readonly id = 'fuel-consumed';
  readonly displayType = 'kpi' as const;
  readonly title = 'Fuel Consumed This Month (litres)';
  readonly section = 'site' as const;
  readonly requires = [Permission.FUEL, Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await siteFuel(ctx, this.plant)).litres;
  }
  note(ctx: DashboardContext): Promise<string | undefined> {
    return fuelAttributionNote(ctx, this.plant);
  }
}

/**
 * The same fuel, as litres and rupees side by side (spec FR-012).
 *
 * Two figures in a `table` rather than two more KPI cards: the pair is read together —
 * litres against spend is how a rate that moved gets noticed — and the Site Dashboard
 * already carries four cards.
 */
@Injectable()
export class SiteFuelConsumptionWidget implements WidgetProvider {
  readonly id = 'fuel-consumption';
  readonly displayType = 'table' as const;
  readonly title = 'Fuel Consumption';
  readonly section = 'site' as const;
  readonly requires = [Permission.FUEL, Permission.MACHINERY];
  constructor(private readonly plant: PlantService) {}
  isAvailable(): boolean {
    return this.plant.isAvailable();
  }
  async compute(ctx: DashboardContext): Promise<{
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  }> {
    const { litres, spend } = await siteFuel(ctx, this.plant);
    return {
      columns: [
        { key: 'measure', label: 'Measure' },
        { key: 'value', label: 'This month' },
      ],
      rows: [
        { measure: 'Litres drawn', value: litres },
        { measure: 'Spend (₹)', value: spend },
      ],
    };
  }
  note(ctx: DashboardContext): Promise<string | undefined> {
    return fuelAttributionNote(ctx, this.plant);
  }
}

/** What the material standing at the selected site is worth (spec FR-012). */
@Injectable()
export class MaterialStockValueWidget implements WidgetProvider {
  readonly id = 'material-stock-value';
  readonly displayType = 'kpi' as const;
  readonly title = 'Material Stock Value';
  readonly section = 'site' as const;
  readonly valueUnit = 'currency' as const;
  readonly requires = [Permission.INVENTORY];
  constructor(private readonly inventory: InventoryService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await siteStock(ctx, this.inventory)).totalValue;
  }
}

/** What is actually in the store, biggest holdings first (spec FR-012). */
@Injectable()
export class MaterialStockWidget implements WidgetProvider {
  readonly id = 'material-stock';
  readonly displayType = 'table' as const;
  readonly title = 'Material Stock';
  readonly section = 'site' as const;
  readonly requires = [Permission.INVENTORY];
  constructor(private readonly inventory: InventoryService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<{
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  }> {
    const stock = await siteStock(ctx, this.inventory);
    return {
      columns: [
        { key: 'name', label: 'Item' },
        { key: 'inStock', label: 'In stock' },
        { key: 'value', label: 'Value' },
      ],
      rows: stock.items.map((item) => ({
        name: item.name,
        inStock: `${item.inStock} ${item.unit}`.trim(),
        value: item.value,
      })),
    };
  }
}

/**
 * Site reads, shared between the count card and the table beside it.
 *
 * Both site machinery cards — and both site stock cards — resolve in parallel from one
 * request and would otherwise run the same query twice to render the same rows as a
 * number and as a list.
 *
 * A dashboard with no site selected cannot answer these, and `ctx.siteId` is undefined on
 * the company path. Empty rather than throwing: `resolveWidget` turns a throw into a
 * "module pending" card, which would blame the machinery module for a missing parameter.
 */
function siteMachinery(ctx: DashboardContext, plant: PlantService) {
  if (!ctx.siteId) return Promise.resolve([]);
  const siteId = ctx.siteId;
  return once(ctx, `plant:site:${siteId}`, () =>
    plant.getSiteMachinery(ctx.companyId, siteId),
  );
}

function siteStock(ctx: DashboardContext, inventory: InventoryService) {
  if (!ctx.siteId) return Promise.resolve({ totalValue: 0, items: [] });
  const siteId = ctx.siteId;
  return once(ctx, `inventory:site:${siteId}`, () =>
    inventory.getSiteStock(ctx.user, siteId),
  );
}

/**
 * What needs attention, from the reminders engine (spec FR-005).
 *
 * The last of the company-dashboard placeholders, and the oddest: it was registered as
 * "waiting on the machinery module" while a whole reminders engine ran beside it —
 * `RemindersService` already evaluates every registered rule, the sidebar already shows
 * its overdue badge, and `/dashboard/reminders` already lists them.
 *
 * Overdue first, then soonest due, which is `compareReminders`' own order — the list is
 * taken as the service sorted it rather than re-sorted here, so the card and the
 * Reminders screen agree about what is most urgent.
 *
 * No `requires`: a reminder is only ever produced by a rule the caller is entitled to
 * see. `RemindersService.list` filters the rules by the caller's permissions before
 * evaluating them, so gating the card again here would hide a reminder from somebody the
 * engine had already decided should get it.
 */
@Injectable()
export class AlertsRemindersWidget implements WidgetProvider {
  readonly id = 'alerts-reminders';
  readonly displayType = 'list' as const;
  readonly title = 'Alerts & Reminders';
  readonly section = 'alerts' as const;
  constructor(private readonly reminders: RemindersService) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<WidgetListItem[]> {
    const { reminders } = await this.reminders.list(ctx.user, {});
    return reminders.slice(0, ALERTS_ON_DASHBOARD).map((reminder) => ({
      label: reminder.subject,
      // "overdue by 6 days" rather than a bare date: the card is a prompt to act, and
      // `daysRemaining` is already negative when late (spec FR-030).
      detail:
        reminder.daysRemaining < 0
          ? `overdue by ${Math.abs(reminder.daysRemaining)} days`
          : reminder.daysRemaining === 0
          ? 'due today'
          : `due in ${reminder.daysRemaining} days`,
      severity: reminder.severity,
      href: reminder.actionLink,
    }));
  }
}

/** How many reminders the card shows before "see all" on the Reminders screen. */
const ALERTS_ON_DASHBOARD = 6;
