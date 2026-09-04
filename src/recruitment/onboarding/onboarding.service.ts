import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  OnboardingItemStatus,
  OnboardingItemType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope } from '../../settings/company-scope';
import type { UploadEmployeeDocumentDto } from '../../hr/employees/documents/dto/upload-document.dto';
import { RecruitmentRefsService } from '../recruitment-refs.service';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async getByEmployee(caller: AuthenticatedUser, employeeId: string) {
    const checklist = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.onboardingChecklist.findFirst({
          where: { employeeId },
          include: { items: { orderBy: { createdAt: 'asc' } } },
        }),
    );
    if (!checklist) {
      throw new NotFoundException('No onboarding checklist for this employee');
    }
    assertInScope(caller, checklist, 'Onboarding checklist');

    const completedCount = checklist.items.filter(
      (i) => i.status !== OnboardingItemStatus.pending,
    ).length;
    return {
      id: checklist.id,
      employeeId: checklist.employeeId,
      candidateId: checklist.candidateId,
      openedAt: checklist.openedAt.toISOString(),
      completedAt: checklist.completedAt
        ? checklist.completedAt.toISOString()
        : null,
      onboardingComplete: checklist.completedAt !== null,
      completedCount,
      totalCount: checklist.items.length,
      items: checklist.items.map((i) => ({
        id: i.id,
        itemType: i.itemType,
        documentTypeId: i.documentTypeId,
        kitItemId: i.kitItemId,
        label: i.label,
        status: i.status,
        completedAt: i.completedAt ? i.completedAt.toISOString() : null,
        waiverReason: i.waiverReason,
        linkedIssueId: i.linkedIssueId,
      })),
    };
  }

  async verifyDocument(
    caller: AuthenticatedUser,
    itemId: string,
    dto: {
      documentNumber?: string;
      expiryDate?: string;
      file: string;
      contentType: string;
    },
    ipAddress: string,
  ) {
    const { item, checklist } = await this.loadItem(caller, itemId);
    if (item.itemType !== OnboardingItemType.document || !item.documentTypeId) {
      throw new ConflictException('This item is not a document item');
    }

    const uploadDto: UploadEmployeeDocumentDto = {
      documentTypeId: item.documentTypeId,
      file: dto.file,
      contentType: dto.contentType,
      documentNumber: dto.documentNumber,
      expiresAt: dto.expiryDate,
    } as UploadEmployeeDocumentDto;

    await this.refs.uploadEmployeeDocument(
      caller,
      ipAddress,
      checklist.employeeId,
      uploadDto,
    );
    return this.complete(caller, item.id, checklist.id, ipAddress);
  }

  /**
   * Issues a kit item. Recorded as a non-stock issuance (actor + date); the
   * inventory-stock linkage is deferred (see plan deviations) so no `linkedIssueId`
   * is set today.
   */
  async issueKit(
    caller: AuthenticatedUser,
    itemId: string,
    _quantity: number,
    ipAddress: string,
  ) {
    const { item, checklist } = await this.loadItem(caller, itemId);
    if (item.itemType !== OnboardingItemType.kit) {
      throw new ConflictException('This item is not a kit item');
    }
    return this.complete(caller, item.id, checklist.id, ipAddress);
  }

  async completeInduction(
    caller: AuthenticatedUser,
    itemId: string,
    ipAddress: string,
  ) {
    const { item, checklist } = await this.loadItem(caller, itemId);
    if (item.itemType !== OnboardingItemType.induction) {
      throw new ConflictException('This item is not an induction item');
    }
    return this.complete(caller, item.id, checklist.id, ipAddress);
  }

  async waive(
    caller: AuthenticatedUser,
    itemId: string,
    reason: string,
    ipAddress: string,
  ) {
    const { item, checklist } = await this.loadItem(caller, itemId);
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.onboardingItem.update({
        where: { id: item.id },
        data: {
          status: OnboardingItemStatus.waived,
          waiverReason: reason,
          completedBy: caller.id,
          completedAt: new Date(),
        },
      }),
    );
    await this.recomputeCompletion(caller, checklist.id);
    await this.audit(item.id, checklist.companyId, caller, ipAddress);
    return this.getByEmployee(caller, checklist.employeeId);
  }

  private async complete(
    caller: AuthenticatedUser,
    itemId: string,
    checklistId: string,
    ipAddress: string,
  ) {
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.onboardingItem.update({
        where: { id: itemId },
        data: {
          status: OnboardingItemStatus.completed,
          completedBy: caller.id,
          completedAt: new Date(),
        },
      }),
    );
    const checklist = await this.recomputeCompletion(caller, checklistId);
    await this.audit(itemId, checklist.companyId, caller, ipAddress);
    return this.getByEmployee(caller, checklist.employeeId);
  }

  private async recomputeCompletion(
    caller: AuthenticatedUser,
    checklistId: string,
  ) {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const checklist = await tx.onboardingChecklist.findUnique({
        where: { id: checklistId },
        include: { items: true },
      });
      if (!checklist) throw new NotFoundException('Checklist not found');
      const allDone = checklist.items.every(
        (i) => i.status !== OnboardingItemStatus.pending,
      );
      if (allDone && !checklist.completedAt) {
        await tx.onboardingChecklist.update({
          where: { id: checklistId },
          data: { completedAt: new Date() },
        });
      } else if (!allDone && checklist.completedAt) {
        await tx.onboardingChecklist.update({
          where: { id: checklistId },
          data: { completedAt: null },
        });
      }
      return checklist;
    });
  }

  private async loadItem(caller: AuthenticatedUser, itemId: string) {
    const item = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.onboardingItem.findUnique({
          where: { id: itemId },
          include: { checklist: true },
        }),
    );
    if (!item)
      throw new NotFoundException(`Onboarding item ${itemId} not found`);
    assertInScope(caller, item, `Onboarding item ${itemId}`);
    return { item, checklist: item.checklist };
  }

  private async audit(
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.ONBOARDING_ITEM,
      action: AuditAction.UPDATE,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
