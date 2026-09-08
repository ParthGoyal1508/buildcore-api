import { Module, type Provider } from '@nestjs/common';
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

/**
 * The three registries, each assembled once by a factory.
 *
 * They used to be registered as `{ provide: TOKEN, useClass, multi: true }`, one
 * entry per provider. That does not work: `multi` is Angular's concept and Nest has
 * no equivalent — it is absent from Nest 10's provider interfaces entirely, so the
 * flag was silently ignored and each registration simply *overwrote* the previous
 * one under the same token. Injecting the token then yielded the single last-declared
 * provider rather than an array, and `DashboardService.companyWidgets`,
 * `NotificationsService.count` and `ReportsService` all died on
 * `this.providers.filter/.map is not a function` the first time they were called.
 *
 * A factory is the fix Nest actually supports: every provider is declared normally so
 * Nest can construct it with its own dependencies, and one `useFactory` per token
 * collects them into the array the consumers expect. The array literal below is also
 * where the render order now lives, explicitly, rather than being an emergent
 * property of declaration order — contracts/dashboard-api.md fixes that order, and
 * the classes and the unbuilt-module placeholders interleave in it.
 *
 * The same shape is why `ReminderRuleRegistry` uses `DiscoveryService`: a registry
 * that must span modules cannot be a token at all. These three are single-module
 * registries, so a factory is enough and keeps the ordering visible.
 */

/** Widget classes, in the order the factory below injects them. */
const WIDGET_CLASSES = [
  TotalEmployeesWidget,
  PresentTodayWidget,
  AbsentTodayWidget,
  OnLeaveWidget,
  PendingApprovalsWidget,
  MusterStatWidget,
  TodayAttendanceTableWidget,
  RecentLeavesTableWidget,
  WorkersTodayWidget,
  SiteAttendanceTableWidget,
] as const;

const NOTIFICATION_CLASSES = [
  LeavePendingProvider,
  ReenrolmentPendingProvider,
  PayrollPendingProvider,
  ExportReadyProvider,
] as const;

const REPORT_CLASSES = [
  AttendanceReportProvider,
  EmployeeReportProvider,
] as const;

const widgetRegistry: Provider = {
  provide: WIDGET_PROVIDERS,
  inject: [...WIDGET_CLASSES],
  useFactory: (
    totalEmployees: WidgetProvider,
    presentToday: WidgetProvider,
    absentToday: WidgetProvider,
    onLeave: WidgetProvider,
    pendingApprovals: WidgetProvider,
    musterStat: WidgetProvider,
    todayAttendanceTable: WidgetProvider,
    recentLeavesTable: WidgetProvider,
    workersToday: WidgetProvider,
    siteAttendanceTable: WidgetProvider,
  ): WidgetProvider[] => [
    // Company dashboard — contract order.
    totalEmployees,
    presentToday,
    absentToday,
    onLeave,
    UNBUILT_WIDGET_PLACEHOLDERS.monthlyExpenses,
    pendingApprovals,
    UNBUILT_WIDGET_PLACEHOLDERS.activeProjects,
    UNBUILT_WIDGET_PLACEHOLDERS.totalMachinery,
    UNBUILT_WIDGET_PLACEHOLDERS.contractValue,
    UNBUILT_WIDGET_PLACEHOLDERS.materialsCost,
    UNBUILT_WIDGET_PLACEHOLDERS.fuelCost,
    UNBUILT_WIDGET_PLACEHOLDERS.hireBills,
    musterStat,
    UNBUILT_WIDGET_PLACEHOLDERS.alertsReminders,
    todayAttendanceTable,
    recentLeavesTable,

    // Site dashboard — contract order.
    workersToday,
    siteAttendanceTable,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.machineryDeployed,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.fuelConsumed,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.materialStockValue,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.machineryAtSite,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.fuelConsumption,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.materialStock,
    UNBUILT_SITE_WIDGET_PLACEHOLDERS.recentExpenses,
  ],
};

const notificationRegistry: Provider = {
  provide: NOTIFICATION_PROVIDERS,
  inject: [...NOTIFICATION_CLASSES],
  useFactory: (...providers: NotificationProvider[]): NotificationProvider[] =>
    providers,
};

const reportRegistry: Provider = {
  provide: REPORT_PROVIDERS,
  inject: [...REPORT_CLASSES],
  useFactory: (...providers: ReportProvider[]): ReportProvider[] => [
    ...providers,
    ...UNBUILT_REPORT_PLACEHOLDERS,
  ],
};

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

    // ── Widget, notification and report providers ───────────────────────────
    // Declared as ordinary providers so Nest constructs each with its own
    // dependencies; the registries above collect them into the arrays the
    // consuming services inject. Order lives in those factories, not here.
    ...WIDGET_CLASSES,
    ...NOTIFICATION_CLASSES,
    ...REPORT_CLASSES,

    widgetRegistry,
    notificationRegistry,
    reportRegistry,
  ],
  // `RemindersService` is exported so a module owning reminder data can trigger an
  // out-of-band sweep after a bulk change, instead of waiting for the nightly run.
  exports: [RemindersService],
})
export class DashboardModule {}
