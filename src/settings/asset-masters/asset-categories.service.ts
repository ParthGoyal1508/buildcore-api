import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetTrackingMode,
  AuditAction,
  AuditEntityType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { DEFAULT_ASSET_CATEGORIES } from '../../assets/constants/assets.constants';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateAssetCategoryDto,
  UpdateAssetCategoryDto,
} from './dto/asset-masters.dto';

export interface AssetCategoryView {
  id: string;
  companyId: string;
  name: string;
  trackingMode: AssetTrackingMode;
  depreciationRatePercent: number;
  usefulLifeYears: number;
  custodyRequired: boolean;
  inspectionRequired: boolean;
  inspectionIntervalDays: number | null;
  repairCostThresholdPercent: number;
  active: boolean;
  /** Filled in by the assets-side controller — see the class comment. */
  assetCount: number;
  /** Book value of every asset in the category, likewise assets-side. */
  totalBookValue: number;
  createdAt: Date;
}

/**
 * Asset category master (spec US1, FR-003).
 *
 * Lives in `settings` for the same reason `EquipmentCategoriesService` does: this is
 * company reference data, and the master PRD files masters under Settings. The
 * `assets` module exposes the HTTP surface by calling this service rather than by
 * owning the table.
 *
 * Two guards that read as if they belong here are deliberately absent: whether any
 * asset exists under a category (which freezes `trackingMode` per FR-003, and blocks
 * a delete) and what those assets are worth. Both count rows in the `assets` schema,
 * and Principle I forbids reading it from here — so they live in
 * `AssetService.assertCategoryUnused()` / `countByCategory()` and the assets-side
 * controller composes the two halves. Same split `VendorCategoriesService` and
 * `EquipmentCategoriesService` already make.
 */
