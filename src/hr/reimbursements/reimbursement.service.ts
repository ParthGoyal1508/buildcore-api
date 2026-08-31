import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  ReimbursementClaim,
  ReimbursementClaimStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { withRlsContext } from '../../common/prisma/rls-context';
import {
  ReimbursementCategoriesService,
  ReimbursementCategoryView,
} from '../../settings/reimbursement-categories/reimbursement-categories.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeesService } from '../employees/employees.service';
import { parseDateOnly } from '../leave/leave-days';
import { CreateClaimDto, UpdateClaimDto } from './dto/claim.dto';

/** Statuses this feature is allowed to change a claim out of. Everything past
 * `submitted` belongs to feature 005's review layer (research.md §10). */
const EMPLOYEE_EDITABLE = [ReimbursementClaimStatus.draft] as const;

/**
 * Employee-originated reimbursement claims (US8).
 *
 * The write surface here stops at `submitted`. Approval, rejection, and payment
 * are feature 005's, over this same table — so every method below either creates a
 * claim or moves it between the two states an employee owns, and none of them
 * touches `paymentMode`, `paymentReference`, or the decision fields.
 */
@Injectable()
export class ReimbursementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly categories: ReimbursementCategoriesService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** The caller's own claims, newest expense first (FR-033). */
  async listOwnClaims(
    caller: Caller,
    status?: ReimbursementClaimStatus,
  ): Promise<ReimbursementClaim[]> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.findMany({
        where: { employeeId: employee.id, ...(status ? { status } : {}) },
        orderBy: { expenseDate: 'desc' },
      }),
    );
  }

  /** Files a claim (FR-029, FR-030). */
  async createClaim(
    caller: Caller,
    dto: CreateClaimDto,
  ): Promise<ReimbursementClaim> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const active = await this.categories.getReimbursementCategories(
      caller.rls,
      employee.companyId,
    );
    const category = active.find((c) => c.id === dto.categoryId);
    if (!category) {
      // Checked against the *active* list, not `requireCategory`: filing against a
      // category the company has retired should fail here, even though existing
      // claims against it stay readable.
      throw new BadRequestException(
        'That reimbursement category is not available for your company.',
      );
    }
    this.assertReceiptRule(category, dto.amount, dto.receiptRef);

    const created = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.create({
        data: {
          employeeId: employee.id,
          companyId: employee.companyId,
          categoryId: dto.categoryId,
          amount: new Prisma.Decimal(dto.amount),
          expenseDate: parseDateOnly(dto.expenseDate),
          description: dto.description,
          receiptRef: dto.receiptRef ?? null,
          status:
            dto.status === 'draft'
              ? ReimbursementClaimStatus.draft
              : ReimbursementClaimStatus.submitted,
        },
      }),
    );

    await this.audit(caller, AuditAction.CREATE, created, {
      categoryId: dto.categoryId,
      amount: dto.amount,
      status: created.status,
    });

    return created;
  }

  /** Edits a claim while it is still a draft (FR-031). */
  async updateClaim(
    caller: Caller,
    id: string,
    dto: UpdateClaimDto,
  ): Promise<ReimbursementClaim> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const existing = await this.requireOwnClaim(caller, employee.id, id);
    if (!EMPLOYEE_EDITABLE.includes(existing.status as never)) {
      throw new ConflictException(
        `This claim is ${existing.status} and can no longer be edited. Withdraw it instead if it is still pending review.`,
      );
    }

    // The receipt rule is re-checked against the values the claim will *end up*
    // with, not the ones the request happened to include — editing the amount
    // upward past the threshold must require the receipt the original claim did
    // not need.
    const categoryId = dto.categoryId ?? existing.categoryId;
    const amount = dto.amount ?? existing.amount.toNumber();
    const receiptRef =
      dto.receiptRef !== undefined ? dto.receiptRef : existing.receiptRef;
    const category = await this.categories.requireCategory(
      caller.rls,
      employee.companyId,
      categoryId,
    );
    this.assertReceiptRule(category, amount, receiptRef ?? undefined);

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.update({
        where: { id },
        data: {
          categoryId,
          amount: new Prisma.Decimal(amount),
          receiptRef: receiptRef ?? null,
          ...(dto.expenseDate
            ? { expenseDate: parseDateOnly(dto.expenseDate) }
            : {}),
          ...(dto.description ? { description: dto.description } : {}),
          ...(dto.status
            ? {
                status:
                  dto.status === 'draft'
                    ? ReimbursementClaimStatus.draft
                    : ReimbursementClaimStatus.submitted,
              }
            : {}),
        },
      }),
    );

    await this.audit(caller, AuditAction.UPDATE, updated, {
      categoryId,
      amount,
      status: updated.status,
    });

    return updated;
  }

  /** Retracts a claim still awaiting review (FR-032). */
  async withdrawClaim(caller: Caller, id: string): Promise<ReimbursementClaim> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const withdrawn = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const claim = await tx.reimbursementClaim.findFirst({
          where: { id, employeeId: employee.id },
        });
        if (!claim) {
          throw new NotFoundException('Reimbursement claim not found');
        }
        if (
          claim.status !== ReimbursementClaimStatus.submitted &&
          claim.status !== ReimbursementClaimStatus.draft
        ) {
          // Once an approver has ruled, withdrawing would erase their decision
          // rather than retract a pending request.
          throw new ConflictException(
            `This claim is already ${claim.status} and can no longer be withdrawn.`,
          );
        }
        return tx.reimbursementClaim.update({
          where: { id },
          data: { status: ReimbursementClaimStatus.withdrawn },
        });
      },
    );

    await this.audit(caller, AuditAction.UPDATE, withdrawn, {
      status: ReimbursementClaimStatus.withdrawn,
    });

    return withdrawn;
  }

  /**
   * Deletes a claim that has not been submitted (FR-031).
   *
   * Only a draft is deletable. Once a claim has been submitted, an approver may
   * already have seen it, and removing the row outright would erase a request that
   * was really made — `withdrawClaim` is the path for that, because it leaves a
   * trace.
   */
  async deleteDraftClaim(caller: Caller, id: string): Promise<void> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const deleted = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const claim = await tx.reimbursementClaim.findFirst({
          where: { id, employeeId: employee.id },
        });
        if (!claim) {
          throw new NotFoundException('Reimbursement claim not found');
        }
        if (claim.status !== ReimbursementClaimStatus.draft) {
          throw new ConflictException(
            `This claim is ${claim.status} and can no longer be deleted. Withdraw it instead if it is still pending review.`,
          );
        }
        await tx.reimbursementClaim.delete({ where: { id } });
        return claim;
      },
    );

    await this.audit(caller, AuditAction.DELETE, deleted, {
      status: deleted.status,
    });
  }

  /**
   * Enforces FR-030's mandatory-receipt threshold.
   *
   * Strictly above, not at-or-above: a threshold of 1000 means "receipts needed
   * for claims over a thousand", and demanding one for a claim of exactly 1000
   * would surprise everyone who read the number that way.
   */
  private assertReceiptRule(
    category: ReimbursementCategoryView,
    amount: number,
    receiptRef?: string | null,
  ): void {
    const threshold = category.receiptRequiredAbove;
    if (threshold !== null && amount > threshold && !receiptRef) {
      throw new BadRequestException(
        `A receipt is required for ${category.name} claims above ${threshold}.`,
      );
    }
  }

  /** Filtered on employeeId as well as id: RLS confines this to the caller's
   * company, and a company contains other employees (FR-033). */
  private async requireOwnClaim(
    caller: Caller,
    employeeId: string,
    id: string,
  ): Promise<ReimbursementClaim> {
    const claim = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.findFirst({ where: { id, employeeId } }),
    );
    if (!claim) {
      throw new NotFoundException('Reimbursement claim not found');
    }
    return claim;
  }

  private async audit(
    caller: Caller,
    action: AuditAction,
    claim: ReimbursementClaim,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record({
      entityType: AuditEntityType.REIMBURSEMENT_CLAIM,
      action,
      entityId: claim.id,
      changes: changes as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: claim.companyId,
      ipAddress: caller.ipAddress,
    });
  }
}
