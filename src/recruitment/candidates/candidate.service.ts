import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CandidateSource,
  CandidateStage,
  InterviewOutcome,
  InterviewStatus,
  OfferStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PII_VISIBLE_CHARS,
  RESUME_NAMESPACE,
} from '../constants/recruitment.constants';
import { RequisitionService } from '../requisitions/requisition.service';
import { RecruitmentRefsService } from '../recruitment-refs.service';
import {
  ACTIVE_STAGES,
  allowedNextStages,
  canTransition,
} from './candidate-stage.util';

function maskTail(value: string | null): string | null {
  if (value === null) return null;
  const visible = value.slice(-PII_VISIBLE_CHARS);
  return `${'•'.repeat(
    Math.max(value.length - PII_VISIBLE_CHARS, 0),
  )}${visible}`;
}
function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const [local, domain] = email.split('@');
  if (!domain) return maskTail(email);
  const shown = local.slice(0, 1);
  return `${shown}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
function maskCtc(value: Prisma.Decimal | null): string | null {
  return value === null ? null : '₹••••';
}

@Injectable()
export class CandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
    private readonly requisitions: RequisitionService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      requisitionId?: string;
      stage?: CandidateStage;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const where: Prisma.CandidateWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.requisitionId ? { requisitionId: query.requisitionId } : {}),
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.search
        ? { fullName: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.candidate.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: {
              offers: {
                where: { status: OfferStatus.accepted },
                select: { confirmedJoiningDate: true },
                take: 1,
              },
            },
          }),
          tx.candidate.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const graceMs = this.refs.noShowGraceDays * 24 * 60 * 60 * 1000;
    return {
      items: rows.map((r) => {
        const confirmed = r.offers[0]?.confirmedJoiningDate ?? null;
        const noShow =
          r.stage === CandidateStage.offer_accepted &&
          confirmed !== null &&
          Date.now() - confirmed.getTime() > graceMs;
        return {
          id: r.id,
          requisitionId: r.requisitionId,
          fullName: r.fullName,
          phone: maskTail(r.phone),
          email: maskEmail(r.email),
          totalExperienceYears: r.totalExperienceYears.toNumber(),
          currentEmployer: r.currentEmployer,
          currentCtc: maskCtc(r.currentCtc),
          expectedCtc: maskCtc(r.expectedCtc),
          source: r.source,
          stage: r.stage,
          employeeId: r.employeeId,
          hasResume: r.resumeRef !== null,
          noShow,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /** Unmasked candidate detail — access is audit-logged (FR-006/READ). */
  async findOne(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.candidate.findUnique({
        where: { id },
        include: {
          stageHistory: { orderBy: { occurredAt: 'asc' } },
        },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }
    assertInScope(caller, row, `Candidate ${id}`);

    await this.auditLog.record({
      entityType: AuditEntityType.CANDIDATE,
      action: AuditAction.READ,
      entityId: id,
      accountId: caller.id,
      companyId: row.companyId,
      ipAddress,
    });

    return {
      id: row.id,
      requisitionId: row.requisitionId,
      fullName: row.fullName,
      phone: row.phone,
      email: row.email,
      totalExperienceYears: row.totalExperienceYears.toNumber(),
      currentEmployer: row.currentEmployer,
      currentCtc: row.currentCtc ? row.currentCtc.toNumber() : null,
      expectedCtc: row.expectedCtc ? row.expectedCtc.toNumber() : null,
      source: row.source,
      referredByEmployeeId: row.referredByEmployeeId,
      stage: row.stage,
      employeeId: row.employeeId,
      rejectionReason: row.rejectionReason,
      hasResume: row.resumeRef !== null,
      stageHistory: row.stageHistory.map((h) => ({
        fromStage: h.fromStage,
        toStage: h.toStage,
        actorId: h.actorId,
        occurredAt: h.occurredAt.toISOString(),
        remarks: h.remarks,
      })),
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      requisitionId: string;
      fullName: string;
      phone: string;
      email: string;
      totalExperienceYears: number;
      currentEmployer?: string;
      currentCtc?: number;
      expectedCtc?: number;
      source: CandidateSource;
      referredByEmployeeId?: string;
    },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      // A 400, not a 404: the company is not missing — the caller never named one.
      // A cross-company Super Admin has no `companyId` of their own for
      // `companyScope()` to fall back on, so a write from them must say which
      // company it belongs to. Reporting "Company not found" sent people hunting
      // for a deleted company instead of picking one. Same message every other
      // module uses for this case.
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.requisitions.assertOpen(tx, caller, dto.requisitionId);

        const clash = await tx.candidate.findFirst({
          where: {
            companyId,
            deletedAt: null,
            stage: { in: ACTIVE_STAGES },
            OR: [{ phone: dto.phone }, { email: dto.email }],
          },
        });
        if (clash) {
          throw new ConflictException({
            message: 'A candidate with this phone or email already exists',
            existingCandidateId: clash.id,
          });
        }

        const candidate = await tx.candidate.create({
          data: {
            companyId,
            requisitionId: dto.requisitionId,
            fullName: dto.fullName.trim(),
            phone: dto.phone.trim(),
            email: dto.email.trim(),
            totalExperienceYears: dto.totalExperienceYears,
            currentEmployer: dto.currentEmployer ?? null,
            currentCtc: dto.currentCtc ?? null,
            expectedCtc: dto.expectedCtc ?? null,
            source: dto.source,
            referredByEmployeeId: dto.referredByEmployeeId ?? null,
            createdBy: caller.id,
          },
        });
        await tx.candidateStageHistory.create({
          data: {
            companyId,
            candidateId: candidate.id,
            fromStage: null,
            toStage: CandidateStage.applied,
            actorId: caller.id,
          },
        });
        return candidate;
      },
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return { id: created.id, stage: created.stage };
  }

  async uploadResume(
    caller: AuthenticatedUser,
    id: string,
    file: string,
    contentType: string,
    ipAddress: string,
  ) {
    const candidate = await this.load(caller, id);
    const buffer = Buffer.from(
      file.replace(/^data:[^;]+;base64,/, ''),
      'base64',
    );
    const ref = await this.storage.put(RESUME_NAMESPACE, buffer, contentType);
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.candidate.update({ where: { id }, data: { resumeRef: ref } }),
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      candidate.companyId,
      caller,
      ipAddress,
    );
    return { hasResume: true };
  }

  async transitionStage(
    caller: AuthenticatedUser,
    id: string,
    toStage: CandidateStage,
    remarks: string | undefined,
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const candidate = await tx.candidate.findUnique({ where: { id } });
        if (!candidate || candidate.deletedAt) {
          throw new NotFoundException(`Candidate ${id} not found`);
        }
        assertInScope(caller, candidate, `Candidate ${id}`);

        if (!canTransition(candidate.stage, toStage)) {
          throw new BadRequestException(
            `Cannot move from ${candidate.stage} to ${toStage}. Allowed: ${
              allowedNextStages(candidate.stage).join(', ') || 'none'
            }`,
          );
        }
        if (toStage === CandidateStage.selected) {
          await this.assertRoundsComplete(tx, id);
        }
        return this.applyStage(
          tx,
          candidate,
          toStage,
          caller.id,
          remarks ?? null,
        );
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return { id, stage: updated.stage };
  }

  async reject(
    caller: AuthenticatedUser,
    id: string,
    rejectionReason: string,
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const candidate = await tx.candidate.findUnique({ where: { id } });
        if (!candidate || candidate.deletedAt) {
          throw new NotFoundException(`Candidate ${id} not found`);
        }
        assertInScope(caller, candidate, `Candidate ${id}`);
        await tx.candidate.update({
          where: { id },
          data: { rejectionReason },
        });
        return this.applyStage(
          tx,
          candidate,
          CandidateStage.rejected,
          caller.id,
          rejectionReason,
        );
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return { id, stage: updated.stage };
  }

  async markNoShow(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const candidate = await tx.candidate.findUnique({ where: { id } });
        if (!candidate || candidate.deletedAt) {
          throw new NotFoundException(`Candidate ${id} not found`);
        }
        assertInScope(caller, candidate, `Candidate ${id}`);
        if (candidate.stage !== CandidateStage.offer_accepted) {
          throw new ConflictException(
            'Only a candidate at Joining Pending can be marked no-show',
          );
        }
        await tx.candidate.update({
          where: { id },
          data: { noShowReason: reason },
        });
        await this.requisitions.releasePositionInTx(
          tx,
          candidate.requisitionId,
        );
        return this.applyStage(
          tx,
          candidate,
          CandidateStage.no_show,
          caller.id,
          reason,
        );
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return { id, stage: updated.stage };
  }

  /** Sets a stage inside a caller transaction (offer/joining flows), writing history. */
  async applyStage(
    tx: Prisma.TransactionClient,
    candidate: { id: string; companyId: string; stage: CandidateStage },
    toStage: CandidateStage,
    actorId: string,
    remarks: string | null,
  ) {
    const updated = await tx.candidate.update({
      where: { id: candidate.id },
      data: { stage: toStage },
    });
    await tx.candidateStageHistory.create({
      data: {
        companyId: candidate.companyId,
        candidateId: candidate.id,
        fromStage: candidate.stage,
        toStage,
        actorId,
        remarks,
      },
    });
    return updated;
  }

  private async assertRoundsComplete(
    tx: Prisma.TransactionClient,
    candidateId: string,
  ): Promise<void> {
    const interviews = await tx.interview.findMany({
      where: { candidateId },
      include: { feedback: true },
      orderBy: { roundNumber: 'asc' },
    });
    if (interviews.length === 0) {
      throw new BadRequestException(
        'No interview rounds have been scheduled for this candidate',
      );
    }
    const pending = interviews.filter(
      (i) => i.status !== InterviewStatus.completed,
    );
    if (pending.length > 0) {
      throw new BadRequestException(
        `Pending interview rounds: ${pending
          .map((i) => i.roundNumber)
          .join(', ')}`,
      );
    }
    const final = interviews[interviews.length - 1];
    const recommended = final.feedback.some(
      (f) => f.outcome === InterviewOutcome.recommend,
    );
    if (!recommended) {
      throw new BadRequestException(
        'The final round must recommend selection before advancing to Selected',
      );
    }
  }

  private async load(caller: AuthenticatedUser, id: string) {
    const candidate = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.candidate.findUnique({ where: { id } }),
    );
    if (!candidate || candidate.deletedAt) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }
    assertInScope(caller, candidate, `Candidate ${id}`);
    return candidate;
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.CANDIDATE,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
