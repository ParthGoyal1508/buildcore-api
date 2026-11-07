import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { SitesService } from '../../projects/sites/sites.service';
import {
  ASSIGNMENT_EMPTY,
  ASSIGNMENT_MOBILE_WITH_TARGETS,
  PROJECT_HAS_NO_ACTIVE_SITE,
} from './location-assignments.constants';

/** What an assignment decides, once resolved for a particular day. */
export interface ResolvedAssignment {
  /** FR-014's exemption — **location only**, never the face check. No sites when true. */
  isMobile: boolean;
  /** Sites named directly (058). */
  siteIds: string[];
  /** Projects named (058): every active site of each, resolved at punch time. */
  projectIds: string[];
}

export interface AssignInput {
  siteIds?: string[];
  projectIds?: string[];
  isMobile?: boolean;
  /** `YYYY-MM-DD`. The day from which this assignment decides. */
  effectiveFrom: string;
  reason?: string | null;
}

/** One place an assignment covers, named for display. */
export interface AssignmentTargetView {
  siteId: string | null;
  projectId: string | null;
  name: string;
}

export interface AssignmentView {
  id: string;
  employeeId: string;
  isMobile: boolean;
  effectiveFrom: Date;
  assignedByUserId: string;
  reason: string | null;
  createdAt: Date;
  targets: AssignmentTargetView[];
}

/**
 * Which locations an employee's punches validate against (020 FR-011, FR-014, FR-016; 058).
 *
 * ## Layered over the site fence, never replacing it
 *
 * An employee with no assignment is validated against their site's geofence exactly as before —
 * which is **every** employee on the day 020 shipped. That is FR-016, and it is what lets this table
 * exist without a backfill: the alternative, requiring an assignment, would refuse everybody's
 * attendance on the first morning.
 *
 * ## Several sites (058)
 *
 * An assignment covers a set of **sites and projects**, or is mobile. A project means every active
 * site of that project at the moment of each punch, so a site added to the project later is
 * covered without a new assignment. The punch is matched to the nearest covered site whose fence
 * contains it (`site-match.ts`).
 *
 * ## Append-only
 *
 * `assign()` writes a new row and never updates a prior one. A transfer six months ago stays
 * explicable: the row in force then is still there, with who decided it and when it took effect.
 * Mutating would make the history a single current value and the audit question unanswerable.
 */
