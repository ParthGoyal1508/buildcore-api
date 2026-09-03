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
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateVendorCategoryDto,
  UpdateVendorCategoryDto,
} from './dto/vendor-category.dto';

/**
 * The six categories every company starts with (007 US1).
 *
 * Seeded rather than hardcoded as an enum: they are the common case, not the only
 * case, and a company that buys something these six do not describe must be able to
 * say so without a deploy.
 */
export const DEFAULT_VENDOR_CATEGORIES = [
  {
    name: 'Material',
    description: 'Cement, steel, aggregates and other supplies',
  },
  { name: 'Fuel', description: 'Diesel, petrol and lubricants' },
  { name: 'Hire', description: 'Plant and equipment taken on hire' },
  { name: 'Service', description: 'Professional and maintenance services' },
  { name: 'Transport', description: 'Freight and vehicle hire' },
  { name: 'Subcontractor', description: 'Labour and works subcontractors' },
] as const;

export interface VendorCategoryView {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
}

/**
 * Vendor category master (007 FR-002a).
 *
 * Lives in `settings`, not `partners`, because it is a company master edited under
 * Settings and referenced from several modules — the same shape Departments and
 * Designations already have. `PartnersModule` exposes the HTTP surface by calling
 * this service rather than by owning the table.
 *
 * The deletion guard is deliberately NOT here: knowing whether a category is in use
 * means reading `partners.VendorDealsIn`, and Principle I forbids this module
 * reaching into another's schema. The partners-side service composes that check with
 * this one — see `src/partners/vendor-categories/vendor-categories.service.ts`.
 */
@Injectable()
export class VendorCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Creates the six defaults for a new company, inside the caller's transaction.
   *
   * `createMany` with `skipDuplicates` rather than a plain insert, so re-running it
   * against a company that already has them is a no-op instead of a unique-violation
   * that would roll back the whole company creation.
   */
  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.vendorCategory.createMany({
      data: DEFAULT_VENDOR_CATEGORIES.map((category) => ({
        companyId,
        name: category.name,
        description: category.description,
        isDefault: true,
      })),
      skipDuplicates: true,
    });
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<VendorCategoryView[]> {
    return withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.vendorCategory.findMany({
        where: companyScope(caller, companyId),
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    );
  }

  async findOne(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<VendorCategoryView> {
    const category = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.vendorCategory.findUnique({ where: { id } }),
    );
    if (!category) {
      throw new NotFoundException(`Vendor category ${id} not found`);
    }
    assertInScope(caller, category, `Vendor category ${id}`);
    return category;
  }

  /**
   * Resolves a category id for another module's write-time validation, returning
   * `null` rather than throwing when it does not exist or is out of scope. Callers
   * validate a whole array of ids at once and want to report all the bad ones, not
   * abort on the first.
   */
  async getVendorCategory(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<VendorCategoryView | null> {
    const category = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.vendorCategory.findUnique({ where: { id } }),
    );
    if (!category) return null;
    const ctx = rlsContextFor(caller);
    if (!ctx.isSuperAdmin && category.companyId !== caller.companyId) {
      return null;
    }
    return category;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateVendorCategoryDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<VendorCategoryView> {
    // `companyScope` returns no company at all for a cross-company caller, which is
    // right for a list (they see every company) but not for a create, which has to
    // name one. Fall back to their own company before giving up — the same order
    // ReferenceDataService.companyIdFor(), SitesController.list() and
    // ReimbursementCategoriesController.companyOf() use. Only a cross-company caller
    // with no company of their own reaches the throw, and 400 rather than 409
    // because nothing conflicts: the request is simply missing a value.
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.vendorCategory.findFirst({
          where: { companyId: targetCompanyId, name: dto.name.trim() },
        });
        if (clash) {
          throw new ConflictException(
            `A vendor category named "${dto.name.trim()}" already exists`,
          );
        }
        return tx.vendorCategory.create({
          data: {
            companyId: targetCompanyId,
            name: dto.name.trim(),
            description: dto.description?.trim() ?? null,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.VENDOR_CATEGORY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return created;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateVendorCategoryDto,
    ipAddress: string,
  ): Promise<VendorCategoryView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.vendorCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Vendor category ${id} not found`);
        }
        assertInScope(caller, existing, `Vendor category ${id}`);

        if (dto.name && dto.name.trim() !== existing.name) {
          const clash = await tx.vendorCategory.findFirst({
            where: { companyId: existing.companyId, name: dto.name.trim() },
          });
          if (clash) {
            throw new ConflictException(
              `A vendor category named "${dto.name.trim()}" already exists`,
            );
          }
        }

        return tx.vendorCategory.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() ?? null }
              : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.VENDOR_CATEGORY,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        after: { name: updated.name, description: updated.description },
      },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return updated;
  }

  /**
   * Deletes a category. The caller MUST have established that nothing references it
   * — this service cannot check that without reaching into `partners`.
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
        const existing = await tx.vendorCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Vendor category ${id} not found`);
        }
        assertInScope(caller, existing, `Vendor category ${id}`);
        await tx.vendorCategory.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.VENDOR_CATEGORY,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
