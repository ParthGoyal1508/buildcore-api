import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  Site,
  SiteStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../../common/prisma/rls-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/projects.constants';
import { CreateSiteDto, ListSitesDto, UpdateSiteDto } from './dto/site.dto';

export interface SiteListPage {
  items: Site[];
  total: number;
  page: number;
  pageSize: number;
}

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
 * Site administration (008 US2), plus the narrow outward contract 003 established
 * for the slice of Site that other modules need (research.md §1). `hr` never queries
 * `projects.Site` directly — Principle I routes every cross-module read through a
 * call like this one, which is what keeps the two schemas independently extractable
 * later.
 *
 * 008 extends this file in place rather than adding a second sites service. The
 * three methods 003 wrote — `listForCompany()`, `getGeofence()`, `getWeeklyOffDay()`
 * — are unchanged and still the only thing `hr` calls; a parallel service would have
 * meant two definitions of what a site is, differing over time in exactly the fields
 * attendance depends on.
 *
 * Note the asymmetry in what the two halves take: 003's exports take a bare
 * `RlsContext`, because their callers are other services with no HTTP request in
 * hand. The CRUD half takes the `AuthenticatedUser`, because it additionally needs
 * the caller's identity for the audit trail and their company for scoping.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    // `hr` imports this module for `getGeofence()`, so the edge back is genuinely
    // circular and `forwardRef` on both sides is what Nest requires to resolve it.
    // The alternative — reading `hr.Employee` from here — is exactly the
    // cross-schema query Principle I exists to prevent, and would be worse.
    @Inject(forwardRef(() => EmployeesService))
    private readonly employees: EmployeesService,
  ) {}

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

  // ── Site administration (008 US2) ──────────────────────────────────────────

  /**
   * The whole site row, for this feature's own consumers (project detail, and DWR
   * and BOQ when those stories land).
   *
   * Separate from `getGeofence()` rather than replacing it: that method returns
   * three numbers HR needs on every punch, and widening it to the full row would put
   * columns attendance has no use for into the hottest read in the system.
   */
  async getSiteById(ctx: RlsContext, siteId: string): Promise<Site> {
    const site = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findUnique({ where: { id: siteId } }),
    );
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }
    return site;
  }

  /** See `ClientsService.targetCompanyOf()` for why the caller's own company is the
   * fallback rather than an immediate refusal. */
  private targetCompanyOf(
    caller: AuthenticatedUser,
    requested?: string,
  ): string {
    const scope = companyScope(caller, requested);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  /**
   * Refuses a project that belongs to another company.
   *
   * Without this a caller could attach their site to any project id they could
   * guess. RLS would not catch it: both rows are in the `projects` schema, and the
   * insert reads as an ordinary same-schema write.
   */
  private async assertProjectInCompany(
    tx: Prisma.TransactionClient,
    companyId: string,
    projectId: string | null | undefined,
  ): Promise<void> {
    if (!projectId) return;
    const project = await tx.project.findFirst({
      where: { id: projectId, companyId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateSiteDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<Site> {
    const targetCompanyId = this.targetCompanyOf(caller, companyId);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.assertProjectInCompany(tx, targetCompanyId, dto.projectId);
        return tx.site.create({
          data: {
            companyId: targetCompanyId,
            name: dto.name.trim(),
            latitude: dto.latitude,
            longitude: dto.longitude,
            geofenceRadiusMeters: dto.geofenceRadiusMeters,
            weeklyOffDay: dto.weeklyOffDay,
            projectId: dto.projectId ?? null,
            address: dto.address ?? null,
            status: dto.status ?? SiteStatus.active,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SITE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return created;
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListSitesDto,
  ): Promise<SiteListPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    const where: Prisma.SiteWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [items, total] = await Promise.all([
        tx.site.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.site.count({ where }),
      ]);
      return { items, total, page, pageSize };
    });
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<Site> {
    const site = await this.getSiteById(rlsContextFor(caller), id);
    assertInScope(caller, site, `Site ${id}`);
    return site;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateSiteDto,
    ipAddress: string,
  ): Promise<Site> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.site.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Site ${id} not found`);
        }
        assertInScope(caller, existing, `Site ${id}`);
        await this.assertProjectInCompany(
          tx,
          existing.companyId,
          dto.projectId,
        );

        return tx.site.update({
          where: { id },
          data: {
            // Applied field by field so a PATCH cannot blank a column it never
            // mentioned — see ClientsService.update() for the same reasoning.
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
            ...(dto.longitude !== undefined
              ? { longitude: dto.longitude }
              : {}),
            ...(dto.geofenceRadiusMeters !== undefined
              ? { geofenceRadiusMeters: dto.geofenceRadiusMeters }
              : {}),
            ...(dto.weeklyOffDay !== undefined
              ? { weeklyOffDay: dto.weeklyOffDay }
              : {}),
            ...(dto.projectId !== undefined
              ? { projectId: dto.projectId || null }
              : {}),
            ...(dto.address !== undefined
              ? { address: dto.address || null }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SITE,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return updated;
  }

  /**
   * Removes a site nothing still depends on.
   *
   * Two guards, for two different reasons. Work reports live in this schema and are
   * counted directly. Employees do not: `hr.Employee.siteId` is a bare id with no
   * foreign key, so nothing in the database would stop this delete, and the count
   * has to come from HR's own service (Principle I).
   *
   * The employee check runs first and outside the transaction it guards, which is a
   * real if narrow race: an employee posted to this site between the check and the
   * delete would be left pointing at a site that no longer exists. It is the same
   * shape 007 accepts elsewhere, and closing it properly needs a lock spanning two
   * schemas — the cost of which is not justified by an administrative delete that
   * one person performs deliberately. Setting the site inactive, which the message
   * recommends, has no such window.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<{ id: string }> {
    const site = await this.findOne(caller, id);

    const employeeCount = await this.employees.countActiveBySite(
      rlsContextFor(caller),
      id,
    );
    if (employeeCount > 0) {
      throw new ConflictException(
        `Site "${site.name}" still has ${employeeCount} active employee(s) ` +
          `posted to it and cannot be deleted. Set it inactive instead.`,
      );
    }

    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      // DWRs reference a project rather than a site directly, so the count goes
      // through the site's project. A site with no project cannot have work reports
      // pointing at it, and skipping the query says so rather than asking Postgres
      // a question whose answer is structurally zero.
      if (site.projectId) {
        const dwrCount = await tx.dailyWorkReport.count({
          where: { projectId: site.projectId },
        });
        if (dwrCount > 0) {
          throw new ConflictException(
            `Site "${site.name}" belongs to a project with ${dwrCount} work ` +
              `report(s) and cannot be deleted. Set it inactive instead.`,
          );
        }
      }
      await tx.site.delete({ where: { id } });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.SITE,
      action: AuditAction.DELETE,
      entityId: site.id,
      accountId: caller.id,
      companyId: site.companyId,
      ipAddress,
    });
    return { id: site.id };
  }
}
