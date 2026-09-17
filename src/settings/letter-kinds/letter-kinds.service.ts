import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, LetterKind } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import {
  CreateLetterKindDto,
  UpdateLetterKindDto,
} from './dto/letter-kind.dto';
import {
  LETTER_KIND_IN_USE,
  LETTER_KIND_KEY_RESERVED,
  LETTER_KIND_NOT_FOUND,
} from './letter-kind-error-codes';

export interface LetterKindView {
  id: string;
  key: string;
  label: string;
  requiresSignature: boolean;
  requiresApproval: boolean;
  approvalActionType: string | null;
  isActive: boolean;
  /** True when the product ships this kind; false when this company defined it. */
  isShipped: boolean;
}

function toView(row: LetterKind): LetterKindView {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    requiresSignature: row.requiresSignature,
    requiresApproval: row.requiresApproval,
    approvalActionType: row.approvalActionType,
    isActive: row.isActive,
    isShipped: row.companyId === null,
  };
}

/**
 * The letter-kind master (017 §1, FR-011, FR-011a, FR-022).
 *
 * Lives in `settings` because a kind is company configuration, beside `LetterTemplate`
 * and `DocumentType`. The `letters` module consumes it through this service rather than
 * querying `settings.LetterKind`, which Principle I forbids.
 */
