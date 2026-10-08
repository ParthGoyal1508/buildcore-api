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
import { DocumentTypesService } from '../../settings/reference-data/document-types.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A project's papers falling due (2026-10-09).
 *
 * Modelled on `CompanyDocumentExpiryRule`, which has done this for the company's own statutory
 * documents since 017. Project documents had no expiry at all until this change, so there was
 * nothing for a rule to read — the gap, not the rule, was the defect.
 *
 * **Why it matters more here than on the company.** A project document answers a *mandatory
 * kind*: readiness now refuses to count an expired one, so a lapsed insurance certificate turns a
 * project from ready to short of a document. A reminder that arrives before that happens is the
 * difference between renewing a policy and discovering at a bill that the project cannot be
 * reported complete.
 *
 * The kind's name comes through `DocumentTypesService`, not a join: `DocumentType` lives in
 * `settings` and this module may not read it (Principle I) — the same reason
 * `ProjectDocument.documentTypeId` is a bare string.
 */
@ReminderRule()
@Injectable()
export class ProjectDocumentExpiryRule implements ReminderRuleProvider {
  readonly ruleKey = 'projects-document-expiry';
  readonly sourceModule = 'projects';
  readonly type = 'document_expiry';
  readonly entityType = 'PROJECT_DOCUMENT';

  /** The same window the company's documents use, from configuration rather than a literal. */
  readonly leadDays = config().documents.expiryReminderLeadDays;
  readonly severityLadder: ReminderSeverityLadder = { warnWithinDays: 14 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentTypes: DocumentTypesService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async evaluate(ctx: RlsContext): Promise<ReminderCandidate[]> {
    const horizon = new Date(Date.now() + this.leadDays * MS_PER_DAY);

    const documents = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.findMany({
        where: { expiresAt: { not: null, lte: horizon } },
        select: {
          id: true,
          companyId: true,
          projectId: true,
          documentType: true,
          documentTypeId: true,
          expiresAt: true,
        },
      }),
    );
    if (documents.length === 0) return [];

    // One lookup per company present, not one per document. A company with two hundred expiring
    // papers is one project portfolio, not two hundred round trips.
    const names = new Map<string, Map<string, string>>();
    for (const companyId of new Set(documents.map((d) => d.companyId))) {
      const types = await this.documentTypes.listForCompany(companyId);
      names.set(companyId, new Map(types.map((t) => [t.id, t.name])));
    }

    return documents.map((document) => ({
      companyId: document.companyId,
      entityId: document.id,
      // The kind by name, falling back to the label stored on the row. A reminder reading
      // "PROJECT_DOCUMENT cmu3l… expires in 9 days" sends somebody to look it up before they can
      // act on it.
      subject: `${
        (document.documentTypeId &&
          names.get(document.companyId)?.get(document.documentTypeId)) ||
        document.documentType
      } expires`,
      dueDate: document.expiresAt as Date,
      actionLink: `/dashboard/projects/portfolio/${document.projectId}/documents`,
    }));
  }
}
