import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope, resolveCompanyId } from '../../settings/company-scope';
import { SitesService } from '../../projects/sites/sites.service';
import { UsersService } from '../../users/users.service';

export interface SiteOption {
  id: string;
  name: string;
}

export interface SupervisorAssignment {
  userId: string;
  name: string;
  siteIds: string[];
}

/**
 * Which sites a supervisor works (031). A supervisor registers labour, sees labour and marks
 * attendance only at the sites HR has assigned them.
 *
 * Holding `LABOUR_APPROVE` (the HR office) or cross-company access lifts the restriction: those
 * callers manage every site, and requiring them to assign themselves to each one would only be a
 * chore that fails open the day somebody forgets.
 */
@Injectable()
export class SupervisorSiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly sites: SitesService,
    private readonly users: UsersService,
  ) {}

  /** Null means every site in the company; otherwise the caller's assigned site ids. */
  async allowedSiteIds(caller: AuthenticatedUser): Promise<string[] | null> {
    if (this.seesEverySite(caller)) return null;
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.supervisorSite.findMany({
          where: { userId: caller.id, ...companyScope(caller) },
          select: { siteId: true },
        }),
    );
    return rows.map((r) => r.siteId);
  }

  /**
   * 403 when the caller is not assigned to `siteId`. Forbidden rather than not-found: the site is
   * one the supervisor can name and HR can fix, and the message says so.
   */
  async assertSiteAllowed(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<void> {
    const allowed = await this.allowedSiteIds(caller);
    if (allowed !== null && !allowed.includes(siteId)) {
      throw new ForbiddenException({
        code: 'LABOUR_SITE_NOT_ASSIGNED',
        message:
          'You are not assigned to this site. Ask the HR office to assign it to you.',
      });
    }
  }

  /** The sites the caller may work at, named, for the site picker. */
  async mySites(caller: AuthenticatedUser): Promise<SiteOption[]> {
    const all = await this.companySites(caller);
    const allowed = await this.allowedSiteIds(caller);
    return allowed === null ? all : all.filter((s) => allowed.includes(s.id));
  }

  /** Everyone who can mark labour attendance, with the sites each is assigned (HR view). */
  async listAssignments(caller: AuthenticatedUser): Promise<{
    supervisors: SupervisorAssignment[];
    sites: SiteOption[];
  }> {
    const companyId = this.requireCompany(caller);
    const [holders, rows, sites] = await Promise.all([
      this.users.findActiveHoldersOfPermission(
        Permission.DAILY_WORKER_REGISTRY,
        companyId,
      ),
      withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.supervisorSite.findMany({ where: { companyId } }),
      ),
      this.companySites(caller),
    ]);
    const byUser = new Map<string, string[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.siteId]);
    }
    return {
      supervisors: holders.map((h) => ({
        userId: h.id,
        name: h.name,
        siteIds: byUser.get(h.id) ?? [],
      })),
      sites,
    };
  }

  /** Replaces a supervisor's assigned sites with `siteIds`. */
  async setAssignments(
    caller: AuthenticatedUser,
    userId: string,
    siteIds: string[],
    ipAddress: string,
  ): Promise<SupervisorAssignment> {
    const companyId = this.requireCompany(caller);
    const holders = await this.users.findActiveHoldersOfPermission(
      Permission.DAILY_WORKER_REGISTRY,
      companyId,
    );
    const holder = holders.find((h) => h.id === userId);
    if (!holder) {
      throw new NotFoundException(
        'No active account with labour attendance access was found for this user',
      );
    }
    const unique = Array.from(new Set(siteIds));
    const known = new Set((await this.companySites(caller)).map((s) => s.id));
    const unknown = unique.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown site: ${unknown.join(', ')}`);
    }

    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      await tx.supervisorSite.deleteMany({
        where: { companyId, userId, siteId: { notIn: unique } },
      });
      await tx.supervisorSite.createMany({
        data: unique.map((siteId) => ({
          companyId,
          userId,
          siteId,
          createdBy: caller.id,
        })),
        skipDuplicates: true,
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.UPDATE,
      entityId: userId,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes: { supervisorSites: unique },
    });
    return { userId, name: holder.name, siteIds: unique };
  }

  private seesEverySite(caller: AuthenticatedUser): boolean {
    return (
      rlsContextFor(caller).isSuperAdmin ||
      caller.permissions.includes(Permission.LABOUR_APPROVE)
    );
  }

  private async companySites(caller: AuthenticatedUser): Promise<SiteOption[]> {
    const companyId = this.requireCompany(caller);
    return this.sites.listForCompany(rlsContextFor(caller), companyId);
  }

  private requireCompany(caller: AuthenticatedUser): string {
    return resolveCompanyId(caller);
  }
}
