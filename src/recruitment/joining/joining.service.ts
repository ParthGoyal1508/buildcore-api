import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CandidateStage,
  Gender,
  OfferStatus,
  OnboardingItemType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import type { CreateEmployeeDto } from '../../hr/employees/dto/create-employee.dto';
import { RecruitmentRefsService } from '../recruitment-refs.service';
import { RequisitionService } from '../requisitions/requisition.service';

export interface JoiningResult {
  employeeId: string;
  employeeCode: string;
  delayedJoining: boolean;
  delayedByDays: number;
  checklistId: string;
}

/**
 * Completes a candidate's joining (011 US5): creates the `hr.Employee` via 005's
 * service (login account is deliberately not provisioned here — HR creates it later),
 * links the candidate, increments the requisition, and opens the onboarding checklist.
 */
@Injectable()
export class JoiningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: RecruitmentRefsService,
    private readonly requisitions: RequisitionService,
  ) {}

  async join(
    caller: AuthenticatedUser,
    candidateId: string,
    dto: {
      actualJoiningDate: string;
      dateOfBirth: string;
      gender: Gender;
      permanentAddress: string;
      emergencyContact: string;
      siteId?: string;
      shiftId?: string;
    },
    ipAddress: string,
  ): Promise<JoiningResult> {
    const companyId = companyScope(caller).companyId;
    if (!companyId) throw new NotFoundException('Company not found');

    // 1. Validate and gather the offer + candidate (read-only).
    const { candidate, offer } = await withRlsContext(
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
        if (candidate.stage === CandidateStage.joined) {
          throw new ConflictException('This candidate has already joined');
        }
        if (candidate.stage !== CandidateStage.offer_accepted) {
          throw new ConflictException(
            'Only a candidate at Joining Pending can join',
          );
        }
        const offer = await tx.offer.findFirst({
          where: { candidateId, status: OfferStatus.accepted },
          orderBy: { createdAt: 'desc' },
        });
        if (!offer) {
          throw new ConflictException('No accepted offer for this candidate');
        }
        return { candidate, offer };
      },
    );

    const siteId = dto.siteId ?? candidate.requisition.siteId ?? undefined;
    if (!siteId) {
      throw new BadRequestException(
        'A site is required to join; the requisition has none, so supply siteId.',
      );
    }
    const shiftId = dto.shiftId ?? (await this.refs.defaultShiftId(caller));

    // 2. Create the Employee (005 owns its own transaction).
    const [firstName, ...rest] = candidate.fullName.trim().split(/\s+/);
    const employeeDto: CreateEmployeeDto = {
      siteId,
      shiftId,
      firstName,
      lastName: rest.join(' ') || undefined,
      dob: dto.dateOfBirth,
      gender: dto.gender,
      departmentId: offer.departmentId,
      designationId: offer.designationId,
      dateOfJoining: dto.actualJoiningDate,
      reportingToEmployeeId: offer.reportingManagerEmployeeId,
      permanentAddress: dto.permanentAddress,
      mobile: /^\d{10}$/.test(candidate.phone) ? candidate.phone : undefined,
      emergencyContactName: dto.emergencyContact,
    } as CreateEmployeeDto;

    const employee = await this.refs.createEmployee(
      caller,
      ipAddress,
      companyId,
      employeeDto,
    );

    // 3. Link candidate, increment requisition, open onboarding checklist.
    const delayed = this.delayedJoining(
      offer.confirmedJoiningDate,
      dto.actualJoiningDate,
    );
    const documentTypes = await this.refs.listDocumentTypes(companyId);
    const mandatoryDocs = documentTypes.filter(
      (d: { isMandatory: boolean; isActive: boolean }) =>
        d.isMandatory && d.isActive,
    );

    const checklistId = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await tx.candidate.update({
          where: { id: candidateId },
          data: { stage: CandidateStage.joined, employeeId: employee.id },
        });
        await tx.candidateStageHistory.create({
          data: {
            companyId,
            candidateId,
            fromStage: CandidateStage.offer_accepted,
            toStage: CandidateStage.joined,
            actorId: caller.id,
            remarks: delayed.delayedJoining
              ? `Delayed joining by ${delayed.delayedByDays} days`
              : null,
          },
        });
        await this.requisitions.incrementFilledInTx(
          tx,
          candidate.requisitionId,
        );

        const kitItems = await this.refs.defaultKitItems(caller, companyId, tx);
        const checklist = await tx.onboardingChecklist.create({
          data: {
            companyId,
            employeeId: employee.id,
            candidateId,
            items: {
              create: [
                ...mandatoryDocs.map((d: { id: string; name: string }) => ({
                  companyId,
                  itemType: OnboardingItemType.document,
                  documentTypeId: d.id,
                  label: d.name,
                })),
                ...kitItems.map((k) => ({
                  companyId,
                  itemType: OnboardingItemType.kit,
                  kitItemId: k.id,
                  label: k.name,
                })),
                {
                  companyId,
                  itemType: OnboardingItemType.induction,
                  label: 'Complete induction',
                },
              ],
            },
          },
        });
        return checklist.id;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CANDIDATE,
      action: AuditAction.UPDATE,
      entityId: candidateId,
      changes: { joined: true, employeeId: employee.id },
      accountId: caller.id,
      companyId,
      ipAddress,
    });

    return {
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      delayedJoining: delayed.delayedJoining,
      delayedByDays: delayed.delayedByDays,
      checklistId,
    };
  }

  private delayedJoining(
    confirmed: Date | null,
    actual: string,
  ): { delayedJoining: boolean; delayedByDays: number } {
    if (!confirmed) return { delayedJoining: false, delayedByDays: 0 };
    const actualDate = new Date(`${actual.slice(0, 10)}T00:00:00.000Z`);
    const days = Math.round(
      (actualDate.getTime() - confirmed.getTime()) / (24 * 60 * 60 * 1000),
    );
    return {
      delayedJoining: days > this.refs.delayedJoiningThresholdDays,
      delayedByDays: Math.max(0, days),
    };
  }
}
