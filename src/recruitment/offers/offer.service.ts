import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CandidateStage,
  OfferStatus,
  Permission,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope } from '../../settings/company-scope';
import { CandidateService } from '../candidates/candidate.service';
import { LetterService } from '../letters/letter.service';
import { RecruitmentRefsService } from '../recruitment-refs.service';
import { breakupReconciles, SalaryComponent } from './salary-breakup.util';

@Injectable()
export class OfferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly candidates: CandidateService,
    private readonly letters: LetterService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async findByCandidate(caller: AuthenticatedUser, candidateId: string) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.offer.findMany({
          where: { candidateId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        }),
    );
    return rows.map((o) => this.toView(o));
  }

  async create(
    caller: AuthenticatedUser,
    candidateId: string,
    dto: {
      designationId: string;
      departmentId: string;
      offeredCtc: number;
      salaryBreakup: SalaryComponent[];
      proposedJoiningDate: string;
      probationMonths: number;
      noticePeriodDays: number;
      reportingManagerEmployeeId: string;
    },
    ipAddress: string,
  ) {
    if (
      !breakupReconciles(
        dto.salaryBreakup,
        dto.offeredCtc,
        this.refs.salaryBreakupToleranceRupees,
      )
    ) {
      throw new BadRequestException(
        'Salary breakup does not reconcile to the monthly CTC (offeredCtc / 12).',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const candidate = await tx.candidate.findUnique({
          where: { id: candidateId },
          include: { requisition: true },
        });
        if (!candidate || candidate.deletedAt) {
          throw new NotFoundException(`Candidate ${candidateId} not found`);
        }
        assertInScope(caller, candidate, `Candidate ${candidateId}`);
        if (candidate.stage !== CandidateStage.selected) {
          throw new ConflictException(
            'An offer can only be created for a Selected candidate',
          );
        }

        // Supersede any prior non-superseded/active offer.
        await tx.offer.updateMany({
          where: {
            candidateId,
            status: { in: [OfferStatus.draft, OfferStatus.issued] },
          },
          data: { status: OfferStatus.superseded },
        });

        const outsideBudget =
          dto.offeredCtc > candidate.requisition.budgetedCtcMax.toNumber();

        return tx.offer.create({
          data: {
            companyId: candidate.companyId,
            candidateId,
            designationId: dto.designationId,
            departmentId: dto.departmentId,
            offeredCtc: dto.offeredCtc,
            salaryBreakup:
              dto.salaryBreakup as unknown as Prisma.InputJsonValue,
            proposedJoiningDate: new Date(
              `${dto.proposedJoiningDate.slice(0, 10)}T00:00:00.000Z`,
            ),
            probationMonths: dto.probationMonths,
            noticePeriodDays: dto.noticePeriodDays,
            reportingManagerEmployeeId: dto.reportingManagerEmployeeId,
            outsideBudget,
            createdBy: caller.id,
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
    return this.toView(created);
  }

  /** Renders the offer letter and issues the offer, advancing the candidate. */
  async generate(
    caller: AuthenticatedUser,
    offerId: string,
    ipAddress: string,
  ) {
    const issued = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer || offer.deletedAt) {
          throw new NotFoundException(`Offer ${offerId} not found`);
        }
        assertInScope(caller, offer, `Offer ${offerId}`);
        if (offer.status !== OfferStatus.draft) {
          throw new ConflictException('Only a draft offer can be generated');
        }
        if (
          offer.outsideBudget &&
          !caller.permissions.includes(Permission.RECRUITMENT_APPROVE)
        ) {
          throw new ForbiddenException(
            'This offer exceeds the budgeted maximum and needs approval to issue.',
          );
        }

        const letterId = await this.letters.generateForOffer(
          caller,
          offer,
          ipAddress,
          tx,
        );

        const candidate = await tx.candidate.findUnique({
          where: { id: offer.candidateId },
        });
        if (candidate) {
          await this.candidates.applyStage(
            tx,
            candidate,
            CandidateStage.offer_issued,
            caller.id,
            'Offer issued',
          );
        }

        return tx.offer.update({
          where: { id: offerId },
          data: { status: OfferStatus.issued, letterId },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      offerId,
      issued.companyId,
      caller,
      ipAddress,
    );
    return this.toView(issued);
  }

  async accept(
    caller: AuthenticatedUser,
    offerId: string,
    dto: { acceptedOn: string; confirmedJoiningDate?: string },
    ipAddress: string,
  ) {
    const accepted = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer || offer.deletedAt) {
          throw new NotFoundException(`Offer ${offerId} not found`);
        }
        assertInScope(caller, offer, `Offer ${offerId}`);
        if (offer.status !== OfferStatus.issued) {
          throw new ConflictException('Only an issued offer can be accepted');
        }
        const candidate = await tx.candidate.findUnique({
          where: { id: offer.candidateId },
        });
        if (candidate) {
          await this.candidates.applyStage(
            tx,
            candidate,
            CandidateStage.offer_accepted,
            caller.id,
            'Offer accepted',
          );
        }
        return tx.offer.update({
          where: { id: offerId },
          data: {
            status: OfferStatus.accepted,
            acceptedOn: new Date(
              `${dto.acceptedOn.slice(0, 10)}T00:00:00.000Z`,
            ),
            confirmedJoiningDate: dto.confirmedJoiningDate
              ? new Date(
                  `${dto.confirmedJoiningDate.slice(0, 10)}T00:00:00.000Z`,
                )
              : offer.proposedJoiningDate,
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      offerId,
      accepted.companyId,
      caller,
      ipAddress,
    );
    return this.toView(accepted);
  }

  async decline(
    caller: AuthenticatedUser,
    offerId: string,
    reason: string,
    ipAddress: string,
  ) {
    const declined = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer || offer.deletedAt) {
          throw new NotFoundException(`Offer ${offerId} not found`);
        }
        assertInScope(caller, offer, `Offer ${offerId}`);
        if (offer.status !== OfferStatus.issued) {
          throw new ConflictException('Only an issued offer can be declined');
        }
        const candidate = await tx.candidate.findUnique({
          where: { id: offer.candidateId },
        });
        if (candidate) {
          await this.candidates.applyStage(
            tx,
            candidate,
            CandidateStage.rejected,
            caller.id,
            `Offer declined: ${reason}`,
          );
        }
        return tx.offer.update({
          where: { id: offerId },
          data: { status: OfferStatus.declined, declineReason: reason },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      offerId,
      declined.companyId,
      caller,
      ipAddress,
    );
    return this.toView(declined);
  }

  private toView(o: {
    id: string;
    candidateId: string;
    designationId: string;
    departmentId: string;
    offeredCtc: Prisma.Decimal;
    salaryBreakup: Prisma.JsonValue;
    proposedJoiningDate: Date;
    confirmedJoiningDate: Date | null;
    probationMonths: number;
    noticePeriodDays: number;
    reportingManagerEmployeeId: string;
    outsideBudget: boolean;
    status: OfferStatus;
    letterId: string | null;
  }) {
    return {
      id: o.id,
      candidateId: o.candidateId,
      designationId: o.designationId,
      departmentId: o.departmentId,
      offeredCtc: o.offeredCtc.toNumber(),
      salaryBreakup: o.salaryBreakup,
      proposedJoiningDate: o.proposedJoiningDate.toISOString().slice(0, 10),
      confirmedJoiningDate: o.confirmedJoiningDate
        ? o.confirmedJoiningDate.toISOString().slice(0, 10)
        : null,
      probationMonths: o.probationMonths,
      noticePeriodDays: o.noticePeriodDays,
      reportingManagerEmployeeId: o.reportingManagerEmployeeId,
      outsideBudget: o.outsideBudget,
      status: o.status,
      letterId: o.letterId,
    };
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.OFFER,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
