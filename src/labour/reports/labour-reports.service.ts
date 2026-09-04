import { Injectable } from '@nestjs/common';
import { AttendanceType, MusterStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { dayFractionOf } from '../payment-sheets/wage-calc.util';

export type DeploymentGrouping = 'skill' | 'site' | 'contractor';

@Injectable()
export class LabourReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  private parseRange(from: string, to: string) {
    return {
      from: new Date(`${from.slice(0, 10)}T00:00:00.000Z`),
      to: new Date(`${to.slice(0, 10)}T00:00:00.000Z`),
    };
  }

  /** Deployment: headcount and man-days grouped by skill, site, or contractor. */
  async deployment(
    caller: AuthenticatedUser,
    query: {
      projectId: string;
      periodFrom: string;
      periodTo: string;
      groupBy: DeploymentGrouping;
    },
  ) {
    const { from, to } = this.parseRange(query.periodFrom, query.periodTo);
    const siteIds = await this.projects.getSitesByProject(
      query.projectId,
      rlsContextFor(caller),
    );
    if (siteIds.length === 0) {
      return { groupBy: query.groupBy, groups: [], totalManDays: 0 };
    }

    const lines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              status: MusterStatus.approved,
              date: { gte: from, lte: to },
              deletedAt: null,
            },
          },
          include: { muster: { select: { siteId: true } } },
        }),
    );

    const workerIds = Array.from(new Set(lines.map((l) => l.workerId)));
    const workers = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, skillCategoryId: true, contractorId: true },
        }),
    );
    const workerById = new Map(workers.map((w) => [w.id, w]));

    const groups = new Map<string, { workers: Set<string>; manDays: number }>();
    let totalManDays = 0;
    for (const line of lines) {
      const worker = workerById.get(line.workerId);
      const key =
        query.groupBy === 'site'
          ? line.muster.siteId
          : query.groupBy === 'contractor'
          ? worker?.contractorId ?? 'direct'
          : worker?.skillCategoryId ?? 'unknown';
      const bucket = groups.get(key) ?? { workers: new Set(), manDays: 0 };
      bucket.workers.add(line.workerId);
      const fraction = dayFractionOf(line.attendanceType);
      bucket.manDays += fraction;
      totalManDays += fraction;
      groups.set(key, bucket);
    }

    return {
      groupBy: query.groupBy,
      groups: Array.from(groups.entries()).map(([key, v]) => ({
        key,
        headcount: v.workers.size,
        manDays: Math.round(v.manDays * 100) / 100,
      })),
      totalManDays: Math.round(totalManDays * 100) / 100,
    };
  }

  /** Attendance percentage per worker for a site and period. */
  async attendance(
    caller: AuthenticatedUser,
    query: { siteId: string; periodFrom: string; periodTo: string },
  ) {
    const { from, to } = this.parseRange(query.periodFrom, query.periodTo);
    const lines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.musterLine.findMany({
          where: {
            muster: {
              siteId: query.siteId,
              status: MusterStatus.approved,
              date: { gte: from, lte: to },
              deletedAt: null,
            },
          },
          include: { muster: { select: { date: true } } },
        }),
    );

    const musterDates = new Set(
      lines.map((l) => l.muster.date.toISOString().slice(0, 10)),
    );
    const totalDays = musterDates.size || 1;

    const perWorker = new Map<
      string,
      { present: number; half: number; absent: number; overtime: number }
    >();
    for (const line of lines) {
      const w = perWorker.get(line.workerId) ?? {
        present: 0,
        half: 0,
        absent: 0,
        overtime: 0,
      };
      if (line.attendanceType === AttendanceType.full_day) w.present += 1;
      else if (line.attendanceType === AttendanceType.half_day) w.half += 1;
      else if (line.attendanceType === AttendanceType.absent) w.absent += 1;
      w.overtime += line.overtimeHours ? line.overtimeHours.toNumber() : 0;
      perWorker.set(line.workerId, w);
    }

    return {
      siteId: query.siteId,
      totalMusterDays: musterDates.size,
      workers: Array.from(perWorker.entries()).map(([workerId, w]) => {
        const daysWorked = w.present + w.half * 0.5;
        return {
          workerId,
          daysPresent: w.present,
          halfDays: w.half,
          absentDays: w.absent,
          overtimeHours: Math.round(w.overtime * 100) / 100,
          attendancePercent: Math.round((daysWorked / totalDays) * 10000) / 100,
        };
      }),
    };
  }

  /** Payment register: every payment-sheet line for a project in a period. */
  async paymentRegister(
    caller: AuthenticatedUser,
    query: { projectId: string; periodFrom: string; periodTo: string },
  ) {
    const { from, to } = this.parseRange(query.periodFrom, query.periodTo);
    const sheets = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPaymentSheet.findMany({
          where: {
            ...companyScope(caller),
            projectId: query.projectId,
            deletedAt: null,
            periodFrom: { lte: to },
            periodTo: { gte: from },
          },
          include: { lines: true },
        }),
    );

    return {
      projectId: query.projectId,
      lines: sheets.flatMap((sheet) =>
        sheet.lines.map((l) => ({
          sheetId: sheet.id,
          workerId: l.workerId,
          daysWorked: l.daysWorked.toNumber(),
          grossWage: l.grossWage.toNumber(),
          deductions: l.deductions,
          netPayable: l.netPayable.toNumber(),
          paymentMode: l.paymentMode,
          status: l.status,
        })),
      ),
    };
  }
}