@Injectable()
export class AssetCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Seeds the seven defaults for a new company, inside the caller's transaction.
   *
   * `skipDuplicates` so re-running it against a company that already has them is a
   * no-op rather than a unique violation rolling back the larger operation.
   */
  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.assetCategory.createMany({
      data: DEFAULT_ASSET_CATEGORIES.map((category) => ({
        companyId,
        name: category.name,
        trackingMode: category.trackingMode as AssetTrackingMode,
        depreciationRatePercent: category.depreciationRatePercent,
        usefulLifeYears: category.usefulLifeYears,
        custodyRequired: category.custodyRequired,
        inspectionRequired: category.inspectionRequired,
        inspectionIntervalDays: category.inspectionIntervalDays,
      })),
      skipDuplicates: true,
    });
  }

  /** Uppercase and trimmed — the normalisation the unique index depends on. */
  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  /**
   * FR-003 / US1 scenario 2: an inspection requirement without an interval is a
   * schedule nothing can compute, so it is rejected at 400 rather than stored.
   * Checked against the merged post-update state, not the DTO alone, so clearing
   * only one half of the pair is caught too.
   */
  private assertInspectionPairing(state: {
    inspectionRequired: boolean;
    inspectionIntervalDays: number | null;
  }): void {
    if (state.inspectionRequired && !state.inspectionIntervalDays) {
      throw new BadRequestException(
        'inspectionIntervalDays is required when inspectionRequired is true.',
      );
    }
  }

  private toView(
    row: Prisma.AssetCategoryGetPayload<object>,
  ): AssetCategoryView {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      trackingMode: row.trackingMode,
      depreciationRatePercent: Number(row.depreciationRatePercent),
      usefulLifeYears: row.usefulLifeYears,
      custodyRequired: row.custodyRequired,
      inspectionRequired: row.inspectionRequired,
      inspectionIntervalDays: row.inspectionIntervalDays,
      repairCostThresholdPercent: Number(row.repairCostThresholdPercent),
      active: row.active,
      assetCount: 0,
      totalBookValue: 0,
      createdAt: row.createdAt,
    };
  }

  /** Every category in scope, name-ordered. */
  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<AssetCategoryView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetCategory.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /** One category, or null when it does not exist or is out of scope. */
  async getCategory(
    caller: AuthenticatedUser,
    categoryId: string,
  ): Promise<AssetCategoryView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.assetCategory.findUnique({ where: { id: categoryId } }),
    );
    if (!row) return null;
    if (
      !rlsContextFor(caller).isSuperAdmin &&
      row.companyId !== caller.companyId
    ) {
      return null;
    }
    return this.toView(row);
  }

  /** Categories for a list of ids in one query — a register listing 500 assets must
   * not run 500 lookups. */
  async getCategoriesByIds(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, AssetCategoryView>> {
    const unique = [...new Set(categoryIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetCategory.findMany({
          where: { id: { in: unique }, ...companyScope(caller) },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateAssetCategoryDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<AssetCategoryView> {
    const scope = companyScope(caller, requestedCompanyId);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = this.normalise(dto.name);
    this.assertInspectionPairing({
      inspectionRequired: dto.inspectionRequired ?? false,
      inspectionIntervalDays: dto.inspectionIntervalDays ?? null,
    });

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.assetCategory.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `An asset category named ${name} already exists.`,
          );
        }
        return tx.assetCategory.create({
          data: {
            companyId,
            name,
            trackingMode: dto.trackingMode,
            ...(dto.depreciationRatePercent !== undefined
              ? { depreciationRatePercent: dto.depreciationRatePercent }
              : {}),
            ...(dto.usefulLifeYears !== undefined
              ? { usefulLifeYears: dto.usefulLifeYears }
              : {}),
            ...(dto.custodyRequired !== undefined
              ? { custodyRequired: dto.custodyRequired }
              : {}),
            ...(dto.inspectionRequired !== undefined
              ? { inspectionRequired: dto.inspectionRequired }
              : {}),
            inspectionIntervalDays: dto.inspectionIntervalDays ?? null,
            ...(dto.repairCostThresholdPercent !== undefined
              ? { repairCostThresholdPercent: dto.repairCostThresholdPercent }
              : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_CATEGORY,
      action: AuditAction.CREATE,
      entityId: created.id,
      companyId,
      ipAddress,
      changes: { name: created.name, trackingMode: created.trackingMode },
    });
    return this.toView(created);
  }

  /**
   * Updates a category.
   *
   * A `trackingMode` change is only safe while no asset exists under the category
   * (FR-003); the caller must have established that — see the class comment for why
   * that guard cannot run from here.
   */
  async update(
    caller: AuthenticatedUser,
    categoryId: string,
    dto: UpdateAssetCategoryDto,
    ipAddress: string,
  ): Promise<AssetCategoryView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.assetCategory.findUnique({
          where: { id: categoryId },
        });
        if (!existing) throw new NotFoundException('Asset category not found');
        assertInScope(caller, existing, 'Asset category');

        const name = dto.name ? this.normalise(dto.name) : undefined;
        if (name && name !== existing.name) {
          const clash = await tx.assetCategory.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `An asset category named ${name} already exists.`,
            );
          }
        }

        this.assertInspectionPairing({
          inspectionRequired:
            dto.inspectionRequired ?? existing.inspectionRequired,
          inspectionIntervalDays:
            dto.inspectionIntervalDays !== undefined
              ? dto.inspectionIntervalDays
              : existing.inspectionIntervalDays,
        });

        return tx.assetCategory.update({
          where: { id: categoryId },
          data: {
            ...(name ? { name } : {}),
            ...(dto.trackingMode !== undefined
              ? { trackingMode: dto.trackingMode }
              : {}),
            ...(dto.depreciationRatePercent !== undefined
              ? { depreciationRatePercent: dto.depreciationRatePercent }
              : {}),
            ...(dto.usefulLifeYears !== undefined
              ? { usefulLifeYears: dto.usefulLifeYears }
              : {}),
            ...(dto.custodyRequired !== undefined
              ? { custodyRequired: dto.custodyRequired }
              : {}),
            ...(dto.inspectionRequired !== undefined
              ? { inspectionRequired: dto.inspectionRequired }
              : {}),
            ...(dto.inspectionIntervalDays !== undefined
              ? { inspectionIntervalDays: dto.inspectionIntervalDays }
              : {}),
            ...(dto.repairCostThresholdPercent !== undefined
              ? { repairCostThresholdPercent: dto.repairCostThresholdPercent }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_CATEGORY,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toView(updated);
  }

  /**
   * Deletes a category. The caller must already have established that no asset
   * references it.
   */
  async remove(
    caller: AuthenticatedUser,
    categoryId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.assetCategory.findUnique({
          where: { id: categoryId },
        });
        if (!existing) throw new NotFoundException('Asset category not found');
        assertInScope(caller, existing, 'Asset category');
        await tx.assetCategory.delete({ where: { id: categoryId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_CATEGORY,
      action: AuditAction.DELETE,
      entityId: categoryId,
      companyId: removed.companyId,
      ipAddress,
      changes: { name: removed.name },
    });
  }
}
