import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  ReimbursementCategory,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type {
  CreateReimbursementCategoryDto,
  UpdateReimbursementCategoryDto,
} from './dto/reimbursement-category.dto';

/** The slice of a category other modules actually need: what it is called, and at
 * what amount a receipt stops being optional. */
export interface ReimbursementCategoryView {
  id: string;
  code: string;
  name: string;
  /** Null when a receipt is never required — distinct from `0`, which requires one
   * on every claim. */
  receiptRequiredAbove: number | null;
}

/**
 * `settings`' contract for reimbursement categories.
 *
 * Feature 003 validates claims against these; feature 005 adds the CRUD below. `hr` never queries
 * `settings.ReimbursementCategory` directly — Principle I routes it through here
 * (research.md §10).
 */
@Injectable()
export class ReimbursementCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Active categories a claim may be filed against. */
  async getReimbursementCategories(
    ctx: RlsContext,
    companyId: string,
  ): Promise<ReimbursementCategoryView[]> {
    const categories = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reimbursementCategory.findMany({
        where: { companyId, isActive: true },
        orderBy: { name: 'asc' },
      }),
    );
    return categories.map(toView);
  }

  /**
   * One category, or 404.
   *
   * Inactive categories are deliberately still resolvable here: a claim filed
   * against a category that is later deactivated must remain readable and
   * renderable, and only the *creation* path checks `isActive`.
   */
  async requireCategory(
    ctx: RlsContext,
    companyId: string,
    categoryId: string,
  ): Promise<ReimbursementCategoryView> {
    const category = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reimbursementCategory.findFirst({
        where: { id: categoryId, companyId },
      }),
    );
    if (!category) {
      throw new NotFoundException('Reimbursement category not found');
    }
    return toView(category);
  }

  /** Every category, active or not — the Settings admin list. */
  async findAll(
    ctx: RlsContext,
    companyId: string,
  ): Promise<ReimbursementCategoryView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reimbursementCategory.findMany({
        where: { companyId },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
    );
    return rows.map(toView);
  }

  async create(
    ctx: RlsContext,
    companyId: string,
    dto: CreateReimbursementCategoryDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<ReimbursementCategoryView> {
    try {
      const created = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.reimbursementCategory.create({
          data: {
            companyId,
            code: dto.code.trim().toUpperCase(),
            name: dto.name.trim(),
            receiptRequiredAbove: dto.receiptRequiredAbove ?? null,
            isActive: dto.isActive ?? true,
          },
        }),
      );

      await this.auditLog.record({
        entityType: AuditEntityType.REIMBURSEMENT_CLAIM,
        action: AuditAction.CREATE,
        entityId: created.id,
        changes: { category: created.code },
        accountId: actor.userId,
        companyId,
        ipAddress: actor.ipAddress,
      });

      return toView(created);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A reimbursement category with code ${dto.code} already exists.`,
        );
      }
      throw e;
    }
  }

  /**
   * Edits a category.
   *
   * Deactivating is how a category is retired — there is deliberately no delete,
   * because claims already filed against it must stay readable and a hard delete
   * would orphan them.
   */
  async update(
    ctx: RlsContext,
    categoryId: string,
    dto: UpdateReimbursementCategoryDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<ReimbursementCategoryView> {
    const existing = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reimbursementCategory.findFirst({ where: { id: categoryId } }),
    );
    if (!existing) throw new NotFoundException('Category not found');

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reimbursementCategory.update({
        where: { id: categoryId },
        data: {
          ...(dto.code ? { code: dto.code.trim().toUpperCase() } : {}),
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(dto.receiptRequiredAbove !== undefined
            ? { receiptRequiredAbove: dto.receiptRequiredAbove }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.REIMBURSEMENT_CLAIM,
      action: AuditAction.UPDATE,
      entityId: categoryId,
      changes: { fields: Object.keys(dto) },
      accountId: actor.userId,
      companyId: existing.companyId,
      ipAddress: actor.ipAddress,
    });

    return toView(updated);
  }
}

function toView(category: ReimbursementCategory): ReimbursementCategoryView {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    receiptRequiredAbove:
      category.receiptRequiredAbove === null
        ? null
        : category.receiptRequiredAbove.toNumber(),
  };
}
