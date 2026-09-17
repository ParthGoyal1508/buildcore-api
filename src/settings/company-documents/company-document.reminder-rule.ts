import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import config from '../../common/configs/config';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { ReminderRule } from '../../dashboard/reminders/reminder-rule.decorator';
import {
  ReminderCandidate,
  ReminderRuleProvider,
  ReminderSeverityLadder,
} from '../../dashboard/reminders/reminder-rule.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Company statutory documents falling due (017 FR-005).
 *
 * **This replaces the `CompanyDocumentExpiryRule` placeholder** that lived in
 * `src/dashboard/reminders/unbuilt-module.rules.ts` while there was nowhere to store a
 * company document. That placeholder is deleted rather than left beside this: keeping
 * both would report the same `ruleKey` as available AND pending at once, and the
 * reminders list would show a rule that is live as still waiting for its module.
 *
 * The rule is registered by decorating a provider **in this module**. Nothing in
 * `src/dashboard/` changes to accommodate it — that is what FR-028 buys, and why the
 * engine discovers rules instead of importing them.
 *
 * Only the CURRENT version of each document is considered. A superseded certificate
 * expiring next week is not a compliance problem; the one that replaced it is what
 * matters, and reminding somebody about a document they already renewed is the fastest
 * way to teach them to ignore reminders.
 */
@ReminderRule()
@Injectable()
export class CompanyDocumentExpiryRule implements ReminderRuleProvider {
  /** Unchanged from the placeholder: the catalogue row and any operator switch-off
   * are keyed on this, and renaming it would orphan both. */
  readonly ruleKey = 'settings-company-document-expiry';
  readonly sourceModule = 'settings';
  readonly type = 'document_expiry';
  readonly entityType = 'COMPANY_DOCUMENT';

  /**
   * Statutory registrations take weeks to renew, so the window is wide — the same 60
   * days the placeholder declared, now read from configuration (Principle III) so it
   * can be tuned without a code change.
   */
  readonly leadDays = config().documents.expiryReminderLeadDays;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };

  constructor(private readonly prisma: PrismaService) {}

  isAvailable(): boolean {
    return true;
  }

  async evaluate(ctx: RlsContext): Promise<ReminderCandidate[]> {
    const horizon = new Date(Date.now() + this.leadDays * MS_PER_DAY);

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const documents = await tx.companyDocument.findMany({
        where: {
          isCurrent: true,
          expiresAt: { not: null, lte: horizon },
        },
        include: { documentType: { select: { name: true, code: true } } },
      });

      return documents.map((doc) => ({
        companyId: doc.companyId,
        entityId: doc.id,
        // Names the kind, not the id. A reminder reading "COMPANY_DOCUMENT
        // cmu3l… expires in 9 days" sends somebody to look it up before they can
        // act on it.
        subject: `${doc.documentType.name} expires`,
        dueDate: doc.expiresAt as Date,
        actionLink: '/dashboard/settings/company-documents',
      }));
    });
  }
}
