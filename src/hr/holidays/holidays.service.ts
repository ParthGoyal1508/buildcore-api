import { ConflictException, Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';
import type {
  CreateHolidayDto,
  ListHolidaysQueryDto,
} from '../attendance/dto/holiday.dto';

/**
 * The company holiday calendar (005 US3, research.md §6).
 *
 * Supersedes `projects.Site.holidays` — a bare `DateTime[]` column that could not
 * carry a holiday's name or type, could not express "national holiday, every site"
 * without repeating the date on every site row, and lived in the wrong module: a
 * holiday is an HR calendar fact, not a property of a construction site.
 *
 * Reads stay in the `hr` schema, so no cross-module call is involved and
 * Principle I is satisfied by construction.
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * The dates this site does not work, as `YYYY-MM-DD` strings.
   *
   * Strings rather than `Date`s for the reason the superseded `SitesService`
   * method gave, which has not changed: a holiday is a calendar date, not an
   * instant, and returning a `Date` invites a caller to compare it against a
   * timestamp in another timezone and land a day off. `Holiday.date` is a
   * `@db.Date`, so Prisma hands back UTC midnight and the slice is exact.
   *
   * A holiday applies to a site when it is company-wide, or when it is explicitly
   * linked to that site.
   */
  async getHolidayCalendar(
    ctx: RlsContext,
    companyId: string,
    siteId: string,
  ): Promise<string[]> {
    const holidays = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.holiday.findMany({
        where: {
          companyId,
          OR: [{ appliesToAllSites: true }, { sites: { some: { siteId } } }],
        },
        select: { date: true },
      }),
    );

    // Deduplicated: a date could in principle be reachable both as a company-wide
    // holiday and via an explicit site link, and callers treat this as a set.
    return [
      ...new Set(holidays.map((h) => h.date.toISOString().slice(0, 10))),
    ].sort();
  }

  /** The holiday calendar as an admin list, with site applicability resolved. */
  async list(caller: Caller, companyId: string, query: ListHolidaysQueryDto) {
    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.holiday.findMany({
        where: {
          companyId,
          ...(query.from || query.to
            ? {
                date: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.siteId
            ? {
                OR: [
                  { appliesToAllSites: true },
                  { sites: { some: { siteId: query.siteId } } },
                ],
              }
            : {}),
        },
        include: { sites: { select: { siteId: true } } },
        orderBy: { date: 'asc' },
      }),
    );

    return rows.map((h) => ({
      id: h.id,
      name: h.name,
      date: h.date.toISOString().slice(0, 10),
      type: h.type,
      appliesToAllSites: h.appliesToAllSites,
      siteIds: h.sites.map((s) => s.siteId),
    }));
  }

  /**
   * Declares a holiday.
   *
   * A same-date, same-name holiday in the same company is a duplicate rather than a
   * second holiday, so it conflicts — the DB unique index is the backstop and this
   * turns it into a message an admin can act on.
   */
  async create(caller: Caller, companyId: string, dto: CreateHolidayDto) {
    const appliesToAllSites = dto.appliesToAllSites ?? true;

    try {
      const created = await withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.holiday.create({
          data: {
            companyId,
            name: dto.name.trim(),
            date: new Date(`${dto.date}T00:00:00.000Z`),
            type: dto.type ?? 'company',
            appliesToAllSites,
            ...(appliesToAllSites
              ? {}
              : {
                  sites: {
                    create: (dto.siteIds ?? []).map((siteId) => ({ siteId })),
                  },
                }),
          },
          include: { sites: { select: { siteId: true } } },
        }),
      );

      await this.auditLog.record({
        entityType: AuditEntityType.HOLIDAY,
        action: AuditAction.CREATE,
        entityId: created.id,
        changes: { name: created.name, date: dto.date },
        accountId: caller.userId,
        companyId,
        ipAddress: caller.ipAddress,
      });

      return {
        id: created.id,
        name: created.name,
        date: created.date.toISOString().slice(0, 10),
        type: created.type,
        appliesToAllSites: created.appliesToAllSites,
        siteIds: created.sites.map((s) => s.siteId),
      };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A holiday named "${dto.name}" already exists on ${dto.date}.`,
        );
      }
      throw e;
    }
  }
}
