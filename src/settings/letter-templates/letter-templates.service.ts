import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { LetterKindFieldsService } from '../letter-kinds/letter-kind-fields.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import { LETTER_TEMPLATE_STANDARD_LOCKED } from '../../letters/letter-error-codes';
import {
  StandardLetterTemplate,
  standardTemplateFor,
} from '../../letters/standard-letter-templates';

export interface LetterTemplateView {
  id: string;
  companyId: string;
  /**
   * The `LetterKind` this template belongs to (017 §1 — was `letterType LetterType`).
   */
  letterKindId: string;
  /**
   * The kind's key, still carried on the wire under its original name.
   *
   * 017 replaced the enum with a table, and the five migrated keys are byte-identical to
   * the old enum values — so a client that sent `letterType: "offer"` before sends the
   * same thing now and gets the same answer. Renaming the wire field would have broken
   * every recruitment screen for a change they do not care about.
   */
  letterType: string;
  name: string;
  bodyTemplate: string;
  letterheadAssetId: string | null;
  isActive: boolean;
}

/** A row with its kind joined, which is all `toView` needs. */
type TemplateRow = {
  id: string;
  companyId: string;
  letterKindId: string;
  name: string;
  bodyTemplate: string;
  letterheadAssetId: string | null;
  isActive: boolean;
  letterKind?: { key: string } | null;
};

/**
 * Letter template master (011 FR-020, FR-021) — a `settings`-schema master owned by
 * feature 011. Enforces at most one active template per (company, letterKind) by
 * deactivating the prior active one when a template is activated.
 *
 * **Field validation moved here on 2026-10-02** (017 FR-011b, FR-011c). It used to be the
 * recruitment controller's job, which was right while the token sets were a compile-time map keyed by
 * the five shipped letter types — and wrong the moment a kind became company-definable, because the
 * controller validating a save it does not own meant a template created through any other path was
 * not validated at all. Now every save goes through `LetterKindFieldsService` against **its own
 * kind's** declaration.
 */
