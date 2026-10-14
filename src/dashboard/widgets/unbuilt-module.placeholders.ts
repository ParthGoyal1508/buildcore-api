import type {
  WidgetDisplayType,
  WidgetProvider,
  WidgetSection,
} from './widget.types';

/**
 * A widget the PRD names but whose module is not built yet (spec FR-003). It carries
 * the same registration shape as a real widget, always reports `isAvailable(): false`,
 * and names the module a reader is waiting on. When that module is built, its own
 * feature is expected to replace the specific placeholder it makes real, not add a
 * second provider beside it (research.md §2).
 */
class PlaceholderWidget implements WidgetProvider {
  constructor(
    public readonly id: string,
    public readonly title: string,
    public readonly section: WidgetSection,
    public readonly displayType: WidgetDisplayType,
    public readonly unavailableModule: string,
  ) {}
  isAvailable(): boolean {
    return false;
  }
  compute(): Promise<never> {
    // Never called — resolveWidget short-circuits on isAvailable() === false.
    return Promise.reject(new Error('placeholder widget has no value'));
  }
}

/**
 * Company-dashboard placeholders, in the order the contract lists them.
 *
 * `monthlyExpenses` (and the site dashboard's `recentExpenses`) were deleted on
 * 2026-10-15 rather than kept for later: the client asked for expense widgets off the
 * dashboard altogether, so there is no future card for them to stand in for.
 */
export const UNBUILT_WIDGET_PLACEHOLDERS = {
  activeProjects: new PlaceholderWidget(
    'active-projects',
    'Active Projects',
    'kpi',
    'kpi',
    'projects',
  ),
  totalMachinery: new PlaceholderWidget(
    'total-machinery',
    'Total Machinery',
    'kpi',
    'kpi',
    'machinery',
  ),
  contractValue: new PlaceholderWidget(
    'contract-value',
    'Contract Value',
    'sidebar',
    'kpi',
    'projects',
  ),
  materialsCost: new PlaceholderWidget(
    'materials-cost',
    'Materials Cost',
    'sidebar',
    'kpi',
    'inventory',
  ),
  fuelCost: new PlaceholderWidget(
    'fuel-cost',
    'Fuel Cost',
    'sidebar',
    'kpi',
    'fuel',
  ),
  hireBills: new PlaceholderWidget(
    'hire-bills',
    'Hire Bills',
    'sidebar',
    'kpi',
    'machinery',
  ),
  alertsReminders: new PlaceholderWidget(
    'alerts-reminders',
    'Alerts & Reminders',
    'alerts',
    'list',
    'machinery',
  ),
} as const;

/** Site-dashboard placeholders, in the order the contract lists them. */
export const UNBUILT_SITE_WIDGET_PLACEHOLDERS = {
  machineryDeployed: new PlaceholderWidget(
    'machinery-deployed',
    'Machinery Deployed',
    'site',
    'kpi',
    'machinery',
  ),
  materialStockValue: new PlaceholderWidget(
    'material-stock-value',
    'Material Stock Value',
    'site',
    'kpi',
    'inventory',
  ),
  machineryAtSite: new PlaceholderWidget(
    'machinery-at-site',
    'Machinery at Site',
    'site',
    'table',
    'machinery',
  ),
  materialStock: new PlaceholderWidget(
    'material-stock',
    'Material Stock',
    'site',
    'table',
    'inventory',
  ),
} as const;
