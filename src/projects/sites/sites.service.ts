import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

/** A site's geofence centre and radius, in the plain numeric form callers compute
 * with — Prisma hands back `Decimal`, which is right for storage and wrong for
 * trigonometry. */
export interface SiteGeofence {
  siteId: string;
  latitude: number;
  longitude: number;
  geofenceRadiusMeters: number;
}

/**
 * The `projects` module's outward contract for the slice of Site that other modules
 * need (research.md §1). `hr` never queries `projects.Site` directly — Principle I
 * routes every cross-module read through a call like this one, which is what keeps
 * the two schemas independently extractable later.
 */
@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The geofence a punch at this site is validated against. */
  async getGeofence(ctx: RlsContext, siteId: string): Promise<SiteGeofence> {
    const site = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findFirst({
        where: { id: siteId },
        select: {
          id: true,
          latitude: true,
          longitude: true,
          geofenceRadiusMeters: true,
        },
      }),
    );
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return {
      siteId: site.id,
      latitude: site.latitude.toNumber(),
      longitude: site.longitude.toNumber(),
      geofenceRadiusMeters: site.geofenceRadiusMeters,
    };
  }

  /**
   * The site's non-working days, as `YYYY-MM-DD` strings.
   *
   * Strings rather than `Date`s on purpose: a holiday is a calendar date, not an
   * instant, and handing back a `Date` invites a caller to compare it against a
   * timestamp in another timezone and land a day off.
   */
  async getHolidayCalendar(ctx: RlsContext, siteId: string): Promise<string[]> {
    const site = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findFirst({ where: { id: siteId }, select: { holidays: true } }),
    );
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site.holidays.map((d) => d.toISOString().slice(0, 10));
  }

  /** Day-of-week this site treats as Weekly Off, 0 = Sunday (research.md §6). */
  async getWeeklyOffDay(ctx: RlsContext, siteId: string): Promise<number> {
    const site = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findFirst({
        where: { id: siteId },
        select: { weeklyOffDay: true },
      }),
    );
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site.weeklyOffDay;
  }
}
