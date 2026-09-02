import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import { lastCompletedMonth } from '../compliance/compliance-status.service';
import {
  COMPLIANCE_MISSING_EVENT,
  ComplianceMissingEvent,
} from './compliance-missing.event';

/**
 * Flags contractors who have not filed for a concluded month (007 FR-010).
 *
 * Runs at 08:00 on the 1st to 5th of each month. Not once on the 1st: PF and ESIC
 * challans are filed in the first half of the following month, so a single run on day
 * one would report almost everyone as missing. Repeating for five days means a
 * contractor drops off the list as soon as their filing is recorded, and the reminder
 * reflects reality rather than the first morning of the month.
 *
 * Runs with the cross-company bypass because it is a system job with no caller —
 * there is no user whose company would scope it, and every tenant needs checking.
 */
@Injectable()
export class ComplianceCheckCron {
  private readonly logger = new Logger(ComplianceCheckCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron('0 8 1-5 * *', { name: 'partners-compliance-check' })
  async checkMissingCompliance(): Promise<void> {
    const month = lastCompletedMonth();

    const missing = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.contractorProfile.findMany({
          where: {
            vendor: { active: true },
            // Absence is the whole point: a contractor with any row for the month —
            // even a `partial` one — has started filing and is the compliance
            // screen's problem, not this job's.
            compliance: { none: { month } },
          },
          select: {
            id: true,
            companyId: true,
            vendor: { select: { name: true } },
          },
        }),
    );

    for (const contractor of missing) {
      const event: ComplianceMissingEvent = {
        contractorProfileId: contractor.id,
        contractorName: contractor.vendor.name,
        companyId: contractor.companyId,
        month,
      };
      this.events.emit(COMPLIANCE_MISSING_EVENT, event);
    }

    // Logged as well as emitted, because nothing subscribes to the event yet: without
    // this line the job would run every month leaving no evidence it had.
    this.logger.log(
      `Compliance check for ${month}: ${missing.length} contractor(s) with no filing`,
    );
  }
}