@Injectable()
export class LocationAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * The assignment in force for `day`, or null to fall back to the site fence.
   *
   * **Keyed on the punch's day, not on the request time.** An offline-queued punch arriving after a
   * transfer must validate against the assignment in force when it was *taken* — otherwise a worker
   * who punched legitimately at their old site on Monday is refused because they moved on Tuesday.
   *
   * `day` is a `YYYY-MM-DD` date and the column is `@db.Date`, so this comparison carries no time
   * component and no timezone question: an assignment effective on the 3rd governs a punch taken on
   * the 3rd, wherever the server happens to be.
   */
  async inForceOn(
    ctx: RlsContext,
    employeeId: string,
    day: string,
  ): Promise<ResolvedAssignment | null> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employeeLocationAssignment.findFirst({
        where: { employeeId, effectiveFrom: { lte: new Date(day) } },
        // Greatest `effectiveFrom` at or before the day. `createdAt` breaks a tie, so two
        // assignments entered for the same effective date resolve to the one recorded later
        // rather than to whichever the planner returned first.
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        select: {
          isMobile: true,
          targets: { select: { siteId: true, projectId: true } },
        },
      }),
    );
    if (!row) return null;
    return {
      isMobile: row.isMobile,
      siteIds: row.targets.flatMap((t) => (t.siteId ? [t.siteId] : [])),
      projectIds: row.targets.flatMap((t) =>
        t.projectId ? [t.projectId] : [],
      ),
    };
  }

  /** Every assignment for one employee, newest effective date first (FR-011's history). */
  async historyFor(
    ctx: RlsContext,
    employeeId: string,
  ): Promise<AssignmentView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employeeLocationAssignment.findMany({
        where: { employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        include: { targets: { select: { siteId: true, projectId: true } } },
      }),
    );
    if (rows.length === 0) return [];

    const siteIds = rows.flatMap((r) =>
      r.targets.flatMap((t) => (t.siteId ? [t.siteId] : [])),
    );
    const projectIds = rows.flatMap((r) =>
      r.targets.flatMap((t) => (t.projectId ? [t.projectId] : [])),
    );
    const names = await this.targetNames(ctx, siteIds, projectIds);
    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      isMobile: row.isMobile,
      effectiveFrom: row.effectiveFrom,
      assignedByUserId: row.assignedByUserId,
      reason: row.reason,
      createdAt: row.createdAt,
      targets: row.targets.map((t) => ({
        siteId: t.siteId,
        projectId: t.projectId,
        name: names.get(t.siteId ?? t.projectId ?? '') ?? '',
      })),
    }));
  }

  /**
   * Records a new assignment. **Appends; never mutates a prior row** (FR-011).
   *
   * The company is taken from the employee rather than from the caller's input: an assignment filed
   * against a company the employee does not belong to would be invisible to every later read, since
   * the RLS policy scopes on `companyId`. Every site and project must belong to that same company
   * (058 FR-013) — an HR user who works in both companies still cannot post a PRPL employee to a TE
   * site.
   *
   * A project with no active site is saved with a warning rather than refused: every punch under
   * it is refused as outside the fence until a site is added, and adding one is the likely next step.
   */
  async assign(
    ctx: RlsContext,
    employeeId: string,
    input: AssignInput,
    actor: { userId: string; ipAddress: string },
  ): Promise<AssignmentView & { warnings: string[] }> {
    const assignedByUserId = actor.userId;
    const siteIds = [...new Set(input.siteIds ?? [])];
    const projectIds = [...new Set(input.projectIds ?? [])];
    const isMobile = input.isMobile ?? false;
    if (isMobile && (siteIds.length > 0 || projectIds.length > 0)) {
      throw new BadRequestException({
        code: ASSIGNMENT_MOBILE_WITH_TARGETS,
        message:
          'A mobile employee is not tied to any site. Choose mobile, or the sites and projects — not both.',
      });
    }
    if (!isMobile && siteIds.length === 0 && projectIds.length === 0) {
      throw new BadRequestException({
        code: ASSIGNMENT_EMPTY,
        message:
          'Choose at least one site or project, or mark the employee as mobile.',
      });
    }

    const employee = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    const checked = await this.sites.assertTargetsInCompany(
      ctx,
      employee.companyId,
      { siteIds, projectIds },
    );

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employeeLocationAssignment.create({
        data: {
          companyId: employee.companyId,
          employeeId,
          isMobile,
          effectiveFrom: new Date(input.effectiveFrom),
          assignedByUserId,
          reason: input.reason ?? null,
          targets: {
            create: [
              ...siteIds.map((siteId) => ({
                companyId: employee.companyId,
                siteId,
              })),
              ...projectIds.map((projectId) => ({
                companyId: employee.companyId,
                projectId,
              })),
            ],
          },
        },
        include: { targets: { select: { siteId: true, projectId: true } } },
      }),
    );

    // FR-014 (058): the history row says what; the audit log says who, from where, and makes the
    // change findable in the activity log alongside the rest of the employee's record.
    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE,
      action: AuditAction.UPDATE,
      entityId: employeeId,
      changes: {
        locationAssignment: {
          id: created.id,
          isMobile,
          effectiveFrom: input.effectiveFrom,
          siteIds,
          projectIds,
          reason: input.reason ?? null,
        },
      } as Prisma.InputJsonValue,
      accountId: assignedByUserId,
      companyId: employee.companyId,
      ipAddress: actor.ipAddress,
    });

    const names = new Map([...checked.siteNames, ...checked.projectNames]);
    return {
      id: created.id,
      employeeId: created.employeeId,
      isMobile: created.isMobile,
      effectiveFrom: created.effectiveFrom,
      assignedByUserId: created.assignedByUserId,
      reason: created.reason,
      createdAt: created.createdAt,
      targets: created.targets.map((t) => ({
        siteId: t.siteId,
        projectId: t.projectId,
        name: names.get(t.siteId ?? t.projectId ?? '') ?? '',
      })),
      warnings:
        checked.projectsWithoutActiveSite.length > 0
          ? [PROJECT_HAS_NO_ACTIVE_SITE]
          : [],
    };
  }

  /**
   * The sites an employee's assignment covers on `day`, for checking a site HR names on a manual
   * punch (058 FR-012). `null` means "any active site of the company" — a mobile employee, who
   * has no list. An employee with no assignment covers their own site only.
   */
  async coveredSiteIds(
    ctx: RlsContext,
    employee: { id: string; siteId: string },
    day: string,
  ): Promise<string[] | null> {
    const assignment = await this.inForceOn(ctx, employee.id, day);
    if (!assignment) return [employee.siteId];
    if (assignment.isMobile) return null;
    const fences = await this.sites.geofencesFor(ctx, assignment);
    return fences.map((fence) => fence.siteId);
  }

  /** Names for history rows. A site or project since deleted, or hidden, just shows blank. */
  private async targetNames(
    ctx: RlsContext,
    siteIds: string[],
    projectIds: string[],
  ): Promise<Map<string, string>> {
    const [sites, projects] = await Promise.all([
      this.sites.namesFor(ctx, siteIds),
      this.sites.projectNamesFor(ctx, projectIds),
    ]);
    return new Map([...sites, ...projects]);
  }
}
