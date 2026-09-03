import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AuditLogService } from '../auth/audit-log.service';
import { ReminderEvaluationCron } from './reminders/cron/reminder-evaluation.cron';
import { ReminderRuleRegistry } from './reminders/reminder-rule.registry';
import { RemindersController } from './reminders/reminders.controller';
import { RemindersService } from './reminders/reminders.service';
import { UNBUILT_MODULE_RULES } from './reminders/unbuilt-module.rules';

/**
 * The `dashboard` module — feature 004.
 *
 * Only the reminders engine exists so far. The widget registry, notifications centre,
 * activity log and reports (T001–T059) are specced and unbuilt: the engine was pulled
 * forward because features 002, 006 and 012 each register reminder rules with it
 * rather than implementing their own evaluation, de-duplication and snooze logic
 * (spec FR-036, ratified 2026-09-01), while the widgets want data from modules that
 * do not exist yet.
 *
 * No BullMQ queue and no Redis: those belong to US7's async export, and adding them
 * now would make every developer run a Redis container to boot an API that never
 * touches it.
 *
 * Imports only `DiscoveryModule`. That is the point of the registry — a module
 * contributes a rule by decorating a provider with `@ReminderRule()` in its own
 * `@Module`, and this feature discovers it without ever importing that module or
 * knowing it exists (spec FR-028). The placeholders below are the exception, and only
 * until their owners are built.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [RemindersController],
  providers: [
    RemindersService,
    ReminderRuleRegistry,
    ReminderEvaluationCron,
    // Declared here rather than imported from AuthModule, matching every other
    // feature module: the service is stateless, and AuthModule does not export it.
    AuditLogService,
    // Every placeholder is an ordinary provider carrying `@ReminderRule()`, exactly
    // the way a real rule from a real module will be.
    ...UNBUILT_MODULE_RULES,
  ],
  // `RemindersService` is exported so a module owning reminder data can trigger an
  // out-of-band sweep after a bulk change, instead of waiting for the nightly run.
  exports: [RemindersService],
})
export class DashboardModule {}
