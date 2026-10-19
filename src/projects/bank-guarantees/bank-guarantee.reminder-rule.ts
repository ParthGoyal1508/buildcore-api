import { Injectable } from '@nestjs/common';
import { BankGuaranteeStatus, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { ReminderRule } from '../../dashboard/reminders/reminder-rule.decorator';
import {
  ReminderCandidate,
  ReminderRuleProvider,
  ReminderSeverityLadder,
} from '../../dashboard/reminders/reminder-rule.types';
import { BG_TYPE_LABEL, liveUntil } from './bank-guarantee.rules';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bank guarantees falling due (037; client: "notify 30 days before a Bank Guarantee expires").
 *
 * Reaches the bell inbox through the reminders provider like every other expiry rule — in-app
 * only, no email (036 D6) — and only for people holding `BANK_GUARANTEES`.
 *
 * Due on the claim period end when one is set, otherwise on the expiry date: a guarantee the
 * department can still claim on is not finished with, and alerting on the earlier date would
 * close the alert while the exposure is still open. Only Running guarantees count — released
 * and encashed ones are done — and one already past its date stays listed (as overdue) until
 * somebody records that it was released or extended, because silence is the wrong answer to a
 * guarantee nobody has dealt with.
 */
@ReminderRule()
@Injectable()
export class BankGuaranteeExpiryRule implements ReminderRuleProvider {
  readonly ruleKey = 'projects-bank-guarantee-expiry';
  readonly sourceModule = 'projects';
  readonly requires = [Permission.BANK_GUARANTEES];
  readonly type = 'document_expiry';
  readonly entityType = 'BANK_GUARANTEE';
  /**
   * The client's 30 days — and the whole window is the warning band, because the bell inbox only
   * carries warning and overdue reminders. A 7-day band left a guarantee 20 days out on the
   * Reminders page but out of the bell, which is not "notify 30 days before". The inbox entry
   * appears once at 30 days and turns unread again if the guarantee goes overdue.
   */
  readonly leadDays = 30;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 30 };

  constructor(private readonly prisma: PrismaService) {}

  isAvailable(): boolean {
    return true;
  }

  async evaluate(ctx: RlsContext): Promise<ReminderCandidate[]> {
    const horizon = new Date(Date.now() + this.leadDays * MS_PER_DAY);

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const guarantees = await tx.bankGuarantee.findMany({
        where: {
          status: BankGuaranteeStatus.RUNNING,
          OR: [
            { claimPeriodEndDate: { lte: horizon } },
            { claimPeriodEndDate: null, expiryDate: { lte: horizon } },
          ],
        },
        include: {
          tender: {
            select: { id: true, workName: true, departmentName: true },
          },
        },
      });

      return guarantees.flatMap((bg) => {
        const due = liveUntil(bg);
        if (!due) return [];
        const label = bg.bgNumber
          ? `${BG_TYPE_LABEL[bg.type]} BG ${bg.bgNumber}`
          : `${BG_TYPE_LABEL[bg.type]} BG`;
        return [
          {
            companyId: bg.companyId,
            entityId: bg.id,
            // Names the guarantee and whom it is with: "PBG BG 0931IGP005221326 — NHAI DELHI
            // expires". The work name is too long for a headline; the department says which one.
            subject: `${label} — ${bg.tender.departmentName} ${
              bg.claimPeriodEndDate ? 'claim period ends' : 'expires'
            }`,
            dueDate: due,
            actionLink: `/dashboard/projects/bank-guarantees/${bg.tender.id}`,
          },
        ];
      });
    });
  }
}
