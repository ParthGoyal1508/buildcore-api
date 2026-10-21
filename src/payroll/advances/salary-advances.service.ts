import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ApprovalDecisionAction,
  AuditAction,
  AuditEntityType,
  Permission,
  Prisma,
  SalaryAdvanceStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
} from '../../approvals/approvals.service';
import { ACTION_SALARY_ADVANCE } from '../../approvals/default-chains';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { webRoutes } from '../../common/web-routes';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { assertNotMakerOrPayee } from '../maker-checker';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Salary advances (005 amendment US15).
 *
 * Deliberately not a `Loan`. A loan has an EMI schedule spread over months; an
 * advance is a single-month recovery with no interest. Modelling one as the other
 * would put two different products behind one screen and one set of rules — which
 * is exactly why the matrix names them separately.
 */
@Injectable()
export class SalaryAdvancesService {
  private readonly hrPayroll: HrPayrollConfig;
  private readonly logger = new Logger(SalaryAdvancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly approvals: ApprovalService,
    configService: ConfigService,
  ) {
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  /**
   * Requests an advance.
   *
   * At most one open advance per employee (FR-054), enforced by a partial unique
   * index as well as this check — the index is what makes it true under
   * concurrency, this is what makes the failure readable.
   */
  async create(
    caller: Caller,
    companyId: string,
    dto: {
      employeeId: string;
      amount: number;
      reason: string;
      recoveryMonth: string;
    },
  ) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: dto.employeeId, companyId },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.isActive) {
      throw new BadRequestException(
        'An advance cannot be given to an inactive employee.',
      );
    }

    const open = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.findFirst({
        where: {
          employeeId: dto.employeeId,
          // A rejected advance was never open (2026-10-20).
          status: {
            notIn: [SalaryAdvanceStatus.closed, SalaryAdvanceStatus.rejected],
          },
        },
      }),
    );
    if (open) {
      throw new ConflictException(
        'That employee already has an open advance; it must be recovered first.',
      );
    }

    // Flagged rather than blocked: an unusually large advance is a business
    // decision someone should make deliberately, not one the system forbids.
    const monthlyNet = this.approxMonthlyNet(employee);
    const limit = r2(
      monthlyNet * this.hrPayroll.salaryAdvance.limitMultipleOfMonthlyNet,
    );
    const exceedsLimit = monthlyNet > 0 && dto.amount > limit;

    const advance = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.create({
        data: {
          employeeId: dto.employeeId,
          amount: dto.amount,
          reason: dto.reason.trim(),
          recoveryMonth: dto.recoveryMonth,
          outstandingBalance: dto.amount,
          exceedsLimit,
          status: SalaryAdvanceStatus.pending,
          // 036 F19: the maker, so the checker can be required to be somebody else.
          createdByUserId: caller.userId,
        },
      }),
    );

    // Into its approval chain (2026-10-20); undone if the company has none, rather than left
    // pending where nobody could ever approve it.
    try {
      await this.submitForApproval(advance, employee, caller.userId);
    } catch (error) {
      await withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.salaryAdvance.delete({ where: { id: advance.id } }),
      );
      throw error;
    }

    await this.audit(caller, companyId, advance.id, AuditAction.CREATE, {
      amount: dto.amount,
      recoveryMonth: dto.recoveryMonth,
      exceedsLimit,
    });

    return this.toView(advance, exceedsLimit ? limit : null);
  }

  /**
   * Approves an advance — a decision on its approval chain (2026-10-20). On the chain's final
   * approval it is approved and disbursed in one step: the money leaves when it is approved.
   *
   * 036 F19 (decision 4: block, no override). **Maker-checker**: whoever recorded the advance
   * cannot approve it, and nor can the employee it is for — checked here and, for advances raised
   * since 2026-10-20, by the spine as well, which is what covers a decision taken from the
   * Approvals page.
   */
  async approve(caller: Caller, advanceId: string, user: AuthenticatedUser) {
    return this.decideOnChain(
      caller,
      advanceId,
      ApprovalDecisionAction.approve,
      null,
      user,
    );
  }

  /** Rejects a pending advance (2026-10-20): it is never paid or recovered. */
  async reject(
    caller: Caller,
    advanceId: string,
    reason: string,
    user: AuthenticatedUser,
  ) {
    if (!reason.trim()) {
      throw new BadRequestException(
        'A reason is required to reject an advance.',
      );
    }
    return this.decideOnChain(
      caller,
      advanceId,
      ApprovalDecisionAction.reject,
      reason,
      user,
    );
  }

  private async decideOnChain(
    caller: Caller,
    advanceId: string,
    action: ApprovalDecisionAction,
    reason: string | null,
    user: AuthenticatedUser,
  ) {
    const advance = await this.require(caller, advanceId);
    if (advance.status !== SalaryAdvanceStatus.pending) {
      throw new ConflictException(
        `A ${advance.status} advance cannot be decided.`,
      );
    }
    await assertNotMakerOrPayee(this.prisma, caller, {
      createdByUserId: advance.createdByUserId,
      employeeId: advance.employeeId,
      noun: 'advance',
    });
    await this.ensureInChain(advance);

    const view = await this.approvals.decideByEntity(
      ACTION_SALARY_ADVANCE,
      advanceId,
      { action, reason },
      user,
      caller.ipAddress,
    );
    if (view.state === 'approved' || view.state === 'rejected') {
      await this.applyOutcome(advanceId, view.state, caller.userId, reason);
    }
    return this.toView(await this.require(caller, advanceId), null);
  }

  /** The chain approved the advance at its last level (2026-10-20). */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_SALARY_ADVANCE) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'approved');
  }

  /** The chain rejected it, at any level. */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_SALARY_ADVANCE) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'rejected');
  }

  /** Logs rather than throws: the decision is already committed in the spine. */
  private async onChainOutcome(
    advanceId: string,
    companyId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      const state = await this.approvals.stateOfSystem(
        ACTION_SALARY_ADVANCE,
        advanceId,
        companyId,
      );
      const latest = state?.latestDecision;
      await this.applyOutcome(
        advanceId,
        outcome,
        latest?.actorUserId ?? null,
        latest?.reason ?? null,
      );
    } catch (error) {
      this.logger.error(
        `Could not apply the ${outcome} chain outcome to advance ${advanceId}`,
        error as Error,
      );
    }
  }

  /**
   * The final decision, written once: conditional on still pending, so the advances screen's own
   * decide and the spine's event — both of which arrive for a decision taken there — disburse once
   * between them (036 F19's race guard, kept).
   *
   * A rejected advance's outstanding balance goes to zero: it was never paid, and the F&F and
   * exit-clearance reads sum the balance of anything not closed.
   */
  private async applyOutcome(
    advanceId: string,
    outcome: 'approved' | 'rejected',
    deciderUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    const { moved, companyId } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const result = await tx.salaryAdvance.updateMany({
          where: { id: advanceId, status: SalaryAdvanceStatus.pending },
          data:
            outcome === 'approved'
              ? {
                  status: SalaryAdvanceStatus.disbursed,
                  approvedByUserId: deciderUserId,
                  disbursedOn: new Date(),
                }
              : { status: SalaryAdvanceStatus.rejected, outstandingBalance: 0 },
        });
        const advance = await tx.salaryAdvance.findFirst({
          where: { id: advanceId },
          select: { employee: { select: { companyId: true } } },
        });
        return {
          moved: result.count === 1,
          companyId: advance?.employee?.companyId,
        };
      },
    );
    if (!moved || !companyId) return;
    await this.auditLog.record({
      entityType: AuditEntityType.SALARY_ADVANCE,
      action: AuditAction.UPDATE,
      entityId: advanceId,
      changes: {
        [outcome]: true,
        ...(reason ? { reason } : {}),
      },
      accountId: deciderUserId ?? undefined,
      companyId,
      ipAddress: '',
    });
  }

  private async submitForApproval(
    advance: { id: string; amount: Prisma.Decimal | number },
    employee: {
      companyId: string;
      userId: string | null;
      firstName: string;
      lastName: string | null;
    },
    makerUserId: string | null,
  ): Promise<void> {
    const name = `${employee.firstName} ${employee.lastName ?? ''}`.trim();
    const amount = Number(advance.amount).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
    });
    await this.approvals.submit({
      companyId: employee.companyId,
      actionType: ACTION_SALARY_ADVANCE,
      entityType: ACTION_SALARY_ADVANCE,
      entityId: advance.id,
      originatorUserId: makerUserId,
      subject: `${name} — salary advance of ${amount}`,
      href: webRoutes.hrAdvances(),
      viewPermission: Permission.PAYROLL,
      // 036 F19: neither the maker nor the employee being paid.
      excludedUserIds: [makerUserId, employee.userId],
    });
  }

  /** An advance raised before advances joined the spine is put into its chain when first decided. */
  private async ensureInChain(advance: {
    id: string;
    employeeId: string;
    amount: Prisma.Decimal;
    createdByUserId: string | null;
  }): Promise<boolean> {
    const employee = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.employee.findFirst({
          where: { id: advance.employeeId },
          select: {
            companyId: true,
            userId: true,
            firstName: true,
            lastName: true,
          },
        }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    const state = await this.approvals.stateOfSystem(
      ACTION_SALARY_ADVANCE,
      advance.id,
      employee.companyId,
    );
    if (state) return false;
    await this.submitForApproval(advance, employee, advance.createdByUserId);
    return true;
  }

  /**
   * Puts every pending advance with no approval chain into one (2026-10-20) — those raised before
   * advances joined the spine, so they reach the Approvals queue rather than waiting for somebody to
   * open the module screen. Idempotent; run by `npm run backfill:approvals`. Returns how many it
   * submitted.
   */
  async backfillApprovals(): Promise<number> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.salaryAdvance.findMany({
          where: { status: SalaryAdvanceStatus.pending },
        }),
    );
    let submitted = 0;
    for (const advance of rows) {
      if (await this.ensureInChain(advance)) submitted += 1;
    }
    return submitted;
  }

  async list(
    caller: Caller,
    companyId: string,
    query: { employeeId?: string; status?: SalaryAdvanceStatus },
  ) {
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({ where: { companyId }, select: { id: true } }),
    );
    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.findMany({
        where: {
          employeeId: query.employeeId ?? { in: employees.map((e) => e.id) },
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => this.toView(r, null));
  }

  /**
   * The recovery due from an employee in a period.
   *
   * Only disbursed advances whose nominated month has arrived (or passed, if an
   * earlier attempt was capped) are recovered.
   */
  async recoveryDue(
    caller: Caller,
    employeeId: string,
    period: string,
  ): Promise<{ amount: number; advanceId: string | null }> {
    const advance = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.findFirst({
        where: {
          employeeId,
          status: SalaryAdvanceStatus.disbursed,
          recoveryMonth: { lte: period },
        },
        orderBy: { recoveryMonth: 'asc' },
      }),
    );
    if (!advance) return { amount: 0, advanceId: null };
    return {
      amount: advance.outstandingBalance.toNumber(),
      advanceId: advance.id,
    };
  }

  /**
   * Applies what payroll actually managed to recover.
   *
   * The capping happens in the engine — net pay may not go negative — so the
   * amount recovered can be less than the balance. The remainder stays outstanding
   * and is attempted again next month rather than being written off (FR-055).
   */
  async applyRecovery(
    tx: Prisma.TransactionClient,
    advanceId: string,
    recovered: number,
  ): Promise<void> {
    const advance = await tx.salaryAdvance.findUnique({
      where: { id: advanceId },
    });
    if (!advance) return;

    const remaining = r2(
      Math.max(advance.outstandingBalance.toNumber() - recovered, 0),
    );
    await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: {
        outstandingBalance: remaining,
        status:
          remaining === 0
            ? SalaryAdvanceStatus.closed
            : SalaryAdvanceStatus.disbursed,
      },
    });
  }

  /** Outstanding advances, for the F&F settlement to recover (FR-056). */
  async outstandingFor(caller: Caller, employeeId: string): Promise<number> {
    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.findMany({
        where: {
          employeeId,
          status: { not: SalaryAdvanceStatus.closed },
        },
        select: { outstandingBalance: true },
      }),
    );
    return r2(rows.reduce((a, r) => a + r.outstandingBalance.toNumber(), 0));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async require(caller: Caller, advanceId: string) {
    const advance = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.findFirst({ where: { id: advanceId } }),
    );
    if (!advance) throw new NotFoundException('Advance not found');
    return advance;
  }

  /**
   * A rough monthly net, used only to decide whether to flag the amount.
   *
   * Deliberately approximate — the salary structure, not a payroll run — because
   * the check must work for an employee who has never been paid yet.
   */
  private approxMonthlyNet(e: {
    basic: Prisma.Decimal | null;
    hra: Prisma.Decimal | null;
    conveyanceAllowance: Prisma.Decimal | null;
    siteAllowance: Prisma.Decimal | null;
    specialAllowance: Prisma.Decimal | null;
  }): number {
    const n = (d: Prisma.Decimal | null) => (d ? d.toNumber() : 0);
    return r2(
      n(e.basic) +
        n(e.hra) +
        n(e.conveyanceAllowance) +
        n(e.siteAllowance) +
        n(e.specialAllowance),
    );
  }

  private toView(
    a: {
      id: string;
      employeeId: string;
      amount: Prisma.Decimal;
      reason: string;
      recoveryMonth: string;
      outstandingBalance: Prisma.Decimal;
      exceedsLimit: boolean;
      status: SalaryAdvanceStatus;
      disbursedOn: Date | null;
      createdByUserId?: string | null;
    },
    limit: number | null,
  ) {
    return {
      id: a.id,
      employeeId: a.employeeId,
      amount: a.amount.toNumber(),
      reason: a.reason,
      recoveryMonth: a.recoveryMonth,
      outstandingBalance: a.outstandingBalance.toNumber(),
      recovered: r2(a.amount.toNumber() - a.outstandingBalance.toNumber()),
      exceedsLimit: a.exceedsLimit,
      ...(limit !== null ? { limit } : {}),
      status: a.status,
      disbursedOn: a.disbursedOn?.toISOString().slice(0, 10) ?? null,
      // 036 F19: so the screen can say "someone else must approve this" before the 403 does.
      createdByUserId: a.createdByUserId ?? null,
    };
  }

  private async audit(
    caller: Caller,
    companyId: string,
    entityId: string,
    action: AuditAction,
    changes: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.auditLog.record({
      entityType: AuditEntityType.SALARY_ADVANCE,
      action,
      entityId,
      changes,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });
  }
}
