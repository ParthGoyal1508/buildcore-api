import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, CodeSeriesType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  DEFAULT_PAGE_SIZE,
  ITEM_CODE_INFIX,
  MAX_PAGE_SIZE,
} from '../../inventory/constants/inventory.constants';
import { CodeSeriesService } from '../code-series/code-series.service';
import { assertInScope, companyScope } from '../company-scope';
import { CreateItemDto, ListItemsDto, UpdateItemDto } from './dto/item.dto';

export interface ItemView {
  id: string;
  companyId: string;
  code: string;
  name: string;
  categoryId: string;
  categoryName: string;
  unit: string;
  /** Null when the item has no stock floor — not 0, which would mean "at its floor". */
  reorderLevel: number | null;
  hsnCode: string | null;
  description: string | null;
  active: boolean;
  createdAt: Date;
}

export interface PaginatedItems {
  items: ItemView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Item master (009 FR-015 to FR-018).
 *
 * A `settings`-schema master for the reason research.md §1 gives, alongside
 * `ItemCategoriesService`.
 *
 * The deletion guard is deliberately NOT here, and this is the same split
 * `VendorCategoriesService` documents: knowing whether an item is referenced means
 * counting `inventory.Purchase`/`Issue`/`StockTransfer` rows, and Principle I
 * forbids this module reaching into another's schema. `InventoryItemsService`
 * composes that check with this one.
 */
@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  private toView(row: {
    id: string;
    companyId: string;
    code: string;
    name: string;
    categoryId: string;
    category: { name: string };
    unit: string;
    reorderLevel: { toNumber(): number } | null;
    hsnCode: string | null;
    description: string | null;
    active: boolean;
    createdAt: Date;
  }): ItemView {
    return {
      id: row.id,
      companyId: row.companyId,
      code: row.code,
      name: row.name,
      categoryId: row.categoryId,
      categoryName: row.category.name,
      unit: row.unit,
      // Converted here rather than left as a Prisma `Decimal`: a Decimal serialises
      // as a string, and every consumer of this figure compares it numerically
      // against a computed stock level.
      reorderLevel: row.reorderLevel?.toNumber() ?? null,
      hsnCode: row.hsnCode,
      description: row.description,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListItemsDto,
  ): Promise<PaginatedItems> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where = {
      ...companyScope(caller, query.companyId),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.search
        ? {
            OR: [
              {
                name: { contains: query.search, mode: 'insensitive' as const },
              },
              {
                code: { contains: query.search, mode: 'insensitive' as const },
              },
              {
                hsnCode: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.item.findMany({
          where,
          include: { category: { select: { name: true } } },
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.item.count({ where }),
      ]);
      return {
        items: rows.map((row) => this.toView(row)),
        total,
        page,
        pageSize,
      };
    });
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<ItemView> {
    const item = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.item.findUnique({
          where: { id },
          include: { category: { select: { name: true } } },
        }),
    );
    if (!item) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    assertInScope(caller, item, `Item ${id}`);
    return this.toView(item);
  }

  /**
   * Resolves an item for another module's write-time validation, returning `null`
   * rather than throwing when it does not exist or is out of scope — the same
   * contract `VendorCategoriesService.getVendorCategory()` offers, for callers
   * validating several ids at once that want to report all the bad ones.
   */
  async getItem(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<ItemView | null> {
    const item = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.item.findUnique({
          where: { id },
          include: { category: { select: { name: true } } },
        }),
    );
    if (!item) return null;
    const ctx = rlsContextFor(caller);
    if (!ctx.isSuperAdmin && item.companyId !== caller.companyId) {
      return null;
    }
    return this.toView(item);
  }

  /**
   * Bulk resolution for a stock list, which needs the name, unit, category and
   * reorder level of every item it is about to render. One query rather than one
   * per row: a 500-row stock page would otherwise make 500 round trips.
   */
  async getItemsByIds(
    caller: AuthenticatedUser,
    ids: string[],
  ): Promise<Map<string, ItemView>> {
    if (ids.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.item.findMany({
          where: { id: { in: ids } },
          include: { category: { select: { name: true } } },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateItemDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<ItemView> {
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    const name = dto.name.trim();
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const category = await tx.itemCategory.findUnique({
          where: { id: dto.categoryId },
        });
        if (!category || category.companyId !== targetCompanyId) {
          throw new BadRequestException(
            `Item category ${dto.categoryId} does not exist in this company`,
          );
        }

        const clash = await tx.item.findFirst({
          where: { companyId: targetCompanyId, name },
        });
        if (clash) {
          throw new ConflictException(`An item named "${name}" already exists`);
        }

        const code = await this.codeSeries.next(
          tx,
          targetCompanyId,
          CodeSeriesType.ITEMS,
          ITEM_CODE_INFIX,
        );

        return tx.item.create({
          data: {
            companyId: targetCompanyId,
            code,
            name,
            categoryId: dto.categoryId,
            unit: dto.unit,
            reorderLevel: dto.reorderLevel ?? null,
            hsnCode: dto.hsnCode?.trim() || null,
            description: dto.description?.trim() || null,
          },
          include: { category: { select: { name: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateItemDto,
    ipAddress: string,
  ): Promise<ItemView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.item.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Item ${id} not found`);
        }
        assertInScope(caller, existing, `Item ${id}`);

        if (dto.name !== undefined && dto.name.trim() !== existing.name) {
          const clash = await tx.item.findFirst({
            where: { companyId: existing.companyId, name: dto.name.trim() },
          });
          if (clash) {
            throw new ConflictException(
              `An item named "${dto.name.trim()}" already exists`,
            );
          }
        }

        if (
          dto.categoryId !== undefined &&
          dto.categoryId !== existing.categoryId
        ) {
          const category = await tx.itemCategory.findUnique({
            where: { id: dto.categoryId },
          });
          if (!category || category.companyId !== existing.companyId) {
            throw new BadRequestException(
              `Item category ${dto.categoryId} does not exist in this company`,
            );
          }
        }

        return tx.item.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.categoryId !== undefined
              ? { categoryId: dto.categoryId }
              : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
            ...(dto.reorderLevel !== undefined
              ? { reorderLevel: dto.reorderLevel }
              : {}),
            ...(dto.hsnCode !== undefined
              ? { hsnCode: dto.hsnCode?.trim() || null }
              : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
          include: { category: { select: { name: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { name: updated.name, active: updated.active } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  /**
   * Deletes an item. The caller MUST have established that no purchase, issue or
   * transfer references it — this service cannot check that without reaching into
   * `inventory`.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.item.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Item ${id} not found`);
        }
        assertInScope(caller, existing, `Item ${id}`);
        await tx.item.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
