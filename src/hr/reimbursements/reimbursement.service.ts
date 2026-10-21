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
import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_REIMBURSEMENT_CLAIM } from '../../approvals/default-chains';
import { AuditLogService } from '../../auth/audit-log.service';
import { submitClaimForApproval } from './claim-approval';
import { withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import {
  ReimbursementCategoriesService,
  ReimbursementCategoryView,
} from '../../settings/reimbursement-categories/reimbursement-categories.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { ImageProcessingService } from '../biometrics/image-processing.service';
import { describeStoredFile } from '../../common/storage/file-type';
import {
  assertAllowedFileType,
  decodeBase64Upload,
  IMAGE_TYPES,
  PDF,
} from '../../common/uploads';
import { EmployeesService } from '../employees/employees.service';
import { parseDateOnly } from '../leave/leave-days';
import { CreateClaimDto, UpdateClaimDto } from './dto/claim.dto';

/** Statuses this feature is allowed to change a claim out of. Everything past
 * `submitted` belongs to feature 005's review layer (research.md §10). */
const EMPLOYEE_EDITABLE = [ReimbursementClaimStatus.draft] as const;

/** Storage namespace for receipt blobs, kept beside the claim it belongs to. */
const RECEIPT_NAMESPACE = 'reimbursement-receipts';

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
    private readonly storage: StorageService,
    private readonly images: ImageProcessingService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * The categories a claim may be filed against, for the employee's own claim form.
   *
   * `settings` owns this master and feature 005 owns its CRUD; this is a read-only
   * projection scoped to the caller's company, exposed because the claim form
   * cannot render a category picker — or tell the employee when a receipt becomes
   * mandatory — without it (US8 AC1).
   */
  async listCategories(caller: Caller): Promise<ReimbursementCategoryView[]> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return this.categories.getReimbursementCategories(
      caller.rls,
      employee.companyId,
    );
  }

  /**
   * Stores an uploaded receipt and returns the reference to persist.
   *
   * Taken in the same request as the claim rather than through a separate upload
   * endpoint: a two-step upload orphans every blob whose claim is then abandoned,
   * and nothing here would ever collect them. Mirrors how enrolment posts its
   * photos (research.md §3).
   */
  private async storeReceipt(receipt: string): Promise<string> {
    const bytes = decodeBase64Upload(receipt, 'The receipt');
    // A PDF invoice is accepted as well as a photo (036 G5): many fuel and travel receipts arrive
    // as PDFs, and the form used to refuse them. Decided by the bytes, so an HTML page labelled a
    // PDF is refused 415. A PDF is stored as uploaded; there is no EXIF to strip.
    const type = assertAllowedFileType(
      bytes,
      [PDF, ...IMAGE_TYPES],
      'The receipt',
    );
    if (type.contentType === PDF) {
      return this.storage.put(RECEIPT_NAMESPACE, bytes, PDF);
    }
    // Normalised before storage rather than stored as uploaded. Two reasons, both
    // load-bearing: it strips the EXIF a phone camera embeds — GPS coordinates
    // included — and it makes `image/jpeg` an honest content type, where storing
    // the raw bytes would mislabel every PNG and WebP the decoder accepts.
    const normalised = await this.images.compressReceipt(bytes);
    return this.storage.put(RECEIPT_NAMESPACE, normalised, 'image/jpeg');
  }

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
    // Resolved before the rule check so an uploaded receipt satisfies the
    // threshold. Only a receipt uploaded here counts (036 F18): a client-sent `receiptRef` is
    // ignored, because any storage key — another employee's receipt, or nothing at all — used to
    // satisfy the threshold.
    const receiptRef = dto.receipt
      ? await this.storeReceipt(dto.receipt)
      : undefined;
    this.assertReceiptRule(category, dto.amount, receiptRef);

    // Straight to head office (2026-10-20). The reporting-manager stage added on 2026-10-16 was
    // withdrawn at the client's request; the manager columns stay for claims decided then.
    const created = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.create({
        data: {
          employeeId: employee.id,
          companyId: employee.companyId,
          categoryId: dto.categoryId,
          amount: new Prisma.Decimal(dto.amount),
          expenseDate: parseDateOnly(dto.expenseDate),
          description: dto.description,
          receiptRef: receiptRef ?? null,
          status:
            dto.status === 'draft'
              ? ReimbursementClaimStatus.draft
              : ReimbursementClaimStatus.submitted,
        },
      }),
    );

    // Into its approval chain once submitted (2026-10-20); a draft waits for `updateClaim`. Undone
    // when the company has no chain, rather than left where nobody could decide it.
    if (created.status === ReimbursementClaimStatus.submitted) {
      try {
        await submitClaimForApproval(
          this.approvals,
          created,
          employee,
          caller.userId,
        );
      } catch (error) {
        await withRlsContext(this.prisma, caller.rls, (tx) =>
          tx.reimbursementClaim.delete({ where: { id: created.id } }),
        );
        throw error;
      }
    }

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
    // A new upload replaces the receipt; `receiptRef: null` removes it; anything else keeps the
    // one on file (036 F18) — a client can no longer point the claim at a storage key of its
    // choosing.
    const receiptRef = dto.receipt
      ? await this.storeReceipt(dto.receipt)
      : dto.receiptRef === null
      ? null
      : existing.receiptRef;
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

    // A draft being submitted enters its chain now (2026-10-20). If that fails it goes back to
    // being a draft, so the employee can try again rather than hold a claim nobody can decide.
    if (
      existing.status === ReimbursementClaimStatus.draft &&
      updated.status === ReimbursementClaimStatus.submitted
    ) {
      try {
        await submitClaimForApproval(
          this.approvals,
          updated,
          employee,
          caller.userId,
        );
      } catch (error) {
        await withRlsContext(this.prisma, caller.rls, (tx) =>
          tx.reimbursementClaim.update({
            where: { id },
            data: { status: ReimbursementClaimStatus.draft },
          }),
        );
        throw error;
      }
    }

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

    // Nothing left for the approver to decide.
    await this.approvals.abandon(
      ACTION_REIMBURSEMENT_CLAIM,
      withdrawn.id,
      withdrawn.companyId,
      'Withdrawn by the employee.',
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

  /** The caller's own receipt, to open from My Workspace (036 F17/G5). */
  async ownReceipt(
    caller: Caller,
    id: string,
  ): Promise<{ data: Buffer; filename: string; contentType: string }> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    const claim = await this.requireOwnClaim(caller, employee.id, id);
    return readReceipt(this.storage, claim);
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

/**
 * A claim's receipt bytes, with a type and a name to serve them under (036 F17).
 *
 * Exported so the admin review screen and My Workspace serve receipts the same way. The type is
 * sniffed from the bytes: receipts were stored as JPEG only until 036 G5 added PDFs, and there is
 * no column recording which a given one is.
 */
export async function readReceipt(
  storage: StorageService,
  claim: { id: string; receiptRef: string | null },
): Promise<{ data: Buffer; filename: string; contentType: string }> {
  if (!claim.receiptRef) {
    throw new NotFoundException('This claim has no receipt.');
  }
  const data = await storage.get(claim.receiptRef);
  const { filename, contentType } = describeStoredFile({
    bytes: data,
    storedName: null,
    storedType: null,
    fallbackName: `receipt-${claim.id}`,
  });
  return { data, filename, contentType };
}
