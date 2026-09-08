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
  isAvailable(): boolean;
  /** The module a placeholder is waiting on. Read only when unavailable. */
  readonly unavailableModule?: string;
  /** Only called for an available type. */
  run(ctx: DashboardContext, params: ReportRunParams): Promise<ReportData>;
}

/** Multi-provider injection token every report type registers under. */
export const REPORT_PROVIDERS = Symbol('REPORT_PROVIDERS');
