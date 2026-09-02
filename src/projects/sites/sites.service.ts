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

  /**
   * Every site in a company, as `{ id, name }`.
   *
   * Added for 005's frontend, which must offer a site picker when creating an
   * employee — `Employee.siteId` is mandatory, and without a way to list sites the
   * form is unfillable. Deliberately the narrowest possible read: no geofence, no
   * coordinates, nothing a caller does not need to render a dropdown. The Projects
   * feature (008) will own the full Site CRUD and should replace the controller
   * over this, not extend it.
   */
  async listForCompany(
    ctx: RlsContext,
    companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findMany({
        where: { companyId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

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