@Injectable()
export class LetterTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly fields: LetterKindFieldsService,
  ) {}

  /**
   * The standard template a kind's wording is managed by, or null when the company owns it.
   *
   * Managed means: a **shipped** kind (`companyId` null) for which this product ships a body.
   * A company-defined kind that happens to share a key is the company's own.
   */
  private managedStandard(kind: {
    key: string;
    companyId: string | null;
  }): StandardLetterTemplate | null {
    if (kind.companyId !== null) return null;
    return standardTemplateFor(kind.key) ?? null;
  }

  /**
   * Refuses a write that would change the wording of a managed template (2026-10-14).
   *
   * Only a *change* is refused: a save that sends the standard body and name back unchanged —
   * which is what an editor form that posts every field does when somebody only flipped
   * `isActive` — goes through. The active flag and the letterhead stay the company's.
   */
  private assertWordingNotManaged(
    kind: { key: string; label: string; companyId: string | null },
    dto: { name?: string; bodyTemplate?: string },
  ): void {
    const standard = this.managedStandard(kind);
    if (!standard) return;
    const bodyChanges =
      dto.bodyTemplate !== undefined && dto.bodyTemplate !== standard.body;
    const nameChanges =
      dto.name !== undefined && dto.name.trim() !== standard.name;
    if (!bodyChanges && !nameChanges) return;
    throw new ConflictException({
      statusCode: 409,
      code: LETTER_TEMPLATE_STANDARD_LOCKED,
      message:
        `The ${kind.label} uses the standard wording, which is the same for every company ` +
        'and is restored on every update of the application — an edit here would be ' +
        'silently overwritten. Its letterhead and whether it is active can still be changed.',
    });
  }

  private toView(row: TemplateRow): LetterTemplateView {
    return {
      id: row.id,
      companyId: row.companyId,
      letterKindId: row.letterKindId,
      letterType: row.letterKind?.key ?? '',
      name: row.name,
      bodyTemplate: row.bodyTemplate,
      letterheadAssetId: row.letterheadAssetId,
      isActive: row.isActive,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<LetterTemplateView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.letterTemplate.findMany({
          where: companyScope(caller, companyId),
          include: { letterKind: { select: { key: true } } },
          orderBy: [{ letterKindId: 'asc' }, { name: 'asc' }],
        }),
    );
    return rows.map((r) => this.toView(r));
  }

  /** The active template for a type, resolved during letter generation. Returns null
   * when none is active (the caller raises the FR-020 "missing template" 409). */
  async getActive(
    companyId: string,
    letterKindId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LetterTemplateView | null> {
    const row = await tx.letterTemplate.findFirst({
      where: { companyId, letterKindId, isActive: true },
      include: { letterKind: { select: { key: true } } },
    });
    return row ? this.toView(row) : null;
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      letterKindId: string;
      name: string;
      bodyTemplate: string;
      letterheadAssetId?: string;
      isActive?: boolean;
    },
    ipAddress: string,
  ): Promise<LetterTemplateView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      // A 400, not a 404: the company is not missing — the caller never named one.
      // A cross-company Super Admin has no `companyId` of their own for
      // `companyScope()` to fall back on, so a write from them must say which
      // company it belongs to. Reporting "Company not found" sent people hunting
      // for a deleted company instead of picking one. Same message every other
      // module uses for this case.
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    // A second template for a managed kind would have its wording overwritten at the next
    // start like the first, so creating one is the same refusal as editing one. Read under the
    // caller's own RLS context: shipped kinds are visible to every company.
    const kind = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.letterKind.findUnique({
          where: { id: dto.letterKindId },
          select: { key: true, label: true, companyId: true },
        }),
    );
    if (kind) this.assertWordingNotManaged(kind, dto);

    // Before the transaction, so a refusal costs nothing and the error is about the template rather
    // than about a rolled-back write.
    await this.fields.assertTemplateFieldsDeclared(
      rlsContextFor(caller),
      dto.letterKindId,
      dto.bodyTemplate,
      'save',
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (dto.isActive) {
          await tx.letterTemplate.updateMany({
            where: {
              companyId,
              letterKindId: dto.letterKindId,
              isActive: true,
            },
            data: { isActive: false },
          });
        }
        return tx.letterTemplate.create({
          data: {
            companyId,
            letterKindId: dto.letterKindId,
            name: dto.name.trim(),
            bodyTemplate: dto.bodyTemplate,
            letterheadAssetId: dto.letterheadAssetId ?? null,
            isActive: dto.isActive ?? false,
          },
          include: { letterKind: { select: { key: true } } },
        });
      },
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: {
      name?: string;
      bodyTemplate?: string;
      letterheadAssetId?: string | null;
      isActive?: boolean;
    },
    ipAddress: string,
  ): Promise<LetterTemplateView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.letterTemplate.findUnique({
          where: { id },
          include: {
            letterKind: { select: { key: true, label: true, companyId: true } },
          },
        });
        if (!existing)
          throw new NotFoundException(`Letter template ${id} not found`);
        assertInScope(caller, existing, `Letter template ${id}`);
        this.assertWordingNotManaged(existing.letterKind, dto);

        // Validated against the existing row's kind, not against anything in the DTO — a template's
        // kind is not editable, and reading it from the request would let a caller point validation
        // at a kind that declares what they wanted to use.
        if (dto.bodyTemplate !== undefined) {
          await this.fields.assertTemplateFieldsDeclared(
            rlsContextFor(caller),
            existing.letterKindId,
            dto.bodyTemplate,
            'save',
          );
        }

        if (dto.isActive === true && !existing.isActive) {
          await tx.letterTemplate.updateMany({
            where: {
              companyId: existing.companyId,
              letterKindId: existing.letterKindId,
              isActive: true,
            },
            data: { isActive: false },
          });
        }
        return tx.letterTemplate.update({
          where: { id },
          include: { letterKind: { select: { key: true } } },
          data: {
            name: dto.name?.trim() ?? undefined,
            bodyTemplate: dto.bodyTemplate ?? undefined,
            letterheadAssetId:
              dto.letterheadAssetId === undefined
                ? undefined
                : dto.letterheadAssetId,
            isActive: dto.isActive ?? undefined,
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return this.toView(updated);
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.LETTER,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
