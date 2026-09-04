import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  InterviewMode,
  InterviewOutcome,
  InterviewRoundType,
  InterviewStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';

@Injectable()
export class InterviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      candidateId?: string;
      status?: InterviewStatus;
    },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.interview.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.candidateId ? { candidateId: query.candidateId } : {}),
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: { scheduledAt: 'asc' },
          include: {
            interviewers: true,
            feedback: true,
            candidate: { select: { fullName: true, requisitionId: true } },
          },
        }),
    );
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidateId,
      candidateName: r.candidate.fullName,
      requisitionId: r.candidate.requisitionId,
      roundNumber: r.roundNumber,
      roundType: r.roundType,
      scheduledAt: r.scheduledAt.toISOString(),
      mode: r.mode,
      location: r.location,
      status: r.status,
      rescheduleCount: r.rescheduleCount,
      overdue:
        r.status === InterviewStatus.scheduled && r.scheduledAt.getTime() < now,
      interviewerEmployeeIds: r.interviewers.map((i) => i.employeeId),
      feedback: r.feedback.map((f) => ({
        interviewerEmployeeId: f.interviewerEmployeeId,
        outcome: f.outcome,
        score: f.score,
        comments: f.comments,
      })),
    }));
  }

  async schedule(
    caller: AuthenticatedUser,
    candidateId: string,
    dto: {
      roundNumber: number;
      roundType: InterviewRoundType;
      scheduledAt: string;
      mode: InterviewMode;
      interviewerEmployeeIds: string[];
      location?: string;
    },
    ipAddress: string,
  ) {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const candidate = await tx.candidate.findUnique({
          where: { id: candidateId },
        });
        if (!candidate || candidate.deletedAt) {
          throw new NotFoundException(`Candidate ${candidateId} not found`);
        }
        assertInScope(caller, candidate, `Candidate ${candidateId}`);

        const clash = await tx.interview.findUnique({
          where: {
            candidateId_roundNumber: {
              candidateId,
              roundNumber: dto.roundNumber,
            },
          },
        });
        if (clash) {
          throw new ConflictException(
            `Round ${dto.roundNumber} already exists for this candidate`,
          );
        }

        return tx.interview.create({
          data: {
            companyId: candidate.companyId,
            candidateId,
            roundNumber: dto.roundNumber,
            roundType: dto.roundType,
            scheduledAt: new Date(dto.scheduledAt),
            mode: dto.mode,
            location: dto.location ?? null,
            createdBy: caller.id,
            interviewers: {
              create: dto.interviewerEmployeeIds.map((employeeId) => ({
                companyId: candidate.companyId,
                employeeId,
              })),
            },
          },
        });
      },
    );
    await this.audit(
      AuditAction.CREATE,
      created.id,
      created.companyId,
      caller,
      ipAddress,
    );
    return { id: created.id, status: created.status };
  }

  async submitFeedback(
    caller: AuthenticatedUser,
    interviewId: string,
    dto: {
      interviewerEmployeeId: string;
      outcome: InterviewOutcome;
      score: number;
      comments: string;
    },
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const interview = await tx.interview.findUnique({
          where: { id: interviewId },
          include: { interviewers: true },
        });
        if (!interview)
          throw new NotFoundException(`Interview ${interviewId} not found`);
        assertInScope(caller, interview, `Interview ${interviewId}`);

        const assigned = interview.interviewers.some(
          (i) => i.employeeId === dto.interviewerEmployeeId,
        );
        if (!assigned) {
          throw new BadRequestException(
            'Feedback can only be recorded against an assigned interviewer',
          );
        }
        if (dto.score < 1 || dto.score > 10) {
          throw new BadRequestException('Score must be between 1 and 10');
        }

        await tx.interviewFeedback.upsert({
          where: {
            interviewId_interviewerEmployeeId: {
              interviewId,
              interviewerEmployeeId: dto.interviewerEmployeeId,
            },
          },
          create: {
            companyId: interview.companyId,
            interviewId,
            interviewerEmployeeId: dto.interviewerEmployeeId,
            outcome: dto.outcome,
            score: dto.score,
            comments: dto.comments,
          },
          update: {
            outcome: dto.outcome,
            score: dto.score,
            comments: dto.comments,
          },
        });
        return tx.interview.update({
          where: { id: interviewId },
          data: { status: InterviewStatus.completed },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      interviewId,
      updated.companyId,
      caller,
      ipAddress,
    );
    return { id: interviewId, status: updated.status };
  }

  async reschedule(
    caller: AuthenticatedUser,
    interviewId: string,
    dto: { scheduledAt: string; reason: string },
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const interview = await tx.interview.findUnique({
          where: { id: interviewId },
        });
        if (!interview)
          throw new NotFoundException(`Interview ${interviewId} not found`);
        assertInScope(caller, interview, `Interview ${interviewId}`);
        if (interview.status !== InterviewStatus.scheduled) {
          throw new ConflictException(
            'Only a scheduled interview can be rescheduled',
          );
        }
        const history = Array.isArray(interview.rescheduleHistory)
          ? (interview.rescheduleHistory as Prisma.JsonArray)
          : [];
        history.push({
          previousScheduledAt: interview.scheduledAt.toISOString(),
          reason: dto.reason,
          at: new Date().toISOString(),
        });
        return tx.interview.update({
          where: { id: interviewId },
          data: {
            scheduledAt: new Date(dto.scheduledAt),
            rescheduleCount: interview.rescheduleCount + 1,
            rescheduleHistory: history,
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      interviewId,
      updated.companyId,
      caller,
      ipAddress,
    );
    return { id: interviewId, rescheduleCount: updated.rescheduleCount };
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.INTERVIEW,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
