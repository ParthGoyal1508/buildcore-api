import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../inventory/constants/inventory.constants';
import { assertInScope, companyScope, isInScope } from '../company-scope';
import {
  CompositeComponentDto,
  CreateCompositeItemDto,
  ListCompositeItemsDto,
  UpdateCompositeItemDto,
} from './dto/composite-item.dto';

export interface CompositeComponentView {
  itemId: string;
  itemName: string;
  itemCode: string;
  /** The sub-item's own unit — the unit `qtyPerUnit` is in. */
  itemUnit: string;
  qtyPerUnit: number;
  position: number;
}

export interface CompositeItemView {
  id: string;
  companyId: string;
  name: string;
  unit: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  components: CompositeComponentView[];
}

export interface PaginatedCompositeItems {
  compositeItems: CompositeItemView[];
  total: number;
  page: number;
  pageSize: number;
}

const WITH_COMPONENTS = {
  components: { orderBy: { position: 'asc' as const } },
} satisfies Prisma.CompositeItemInclude;

type CompositeRow = Prisma.CompositeItemGetPayload<{
  include: typeof WITH_COMPONENTS;
}>;

/**
 * Composite item master (039): a mix — "DLC Concrete for plant foundation" — defined as fixed
 * quantities of ordinary items per one unit of the mix. Issuing 10 CUM of it issues each sub-item
 * in proportion; the composite itself never holds stock.
 *
 * A `settings` master beside `ItemsService`, and the same split: whether a composite has been
 * issued is a count of `inventory.Issue` rows, which this module may not read (Principle I), so the
 * delete guard lives in `InventoryItemsService`.
 */
