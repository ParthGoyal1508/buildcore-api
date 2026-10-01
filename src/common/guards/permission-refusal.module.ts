import { Global, Module } from '@nestjs/common';

import { PermissionRefusalCleanupCron } from './permission-refusal-cleanup.cron';
import { PermissionRefusalService } from './permission-refusal.service';

/**
 * Makes the refusal recorder injectable into `PermissionsGuard` (019 FR-003).
 *
 * `@Global` because `PermissionsGuard` is declared in `@UseGuards(...)` on 91 controllers
 * across every module, and Nest resolves a guard's dependencies from the module the controller
 * belongs to. Without this, FR-003 would mean adding a provider to 91 modules — and the one
 * somebody missed would be a route whose refusals silently went unrecorded.
 */
@Global()
@Module({
  providers: [PermissionRefusalService, PermissionRefusalCleanupCron],
  exports: [PermissionRefusalService],
})
export class PermissionRefusalModule {}
