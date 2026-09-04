import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { parseDateOnly } from '../../hr/leave/leave-days';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateHireRateDto,
  ListHireRatesDto,
} from './dto/machinery-masters.dto';

export interface HireRateView {
  id: string;
  companyId: string;
  categoryId: string;
  categoryName: string;
  ratePerUnit: number;
  effectiveFrom: Date;
  /** Null means "current" — the open end of the history. */
  effectiveTo: Date | null;
  createdAt: Date;
}

/** One day, in milliseconds — for closing a prior rate the day before the new one. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Effective-dated hire rates per equipment category (006 FR-014).
 *
 * The whole point of this master is SC-006: a hire bill raised last March must still
 * resolve last March's rate after this year's revision lands. A single mutable
 * "current rate" column on the category could not do that — it would silently
 * reprice history — so rates are a non-overlapping timeline instead, and
 * `getEffectiveHireRate()` reads it at a date rather than reading "now".
 */
@Injectable()
export class HireRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toView(row: {
    id: string;
    companyId: string;
    categoryId: string;
    ratePerUnit: unknown;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
    category?: { name: string } | null;
  }): HireRateView {
    return {
      id: row.id,
      companyId: row.companyId,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? '',
      ratePerUnit: Number(row.ratePerUnit),
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      createdAt: row.createdAt,
    };
  }

  /** The effective-dated history, newest first — this is a timeline, and the row
   * people need to see first is the one in force now. */
  async findAll(
    caller: AuthenticatedUser,
    query: ListHireRatesDto,
  ): Promise<HireRateView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.hireRate.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          },
          orderBy: [{ categoryId: 'asc' }, { effectiveFrom: 'desc' }],
          include: { category: { select: { name: true } } },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * The rate in force for a category on a given date (FR-014), or null when the
   * category has no rate covering it.
   *
   * Null is a legitimate answer, not an error: a category may genuinely have no
   * hire rate on file, and the caller — `HireBillsService` — turns that into a
   * "supply a rate" 400 rather than inventing a number.
   */
  async getEffectiveHireRate(
    caller: AuthenticatedUser,
    categoryId: string,
    onDate: Date,
  ): Promise<number | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.hireRate.findFirst({
        where: {
          categoryId,
          ...companyScope(caller),
          effectiveFrom: { lte: onDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
    return row === null ? null : Number(row.ratePerUnit);
  }

  /**
   * Adds a rate to a category's timeline, keeping it non-overlapping (FR-014).
   *
   * An open-ended rate closes the prior current one to the day before it starts.
   * Done inside the same transaction as the insert, so a crash between the two
   * cannot leave two overlapping "current" rates — which would make
   * `getEffectiveHireRate()` return whichever row the planner happened to order
   * first, and that is not a thing a bill's amount should depend on.
   */
  async create(
    caller: AuthenticatedUser,
    dto: CreateHireRateDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<HireRateView> {
    const scope = companyScope(caller, requestedCompanyId);
    const fallbackCompanyId = scope.companyId ?? caller.companyId;
    if (!fallbackCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom.slice(0, 10));
    const effectiveTo = dto.effectiveTo
      ? parseDateOnly(dto.effectiveTo.slice(0, 10))
      : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo cannot be earlier than effectiveFrom.',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const category = await tx.equipmentCategory.findUnique({
          where: { id: dto.categoryId },
        });
        if (!category) {
          throw new BadRequestException(
            `Equipment category ${dto.categoryId} does not exist.`,
          );
        }
        assertInScope(caller, category, 'Equipment category');

        const overlapping = await tx.hireRate.findFirst({
          where: {
            categoryId: dto.categoryId,
            effectiveFrom: { gte: effectiveFrom },
          },
          orderBy: { effectiveFrom: 'asc' },
        });
        if (overlapping) {
          throw new ConflictException(
            `A hire rate already starts on or after ${dto.effectiveFrom.slice(
              0,
              10,
            )} ` +
              'for this category. Rates are a forward-only timeline — add the new ' +
              'rate after the latest one, or delete the later rate first.',
          );
        }

        // Close the prior open-ended rate the day before this one begins. Only ever
        // one such row, by this same invariant.
        await tx.hireRate.updateMany({
          where: { categoryId: dto.categoryId, effectiveTo: null },
          data: {
            effectiveTo: new Date(effectiveFrom.getTime() - MS_PER_DAY),
          },
        });

        return tx.hireRate.create({
          data: {
            companyId: category.companyId,
            categoryId: dto.categoryId,
            ratePerUnit: dto.ratePerUnit,
            effectiveFrom,
            effectiveTo,
          },
          include: { category: { select: { name: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_RATE,
      action: AuditAction.CREATE,
      entityId: created.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        categoryId: created.categoryId,
        ratePerUnit: Number(created.ratePerUnit),
        effectiveFrom: dto.effectiveFrom.slice(0, 10),
      },
    });
    return this.toView(created);
  }

  /**
   * Removes a rate and reopens the one before it.
   *
   * Deleting the current rate would otherwise leave the timeline with a closed end
   * and no rate in force, so the predecessor's `effectiveTo` is cleared — putting
   * the category back exactly where it was before the deleted rate was added.
   */
  async remove(
    caller: AuthenticatedUser,
    rateId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.hireRate.findUnique({
          where: { id: rateId },
        });
        if (!existing) throw new NotFoundException('Hire rate not found');
        assertInScope(caller, existing, 'Hire rate');

        const later = await tx.hireRate.findFirst({
          where: {
            categoryId: existing.categoryId,
            effectiveFrom: { gt: existing.effectiveFrom },
          },
        });
        if (later) {
          throw new ConflictException(
            'Only the most recent hire rate can be removed — deleting one from the ' +
              'middle of the timeline would leave a gap no bill could resolve.',
          );
        }

        await tx.hireRate.delete({ where: { id: rateId } });

        const predecessor = await tx.hireRate.findFirst({
          where: { categoryId: existing.categoryId },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (predecessor) {
          await tx.hireRate.update({
            where: { id: predecessor.id },
            data: { effectiveTo: null },
          });
        }
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_RATE,
      action: AuditAction.DELETE,
      entityId: rateId,
      companyId: removed.companyId,
      ipAddress,
      changes: { categoryId: removed.categoryId },
    });
  }
}
