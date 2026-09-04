import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  MusterStatus,
  Prisma,
  RateSource,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { ProjectsService } from '../../projects/portfolio/projects.service';

/** Parses a `YYYY-MM-DD` string to a UTC date-only `Date`. */
export function parseDateOnly(value: string): Date {
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return d;
}

/** The day before a date-only `Date`, as another date-only `Date`. */
export function dayBefore(date: Date): Date {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}

export interface WageRateView {
  id: string;
  projectId: string;
  skillCategoryId: string;
  dailyRate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
}

export interface ResolvedRate {
  rate: number;
  source: RateSource;
}

/**
 * Per-project, per-skill-category effective-dated wage rates (013 US1, FR-004 to
 * FR-007) — the same non-overlapping append-forward history 006 FR-014 uses for hire
 * rates. `resolveRate` is the single point the payment-sheet generator prices a
 * worked day through.
 */
@Injectable()
export class WageRateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly projects: ProjectsService,
  ) {}

  private toView(row: {
    id: string;
    projectId: string;
    skillCategoryId: string;
    dailyRate: Prisma.Decimal;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }): WageRateView {
    return {
      id: row.id,
      projectId: row.projectId,
      skillCategoryId: row.skillCategoryId,
      dailyRate: row.dailyRate.toNumber(),
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo
        ? row.effectiveTo.toISOString().slice(0, 10)
        : null,
      isCurrent: row.effectiveTo === null,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      projectId?: string;
      skillCategoryId?: string;
      asOf?: string;
    },
  ): Promise<WageRateView[]> {
    const where: Prisma.WageRateWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.skillCategoryId
        ? { skillCategoryId: query.skillCategoryId }
        : {}),
    };

    if (query.asOf) {
      const asOf = parseDateOnly(query.asOf);
      where.effectiveFrom = { lte: asOf };
      where.OR = [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }];
    }

    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.wageRate.findMany({
          where,
          orderBy: [{ effectiveFrom: 'desc' }],
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * Appends a new rate forward (FR-004): the prior open-ended rate for the same
   * project and skill category has its `effectiveTo` closed to the day before the
   * new `effectiveFrom`. An `effectiveFrom` at or before any existing rate's is
   * rejected — rates are appended forward, not inserted (FR-004).
   */
  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      projectId: string;
      skillCategoryId: string;
      dailyRate: number;
      effectiveFrom: string;
    },
    ipAddress: string,
  ): Promise<WageRateView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    const effectiveFrom = parseDateOnly(dto.effectiveFrom);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.wageRate.findMany({
          where: {
            companyId,
            projectId: dto.projectId,
            skillCategoryId: dto.skillCategoryId,
            deletedAt: null,
          },
          orderBy: { effectiveFrom: 'desc' },
        });

        const latest = existing[0];
        if (latest && effectiveFrom <= latest.effectiveFrom) {
          throw new BadRequestException(
            'A rate with an equal or later effective-from date already exists; rates are appended forward. Amend the existing rate instead of backdating.',
          );
        }

        if (latest && latest.effectiveTo === null) {
          await tx.wageRate.update({
            where: { id: latest.id },
            data: { effectiveTo: dayBefore(effectiveFrom) },
          });
        }

        return tx.wageRate.create({
          data: {
            companyId,
            projectId: dto.projectId,
            skillCategoryId: dto.skillCategoryId,
            dailyRate: dto.dailyRate,
            effectiveFrom,
            effectiveTo: null,
            createdBy: caller.id,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.WAGE_RATE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  /**
   * Edits a rate's daily amount. Rejected with 409 once the rate has priced an
   * approved muster (FR-005) — a rate that has already paid attendance is immutable.
   */
  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: { dailyRate: number },
    ipAddress: string,
  ): Promise<WageRateView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.wageRate.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Wage rate ${id} not found`);
        }
        assertInScope(caller, existing, `Wage rate ${id}`);

        if (
          await this.hasPricedApprovedMuster(
            caller,
            tx,
            existing.projectId,
            existing.skillCategoryId,
            existing.effectiveFrom,
            existing.effectiveTo,
          )
        ) {
          throw new ConflictException(
            'This rate has already priced approved attendance and can no longer be edited.',
          );
        }

        return tx.wageRate.update({
          where: { id },
          data: { dailyRate: dto.dailyRate },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.WAGE_RATE,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  /**
   * Resolves the daily rate applicable to a worker on a date: the worker's own
   * `rateOverride` takes precedence, otherwise the project + skill-category rate in
   * force on that date (FR-006). Returns null when neither exists — the caller
   * decides whether that is a 409 (payment-sheet generation) or benign.
   */
  async resolveRate(
    caller: AuthenticatedUser,
    input: {
      projectId: string;
      skillCategoryId: string;
      rateOverride: number | null;
      date: Date;
      tx?: Prisma.TransactionClient;
    },
  ): Promise<ResolvedRate | null> {
    if (input.rateOverride !== null && input.rateOverride !== undefined) {
      return { rate: input.rateOverride, source: RateSource.override };
    }

    const run = async (tx: Prisma.TransactionClient) =>
      tx.wageRate.findFirst({
        where: {
          projectId: input.projectId,
          skillCategoryId: input.skillCategoryId,
          deletedAt: null,
          effectiveFrom: { lte: input.date },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.date } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });

    const rate = input.tx
      ? await run(input.tx)
      : await withRlsContext(this.prisma, rlsContextFor(caller), run);

    if (!rate) return null;
    return { rate: rate.dailyRate.toNumber(), source: RateSource.project_rate };
  }

  /** Whether any approved muster line for this project + skill falls inside the
   * rate's effective window — the FR-005 immutability test. */
  private async hasPricedApprovedMuster(
    caller: AuthenticatedUser,
    tx: Prisma.TransactionClient,
    projectId: string,
    skillCategoryId: string,
    from: Date,
    to: Date | null,
  ): Promise<boolean> {
    const siteIds = await this.projects.getSitesByProject(
      projectId,
      rlsContextFor(caller),
    );
    if (siteIds.length === 0) return false;

    const count = await tx.musterLine.count({
      where: {
        skillCategoryIdOnDay: skillCategoryId,
        muster: {
          status: MusterStatus.approved,
          siteId: { in: siteIds },
          date: { gte: from, ...(to ? { lte: to } : {}) },
        },
      },
    });
    return count > 0;
  }
}
