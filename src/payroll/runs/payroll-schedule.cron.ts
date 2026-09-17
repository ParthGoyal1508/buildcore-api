import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import type { PayrollScheduleConfig } from '../../common/configs/config.interface';
import { PayrollScheduleService } from './payroll-schedule.service';

/**
 * Creates each month's payroll run without anybody having to remember (016 FR-013, T032).
 *
 * Mirrors `ReminderEvaluationCron` exactly: a thin `@Cron` calling a service method, so
 * the work can be triggered in a test without a scheduler running in the background, and
 * so reading the service does not require knowing when it fires. A failure is logged
 * rather than rethrown — an unhandled rejection in a cron handler takes down nothing but
 * is reported nowhere either.
 *
 * ## The part this class cannot fix
 *
 * **A suspended instance runs no schedule.** The production API is deployed on an
 * instance class that suspends when idle, which means this cron may simply never fire on
 * the 1st (research.md §4). That is an infrastructure decision, not a defect in this
 * code, and it is the reason `PayrollScheduleService.createRunsForPreviousPeriod` is
 * independently callable and the manual "generate run" path remains. Until the deployment
 * changes, **automatic monthly creation must not be relied upon** — and
 * `PayrollRun.createdBySchedule` is what lets an operator see whether it is actually
 * happening rather than assume.
 */
@Injectable()
export class PayrollScheduleCron {
  private readonly logger = new Logger(PayrollScheduleCron.name);

  constructor(
    private readonly schedule: PayrollScheduleService,
    configService: ConfigService,
  ) {
    const cfg = configService.get<PayrollScheduleConfig>('payrollSchedule');
    this.logger.log(
      `Monthly payroll creation scheduled at "${cfg.cron}" (${cfg.timeZone}). ` +
        `This will not fire if the instance is suspended when the time arrives.`,
    );
  }

  // The expression and zone are read from configuration by the decorator factory below
  // rather than written here — Principle III, and a deployment must be able to move the
  // schedule without a release.
  @Cron(process.env.PAYROLL_SCHEDULE_CRON || '30 0 1 * *', {
    name: 'payroll-monthly-run',
    timeZone:
      process.env.PAYROLL_SCHEDULE_TIMEZONE ||
      process.env.APP_TIMEZONE ||
      'Asia/Kolkata',
  })
  async createMonthlyRuns(): Promise<void> {
    try {
      const result = await this.schedule.createRunsForPreviousPeriod();
      this.logger.log(
        `Payroll ${result.period}: ${result.created.length} created, ` +
          `${result.alreadyPresent.length} already present, ` +
          `${result.failed.length} failed.`,
      );
      for (const failure of result.failed) {
        this.logger.error(
          `Payroll ${result.period} failed for company ${failure.companyId}: ${failure.reason}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Monthly payroll creation failed outright; no runs were created and the ' +
          'manual generate path remains available.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
