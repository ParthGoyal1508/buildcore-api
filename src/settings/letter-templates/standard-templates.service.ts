import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import {
  STANDARD_LETTER_TEMPLATES,
  type StandardField,
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
 * ## The standard wording is the product's, not the company's (2026-10-14)
 *
 * This used to say the opposite: `install` created what was missing and touched nothing that
 * existed, so a company could rewrite its offer letter and keep the rewrite, as
 * `ChainsService.seedDefaultsForCompany` still does for approval chains. The client decided
 * against that. The wording of an offer, appointment, relieving or F&F letter is the same for
 * every company, and a company's copy of a shipped kind's template **must match the code**.
 *
 * So for every shipped kind that has a standard template, every company's template rows are
 * brought up to the code's body and name — at company creation, from the install endpoint,
 * and on every application start (`onApplicationBootstrap`). A missing one is created. It is
 * idempotent: a row that already matches is not written. `isActive` and the letterhead are
 * left as the company set them; only the wording is managed.
 *
 * What stays the company's: **kinds the company defined itself** (`LetterKind.companyId` set),
 * and shipped kinds this product has no standard body for (confirmation, work orders …).
 * Neither is touched here. `LetterTemplatesService` refuses an edit to a managed template's
 * body or name with `LETTER_TEMPLATE_STANDARD_LOCKED`, because the next start would silently
 * overwrite it.
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
 *
 * ## …and kept in step with the code, as the bodies now are too (2026-10-13)
 *
 * The fields used to be create-only too, which was wrong for them even while the bodies
 * were still the company's to edit. A shipped kind's fields cannot be edited by anybody —
 * `LetterKindFieldsService.requireOwnKind` refuses every write to a kind with no
 * `companyId`, because every tenant shares the row — so there is no administrator's edit
 * to preserve. Create-only preserved nothing but the *previous release's* declaration:
 * when pre-fill changed `designation.name` to `designation`, every existing database kept
 * the old path and resolved it to a blank.
 *
 * So for shipped kinds the declaration is now overwritten from `standard-letter-
 * templates.ts`, and a token the code no longer declares is removed. It runs at company
 * creation as before, and on every application start (`onApplicationBootstrap`), which is
 * how an existing database picks up a new path without anybody reinstalling a template.
 * It is a handful of upserts against a table of a few hundred rows, and does nothing when
 * nothing changed.
 */
@Injectable()
export class StandardTemplatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StandardTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Brings every shipped kind's field declarations, and every company's standard templates, in
   * line with the code, once per start.
   *
   * Logged and swallowed on failure. A database a migration behind must still boot; its
   * letters pre-fill from the old paths, and print the old wording, until the next start —
   * which is the state it was in anyway. Each company is synchronised in its own transaction,
   * so one company's failure does not hold back the others.
   */
  async onApplicationBootstrap(): Promise<void> {
    let companies: { id: string; shortCode: string }[] = [];
    try {
      const changed = await withRlsContext(
        this.prisma,
        // `LetterKind` is RLS-scoped, and the shipped rows (`companyId` null) belong to no
        // company; a system job with no caller reads them under the bypass, as login does.
        { isSuperAdmin: true },
        async (tx) => {
          const count = await this.syncShippedFields(tx);
          companies = await tx.company.findMany({
            select: { id: true, shortCode: true },
            orderBy: { createdAt: 'asc' },
          });
          return count;
        },
      );
      if (changed > 0) {
        this.logger.log(
          `Synchronised ${changed} shipped letter field declaration(s).`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Shipped letter fields were not synchronised: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    for (const company of companies) {
      try {
        const result = await withRlsContext(
          this.prisma,
          { isSuperAdmin: false, companyId: company.id },
          (tx) => this.syncCompanyTemplates(company.id, tx),
        );
        if (result.created.length + result.replaced.length > 0) {
          this.logger.log(
            `Standard letter templates for ${company.shortCode}: ` +
              [
                result.created.length
                  ? `created ${result.created.join(', ')}`
                  : '',
                result.replaced.length
                  ? `brought up to the standard wording ${result.replaced.join(
                      ', ',
                    )}`
                  : '',
              ]
                .filter(Boolean)
                .join('; ') +
              '.',
          );
        }
      } catch (error) {
        this.logger.warn(
          `Standard letter templates for ${
            company.shortCode
          } were not synchronised: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Overwrites each shipped kind's fields with the code's declaration, and removes the
   * tokens it no longer declares. Returns how many rows it created, changed or removed.
   *
   * Reads first and writes only the differences, so the common case — a restart with
   * nothing changed — is two queries and no writes.
   */
  async syncShippedFields(tx: Prisma.TransactionClient): Promise<number> {
    const kinds = await tx.letterKind.findMany({
      where: {
        key: { in: STANDARD_LETTER_TEMPLATES.map((t) => t.kindKey) },
        companyId: null,
      },
      select: { id: true, key: true },
    });
    const kindIdByKey = new Map(kinds.map((k) => [k.key, k.id]));
    const existing = await tx.letterKindField.findMany({
      where: { letterKindId: { in: kinds.map((k) => k.id) } },
    });

    // One kind may in principle carry more than one shipped template; its declared
    // fields are the union, keyed by token, the later declaration winning.
    const declaredByKind = new Map<string, Map<string, StandardField>>();
    for (const template of STANDARD_LETTER_TEMPLATES) {
      const kindId = kindIdByKey.get(template.kindKey);
      if (!kindId) continue;
      const fields = declaredByKind.get(kindId) ?? new Map();
      for (const field of template.fields) fields.set(field.token, field);
      declaredByKind.set(kindId, fields);
    }

    let changed = 0;
    for (const [letterKindId, fields] of declaredByKind) {
      const current = new Map(
        existing
          .filter((row) => row.letterKindId === letterKindId)
          .map((row) => [row.token, row]),
      );
      for (const field of fields.values()) {
        const row = current.get(field.token);
        if (
          row &&
          row.label === field.label &&
          row.sourceType === field.sourceType &&
          row.sourcePath === field.sourcePath &&
          row.isRequired === field.isRequired
        ) {
          continue;
        }
        await this.upsertField(tx, letterKindId, field);
        changed += 1;
      }
      const stale = [...current.keys()].filter((token) => !fields.has(token));
      if (stale.length > 0) {
        const removed = await tx.letterKindField.deleteMany({
          where: { letterKindId, token: { in: stale } },
        });
        changed += removed.count;
      }
    }
    return changed;
  }

  /**
   * Brings a company's standard templates in line with the code — field declarations first,
   * then the bodies — and reports what it created and what it rewrote.
   *
   * Takes a transaction client rather than opening its own, so it can run inside the
   * company-creation transaction alongside every other `seedDefaultsForCompany`.
   *
   * There used to be a `replace` option, off by default, because the bodies were starting
   * values a company kept. They are not any more (see the class comment), so there is nothing
   * left to opt into: a differing body is always brought up to the code, and a matching one is
   * always left alone.
   */
  async install(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ created: string[]; replaced: string[]; skipped: string[] }> {
    await this.syncShippedFields(tx);
    return this.syncCompanyTemplates(companyId, tx);
  }

  /**
   * The bodies half of `install`, without the field declarations — what the start-up sync runs
   * per company, the declarations having been done once for everybody.
   *
   * - `created`: the company had no template for the kind.
   * - `replaced`: at least one of its templates for the kind differed in body or name, and was
   *   rewritten. Every row of the kind is, not only the active one — an inactive copy with old
   *   wording is one `isActive` toggle away from being what goes out.
   * - `skipped`: already the standard wording, or the shipped kind does not exist yet.
   */
  async syncCompanyTemplates(
    companyId: string,
    tx: Prisma.TransactionClient,
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
        // than a company starting without one letter it gets on the next start.
        this.logger.warn(
          `No shipped LetterKind "${template.kindKey}"; its standard template was not installed.`,
        );
        skipped.push(template.kindKey);
        continue;
      }

      const existing = await tx.letterTemplate.findMany({
        where: { companyId, letterKindId },
        select: { id: true, name: true, bodyTemplate: true },
      });
      if (existing.length === 0) {
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
        continue;
      }

      const stale = existing.filter(
        (row) =>
          row.name !== template.name || row.bodyTemplate !== template.body,
      );
      if (stale.length === 0) {
        skipped.push(template.kindKey);
        continue;
      }
      await tx.letterTemplate.updateMany({
        where: { id: { in: stale.map((row) => row.id) } },
        data: { name: template.name, bodyTemplate: template.body },
      });
      replaced.push(template.kindKey);
    }

    return { created, replaced, skipped };
  }

  /** Declares one token on a shipped kind, overwriting what the previous release said. */
  private async upsertField(
    tx: Prisma.TransactionClient,
    letterKindId: string,
    field: StandardField,
  ): Promise<void> {
    const values = {
      label: field.label,
      sourceType: field.sourceType,
      sourcePath: field.sourcePath,
      isRequired: field.isRequired,
    };
    await tx.letterKindField.upsert({
      where: { letterKindId_token: { letterKindId, token: field.token } },
      // Overwritten, not create-only: nobody can edit a shipped kind's fields, so the
      // only thing an empty update ever preserved was a stale path.
      update: values,
      create: { letterKindId, token: field.token, ...values },
    });
  }
}
