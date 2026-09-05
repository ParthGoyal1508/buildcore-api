import { Module, type Provider, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AuditLogService } from '../auth/audit-log.service';
import { StorageModule } from '../common/storage/storage.module';
import { HrModule } from '../hr/hr.module';
import { PayrollModule } from '../payroll/payroll.module';
import { PlantModule } from '../plant/plant.module';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { ActivityLogController } from './activity-log/activity-log.controller';
import { ActivityLogService } from './activity-log/activity-log.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { GroupController } from './group.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { ExportReadyProvider } from './notifications/export-ready.provider';
import { LeavePendingProvider } from './notifications/leave-pending.provider';
import { PayrollPendingProvider } from './notifications/payroll-pending.provider';
import { ReenrolmentPendingProvider } from './notifications/reenrolment-pending.provider';
import { NOTIFICATION_PROVIDERS } from './notifications/notification.types';
import { ReminderEvaluationCron } from './reminders/cron/reminder-evaluation.cron';
import { ReminderRuleRegistry } from './reminders/reminder-rule.registry';
import { RemindersController } from './reminders/reminders.controller';
import { RemindersService } from './reminders/reminders.service';
import { UNBUILT_MODULE_RULES } from './reminders/unbuilt-module.rules';
import { AttendanceReportProvider } from './reports/attendance-report.provider';
import { EmployeeReportProvider } from './reports/employee-report.provider';
import { ExportJobService } from './reports/export/export-job.service';
import { REPORT_PROVIDERS } from './reports/report.types';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { UNBUILT_REPORT_PLACEHOLDERS } from './reports/unbuilt-report.placeholders';
import { SiteDashboardController } from './site-dashboard.controller';
import { TodayAttendanceTableWidget } from './widgets/attendance-table.provider';
import { CompanyDataService } from './widgets/company-data.service';
import {
  AbsentTodayWidget,
  OnLeaveWidget,
  PendingApprovalsWidget,
  PresentTodayWidget,
  TotalEmployeesWidget,
} from './widgets/company-kpi.providers';
import { GroupCompanyCardProvider } from './widgets/group-company-card.provider';
import { MusterStatWidget } from './widgets/muster-stat.provider';
import { RecentLeavesTableWidget } from './widgets/recent-leaves-table.provider';
import {
  SiteAttendanceTableWidget,
  WorkersTodayWidget,
} from './widgets/site-widgets.providers';
import {
  UNBUILT_SITE_WIDGET_PLACEHOLDERS,
  UNBUILT_WIDGET_PLACEHOLDERS,
} from './widgets/unbuilt-module.placeholders';
import { WIDGET_PROVIDERS, type WidgetProvider } from './widgets/widget.types';
import type { NotificationProvider } from './notifications/notification.types';
import type { ReportProvider } from './reports/report.types';

// This Nest version types `multi` only on FactoryProvider, so the class/value multi
// registrations below are built through these helpers rather than inline literals.
const widget = (useClass: Type<WidgetProvider>): Provider =>
  ({ provide: WIDGET_PROVIDERS, useClass, multi: true } as unknown as Provider);
const widgetValue = (useValue: WidgetProvider): Provider =>
  ({ provide: WIDGET_PROVIDERS, useValue, multi: true } as unknown as Provider);
const notification = (useClass: Type<NotificationProvider>): Provider =>
  ({
    provide: NOTIFICATION_PROVIDERS,
    useClass,
    multi: true,
  } as unknown as Provider);
const report = (useClass: Type<ReportProvider>): Provider =>
  ({ provide: REPORT_PROVIDERS, useClass, multi: true } as unknown as Provider);
const reportValue = (useValue: ReportProvider): Provider =>
  ({ provide: REPORT_PROVIDERS, useValue, multi: true } as unknown as Provider);

