import { Injectable, NotFoundException } from '@nestjs/common';
import { ReimbursementCategory } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

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
 * `settings`' outward contract for reimbursement categories.
 *
 * Read-only by design at this point. Feature 003 validates claims against these;
 * feature 005 owns creating and editing them. `hr` never queries
 * `settings.ReimbursementCategory` directly — Principle I routes it through here
 * (research.md §10).
 */
@Injectable()
export class ReimbursementCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

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
