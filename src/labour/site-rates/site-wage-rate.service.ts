import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LabourGender,
  PaymentSheetStatus,
  Prisma,
  RateSource,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { SitesService } from '../../projects/sites/sites.service';
import {
  dayBefore,
  parseDateOnly,
  ResolvedRate,
  WageRateService,
} from '../wage-rates/wage-rate.service';

export interface SiteWageRateView {
  id: string;
  siteId: string;
  gender: LabourGender;
  dailyRate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
}

/**
 * The male and female daily rate HR sets per site (031). Effective-dated and appended forward,
 * the same history `WageRateService` keeps per project and skill: a new rate closes the previous
 * one the day before it starts, so a sheet for a past period still prices at the rate then in force.
 */
@Injectable()
export class SiteWageRateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sites: SitesService,
    private readonly wageRates: WageRateService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { siteId?: string },
  ): Promise<SiteWageRateView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.siteWageRate.findMany({
          where: {
            ...companyScope(caller),
            deletedAt: null,
            ...(query.siteId ? { siteId: query.siteId } : {}),
          },
          orderBy: [
            { siteId: 'asc' },
            { gender: 'asc' },
            { effectiveFrom: 'desc' },
          ],
        }),
    );
    return rows.map(toView);
  }

  /**
   * Sets the site's male and/or female rate from `effectiveFrom`, in one transaction so the pair
   * HR typed together is saved together or not at all.
   */
  async create(
    caller: AuthenticatedUser,
    dto: {
      siteId: string;
      effectiveFrom: string;
      maleRate?: number;
      femaleRate?: number;
    },
    ipAddress: string,
  ): Promise<SiteWageRateView[]> {
    if (dto.maleRate === undefined && dto.femaleRate === undefined) {
      throw new BadRequestException('Enter a male rate, a female rate or both');
    }
    const site = await this.sites.getSiteById(
      rlsContextFor(caller),
      dto.siteId,
    );
    assertInScope(caller, site, `Site ${dto.siteId}`);
    // The site's company, not a resolved one: a cross-company caller may set rates for any
    // company's site, and the rate must land in that site's company.
    const companyId = site.companyId;
    const effectiveFrom = parseDateOnly(dto.effectiveFrom);

    const entries: [LabourGender, number][] = [];
    if (dto.maleRate !== undefined)
      entries.push([LabourGender.male, dto.maleRate]);
    if (dto.femaleRate !== undefined) {
      entries.push([LabourGender.female, dto.femaleRate]);
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const out = [];
        for (const [gender, dailyRate] of entries) {
          const latest = await tx.siteWageRate.findFirst({
            where: { companyId, siteId: dto.siteId, gender, deletedAt: null },
            orderBy: { effectiveFrom: 'desc' },
          });
          if (latest && effectiveFrom <= latest.effectiveFrom) {
            throw new BadRequestException(
              `The ${gender} rate already has one starting ${iso(
                latest.effectiveFrom,
              )}. A new rate must start after it; to correct that rate, edit it instead.`,
            );
          }
          if (latest && latest.effectiveTo === null) {
            await tx.siteWageRate.update({
              where: { id: latest.id },
              data: { effectiveTo: dayBefore(effectiveFrom) },
            });
          }
          out.push(
            await tx.siteWageRate.create({
              data: {
                companyId,
                siteId: dto.siteId,
                gender,
                dailyRate,
                effectiveFrom,
                createdBy: caller.id,
              },
            }),
          );
        }
        return out;
      },
    );

    for (const row of created) {
      await this.audit(
        AuditAction.CREATE,
        row.id,
        companyId,
        caller,
        ipAddress,
      );
    }
    return created.map(toView);
  }

  /**
   * Corrects a rate's amount. Refused once an approved payment sheet for the site covers any day
   * of the rate's window: that money has been agreed, and changing the rate behind it would leave
   * the sheet disagreeing with the rate table.
   */
  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: { dailyRate: number },
    ipAddress: string,
  ): Promise<SiteWageRateView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.siteWageRate.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Site rate ${id} not found`);
        }
        assertInScope(caller, existing, `Site rate ${id}`);
        const priced = await tx.labourPaymentSheet.count({
          where: {
            siteId: existing.siteId,
            deletedAt: null,
            status: { not: PaymentSheetStatus.draft },
            periodTo: { gte: existing.effectiveFrom },
            ...(existing.effectiveTo
              ? { periodFrom: { lte: existing.effectiveTo } }
              : {}),
          },
        });
        if (priced > 0) {
          throw new ConflictException(
            'An approved payment sheet already used this rate, so it can no longer be edited. Add a new rate from a later date instead.',
          );
        }
        return tx.siteWageRate.update({
          where: { id },
          data: { dailyRate: dto.dailyRate },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return toView(updated);
  }

  /** The rate in force for a site and gender on a date, or null when HR has set none. */
  async resolve(
    tx: Prisma.TransactionClient,
    input: { siteId: string; gender: LabourGender; date: Date },
  ): Promise<number | null> {
    const rate = await tx.siteWageRate.findFirst({
      where: {
        siteId: input.siteId,
        gender: input.gender,
        deletedAt: null,
        effectiveFrom: { lte: input.date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.date } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    return rate ? rate.dailyRate.toNumber() : null;
  }

  /**
   * The daily rate for one worked day, in the order 031 settles it:
   *
   * 1. the worker's own `rateOverride`, when the office set one;
   * 2. the site's rate for the worker's gender on that date;
   * 3. for days before any site rate existed, the pre-031 project × skill rate, so musters
   *    approved under the old scheme still price as they did.
   *
   * Null when none applies — the caller decides whether that is a 409 or a skipped day.
   */
  async resolveDayRate(
    caller: AuthenticatedUser,
    tx: Prisma.TransactionClient,
    input: {
      rateOverride: number | null;
      gender: LabourGender | null;
      siteId: string;
      projectId: string | null;
      skillCategoryIdOnDay: string | null;
      date: Date;
    },
  ): Promise<ResolvedRate | null> {
    if (input.rateOverride !== null && input.rateOverride !== undefined) {
      return { rate: input.rateOverride, source: RateSource.override };
    }
    if (input.gender) {
      const rate = await this.resolve(tx, {
        siteId: input.siteId,
        gender: input.gender,
        date: input.date,
      });
      if (rate !== null) return { rate, source: RateSource.site_rate };
    }
    if (input.projectId && input.skillCategoryIdOnDay) {
      return this.wageRates.resolveRate(caller, {
        projectId: input.projectId,
        skillCategoryId: input.skillCategoryIdOnDay,
        rateOverride: null,
        date: input.date,
        tx,
      });
    }
    return null;
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.WAGE_RATE,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toView(row: {
  id: string;
  siteId: string;
  gender: LabourGender;
  dailyRate: Prisma.Decimal;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): SiteWageRateView {
  return {
    id: row.id,
    siteId: row.siteId,
    gender: row.gender,
    dailyRate: row.dailyRate.toNumber(),
    effectiveFrom: iso(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? iso(row.effectiveTo) : null,
    isCurrent: row.effectiveTo === null,
  };
}
