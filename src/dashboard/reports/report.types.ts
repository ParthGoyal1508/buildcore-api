import type { Permission } from '@prisma/client';

import type { DashboardContext } from '../context';

/** One filter a report type accepts, described so the frontend can render it. */
export interface FilterSpec {
  key: string;
  label: string;
  type: 'date' | 'dateRange' | 'select' | 'text';
  /** Populated for `select` filters. */
  options?: { value: string; label: string }[];
  required?: boolean;
}

/** The params a report run is invoked with — a date range plus per-type filters. */
export interface ReportRunParams {
  fromDate?: string;
  toDate?: string;
  filters?: Record<string, string | undefined>;
}

/** An available report's tabular result (data-model.md). */
export interface ReportData {
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  /**
   * Why there is nothing to show, or what is missing from what is (2026-10-12).
   *
   * "This report returned no rows" is the interface's only account of an empty result,
   * and for several reports that is not the interesting fact. The Payroll report returns
   * nothing when every run in the range is still a draft — a register is produced from a
   * processed run — and a reader who is told only "no rows" goes looking for missing
   * employees rather than pressing Process.
   *
   * Optional and per-run, like `WidgetProvider.note`: a report whose result is complete
   * says nothing, and a caveat that applies today must stop appearing once it does not.
   */
  note?: string;
}

/** A report run's output — data for an available type, or the widget-style
 * `unavailable` envelope for a placeholder (contracts/dashboard-api.md). */
export type ReportResult =
  | ReportData
  | { unavailable: { reason: 'module_pending'; module: string } };

/**
 * One report type's registration, mirroring {@link import('../widgets/widget.types').WidgetProvider}
 * — an id, a display name, the filters it accepts, an availability flag, and a `run`
 * that produces rows. Registered under {@link REPORT_PROVIDERS}.
 */
export interface ReportProvider {
  id: string;
  name: string;
  filters: FilterSpec[];
  /**
   * The permissions that make this report the caller's business — **any one of them**
   * (2026-10-10).
   *
   * `/reports` is gated on `REPORTS`, which is one permission covering every report
   * there is. So a role given `REPORTS` to run the machinery utilisation figures could
   * also run the Employee report — the whole roster with joining dates — and export it
   * to Excel. `REPORTS` says somebody may use the reporting surface; it does not say
   * which data they may take away.
   *
   * Declared as the permission the module's own screens are gated on, matching what
   * `WidgetProvider.requires` and `ReminderRuleProvider.requires` already do.
   *
   * A placeholder for an unbuilt module declares nothing: it carries no rows, only the
   * name of a module that does not exist yet.
   */
  readonly requires?: Permission[];
  isAvailable(): boolean;
  /** The module a placeholder is waiting on. Read only when unavailable. */
  readonly unavailableModule?: string;
  /** Only called for an available type. */
  run(ctx: DashboardContext, params: ReportRunParams): Promise<ReportData>;
}

/** Multi-provider injection token every report type registers under. */
export const REPORT_PROVIDERS = Symbol('REPORT_PROVIDERS');
