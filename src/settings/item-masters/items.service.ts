import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../../common/prisma/rls-context';
import {
  DEFAULT_PAGE_SIZE,
  ITEM_CODE_INFIX,
  MAX_PAGE_SIZE,
} from '../../inventory/constants/inventory.constants';
import { CodeSeriesService } from '../code-series/code-series.service';
import { assertInScope, companyScope, isInScope } from '../company-scope';
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
  /** 050: the rate changes day to day. */
  dailyRate: boolean;
  /** 050: the fuel machines draw. */
  machineFuel: boolean;
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
    dailyRate: boolean;
    machineFuel: boolean;
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
      dailyRate: row.dailyRate,
      machineFuel: row.machineFuel,
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

    const where = this.whereFor(caller, query);

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

  /**
   * The ids of every item matching a search or category, unpaginated (036 M5).
   *
   * For another module filtering its own rows by item attributes — the stock list's search and
   * category filter. It used to go through `findAll` at `MAX_PAGE_SIZE`, which silently dropped
   * every match past the 200th: an item beyond it vanished from a filtered stock list and the
   * category total came out short. Ids only, so the unbounded read stays one narrow column.
   */
  async getItemIdsMatching(
    caller: AuthenticatedUser,
    query: Pick<ListItemsDto, 'search' | 'categoryId' | 'companyId' | 'active'>,
  ): Promise<string[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.item.findMany({
          where: this.whereFor(caller, query),
          select: { id: true },
        }),
    );
    return rows.map((row) => row.id);
  }

  private whereFor(
    caller: AuthenticatedUser,
    query: Pick<
      ListItemsDto,
      'search' | 'categoryId' | 'companyId' | 'active' | 'dailyRate'
    >,
  ) {
    return {
      ...companyScope(caller, query.companyId),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.dailyRate !== undefined ? { dailyRate: query.dailyRate } : {}),
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
    // `isInScope`, not `row.companyId !== caller.companyId`. That comparison ignored the 019
    // company switcher, and because this reader feeds a validator the symptom was a refusal
    // stating that a row which plainly exists does not — see `isInScope`.
    if (!isInScope(caller, item)) {
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

        if (dto.machineFuel) {
          await this.clearMachineFuel(tx, targetCompanyId);
        }
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
            // A machine fuel is always a daily-rate item (050).
            dailyRate: Boolean(dto.dailyRate || dto.machineFuel),
            machineFuel: Boolean(dto.machineFuel),
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

        // 050: one machine fuel per company, and it is always a daily-rate item; an item that stops
        // changing daily stops being the fuel.
        if (dto.machineFuel) {
          await this.clearMachineFuel(tx, existing.companyId, id);
        }
        const dailyRate =
          dto.machineFuel === true
            ? true
            : dto.dailyRate !== undefined
            ? dto.dailyRate
            : undefined;
        const machineFuel =
          dto.dailyRate === false && dto.machineFuel === undefined
            ? false
            : dto.machineFuel;

        return tx.item.update({
          where: { id },
          data: {
            ...(dailyRate !== undefined ? { dailyRate } : {}),
            ...(machineFuel !== undefined ? { machineFuel } : {}),
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
      changes: {
        after: {
          name: updated.name,
          active: updated.active,
          dailyRate: updated.dailyRate,
          machineFuel: updated.machineFuel,
        },
      },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  /** 050: at most one machine fuel per company — marking one unmarks the rest. */
  private async clearMachineFuel(
    tx: Prisma.TransactionClient,
    companyId: string,
    exceptId?: string,
  ): Promise<void> {
    await tx.item.updateMany({
      where: {
        companyId,
        machineFuel: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { machineFuel: false },
    });
  }

  /**
   * The company's machine fuel item, if one is marked (050) — what a Machinery fuel entry's rate is
   * offered from. Null when none is marked, so the fuel form simply offers nothing.
   */
  async machineFuelItem(
    ctx: RlsContext,
    companyId: string,
  ): Promise<{ id: string; name: string; code: string } | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.item.findFirst({
        where: { companyId, machineFuel: true, active: true },
        select: { id: true, name: true, code: true },
      }),
    );
  }

  /**
   * The company's active daily-rate items (050), for Update today's rates. Unpaginated: these are a
   * handful of commodities, not the item master.
   */
  async dailyRateItems(
    caller: AuthenticatedUser,
    companyId: string,
  ): Promise<ItemView[]> {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const rows = await tx.item.findMany({
        where: { companyId, dailyRate: true, active: true },
        include: { category: { select: { name: true } } },
        orderBy: { name: 'asc' },
      });
      return rows.map((row) => this.toView(row));
    });
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
