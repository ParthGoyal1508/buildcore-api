import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  TermsDocumentKind,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  rlsContextFor,
  withRlsContext,
  type RlsContext,
} from '../../common/prisma/rls-context';
import { STANDARD_TERMS } from './standard-terms';

/** One kind's terms, as a reader sees them. */
export interface TermsTemplateView {
  documentKind: TermsDocumentKind;
  body: string;
  /**
   * False while the company is still on the set this product ships (2026-10-11).
   *
   * The distinction a screen needs: "nobody has reviewed these" is a different sentence
   * from "somebody wrote these and they happen to read like the default", and only the
   * first is worth prompting about.
   */
  isCustomised: boolean;
  updatedAt: Date | null;
}

/**
 * The company's standard terms and conditions, per kind of document (2026-10-11).
 *
 * ## The fixed set, and the mechanism to change it
 *
 * Every company starts on `STANDARD_TERMS` — a real clause set, shipped, not an empty
 * box. Saving replaces it for that company and for that kind only. There is no "reset",
 * because the shipped text is still in the code and pasting it back is one copy; a
 * button that silently discarded somebody's drafting is the more expensive mistake.
 *
 * ## What this is not
 *
 * **Not `LetterTemplate`.** That holds whole letter bodies with `{{token}}` substitution
 * and already serves the LOI and the other issued letters; it is not duplicated here. A
 * terms block is a clause set copied *into* a document that has its own structure.
 *
 * **Not read through at render time.** A work order keeps the terms it was raised under
 * in its own column, exactly as a bill keeps the rate it was priced at. Editing the
 * standard set changes what the next document starts from and leaves every award already
 * signed alone.
 */
@Injectable()
export class TermsTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Every kind, shipped text where the company has not written its own. */
  async findAll(
    ctx: RlsContext,
    companyId: string,
  ): Promise<TermsTemplateView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.termsTemplate.findMany({ where: { companyId } }),
    );
    const byKind = new Map(rows.map((row) => [row.documentKind, row]));

    // Driven by the enum, not by what is stored: a kind nobody has saved must still
    // appear, with the shipped text, or the screen offers no way to start from it.
    return Object.values(TermsDocumentKind).map((documentKind) => {
      const stored = byKind.get(documentKind);
      return {
        documentKind,
        body: stored?.body ?? STANDARD_TERMS[documentKind],
        isCustomised: !!stored,
        updatedAt: stored?.updatedAt ?? null,
      };
    });
  }

  /**
   * The terms a new document of this kind starts from.
   *
   * Takes a transaction client, because the caller is usually inside the one creating
   * the document — and terms read in a separate transaction could come from a set that
   * the transaction then rolls back past.
   */
  async bodyFor(
    tx: Prisma.TransactionClient,
    companyId: string,
    documentKind: TermsDocumentKind,
  ): Promise<string> {
    const stored = await tx.termsTemplate.findUnique({
      where: { companyId_documentKind: { companyId, documentKind } },
      select: { body: true },
    });
    return stored?.body ?? STANDARD_TERMS[documentKind];
  }

  /** Writes the company's own set for one kind. */
  async upsert(
    caller: AuthenticatedUser,
    companyId: string,
    documentKind: TermsDocumentKind,
    body: string,
    ipAddress: string,
  ): Promise<TermsTemplateView> {
    const saved = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.termsTemplate.upsert({
          where: { companyId_documentKind: { companyId, documentKind } },
          create: {
            companyId,
            documentKind,
            body: body.trim(),
            updatedByUserId: caller.id,
          },
          update: { body: body.trim(), updatedByUserId: caller.id },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.UPDATE,
      entityId: saved.id,
      accountId: caller.id,
      companyId,
      ipAddress,
      // The kind and the length, never the body: an audit row is read in a list, and a
      // forty-clause contract pasted into one buries everything around it.
      changes: { termsFor: documentKind, length: saved.body.length },
    });

    return {
      documentKind: saved.documentKind,
      body: saved.body,
      isCustomised: true,
      updatedAt: saved.updatedAt,
    };
  }
}
