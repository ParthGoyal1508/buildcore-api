import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';

export const REMINDER_RULE_METADATA = 'dashboard:reminder-rule';

/**
 * Marks a class as a reminder rule for the engine to discover.
 *
 * This is what makes spec FR-028's guarantee real: a module contributes a rule by
 * decorating a provider in *its own* module and listing it in its own `providers`
 * array. Nothing in `src/dashboard/` changes — no import, no registration, no
 * migration.
 *
 * research.md §1 describes a NestJS multi-provider token for the widget registry, and
 * TA002 says to mirror it. A multi-provider token does not actually deliver the
 * guarantee: multi-providers are resolved per-injector, so `DashboardModule` would
 * have to import every contributing module for their rules to be visible — which is
 * precisely the edit FR-028 forbids, and it would invert the dependency graph on top
 * of that, making the dashboard depend on every module in the system.
 *
 * `DiscoveryService` scans the whole application's provider graph instead, so the
 * dependency points the right way: contributors know about the engine, the engine
 * knows about nobody. When the widget registry is built it should use this same
 * mechanism, for the same reason.
 */
export const ReminderRule = () =>
  applyDecorators(Injectable(), SetMetadata(REMINDER_RULE_METADATA, true));
