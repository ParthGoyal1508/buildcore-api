import type { FilterSpec, ReportData, ReportProvider } from './report.types';

/**
 * A report type the PRD names but whose module is not built yet (spec FR-019). Same
 * registration shape as a real report, always `isAvailable(): false`. Running it
 * returns the widget-style `unavailable` envelope, not an error — requesting an
 * inert-but-registered type is a valid call in this feature's own framework contract.
 */
class PlaceholderReport implements ReportProvider {
  readonly filters: FilterSpec[] = [];
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly unavailableModule: string,
  ) {}
  isAvailable(): boolean {
    return false;
  }
  run(): Promise<ReportData> {
    return Promise.reject(new Error('placeholder report has no rows'));
  }
}

/** The not-yet-built report types, in the order the contract lists them. */
export const UNBUILT_REPORT_PLACEHOLDERS: ReportProvider[] = [
  new PlaceholderReport('payroll', 'Payroll', 'payroll'),
  new PlaceholderReport('machinery', 'Machinery', 'machinery'),
  new PlaceholderReport('fuel', 'Fuel', 'fuel'),
  new PlaceholderReport('project-cost', 'Project Cost', 'projects'),
  new PlaceholderReport('expense', 'Expense', 'expenses'),
  new PlaceholderReport('pnl', 'P&L', 'projects'),
  new PlaceholderReport(
    'equipment-utilization',
    'Equipment Utilization',
    'machinery',
  ),
];
