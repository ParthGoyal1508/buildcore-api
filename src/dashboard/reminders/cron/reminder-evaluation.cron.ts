import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { REMINDER_SWEEP_CRON } from '../../constants/dashboard.constants';
import { RemindersService } from '../reminders.service';

/**
 * Runs the nightly reconciliation that keeps the notification ledger honest
 * (spec FR-032, FR-033).
 *
 * Separate from `RemindersService` so the sweep can be triggered in a test by calling
 * the service directly, without a scheduler running in the background — and so that
 * reading the service does not require knowing when it fires.
 *
 * A failure is logged, not rethrown: an unhandled rejection inside a `@Cron` handler
 * takes down nothing today but is reported nowhere either, and a sweep that fails is
 * an operational event worth seeing in the logs rather than a crash.
 */
@Injectable()
export class ReminderEvaluationCron {
  private readonly logger = new Logger(ReminderEvaluationCron.name);

  constructor(private readonly reminders: RemindersService) {}

  @Cron(REMINDER_SWEEP_CRON, { name: 'dashboard-reminder-sweep' })
  async sweep(): Promise<void> {
    try {
      await this.reminders.evaluateAndEmit();
    } catch (error) {
      this.logger.error(
        'Reminder sweep failed; the ledger is unchanged and the next run will ' +
          'reconcile it.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
