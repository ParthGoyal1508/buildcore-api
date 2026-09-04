import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  MeterType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { DEFAULT_EQUIPMENT_CATEGORIES } from '../../plant/constants/plant.constants';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateEquipmentCategoryDto,
  UpdateEquipmentCategoryDto,
} from './dto/machinery-masters.dto';

export interface EquipmentCategoryView {
  id: string;
  companyId: string;
  name: string;
  meterType: MeterType;
  fuelBenchmark: number | null;
  fuelVarianceThresholdPercent: number;
  targetHoursPerMonth: number;
  active: boolean;
  /** Drives both the list column and whether the delete control is offered. */
  equipmentCount: number;
  createdAt: Date;
}

/**
 * Equipment category master (006 FR-013).
 *
 * Lives in `settings`, not `plant`, for the reason research.md §1 gives: master PRD
 * §7.8.5 lists Machinery Masters as a Settings subsection, and this is company
 * reference data of exactly the kind vendor categories, document types and item
 * categories already are. `PlantModule` exposes the HTTP surface by calling this
 * service rather than by owning the table.
 *
 * Unlike `ItemCategoriesService`, the delete guard is *not* here: what blocks a
 * delete is linked `plant.Equipment` rows, which are another schema's. Counting them
 * from here is exactly the cross-schema query Principle I forbids, so the guard
 * lives on the plant side in `EquipmentService.assertCategoryUnused()` — the same
 * split `VendorCategoriesService` makes.
 */
@Injectable()
export class EquipmentCategoriesService {
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
    await tx.equipmentCategory.createMany({
      data: DEFAULT_EQUIPMENT_CATEGORIES.map((category) => ({
        companyId,
        name: category.name,
        meterType: category.meterType as MeterType,
      })),
      skipDuplicates: true,
    });
  }

  /** Uppercase and trimmed — the normalisation the unique index depends on. */
  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  private toView(
    row: Prisma.EquipmentCategoryGetPayload<{
      include: { _count: { select: { hireRates: true } } };
    }> & { equipmentCount?: number },
  ): EquipmentCategoryView {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      meterType: row.meterType,
      fuelBenchmark:
        row.fuelBenchmark === null ? null : Number(row.fuelBenchmark),
      fuelVarianceThresholdPercent: Number(row.fuelVarianceThresholdPercent),
      targetHoursPerMonth: row.targetHoursPerMonth,
      active: row.active,
      equipmentCount: row.equipmentCount ?? 0,
      createdAt: row.createdAt,
    };
  }

  /**
   * Every category in scope.
   *
   * `equipmentCount` comes back 0 here and is filled in by the plant-side
   * controller, which can count its own schema's rows. Returning the shape with a
   * zero rather than omitting the field keeps one view type for both callers.
   */
  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<EquipmentCategoryView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentCategory.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
          include: { _count: { select: { hireRates: true } } },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /** One category, or null when it does not exist or is out of scope. */
  async getCategory(
    caller: AuthenticatedUser,
    categoryId: string,
  ): Promise<EquipmentCategoryView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentCategory.findUnique({
        where: { id: categoryId },
        include: { _count: { select: { hireRates: true } } },
      }),
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

  /** Categories for a list of ids, in one query — for a register listing 500
   * machines that must not run 500 lookups. */
  async getCategoriesByIds(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, EquipmentCategoryView>> {
    const unique = [...new Set(categoryIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentCategory.findMany({
          where: { id: { in: unique }, ...companyScope(caller) },
          include: { _count: { select: { hireRates: true } } },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateEquipmentCategoryDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<EquipmentCategoryView> {
    const scope = companyScope(caller, requestedCompanyId);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new ConflictException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = this.normalise(dto.name);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.equipmentCategory.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `An equipment category named ${name} already exists.`,
          );
        }
        return tx.equipmentCategory.create({
          data: {
            companyId,
            name,
            meterType: dto.meterType,
            fuelBenchmark: dto.fuelBenchmark ?? null,
            ...(dto.fuelVarianceThresholdPercent !== undefined
              ? {
                  fuelVarianceThresholdPercent:
                    dto.fuelVarianceThresholdPercent,
                }
              : {}),
            ...(dto.targetHoursPerMonth !== undefined
              ? { targetHoursPerMonth: dto.targetHoursPerMonth }
              : {}),
          },
          include: { _count: { select: { hireRates: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_CATEGORY,
      action: AuditAction.CREATE,
      entityId: created.id,
      companyId,
      ipAddress,
      changes: { name: created.name, meterType: created.meterType },
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    categoryId: string,
    dto: UpdateEquipmentCategoryDto,
    ipAddress: string,
  ): Promise<EquipmentCategoryView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.equipmentCategory.findUnique({
          where: { id: categoryId },
        });
        if (!existing)
          throw new NotFoundException('Equipment category not found');
        assertInScope(caller, existing, 'Equipment category');

        const name = dto.name ? this.normalise(dto.name) : undefined;
        if (name && name !== existing.name) {
          const clash = await tx.equipmentCategory.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `An equipment category named ${name} already exists.`,
            );
          }
        }

        return tx.equipmentCategory.update({
          where: { id: categoryId },
          data: {
            ...(name ? { name } : {}),
            ...(dto.meterType !== undefined
              ? { meterType: dto.meterType }
              : {}),
            ...(dto.fuelBenchmark !== undefined
              ? { fuelBenchmark: dto.fuelBenchmark }
              : {}),
            ...(dto.fuelVarianceThresholdPercent !== undefined
              ? {
                  fuelVarianceThresholdPercent:
                    dto.fuelVarianceThresholdPercent,
                }
              : {}),
            ...(dto.targetHoursPerMonth !== undefined
              ? { targetHoursPerMonth: dto.targetHoursPerMonth }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
          include: { _count: { select: { hireRates: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_CATEGORY,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toView(updated);
  }

  /**
   * Deletes a category. The caller must already have established that no equipment
   * references it — see the class comment for why that guard cannot live here.
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
        const existing = await tx.equipmentCategory.findUnique({
          where: { id: categoryId },
        });
        if (!existing)
          throw new NotFoundException('Equipment category not found');
        assertInScope(caller, existing, 'Equipment category');

        const rates = await tx.hireRate.count({ where: { categoryId } });
        if (rates > 0) {
          throw new ConflictException(
            `This category has ${rates} hire rate(s) recorded against it. ` +
              'Retire it instead so historical hire bills still resolve their rate.',
          );
        }

        await tx.equipmentCategory.delete({ where: { id: categoryId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_CATEGORY,
      action: AuditAction.DELETE,
      entityId: categoryId,
      companyId: removed.companyId,
      ipAddress,
      changes: { name: removed.name },
    });
  }
}
