import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  STANDARD_LETTER_TEMPLATES,
  type StandardLetterTemplate,
} from '../../letters/standard-letter-templates';

/**
 * Installing the shipped letter bodies for a company (2026-10-11).
 *
 * ## Why a company needs rows at all
 *
 * `LettersService.requireTemplate` resolves the **active `LetterTemplate` row** for the
 * kind and refuses to compose without one. So a body held only in code is a body nobody
 * can use: it would not appear in the template list, and composing would answer
 * `LETTER_TEMPLATE_MISSING`. The catalogue therefore has to be materialised per company.
 *
 * ## Starting values, pushed once and never again
 *
 * `install` creates what is missing and **touches nothing that exists**. A company that
 * rewrites its offer letter keeps the rewrite; running this again does not undo it. The
 * same contract `ChainsService.seedDefaultsForCompany` states for approval chains, and
 * for the same reason: the alternative is an upgrade that silently reverts somebody's
 * edit to a legal document.
 *
 * A kind is skipped — not created — when the company already has *any* template for it,
 * active or not. A company that deactivated the shipped offer letter in favour of its own
 * does not want it quietly reinstated on the next deploy.
 *
 * ## Field declarations hang off the kind, not the company
 *
 * `LetterKindField` has no `companyId`: the tokens an offer letter takes are a property of
 * the kind. They are nonetheless ensured from here rather than from a migration, so the
 * tokens and the body that references them have **one source** — `standard-letter-
 * templates.ts`, with a unit test asserting the two agree. Writing them in SQL would put
 * the declarations a migration away from the bodies and let them drift, which is how a
 * token ends up never asked for and rendered as a blank in a signed letter.
 *
 * The write is an idempotent upsert keyed `(letterKindId, token)`, so running it from a
 * per-company path is harmless. It is global state written from a company-scoped call,
 * which is unusual enough to say out loud.
 */
@Injectable()
export class StandardTemplatesService {
  private readonly logger = new Logger(StandardTemplatesService.name);

  /**
   * Creates any missing shipped template for a company, and returns how many it made.
   *
   * Takes a transaction client rather than opening its own, so it can run inside the
   * company-creation transaction alongside every other `seedDefaultsForCompany`.
   */
  async install(
    companyId: string,
    tx: Prisma.TransactionClient,
    /**
     * Overwrite a kind that already has a template.
     *
     * **Off by default, and it must stay off by default.** The reason for the whole
     * create-only contract is that these are starting values and a company's rewrite of
     * its own offer letter is theirs to keep.
     *
     * The flag exists because a company can be holding a *placeholder* rather than a
     * rewrite — this product seeded short demo bodies for offer, appointment and
     * relieving, and the client asking for their real documents to be used is asking for
     * exactly those three to be replaced. That is a decision somebody makes knowingly,
     * which is what an explicit flag and a `replaced` list in the response are for.
     */
    opts: { replace?: boolean } = {},
  ): Promise<{ created: string[]; replaced: string[]; skipped: string[] }> {
    const kinds = await tx.letterKind.findMany({
      where: {
        key: { in: STANDARD_LETTER_TEMPLATES.map((t) => t.kindKey) },
        // The shipped row, not a company's own kind that happens to share a key.
        companyId: null,
      },
      select: { id: true, key: true },
    });
    const kindIdByKey = new Map(kinds.map((k) => [k.key, k.id]));

    const created: string[] = [];
    const replaced: string[] = [];
    const skipped: string[] = [];

    for (const template of STANDARD_LETTER_TEMPLATES) {
      const letterKindId = kindIdByKey.get(template.kindKey);
      if (!letterKindId) {
        // Logged rather than thrown. A missing kind means a migration has not run yet,
        // and failing company creation over a letter template would be a worse outcome
        // than a company starting without one letter it can add later.
        this.logger.warn(
          `No shipped LetterKind "${template.kindKey}"; its standard template was not installed.`,
        );
        skipped.push(template.kindKey);
        continue;
      }

      await this.ensureFields(template, letterKindId, tx);

      const existing = await tx.letterTemplate.findFirst({
        where: { companyId, letterKindId },
        select: { id: true },
      });
      if (existing) {
        if (!opts.replace) {
          skipped.push(template.kindKey);
          continue;
        }
        await tx.letterTemplate.update({
          where: { id: existing.id },
          data: {
            name: template.name,
            bodyTemplate: template.body,
            isActive: true,
          },
        });
        replaced.push(template.kindKey);
        continue;
      }

      await tx.letterTemplate.create({
        data: {
          companyId,
          letterKindId,
          name: template.name,
          bodyTemplate: template.body,
          // Active on creation: a template installed inactive is a template that looks
          // present on the settings screen and still answers LETTER_TEMPLATE_MISSING at
          // compose, which reads as a bug rather than as a choice.
          isActive: true,
        },
      });
      created.push(template.kindKey);
    }

    return { created, replaced, skipped };
  }

  /** Declares the kind's tokens, so the compose screen knows what to ask for. */
  private async ensureFields(
    template: StandardLetterTemplate,
    letterKindId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const field of template.fields) {
      await tx.letterKindField.upsert({
        where: {
          letterKindId_token: { letterKindId, token: field.token },
        },
        // **Create only.** An administrator who re-labelled a field or made one optional
        // meant it; an empty update is what keeps this safe to run on every company
        // creation forever.
        update: {},
        create: {
          letterKindId,
          token: field.token,
          label: field.label,
          sourceType: field.sourceType,
          sourcePath: field.sourcePath,
          isRequired: field.isRequired,
        },
      });
    }
  }
}
