import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeaveCreditService } from './leave-credit.service';

/**
 * Credits leave every day (2026-10-16). Daily rather than on the 1st: crediting is idempotent, so
 * a day the server was down is simply caught up the next morning, and a new joiner's first month
 * lands the day after they are added rather than a month later.
 */
@Injectable()
export class LeaveCreditCron {
  constructor(private readonly credits: LeaveCreditService) {}

  @Cron('30 0 * * *', { name: 'leave-credit', timeZone: 'Asia/Kolkata' })
  async credit(): Promise<void> {
    await this.credits.runAllCompanies();
  }
}