@Injectable()
export class LetterKindsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Every kind this company may use: its own, plus the product-shipped ones.
   *
   * Shipped kinds carry `companyId = NULL` and are visible to everyone — the RLS policy
   * admits `companyId IS NULL` for exactly this reason.
   */
  async listFor(
    ctx: RlsContext,
    companyId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<LetterKindView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.findMany({
        where: {
          OR: [{ companyId }, { companyId: null }],
          ...(opts.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ companyId: 'asc' }, { key: 'asc' }],
      }),
    );
    return rows.map(toView);
  }

  /**
   * Resolve one kind by its key.
   *
   * At most one row can match, and that is a guarantee rather than an observation:
   * FR-011a forbids a company-authored kind from reusing a shipped key, and the partial
   * unique index stops two shipped kinds sharing one. Without both, this lookup would
   * need a precedence rule nobody has written.
   */
  async findByKey(
    ctx: RlsContext,
    companyId: string,
    key: string,
  ): Promise<LetterKind | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.findFirst({
        where: { key, OR: [{ companyId }, { companyId: null }] },
      }),
    );
  }

  /** `findByKey`, as a 404. */
  async requireByKey(
    ctx: RlsContext,
    companyId: string,
    key: string,
  ): Promise<LetterKind> {
    const kind = await this.findByKey(ctx, companyId, key);
    if (!kind) {
      throw new NotFoundException({
        statusCode: 404,
        message: `No letter kind "${key}" is defined for this company.`,
        code: LETTER_KIND_NOT_FOUND,
      });
    }
    return kind;
  }

  async requireById(
    ctx: RlsContext,
    companyId: string,
    id: string,
  ): Promise<LetterKind> {
    const kind = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.findFirst({
        where: { id, OR: [{ companyId }, { companyId: null }] },
      }),
    );
    if (!kind) {
      throw new NotFoundException({
        statusCode: 404,
        message: `Letter kind ${id} not found.`,
        code: LETTER_KIND_NOT_FOUND,
      });
    }
    return kind;
  }

  /**
   * Define a new kind — FR-011, without a code change.
   *
   * Refuses a key the product already ships (FR-011a). Checked against **shipped** kinds
   * specifically, not against the company's own: two shipped kinds cannot collide because
   * of the partial index, and a company redefining its own key is an update, not a clash.
   */
  async create(
    ctx: RlsContext,
    companyId: string,
    dto: CreateLetterKindDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<LetterKindView> {
    this.assertApprovalCoherent(dto.requiresApproval, dto.approvalActionType);

    const shipped = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.findFirst({ where: { key: dto.key, companyId: null } }),
    );
    if (shipped) {
      throw new ConflictException({
        statusCode: 409,
        message:
          `"${dto.key}" is a letter kind this product already provides. Two kinds ` +
          `answering to one key leave every lookup ambiguous — edit the existing kind's ` +
          `label instead, or choose a different key.`,
        code: LETTER_KIND_KEY_RESERVED,
      });
    }

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.create({
        data: {
          companyId,
          key: dto.key,
          label: dto.label.trim(),
          requiresSignature: dto.requiresSignature ?? false,
          requiresApproval: dto.requiresApproval ?? false,
          approvalActionType: dto.approvalActionType ?? null,
        },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: { key: created.key, label: created.label },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
    return toView(created);
  }

  /**
   * Edit a kind. The `key` is deliberately not editable — it is what issued letters,
   * templates and 016 action types all match on, and renaming it would orphan every one
   * of them silently.
   */
  async update(
    ctx: RlsContext,
    companyId: string,
    id: string,
    dto: UpdateLetterKindDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<LetterKindView> {
    const existing = await this.requireById(ctx, companyId, id);
    if (existing.companyId === null) {
      throw new ConflictException({
        statusCode: 409,
        message:
          `"${existing.key}" is a product-shipped kind and cannot be edited. Define your ` +
          `own kind with a different key if you need different behaviour.`,
        code: LETTER_KIND_KEY_RESERVED,
      });
    }

    this.assertApprovalCoherent(
      dto.requiresApproval ?? existing.requiresApproval,
      dto.approvalActionType ?? existing.approvalActionType ?? undefined,
    );

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKind.update({
        where: { id },
        data: {
          label: dto.label?.trim() ?? undefined,
          requiresSignature: dto.requiresSignature ?? undefined,
          requiresApproval: dto.requiresApproval ?? undefined,
          approvalActionType:
            dto.approvalActionType === undefined
              ? undefined
              : dto.approvalActionType,
          isActive: dto.isActive ?? undefined,
        },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { key: updated.key, label: updated.label },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
    return toView(updated);
  }

  /**
   * Delete a kind nothing references (FR-022).
   *
   * The refusal comes from the **database**: `IssuedLetter.letterKindId` and
   * `LetterTemplate.letterKindId` are `onDelete: Restrict`, so the delete fails whatever
   * this service believes. Catching the foreign-key violation and translating it is
   * deliberate — counting the referencing letters here would mean `settings` reading
   * `shared.IssuedLetter`, which Principle I forbids, and a count taken before the delete
   * is a guess by the time the delete runs.
   */
  async remove(
    ctx: RlsContext,
    companyId: string,
    id: string,
    actor: { userId: string; ipAddress: string },
  ): Promise<void> {
    const existing = await this.requireById(ctx, companyId, id);
    if (existing.companyId === null) {
      throw new ConflictException({
        statusCode: 409,
        message: `"${existing.key}" is a product-shipped kind and cannot be deleted.`,
        code: LETTER_KIND_KEY_RESERVED,
      });
    }

    try {
      await withRlsContext(this.prisma, ctx, (tx) =>
        tx.letterKind.delete({ where: { id } }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'P2003') {
        throw new ConflictException({
          statusCode: 409,
          message:
            `"${existing.key}" cannot be deleted while letters or templates still ` +
            `reference it. Deactivate it instead — issued letters must keep naming the ` +
            `kind they were issued under.`,
          code: LETTER_KIND_IN_USE,
        });
      }
      throw error;
    }

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.DELETE,
      entityId: id,
      changes: { key: existing.key },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
  }

  /**
   * A kind that requires approval but names no action type would be gated on nothing —
   * `assertMayTakeEffect` would be called with an empty action type and pass, which is
   * the worst of both worlds: it looks gated and is not.
   */
  private assertApprovalCoherent(
    requiresApproval: boolean | undefined,
    approvalActionType: string | undefined,
  ): void {
    if (requiresApproval && !approvalActionType) {
      throw new BadRequestException(
        'A kind that requires approval must name the approval action type to gate on. ' +
          'Without one it would look gated and be gated on nothing.',
      );
    }
  }
}
