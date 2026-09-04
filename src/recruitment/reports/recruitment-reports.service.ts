import { Injectable } from '@nestjs/common';
import { CandidateStage, OfferStatus, ResignationStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';
import { RecruitmentRefsService } from '../recruitment-refs.service';
import {
  attritionRate,
  averageTimeToHire,
  funnelConversions,
  tenureMonths,
  timeToHireDays,
} from './recruitment-metrics.util';

const FUNNEL_ORDER: CandidateStage[] = [
  CandidateStage.applied,
  CandidateStage.shortlisted,
  CandidateStage.interviewing,
  CandidateStage.selected,
  CandidateStage.offer_issued,
  CandidateStage.offer_accepted,
  CandidateStage.joined,
];

const parse = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class RecruitmentReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async newJoinings(
    caller: AuthenticatedUser,
    query: {
      from: string;
      to: string;
      departmentId?: string;
      projectId?: string;
    },
  ) {
    const from = parse(query.from);
    const to = parse(query.to);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.candidate.findMany({
          where: {
            ...companyScope(caller),
            stage: CandidateStage.joined,
            deletedAt: null,
            requisition: {
              ...(query.departmentId
                ? { departmentId: query.departmentId }
                : {}),
              ...(query.projectId ? { projectId: query.projectId } : {}),
            },
            stageHistory: {
              some: {
                toStage: CandidateStage.joined,
                occurredAt: { gte: from, lte: to },
              },
            },
          },
          include: {
            requisition: { select: { requisitionCode: true } },
            offers: {
              where: { status: OfferStatus.accepted },
              select: { offeredCtc: true },
              take: 1,
            },
            stageHistory: {
              where: { toStage: CandidateStage.joined },
              select: { occurredAt: true },
              take: 1,
            },
          },
        }),
    );

    return {
      items: rows.map((r) => ({
        candidateId: r.id,
        employeeId: r.employeeId,
        name: r.fullName,
        requisitionCode: r.requisition.requisitionCode,
        source: r.source,
        offeredCtc: r.offers[0]?.offeredCtc.toNumber() ?? null,
        joiningDate:
          r.stageHistory[0]?.occurredAt.toISOString().slice(0, 10) ?? null,
      })),
    };
  }

  async funnel(caller: AuthenticatedUser, query: { requisitionId?: string }) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.candidate.findMany({
          where: {
            ...companyScope(caller),
            deletedAt: null,
            ...(query.requisitionId
              ? { requisitionId: query.requisitionId }
              : {}),
          },
          select: { source: true },
        }),
    );

    // Stage counts across the funnel (cumulative membership by furthest stage).
    const stageCounts = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.candidate.groupBy({
          by: ['stage'],
          where: {
            ...companyScope(caller),
            deletedAt: null,
            ...(query.requisitionId
              ? { requisitionId: query.requisitionId }
              : {}),
          },
          _count: { _all: true },
        }),
    );
    const counts: Record<string, number> = {};
    for (const s of FUNNEL_ORDER) counts[s] = 0;
    for (const g of stageCounts) counts[g.stage] = g._count._all;

    // Time-to-hire from the stage history of joined candidates.
    const joined = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.candidate.findMany({
          where: {
            ...companyScope(caller),
            stage: CandidateStage.joined,
            deletedAt: null,
            ...(query.requisitionId
              ? { requisitionId: query.requisitionId }
              : {}),
          },
          select: {
            stageHistory: {
              select: { toStage: true, occurredAt: true },
              orderBy: { occurredAt: 'asc' },
            },
          },
        }),
    );
    const tth = joined.map((c) => timeToHireDays(c.stageHistory));

    const sourceBreakdown: Record<string, number> = {};
    for (const r of rows) {
      sourceBreakdown[r.source] = (sourceBreakdown[r.source] ?? 0) + 1;
    }

    return {
      stageCounts: counts,
      conversions: funnelConversions(counts, FUNNEL_ORDER),
      averageTimeToHireDays: averageTimeToHire(tth),
      sourceBreakdown: Object.entries(sourceBreakdown).map(
        ([source, count]) => ({
          source,
          count,
        }),
      ),
    };
  }

  async resignations(
    caller: AuthenticatedUser,
    query: {
      from: string;
      to: string;
      departmentId?: string;
      headcount?: number;
    },
  ) {
    const from = parse(query.from);
    const to = parse(query.to);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.resignation.findMany({
          where: {
            ...companyScope(caller),
            deletedAt: null,
            status: { not: ResignationStatus.withdrawn },
            resignationDate: { gte: from, lte: to },
          },
          orderBy: { resignationDate: 'desc' },
        }),
    );

    const items = await Promise.all(
      rows.map(async (r) => {
        const employee = await this.refs
          .getEmployee(caller, r.employeeId)
          .catch(() => null);
        const lwd = r.agreedLastWorkingDay ?? r.expectedLastWorkingDay;
        const doj = employee?.dateOfJoining ?? null;
        const settlementPending =
          lwd.getTime() < Date.now() &&
          (await this.refs.isFnfProcessed(caller, r.employeeId)) === false;
        return {
          employeeId: r.employeeId,
          resignationDate: r.resignationDate.toISOString().slice(0, 10),
          lastWorkingDay: lwd.toISOString().slice(0, 10),
          tenureMonths: doj ? tenureMonths(doj, lwd) : null,
          reasonCategory: r.reasonCategory,
          settlementPending,
        };
      }),
    );

    const reasonCounts: Record<string, number> = {};
    for (const r of rows) {
      reasonCounts[r.reasonCategory] =
        (reasonCounts[r.reasonCategory] ?? 0) + 1;
    }

    return {
      totalSeparations: rows.length,
      reasonCounts: Object.entries(reasonCounts).map(([reason, count]) => ({
        reason,
        count,
      })),
      attritionRatePercent:
        query.headcount && query.headcount > 0
          ? attritionRate(rows.length, query.headcount)
          : null,
      items,
    };
  }
}
