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
  ReimbursementClaimStatus,
  ReimbursementPaymentMode,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import type {
  ApproveClaimDto,
  ListClaimsQueryDto,
  PayClaimDto,
  RejectClaimDto,
} from './dto/decide-claim.dto';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The admin side of reimbursement claims (005 US12).
 *
 * Operates on feature 003's `hr.ReimbursementClaim` table — the same rows the
 * employee created. 003 deliberately reserved the admin columns
 * (`decidedByUserId`, `paymentMode`, ...) and never writes them, so this is the
 * second half of one workflow rather than a parallel one.
 */
@Injectable()
export class ReimbursementsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listClaims(
    caller: Caller,
    companyId: string,
    query: ListClaimsQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);

    const where: Prisma.ReimbursementClaimWhereInput = {
      companyId,
      // Drafts belong to the employee who has not submitted them yet; an admin
      // list that included them would show claims nobody has asked for.
      status: query.status ?? { not: ReimbursementClaimStatus.draft },
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) =>
        Promise.all([
          tx.reimbursementClaim.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.reimbursementClaim.count({ where }),
        ]),
    );

    return { items, total, page, pageSize };
  }

  /** Approves a submitted claim (FR-037). */
  async approveClaim(caller: Caller, claimId: string, dto: ApproveClaimDto) {
    const claim = await this.requireClaim(caller, claimId);
    this.assertTransition(claim.status, ReimbursementClaimStatus.approved);

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.update({
        where: { id: claimId },
        data: {
          status: ReimbursementClaimStatus.approved,
          decidedByUserId: caller.userId,
          decidedAt: new Date(),
          adminRemarks: dto.remarks?.trim() ?? null,
        },
      }),
    );

    await this.audit(caller, claim.companyId, claimId, {
      decision: 'approved',
    });
    return updated;
  }

  /** Rejects a submitted claim. Remarks are mandatory (FR-037). */
  async rejectClaim(caller: Caller, claimId: string, dto: RejectClaimDto) {
    const claim = await this.requireClaim(caller, claimId);
    this.assertTransition(claim.status, ReimbursementClaimStatus.rejected);

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.update({
        where: { id: claimId },
        data: {
          status: ReimbursementClaimStatus.rejected,
          decidedByUserId: caller.userId,
          decidedAt: new Date(),
          adminRemarks: dto.remarks.trim(),
        },
      }),
    );

    await this.audit(caller, claim.companyId, claimId, {
      decision: 'rejected',
    });
    return updated;
  }

  /**
   * Marks an approved claim paid (FR-038).
   *
   * `direct` requires a reference — a payment recorded with no way to trace it is
   * indistinguishable from one that never happened. `payroll` records the intent
   * and leaves the money to the next run, which picks it up via
   * `pendingPayrollReimbursements`.
   */
  async payClaim(caller: Caller, claimId: string, dto: PayClaimDto) {
    const claim = await this.requireClaim(caller, claimId);
    this.assertTransition(claim.status, ReimbursementClaimStatus.paid);

    if (
      dto.paymentMode === ReimbursementPaymentMode.direct &&
      !dto.paymentReference?.trim()
    ) {
      throw new BadRequestException(
        'A direct payment requires a paymentReference.',
      );
    }

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.update({
        where: { id: claimId },
        data: {
          status: ReimbursementClaimStatus.paid,
          paymentMode: dto.paymentMode,
          paymentReference: dto.paymentReference?.trim() ?? null,
        },
      }),
    );

    await this.audit(caller, claim.companyId, claimId, {
      paid: true,
      paymentMode: dto.paymentMode,
    });
    return updated;
  }

  /**
   * The Reimbursement Register (FR-039): every non-draft claim with status
   * subtotals.
   */
  async getRegister(
    caller: Caller,
    companyId: string,
    query: ListClaimsQueryDto,
  ) {
    const { items } = await this.listClaims(caller, companyId, {
      ...query,
      page: 1,
      pageSize: 100,
    });

    const subtotal = (status: ReimbursementClaimStatus) =>
      r2(
        items
          .filter((c) => c.status === status)
          .reduce((a, c) => a + c.amount.toNumber(), 0),
      );

    return {
      items,
      totals: {
        submitted: subtotal(ReimbursementClaimStatus.submitted),
        approved: subtotal(ReimbursementClaimStatus.approved),
        paid: subtotal(ReimbursementClaimStatus.paid),
        rejected: subtotal(ReimbursementClaimStatus.rejected),
        all: r2(items.reduce((a, c) => a + c.amount.toNumber(), 0)),
      },
    };
  }

  /**
   * Approved claims marked for payroll settlement that have not yet been paid.
   *
   * Read by the payroll engine so an employee's next run carries the amount as an
   * earnings line (FR-038, T110). A rejected or draft claim can never appear here,
   * which is FR-040's guarantee expressed as a query rather than a convention.
   */
  async pendingPayrollReimbursements(
    caller: Caller,
    employeeId: string,
  ): Promise<{ total: number; claimIds: string[] }> {
    const claims = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.findMany({
        where: {
          employeeId,
          status: ReimbursementClaimStatus.approved,
          paymentMode: ReimbursementPaymentMode.payroll,
        },
        select: { id: true, amount: true },
      }),
    );
    return {
      total: r2(claims.reduce((a, c) => a + c.amount.toNumber(), 0)),
      claimIds: claims.map((c) => c.id),
    };
  }

  /** Marks payroll-settled claims paid once the run that carried them processes. */
  async settlePayrollClaims(
    tx: Prisma.TransactionClient,
    claimIds: string[],
    payrollRunId: string,
  ): Promise<void> {
    if (claimIds.length === 0) return;
    await tx.reimbursementClaim.updateMany({
      where: { id: { in: claimIds } },
      data: {
        status: ReimbursementClaimStatus.paid,
        paymentReference: `payroll:${payrollRunId}`,
      },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireClaim(caller: Caller, claimId: string) {
    const claim = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.findFirst({ where: { id: claimId } }),
    );
    if (!claim) throw new NotFoundException('Claim not found');
    return claim;
  }

  /**
   * The admin-side claim lifecycle.
   *
   * Withdrawn and rejected are terminal: an employee who retracted a claim has to
   * submit a new one rather than have an admin revive it behind their back.
   */
  private assertTransition(
    from: ReimbursementClaimStatus,
    to: ReimbursementClaimStatus,
  ): void {
    const allowed: Partial<
      Record<ReimbursementClaimStatus, ReimbursementClaimStatus[]>
    > = {
      submitted: [
        ReimbursementClaimStatus.approved,
        ReimbursementClaimStatus.rejected,
      ],
      approved: [ReimbursementClaimStatus.paid],
    };
    if (!(allowed[from] ?? []).includes(to)) {
      throw new ConflictException(
        `A ${from} claim cannot become ${to}.`,
      );
    }
  }

  private async audit(
    caller: Caller,
    companyId: string,
    claimId: string,
    changes: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.auditLog.record({
      entityType: AuditEntityType.REIMBURSEMENT_CLAIM,
      action: AuditAction.UPDATE,
      entityId: claimId,
      changes,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });
  }
}
