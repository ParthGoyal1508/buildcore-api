import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AuditAction,
  ApprovalDecisionAction,
  AuditEntityType,
  Prisma,
  ReimbursementClaimStatus,
  ReimbursementPaymentMode,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
} from '../../approvals/approvals.service';
import { ACTION_REIMBURSEMENT_CLAIM } from '../../approvals/default-chains';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { submitClaimForApproval } from '../../hr/reimbursements/claim-approval';
import { withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { readReceipt } from '../../hr/reimbursements/reimbursement.service';
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
  private readonly logger = new Logger(ReimbursementsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
    private readonly approvals: ApprovalService,
  ) {}

  /** Whether a claim has a receipt — for the Approvals page's files, without reading it. */
  async hasReceipt(caller: Caller, claimId: string): Promise<boolean> {
    const claim = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reimbursementClaim.findFirst({
        where: { id: claimId },
        select: { receiptRef: true },
      }),
    );
    return !!claim?.receiptRef;
  }

  /**
   * A claim's receipt, for the approver (036 F17). There was no way to see it before: the review
   * screen showed only that one existed. Scoped by RLS, plus the company check, so a Super Admin
   * working in one company cannot open another's by id.
   */
  async receipt(caller: Caller, claimId: string) {
    const claim = await this.requireClaim(caller, claimId);
    if (
      !caller.rls.isSuperAdmin &&
      caller.rls.companyId &&
      claim.companyId !== caller.rls.companyId
    ) {
      throw new NotFoundException('Claim not found');
    }
    return readReceipt(this.storage, claim);
  }

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

  /**
   * Approves a submitted claim (FR-037) — a decision on its approval chain (2026-10-20). The
   * claim is approved when the chain's last level approves; until then it stays submitted.
   */
  async approveClaim(
    caller: Caller,
    claimId: string,
    dto: ApproveClaimDto,
    user: AuthenticatedUser,
  ) {
    return this.decideOnChain(
      caller,
      claimId,
      ApprovalDecisionAction.approve,
      dto.remarks,
      user,
    );
  }

  /** Rejects a submitted claim. Remarks are mandatory (FR-037). */
  async rejectClaim(
    caller: Caller,
    claimId: string,
    dto: RejectClaimDto,
    user: AuthenticatedUser,
  ) {
    return this.decideOnChain(
      caller,
      claimId,
      ApprovalDecisionAction.reject,
      dto.remarks,
      user,
    );
  }

  private async decideOnChain(
    caller: Caller,
    claimId: string,
    action: ApprovalDecisionAction,
    remarks: string | undefined,
    user: AuthenticatedUser,
  ) {
    const claim = await this.requireClaim(caller, claimId);
    await this.assertNotOwnClaim(caller, claim);
    this.assertTransition(
      claim.status,
      action === ApprovalDecisionAction.approve
        ? ReimbursementClaimStatus.approved
        : ReimbursementClaimStatus.rejected,
    );
    await this.ensureInChain(claim);

    const view = await this.approvals.decideByEntity(
      ACTION_REIMBURSEMENT_CLAIM,
      claimId,
      { action, reason: remarks?.trim() || null },
      user,
      caller.ipAddress,
    );
    if (view.state === 'approved' || view.state === 'rejected') {
      await this.applyOutcome(claimId, view.state, caller.userId, remarks);
    }
    return this.requireClaim(caller, claimId);
  }

  /** The chain approved the claim at its last level (2026-10-20). */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_REIMBURSEMENT_CLAIM) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'approved');
  }

  /** The chain rejected it, at any level. */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_REIMBURSEMENT_CLAIM) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'rejected');
  }

  /** Logs rather than throws: the decision is already committed in the spine. */
  private async onChainOutcome(
    claimId: string,
    companyId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      const state = await this.approvals.stateOfSystem(
        ACTION_REIMBURSEMENT_CLAIM,
        claimId,
        companyId,
      );
      const latest = state?.latestDecision;
      await this.applyOutcome(
        claimId,
        outcome,
        latest?.actorUserId ?? null,
        latest?.reason ?? undefined,
      );
    } catch (error) {
      this.logger.error(
        `Could not apply the ${outcome} chain outcome to claim ${claimId}`,
        error as Error,
      );
    }
  }

  /**
   * The final decision, written once: conditional on the claim still being submitted, so the
   * admin screen's own decide and the spine's event — which both arrive for a decision taken
   * there — record it once between them.
   */
  private async applyOutcome(
    claimId: string,
    outcome: 'approved' | 'rejected',
    deciderUserId: string | null,
    remarks: string | undefined,
  ): Promise<void> {
    const status =
      outcome === 'approved'
        ? ReimbursementClaimStatus.approved
        : ReimbursementClaimStatus.rejected;
    const { moved, companyId } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const result = await tx.reimbursementClaim.updateMany({
          where: { id: claimId, status: ReimbursementClaimStatus.submitted },
          data: {
            status,
            decidedByUserId: deciderUserId,
            decidedAt: new Date(),
            adminRemarks: remarks?.trim() || null,
          },
        });
        const claim = await tx.reimbursementClaim.findFirst({
          where: { id: claimId },
          select: { companyId: true },
        });
        return { moved: result.count === 1, companyId: claim?.companyId };
      },
    );
    if (!moved || !companyId) return;
    await this.audit(
      { userId: deciderUserId ?? '', ipAddress: '' } as Caller,
      companyId,
      claimId,
      { decision: outcome },
    );
  }

  /**
   * A claim submitted before claims joined the spine has no chain; it is put into one when first
   * decided, so the decision still runs through the company's configured levels.
   */
  private async ensureInChain(claim: {
    id: string;
    companyId: string;
    employeeId: string;
    amount: Prisma.Decimal;
    description: string;
    expenseDate: Date;
  }): Promise<boolean> {
    const state = await this.approvals.stateOfSystem(
      ACTION_REIMBURSEMENT_CLAIM,
      claim.id,
      claim.companyId,
    );
    if (state) return false;
    const claimant = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId: claim.companyId },
      (tx) =>
        tx.employee.findFirst({
          where: { id: claim.employeeId },
          select: { userId: true, firstName: true, lastName: true },
        }),
    );
    if (!claimant) throw new NotFoundException('Claimant not found');
    await submitClaimForApproval(
      this.approvals,
      claim,
      claimant,
      claimant.userId,
    );
    return true;
  }

  /**
   * Puts every pending claim with no approval chain into one (2026-10-20) — those raised before
   * claims joined the spine, so they reach the Approvals queue rather than waiting for somebody to
   * open the module screen. Idempotent; run by `npm run backfill:approvals`. Returns how many it
   * submitted.
   */
  async backfillApprovals(): Promise<number> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.reimbursementClaim.findMany({
          where: { status: ReimbursementClaimStatus.submitted },
        }),
    );
    let submitted = 0;
    for (const claim of rows) {
      if (await this.ensureInChain(claim)) submitted += 1;
    }
    return submitted;
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
    await this.assertNotOwnClaim(caller, claim);
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
   * Nobody approves, rejects or pays their own claim (2026-10-16 access-control audit, H3) — the
   * admin list shows every claim in the company to anyone holding EMPLOYEES, the claimant
   * included.
   */
  private async assertNotOwnClaim(
    caller: Caller,
    claim: { employeeId: string },
  ): Promise<void> {
    const claimant = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: claim.employeeId },
        select: { userId: true },
      }),
    );
    if (claimant?.userId && claimant.userId === caller.userId) {
      throw new ForbiddenException({
        code: 'SELF_APPROVAL',
        message: 'You cannot decide your own claim. Another approver must.',
      });
    }
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
      throw new ConflictException(`A ${from} claim cannot become ${to}.`);
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
      accountId: caller.userId || undefined,
      companyId,
      ipAddress: caller.ipAddress,
    });
  }
}