/**
 * The `dashboard` module — feature 004.
 *
 * Three parallel registries (widgets, notifications, report types) built on NestJS
 * multi-provider tokens (research.md §1): a widget/notification/report is registered
 * by adding one provider to the arrays below, never by editing the resolution engine
 * or the response contract (spec FR-002). Real providers compute from features
 * 001–003's data through each owning module's exported service (Principle I —
 * `HrModule`, `ProjectsModule`, `SettingsModule`, and, for the Pending Approvals
 * KPI, `PlantModule`/`PayrollModule`); placeholder providers stand in for every
 * PRD-named item whose module is not built yet, always reporting `unavailable`.
 *
 * The reminders engine (US9) and its cross-module rule discovery via `DiscoveryModule`
 * were pulled forward earlier and are unchanged here.
 *
 * The order of the `WIDGET_PROVIDERS` and `REPORT_PROVIDERS` entries is the order the
 * frontend renders them in — it matches contracts/dashboard-api.md verbatim.
 *
 * US7's async export runs in-process rather than on `@nestjs/bullmq` + Redis — a
 * deliberate deviation recorded in plan.md, keeping every developer off a mandatory
 * Redis container while preserving the `ExportJob` table, poll contract and
 * notification exactly as specified.
 */
@Module({
  imports: [
    DiscoveryModule,
    HrModule,
    ProjectsModule,
    SettingsModule,
    PlantModule,
    PayrollModule,
    StorageModule,
  ],
  controllers: [
    RemindersController,
    DashboardController,
    GroupController,
    SiteDashboardController,
    NotificationsController,
    ActivityLogController,
    ReportsController,
  ],
  providers: [
    // ── Reminders engine (US9, pre-existing) ────────────────────────────────
    RemindersService,
    ReminderRuleRegistry,
    ReminderEvaluationCron,
    // Declared here rather than imported from AuthModule, matching every other
    // feature module: the service is stateless, and AuthModule does not export it.
    AuditLogService,
    ...UNBUILT_MODULE_RULES,

    // ── Dashboard services ──────────────────────────────────────────────────
    CompanyDataService,
    DashboardService,
    GroupCompanyCardProvider,
    ActivityLogService,
    NotificationsService,
    ReportsService,
    ExportJobService,

    // ── Widget registry (company dashboard — contract order) ────────────────
    widget(TotalEmployeesWidget),
    widget(PresentTodayWidget),
    widget(AbsentTodayWidget),
    widget(OnLeaveWidget),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.monthlyExpenses),
    widget(PendingApprovalsWidget),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.activeProjects),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.totalMachinery),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.contractValue),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.materialsCost),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.fuelCost),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.hireBills),
    widget(MusterStatWidget),
    widgetValue(UNBUILT_WIDGET_PLACEHOLDERS.alertsReminders),
    widget(TodayAttendanceTableWidget),
    widget(RecentLeavesTableWidget),

    // ── Widget registry (site dashboard — contract order) ───────────────────
    widget(WorkersTodayWidget),
    widget(SiteAttendanceTableWidget),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.machineryDeployed),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.fuelConsumed),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.materialStockValue),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.machineryAtSite),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.fuelConsumption),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.materialStock),
    widgetValue(UNBUILT_SITE_WIDGET_PLACEHOLDERS.recentExpenses),

    // ── Notification registry ───────────────────────────────────────────────
    notification(LeavePendingProvider),
    notification(ReenrolmentPendingProvider),
    notification(PayrollPendingProvider),
    notification(ExportReadyProvider),

    // ── Report registry (Attendance & Employee real, rest placeholder) ──────
    report(AttendanceReportProvider),
    report(EmployeeReportProvider),
    ...UNBUILT_REPORT_PLACEHOLDERS.map(reportValue),
  ],
  // `RemindersService` is exported so a module owning reminder data can trigger an
  // out-of-band sweep after a bulk change, instead of waiting for the nightly run.
  exports: [RemindersService],
})
export class DashboardModule {}