@Injectable()
export class CompositeItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Names the sub-items in one query; an item deleted since reads as unknown rather than failing. */
  private async toViews(
    tx: Prisma.TransactionClient,
    rows: CompositeRow[],
  ): Promise<CompositeItemView[]> {
    const itemIds = [
      ...new Set(rows.flatMap((r) => r.components.map((c) => c.itemId))),
    ];
    const items = itemIds.length
      ? await tx.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, code: true, unit: true },
        })
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      unit: row.unit,
      description: row.description,
      active: row.active,
      createdAt: row.createdAt,
      components: row.components.map((c) => {
        const item = byId.get(c.itemId);
        return {
          itemId: c.itemId,
          itemName: item?.name ?? 'Unknown item',
          itemCode: item?.code ?? '',
          itemUnit: item?.unit ?? '',
          qtyPerUnit: c.qtyPerUnit.toNumber(),
          position: c.position,
        };
      }),
    }));
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListCompositeItemsDto,
  ): Promise<PaginatedCompositeItems> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const where: Prisma.CompositeItemWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.search
        ? { name: { contains: query.search.trim(), mode: 'insensitive' } }
        : {}),
    };
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.compositeItem.findMany({
          where,
          include: WITH_COMPONENTS,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.compositeItem.count({ where }),
      ]);
      return {
        compositeItems: await this.toViews(tx, rows),
        total,
        page,
        pageSize,
      };
    });
  }

  /**
   * Resolves a composite for another module's write — the issue that deducts its sub-items —
   * returning `null` rather than throwing, the contract `ItemsService.getItem()` offers.
   */
  async getCompositeItem(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<CompositeItemView | null> {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const row = await tx.compositeItem.findUnique({
        where: { id },
        include: WITH_COMPONENTS,
      });
      if (!row || !isInScope(caller, row)) return null;
      const [view] = await this.toViews(tx, [row]);
      return view;
    });
  }

  /** Names for the issue list, in one query. A missing id is simply absent from the map. */
  async getNamesByIds(
    caller: AuthenticatedUser,
    ids: string[],
  ): Promise<Map<string, { name: string; unit: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.compositeItem.findMany({
          where: { id: { in: unique } },
          select: { id: true, name: true, unit: true },
        }),
    );
    return new Map(rows.map((r) => [r.id, { name: r.name, unit: r.unit }]));
  }

  /** How many composites name this item in their recipe — the item master's delete guard. */
  async countUsingItem(
    caller: AuthenticatedUser,
    itemId: string,
  ): Promise<number> {
    return withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.compositeItemComponent.count({ where: { itemId } }),
    );
  }

  /**
   * At least one sub-item, each named once, each an active item of this company. The DTO has
   * already held `qtyPerUnit` to a positive number of at most 6 decimals.
   */
  private async validateComponents(
    tx: Prisma.TransactionClient,
    companyId: string,
    components: CompositeComponentDto[],
  ): Promise<void> {
    if (components.length === 0) {
      throw new BadRequestException('A composite needs at least one sub-item.');
    }
    const ids = components.map((c) => c.itemId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Each sub-item can appear only once. Combine the quantities into one row.',
      );
    }
    const items = await tx.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, companyId: true, active: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of ids) {
      const item = byId.get(id);
      if (!item || item.companyId !== companyId) {
        throw new BadRequestException(
          `Item ${id} does not exist in this company`,
        );
      }
      if (!item.active) {
        throw new BadRequestException(
          `${item.name} is retired. Reactivate it or choose another item.`,
        );
      }
    }
  }

  private componentRows(
    companyId: string,
    components: CompositeComponentDto[],
  ) {
    return components.map((c, position) => ({
      companyId,
      itemId: c.itemId,
      qtyPerUnit: new Prisma.Decimal(c.qtyPerUnit),
      position,
    }));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateCompositeItemDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<CompositeItemView> {
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = dto.name.trim();

    const view = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.compositeItem.findFirst({
          where: { companyId: targetCompanyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `A composite item named "${name}" already exists`,
          );
        }
        await this.validateComponents(tx, targetCompanyId, dto.components);
        const created = await tx.compositeItem.create({
          data: {
            companyId: targetCompanyId,
            name,
            unit: dto.unit,
            description: dto.description?.trim() || null,
            components: {
              create: this.componentRows(targetCompanyId, dto.components),
            },
          },
          include: WITH_COMPONENTS,
        });
        const [v] = await this.toViews(tx, [created]);
        return v;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPOSITE_ITEM,
      action: AuditAction.CREATE,
      entityId: view.id,
      changes: {
        after: {
          name: view.name,
          unit: view.unit,
          components: view.components.map(
            (c) => `${c.itemName} ${c.qtyPerUnit} ${c.itemUnit}`,
          ),
        },
      },
      accountId: caller.id,
      companyId: view.companyId,
      ipAddress,
    });
    return view;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateCompositeItemDto,
    ipAddress: string,
  ): Promise<CompositeItemView> {
    const view = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.compositeItem.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Composite item ${id} not found`);
        }
        assertInScope(caller, existing, `Composite item ${id}`);

        const name = dto.name?.trim();
        if (name !== undefined && name !== existing.name) {
          const clash = await tx.compositeItem.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `A composite item named "${name}" already exists`,
            );
          }
        }

        // The recipe is replaced whole. Issues already made keep the quantities they deducted —
        // each row stores its own — so a corrected proportion applies from the next issue on.
        if (dto.components !== undefined) {
          await this.validateComponents(tx, existing.companyId, dto.components);
          await tx.compositeItemComponent.deleteMany({
            where: { compositeItemId: id },
          });
          await tx.compositeItemComponent.createMany({
            data: this.componentRows(existing.companyId, dto.components).map(
              (row) => ({ ...row, compositeItemId: id }),
            ),
          });
        }

        const updated = await tx.compositeItem.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
          include: WITH_COMPONENTS,
        });
        const [v] = await this.toViews(tx, [updated]);
        return v;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPOSITE_ITEM,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        after: {
          name: view.name,
          active: view.active,
          ...(dto.components !== undefined
            ? {
                components: view.components.map(
                  (c) => `${c.itemName} ${c.qtyPerUnit} ${c.itemUnit}`,
                ),
              }
            : {}),
        },
      },
      accountId: caller.id,
      companyId: view.companyId,
      ipAddress,
    });
    return view;
  }

  /**
   * Deletes a composite and its recipe. The caller MUST have established that no issue names it —
   * see `InventoryItemsService.removeComposite`.
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
        const existing = await tx.compositeItem.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Composite item ${id} not found`);
        }
        assertInScope(caller, existing, `Composite item ${id}`);
        await tx.compositeItem.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPOSITE_ITEM,
      action: AuditAction.DELETE,
      entityId: id,
      changes: { before: { name: removed.name } },
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
