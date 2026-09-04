import { Injectable } from '@nestjs/common';
import { EngagementType, MusterStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { RlsContext, withRlsContext } from '../common/prisma/rls-context';
import { ProjectsService } from '../projects/portfolio/projects.service';
import { LabourRefsService } from './labour-refs.service';
import { WageRateService } from './wage-rates/wage-rate.service';
import { computeWage, WorkedDay } from './payment-sheets/wage-calc.util';

/** A caller stand-in used only for internal rate resolution that always runs inside a
 * provided transaction, so its RLS context is never consulted (see resolveRate). */
const SYSTEM_CALLER = {
  id: '',
  companyId: null,
  permissions: [],
} as unknown as AuthenticatedUser;

export interface LabourCostByProject {
  /** Gross wage of approved muster lines for direct-engaged workers. */
  direct: number;
  /** Gross wage of approved muster lines for contractor-engaged workers. */
  contractor: number;
  total: number;
  /** Musters in range that are not yet approved and are therefore excluded — so a
   * P&L consumer can flag the figure as incomplete (FR-033). */
  unapprovedMusterCount: number;
}

/**
 * The labour module's outward contract (013 FR-033).
 *
 * `getLabourCostByProject` is the single path feature 008's Project P&L reads labour
 * cost through — an in-process call, never a cross-schema query. It returns the gross
 * wage of the project's approved muster lines split by engagement type, plus the
 * count of unapproved musters excluded so the consumer can say the figure is partial.
 */
@Injectable()
export class LabourService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly refs: LabourRefsService,
    private readonly wageRates: WageRateService,
  ) {}

  async getLabourCostByProject(
    projectId: string,
    dateRange?: { from?: Date; to?: Date },
    ctx: RlsContext = { isSuperAdmin: true },
    companyId?: string,
  ): Promise<LabourCostByProject> {
    const siteIds = await this.projects.getSitesByProject(projectId, ctx);
    if (siteIds.length === 0) {
      return { direct: 0, contractor: 0, total: 0, unapprovedMusterCount: 0 };
    }

    const dateFilter: Prisma.DateTimeFilter = {};
    if (dateRange?.from) dateFilter.gte = dateRange.from;
    if (dateRange?.to) dateFilter.lte = dateRange.to;

    const otMultiplier = companyId
      ? (await this.refs.getLabourSettings(companyId)).otMultiplier
      : 2;
    const standardHours = this.refs.standardHoursPerDay;

    const { lines, unapprovedMusterCount } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => {
        const approvedLines = await tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              status: MusterStatus.approved,
              deletedAt: null,
              ...(dateRange ? { date: dateFilter } : {}),
            },
          },
          include: { muster: { select: { date: true } } },
        });
        const unapproved = await tx.musterRoll.count({
          where: {
            siteId: { in: siteIds },
            status: { in: [MusterStatus.draft, MusterStatus.submitted] },
            deletedAt: null,
            ...(dateRange ? { date: dateFilter } : {}),
          },
        });
        return { lines: approvedLines, unapprovedMusterCount: unapproved };
      },
    );

    const workerIds = Array.from(new Set(lines.map((l) => l.workerId)));
    const workers = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.labourWorker.findMany({ where: { id: { in: workerIds } } }),
    );
    const workerById = new Map(workers.map((w) => [w.id, w]));

    let direct = 0;
    let contractor = 0;

    // Aggregate per worker to price OT against a full day's rate correctly.
    const perWorker = new Map<string, typeof lines>();
    for (const line of lines) {
      const list = perWorker.get(line.workerId) ?? [];
      list.push(line);
      perWorker.set(line.workerId, list);
    }

    await withRlsContext(this.prisma, ctx, async (tx) => {
      for (const [workerId, workerLines] of perWorker) {
        const worker = workerById.get(workerId);
        if (!worker) continue;
        const rateOverride = worker.rateOverride
          ? worker.rateOverride.toNumber()
          : null;

        const workedDays: WorkedDay[] = [];
        for (const line of workerLines) {
          const resolved = await this.wageRates.resolveRate(SYSTEM_CALLER, {
            projectId,
            skillCategoryId: line.skillCategoryIdOnDay,
            rateOverride,
            date: line.muster.date,
            tx,
          });
          if (!resolved) continue;
          workedDays.push({
            attendanceType: line.attendanceType,
            overtimeHours: line.overtimeHours
              ? line.overtimeHours.toNumber()
              : 0,
            dailyRate: resolved.rate,
          });
        }
        const wage = computeWage(workedDays, standardHours, otMultiplier);
        if (worker.engagementType === EngagementType.direct) {
          direct += wage.grossWage;
        } else {
          contractor += wage.grossWage;
        }
      }
    });

    direct = Math.round(direct * 100) / 100;
    contractor = Math.round(contractor * 100) / 100;
    return {
      direct,
      contractor,
      total: Math.round((direct + contractor) * 100) / 100,
      unapprovedMusterCount,
    };
  }
}
