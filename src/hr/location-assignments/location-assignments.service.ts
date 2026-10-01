import { Injectable, NotFoundException } from '@nestjs/common';
import { EmployeeLocationAssignment } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

/** What an assignment decides, once resolved for a particular day. */
export interface ResolvedAssignment {
  /** The site whose fence applies. Null when the employee is exempt. */
  siteId: string | null;
  /** FR-014's exemption — **location only**, never the face check. */
  isMobile: boolean;
}

export interface AssignInput {
  siteId?: string | null;
  isMobile?: boolean;
  /** `YYYY-MM-DD`. The day from which this assignment decides. */
  effectiveFrom: string;
  reason?: string | null;
}

/**
 * Which location an employee's punches validate against (020 FR-011, FR-014, FR-016).
 *
 * ## Layered over the site fence, never replacing it
 *
 * An employee with no assignment is validated against their site's geofence exactly as before —
 * which is **every** employee on the day this ships. That is FR-016, and it is what lets this table
 * exist without a backfill: the alternative, requiring an assignment, would refuse everybody's
 * attendance on the first morning.
 *
 * ## Append-only
 *
 * `assign()` writes a new row and never updates a prior one. A transfer six months ago stays
 * explicable: the row in force then is still there, with who decided it and when it took effect.
 * Mutating would make the history a single current value and the audit question unanswerable.
 */
@Injectable()
export class LocationAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

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
        select: { siteId: true, isMobile: true },
      }),
    );
    return row ?? null;
  }

  /** Every assignment for one employee, newest effective date first (FR-011's history). */
  async historyFor(
    ctx: RlsContext,
    employeeId: string,
  ): Promise<EmployeeLocationAssignment[]> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.employeeLocationAssignment.findMany({
        where: { employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  }

  /**
   * Records a new assignment. **Appends; never mutates a prior row** (FR-011).
   *
   * The company is taken from the employee rather than from the caller's input: an assignment filed
   * against a company the employee does not belong to would be invisible to every later read, since
   * the RLS policy scopes on `companyId`.
   */
  async assign(
    ctx: RlsContext,
    employeeId: string,
    input: AssignInput,
    assignedByUserId: string,
  ): Promise<EmployeeLocationAssignment> {
    const employee = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.employeeLocationAssignment.create({
        data: {
          companyId: employee.companyId,
          employeeId,
          siteId: input.siteId ?? null,
          isMobile: input.isMobile ?? false,
          effectiveFrom: new Date(input.effectiveFrom),
          assignedByUserId,
          reason: input.reason ?? null,
        },
      }),
    );
  }
}
