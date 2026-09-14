import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ReconciliationService } from './reconciliation.service';

/**
 * Runs the reconciliation sweep nightly (016 T052).
 *
 * A thin `@Cron` over a service method, matching `PayrollScheduleCron` and
 * `ReminderEvaluationCron`, so the sweep can be run from a test or by hand without a
 * scheduler in the background.
 *
 * 02:40, off the hour and off every other job's slot: it reads every live approval in the
 * product, and there is no reason for it to contend with anything.
 *
 * **A suspended instance runs no schedule** — the same caveat as the payroll cron, and it
 * matters less here only because drift is cumulative rather than time-critical. A sweep
 * that runs weekly instead of nightly still finds everything; it just finds it later.
 */
@Injectable()
export class ReconciliationCron {
  private readonly logger = new Logger(ReconciliationCron.name);

  constructor(private readonly reconciliation: ReconciliationService) {}

  @Cron('40 2 * * *', { name: 'approval-reconciliation' })
  async sweep(): Promise<void> {
    try {
      await this.reconciliation.sweep();
    } catch (error) {
      // The sweep reports; it does not repair. A failure here loses a night's visibility,
      // nothing more — so it is logged and swallowed rather than left as an unhandled
      // rejection nobody sees.
      this.logger.error(
        'Approval reconciliation sweep failed.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
