import {
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

export interface SkillCategoryView {
  id: string;
  companyId: string;
  name: string;
  code: string;
  defaultDailyRate: number | null;
  isActive: boolean;
}

export interface CreateSkillCategoryInput {
  companyId?: string;
  name: string;
  code: string;
  defaultDailyRate?: number;
}

export interface UpdateSkillCategoryInput {
  name?: string;
  code?: string;
  defaultDailyRate?: number | null;
  isActive?: boolean;
}

/**
 * Labour skill-category master (013 FR-003, US1).
 *
 * A `settings`-schema reference master, so it lives beside the other per-company
 * masters here rather than in `labour` — the same arrangement `ItemsService` has for
 * inventory. Owned and audited by feature 013 (`SKILL_CATEGORY`), and exported so the
 * labour module (which owns the endpoints and the deletion-in-use guard) can read and
 * mutate it without querying `settings.SkillCategory` directly.
 *
 * Deletion cannot be guarded here: knowing whether a category is referenced means
 * counting `labour.LabourWorker` rows, and Principle I forbids this module reaching
 * into `labour`. The caller establishes that first — exactly as `ItemsService.remove`
 * leaves the stock check to inventory.
 */
@Injectable()
export class SkillCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toView(row: {
    id: string;
    companyId: string;
    name: string;
    code: string;
    defaultDailyRate: Prisma.Decimal | null;
    isActive: boolean;
  }): SkillCategoryView {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      code: row.code,
      defaultDailyRate:
        row.defaultDailyRate === null ? null : row.defaultDailyRate.toNumber(),
      isActive: row.isActive,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<SkillCategoryView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.skillCategory.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /** Resolves one category, scoped to the caller's company. Used by the labour
   * worker service to validate a `skillCategoryId` reference. */
  async getById(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<SkillCategoryView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.skillCategory.findUnique({ where: { id } }),
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

  async create(
    caller: AuthenticatedUser,
    dto: CreateSkillCategoryInput,
    ipAddress: string,
  ): Promise<SkillCategoryView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    const name = dto.name.trim();
    const code = dto.code.trim().toUpperCase();

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.assertFree(tx, companyId, name, code);
        return tx.skillCategory.create({
          data: {
            companyId,
            name,
            code,
            defaultDailyRate: dto.defaultDailyRate ?? null,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SKILL_CATEGORY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateSkillCategoryInput,
    ipAddress: string,
  ): Promise<SkillCategoryView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.skillCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Skill category ${id} not found`);
        }
        assertInScope(caller, existing, `Skill category ${id}`);

        const name = dto.name?.trim() ?? existing.name;
        const code = dto.code?.trim().toUpperCase() ?? existing.code;
        if (name !== existing.name || code !== existing.code) {
          await this.assertFree(tx, existing.companyId, name, code, id);
        }

        return tx.skillCategory.update({
          where: { id },
          data: {
            name,
            code,
            defaultDailyRate:
              dto.defaultDailyRate === undefined
                ? undefined
                : dto.defaultDailyRate,
            isActive: dto.isActive === undefined ? undefined : dto.isActive,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SKILL_CATEGORY,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  /**
   * Deletes a category. The caller MUST have established that no labour worker
   * references it — this service cannot check that without reaching into `labour`.
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
        const existing = await tx.skillCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Skill category ${id} not found`);
        }
        assertInScope(caller, existing, `Skill category ${id}`);
        await tx.skillCategory.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SKILL_CATEGORY,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }

  private async assertFree(
    tx: Prisma.TransactionClient,
    companyId: string,
    name: string,
    code: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await tx.skillCategory.findFirst({
      where: {
        companyId,
        OR: [{ name }, { code }],
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (clash) {
      const field = clash.name === name ? 'name' : 'code';
      throw new ConflictException(
        `A skill category with that ${field} already exists`,
      );
    }
  }
}
