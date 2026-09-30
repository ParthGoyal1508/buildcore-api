import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PermissionRefusalService } from './permission-refusal.service';

/**
 * Prunes the refusal log past its retention window (019 FR-003, T040).
 *
 * A security log with no stated lifetime is how a small table becomes an incident. Every
 * refused request writes a row, and a misconfigured client can refuse in a loop — so the
 * window is not an optimisation, it is the thing that keeps the table bounded.
 *
 * 180 days, stated on `PermissionRefusalService` rather than here, because the number is a
 * property of the data's usefulness and not of when the job happens to run. Long enough to
 * investigate something reported weeks late; short enough that the table does not become an
 * archive nobody asked for.
 *
 * 3:20am rather than 3am, so it does not contend with the refresh-token cleanup for the same
 * connection pool at the same moment.
 */
@Injectable()
export class PermissionRefusalCleanupCron {
  private readonly logger = new Logger(PermissionRefusalCleanupCron.name);

  constructor(private readonly refusals: PermissionRefusalService) {}

  @Cron('20 3 * * *', { name: 'permission-refusal-cleanup' })
  async prune(): Promise<void> {
    try {
      const removed = await this.refusals.sweep();
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} permission refusal(s) older than ` +
            `${PermissionRefusalService.RETENTION_DAYS} days.`,
        );
      }
    } catch (error) {
      // Logged rather than rethrown: a failed prune leaves rows in place, which is untidy
      // rather than harmful, and a throwing cron would retry into the same failure nightly.
      this.logger.error(
        `Could not prune the permission refusal log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
