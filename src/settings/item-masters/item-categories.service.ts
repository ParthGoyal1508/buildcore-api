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
import { DEFAULT_ITEM_CATEGORIES } from '../../inventory/constants/inventory.constants';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateItemCategoryDto,
  UpdateItemCategoryDto,
} from './dto/item-category.dto';

export interface ItemCategoryView {
  id: string;
  companyId: string;
  name: string;
  /** Drives both the list column and whether the delete control is offered. */
  itemCount: number;
  createdAt: Date;
}

/**
 * Item category master (009 FR-016).
 *
 * Lives in `settings`, not `inventory`, for the reason research.md §1 gives: it is
 * company reference data of the same kind as vendor categories and document types,
 * edited under the SETTINGS permission. `InventoryModule` exposes the HTTP surface
 * by calling this service rather than by owning the table.
 *
 * Unlike `VendorCategoriesService`, the deletion guard *is* here: what blocks a
 * delete is linked `settings.Item` rows, which is this module's own table. Nothing
 * has to reach across a schema boundary to answer it.
 */
@Injectable()
export class ItemCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Creates the ten defaults for a new company, inside the caller's transaction.
   *
   * `createMany` with `skipDuplicates` so re-running it against a company that
   * already has them is a no-op rather than a unique violation that would roll back
   * whatever larger operation called it.
   */
  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.itemCategory.createMany({
      data: DEFAULT_ITEM_CATEGORIES.map((name) => ({ companyId, name })),
      skipDuplicates: true,
    });
  }

  /** Uppercase and trimmed — the normalisation the unique index depends on. */
  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<ItemCategoryView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.itemCategory.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
          include: { _count: { select: { items: true } } },
        }),
    );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      itemCount: row._count.items,
      createdAt: row.createdAt,
    }));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateItemCategoryDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<ItemCategoryView> {
    // `companyScope` returns no company at all for a cross-company caller, which is
    // right for a list and not for a create, which has to name one. Falling back to
    // their own company first is the order every other settings master uses.
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    const name = this.normalise(dto.name);
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.itemCategory.findFirst({
          where: { companyId: targetCompanyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `An item category named "${name}" already exists`,
          );
        }
        return tx.itemCategory.create({
          data: { companyId: targetCompanyId, name },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM_CATEGORY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return { ...created, itemCount: 0 };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateItemCategoryDto,
    ipAddress: string,
  ): Promise<ItemCategoryView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.itemCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Item category ${id} not found`);
        }
        assertInScope(caller, existing, `Item category ${id}`);

        const name =
          dto.name === undefined ? existing.name : this.normalise(dto.name);
        if (name !== existing.name) {
          const clash = await tx.itemCategory.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `An item category named "${name}" already exists`,
            );
          }
        }

        return tx.itemCategory.update({
          where: { id },
          data: { name },
          include: { _count: { select: { items: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM_CATEGORY,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { name: updated.name } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return {
      id: updated.id,
      companyId: updated.companyId,
      name: updated.name,
      itemCount: updated._count.items,
      createdAt: updated.createdAt,
    };
  }

  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.itemCategory.findUnique({
          where: { id },
          include: { _count: { select: { items: true } } },
        });
        if (!existing) {
          throw new NotFoundException(`Item category ${id} not found`);
        }
        assertInScope(caller, existing, `Item category ${id}`);

        // Checked rather than left to the foreign key: the FK would surface as a
        // 500, and the caller needs to know how many items are in the way.
        if (existing._count.items > 0) {
          throw new ConflictException(
            `This category still has ${existing._count.items} item${
              existing._count.items === 1 ? '' : 's'
            }. Recategorise them before deleting it.`,
          );
        }

        await tx.itemCategory.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ITEM_CATEGORY,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
