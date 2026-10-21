import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ApprovalDecisionAction,
  AuditAction,
  AuditEntityType,
  LoanScheduleStatus,
  LoanStatus,
  Permission,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
} from '../../approvals/approvals.service';
import { ACTION_EMPLOYEE_LOAN } from '../../approvals/default-chains';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { webRoutes } from '../../common/web-routes';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import type { CreateLoanDto, ListLoansQueryDto } from './dto/create-loan.dto';
import { generateSchedule, nextPeriod, periodOf } from './loan-schedule';
import { assertNotMakerOrPayee } from '../maker-checker';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Employee loans and their EMI schedules (005 US7).
 *
 * The schedule is generated once, at approval, rather than derived on every read:
 * the payroll engine deducts against specific schedule entries and marks them paid,
 * so the schedule is a ledger, not a projection.
 */
@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * Records a loan in `pending` and builds its schedule.
   *
   * Created pending rather than active so the schedule can be reviewed before any
   * payroll run picks up its first instalment — the engine only deducts against
   * `active` loans.
   */
  async create(caller: Caller, companyId: string, dto: CreateLoanDto) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: dto.employeeId, companyId },
        select: {
          id: true,
          isActive: true,
          userId: true,
          firstName: true,
          lastName: true,
        },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.isActive) {
      throw new BadRequestException(
        'A loan cannot be advanced to an inactive employee.',
      );
    }
    if (dto.emiAmount > dto.amount) {
      throw new BadRequestException(
        'The EMI cannot exceed the loan amount — it would recover more than was advanced.',
      );
    }

    const disbursedOn = new Date(`${dto.disbursementDate}T00:00:00.000Z`);
    // Recovery starts the month after disbursement unless told otherwise:
    // deducting in the same month takes part of the advance back before the
    // employee has had the use of it.
    const firstPeriod =
      dto.firstRecoveryPeriod ?? nextPeriod(periodOf(disbursedOn));

    let schedule;
    try {
      schedule = generateSchedule(dto.amount, dto.emiAmount, firstPeriod);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const loan = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.create({
        data: {
          companyId,
          employeeId: dto.employeeId,
          amount: dto.amount,
          emiAmount: dto.emiAmount,
          disbursementDate: disbursedOn,
          reason: dto.reason.trim(),
          remarks: dto.remarks?.trim() ?? null,
          status: LoanStatus.pending,
          // 036 F19: the maker, so the checker can be required to be somebody else.
          createdByUserId: caller.userId,
          schedule: {
            create: schedule.map((e) => ({
              month: e.month,
              emiAmount: e.emiAmount,
              principal: e.principal,
              interest: e.interest,
              remainingBalance: e.remainingBalance,
              status: LoanScheduleStatus.upcoming,
            })),
          },
        },
        include: { schedule: { orderBy: { month: 'asc' } } },
      }),
    );

    // Into its approval chain (2026-10-20); undone if the company has none, rather than left
    // pending where nobody could ever approve it.
    try {
      await this.submitForApproval(loan, employee, caller.userId);
    } catch (error) {
      await withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.loan.delete({ where: { id: loan.id } }),
      );
      throw error;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.LOAN,
      action: AuditAction.CREATE,
      entityId: loan.id,
      changes: {
        amount: dto.amount,
        emiAmount: dto.emiAmount,
        instalments: schedule.length,
      },
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toView(loan);
  }

  /**
   * Approves a pending loan so payroll begins recovering it — a decision on the loan's approval
   * chain (2026-10-20). The loan becomes active on the chain's final approval; until then it
   * stays pending and nothing is deducted.
   *
   * Separate from creation because generation and approval are different acts by
   * potentially different people, and the engine must not start deducting from
   * someone's salary on the strength of an unreviewed record.
   */
  async approve(caller: Caller, loanId: string, user: AuthenticatedUser) {
    return this.decideOnChain(
      caller,
      loanId,
      ApprovalDecisionAction.approve,
      null,
      user,
    );
  }

  /** Rejects a pending loan (2026-10-20): it is never activated or deducted. */
  async reject(
    caller: Caller,
    loanId: string,
    reason: string,
    user: AuthenticatedUser,
  ) {
    if (!reason.trim()) {
      throw new BadRequestException('A reason is required to reject a loan.');
    }
    return this.decideOnChain(
      caller,
      loanId,
      ApprovalDecisionAction.reject,
      reason,
      user,
    );
  }

  private async decideOnChain(
    caller: Caller,
    loanId: string,
    action: ApprovalDecisionAction,
    reason: string | null,
    user: AuthenticatedUser,
  ) {
    const loan = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.findFirst({ where: { id: loanId } }),
    );
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.pending) {
      throw new ConflictException(`A ${loan.status} loan cannot be decided.`);
    }
    // 036 F19 (decision 4: block, no override). Not the person who recorded the loan, and not the
    // employee it is for. Also refused by the spine for loans recorded since 2026-10-20.
    await assertNotMakerOrPayee(this.prisma, caller, {
      createdByUserId: loan.createdByUserId,
      employeeId: loan.employeeId,
      noun: 'loan',
    });
    await this.ensureInChain(loan);

    const view = await this.approvals.decideByEntity(
      ACTION_EMPLOYEE_LOAN,
      loanId,
      { action, reason },
      user,
      caller.ipAddress,
    );
    if (view.state === 'approved' || view.state === 'rejected') {
      await this.applyOutcome(loanId, view.state, caller.userId, reason);
    }
    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.findFirstOrThrow({
        where: { id: loanId },
        include: { schedule: { orderBy: { month: 'asc' } } },
      }),
    );
    return this.toView(updated);
  }

  /** The chain approved the loan at its last level (2026-10-20). */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_EMPLOYEE_LOAN) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'approved');
  }

  /** The chain rejected it, at any level. */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_EMPLOYEE_LOAN) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'rejected');
  }

  /** Logs rather than throws: the decision is already committed in the spine. */
  private async onChainOutcome(
    loanId: string,
    companyId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      const state = await this.approvals.stateOfSystem(
        ACTION_EMPLOYEE_LOAN,
        loanId,
        companyId,
      );
      const latest = state?.latestDecision;
      await this.applyOutcome(
        loanId,
        outcome,
        latest?.actorUserId ?? null,
        latest?.reason ?? null,
      );
    } catch (error) {
      this.logger.error(
        `Could not apply the ${outcome} chain outcome to loan ${loanId}`,
        error as Error,
      );
    }
  }

  /**
   * The final decision, written once: conditional on still pending, so the loan screen's own
   * decide and the spine's event — both of which arrive for a decision taken there — activate it
   * once between them (036 F19's race guard, kept).
   */
  private async applyOutcome(
    loanId: string,
    outcome: 'approved' | 'rejected',
    deciderUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    const to = outcome === 'approved' ? LoanStatus.active : LoanStatus.rejected;
    const { moved, companyId } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const result = await tx.loan.updateMany({
          where: { id: loanId, status: LoanStatus.pending },
          data: {
            status: to,
            ...(outcome === 'approved'
              ? { approvedByUserId: deciderUserId }
              : {}),
          },
        });
        const loan = await tx.loan.findFirst({
          where: { id: loanId },
          select: { companyId: true },
        });
        return { moved: result.count === 1, companyId: loan?.companyId };
      },
    );
    if (!moved || !companyId) return;
    await this.auditLog.record({
      entityType: AuditEntityType.LOAN,
      action: AuditAction.UPDATE,
      entityId: loanId,
      changes: {
        from: LoanStatus.pending,
        to,
        ...(reason ? { reason } : {}),
      },
      accountId: deciderUserId ?? undefined,
      companyId,
      ipAddress: '',
    });
  }

  private async submitForApproval(
    loan: { id: string; companyId: string; amount: Prisma.Decimal | number },
    employee: {
      userId: string | null;
      firstName: string;
      lastName: string | null;
    },
    makerUserId: string | null,
  ): Promise<void> {
    const name = `${employee.firstName} ${employee.lastName ?? ''}`.trim();
    const amount = Number(loan.amount).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
    });
    await this.approvals.submit({
      companyId: loan.companyId,
      actionType: ACTION_EMPLOYEE_LOAN,
      entityType: ACTION_EMPLOYEE_LOAN,
      entityId: loan.id,
      originatorUserId: makerUserId,
      subject: `${name} — loan of ${amount}`,
      href: webRoutes.hrLoans(),
      viewPermission: Permission.LOANS,
      // 036 F19: neither the maker nor the employee being lent to.
      excludedUserIds: [makerUserId, employee.userId],
    });
  }

  /** A loan recorded before loans joined the spine is put into its chain when first decided. */
  private async ensureInChain(loan: {
    id: string;
    companyId: string;
    employeeId: string;
    amount: Prisma.Decimal;
    createdByUserId: string | null;
  }): Promise<boolean> {
    const state = await this.approvals.stateOfSystem(
      ACTION_EMPLOYEE_LOAN,
      loan.id,
      loan.companyId,
    );
    if (state) return false;
    const employee = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId: loan.companyId },
      (tx) =>
        tx.employee.findFirst({
          where: { id: loan.employeeId },
          select: { userId: true, firstName: true, lastName: true },
        }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    await this.submitForApproval(loan, employee, loan.createdByUserId);
    return true;
  }

  /**
   * Puts every pending loan with no approval chain into one (2026-10-20) — those raised before
   * loans joined the spine, so they reach the Approvals queue rather than waiting for somebody to
   * open the module screen. Idempotent; run by `npm run backfill:approvals`. Returns how many it
   * submitted.
   */
  async backfillApprovals(): Promise<number> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) => tx.loan.findMany({ where: { status: LoanStatus.pending } }),
    );
    let submitted = 0;
    for (const loan of rows) {
      if (await this.ensureInChain(loan)) submitted += 1;
    }
    return submitted;
  }

  /**
   * Closes a loan early — a lump-sum settlement outside payroll.
   *
   * Remaining schedule entries are dropped rather than marked paid: they were
   * never recovered through payroll, and marking them paid would make the challan
   * and register figures claim deductions that never happened.
   */
  async close(caller: Caller, loanId: string, reason: string) {
    const loan = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.findFirst({ where: { id: loanId } }),
    );
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status === LoanStatus.closed) {
      throw new ConflictException('That loan is already closed.');
    }
    // A pending loan closed before it was decided leaves nothing for its approvers (2026-10-20).
    if (loan.status === LoanStatus.pending) {
      await this.approvals.abandon(
        ACTION_EMPLOYEE_LOAN,
        loan.id,
        loan.companyId,
        'Closed before it was approved.',
      );
    }

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      await tx.loanScheduleEntry.deleteMany({
        where: { loanId, status: { not: LoanScheduleStatus.paid } },
      });
      await tx.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.closed,
          remarks: reason
            ? `${
                loan.remarks ? `${loan.remarks}\n` : ''
              }Closed early: ${reason}`
            : loan.remarks,
        },
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.LOAN,
      action: AuditAction.UPDATE,
      entityId: loanId,
      changes: { closedEarly: true, reason },
      accountId: caller.userId,
      companyId: loan.companyId,
      ipAddress: caller.ipAddress,
    });

    return { loanId, status: LoanStatus.closed };
  }

  async list(caller: Caller, companyId: string, query: ListLoansQueryDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);

    const where: Prisma.LoanWhereInput = {
      companyId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) =>
        Promise.all([
          tx.loan.findMany({
            where,
            include: { schedule: { orderBy: { month: 'asc' } } },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.loan.count({ where }),
        ]),
    );

    return { items: items.map((l) => this.toView(l)), total, page, pageSize };
  }

  async getOne(caller: Caller, loanId: string) {
    const loan = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.findFirst({
        where: { id: loanId },
        include: { schedule: { orderBy: { month: 'asc' } } },
      }),
    );
    if (!loan) throw new NotFoundException('Loan not found');
    return this.toView(loan);
  }

  /**
   * What active loans still owe, per company (Group Dashboard, 2026-10-15).
   *
   * The same arithmetic `toView` gives the Loans screen — amount less the instalments
   * marked paid, never below zero — summed per company, so the dashboard and the screen
   * agree loan by loan. One statement for every company: only paid instalments are
   * joined, and only their EMI is selected.
   */
  async outstandingByCompany(
    rls: RlsContext,
    companyIds: string[],
  ): Promise<Map<string, { outstanding: number; count: number }>> {
    const result = new Map<string, { outstanding: number; count: number }>();
    if (companyIds.length === 0) return result;
    const loans = await withRlsContext(this.prisma, rls, (tx) =>
      tx.loan.findMany({
        where: { companyId: { in: companyIds }, status: LoanStatus.active },
        select: {
          companyId: true,
          amount: true,
          schedule: {
            where: { status: LoanScheduleStatus.paid },
            select: { emiAmount: true },
          },
        },
      }),
    );
    for (const loan of loans) {
      const recovered = loan.schedule.reduce(
        (a, e) => a + e.emiAmount.toNumber(),
        0,
      );
      const owed = Math.max(loan.amount.toNumber() - r2(recovered), 0);
      const entry = result.get(loan.companyId) ?? { outstanding: 0, count: 0 };
      entry.outstanding = r2(entry.outstanding + owed);
      entry.count += 1;
      result.set(loan.companyId, entry);
    }
    return result;
  }

  /** Adds the recovered/outstanding totals the Loans screen shows per row. */
  private toView(loan: {
    id: string;
    employeeId: string;
    amount: Prisma.Decimal;
    emiAmount: Prisma.Decimal;
    disbursementDate: Date;
    reason: string;
    remarks: string | null;
    status: LoanStatus;
    createdByUserId?: string | null;
    schedule: {
      month: string;
      emiAmount: Prisma.Decimal;
      status: LoanScheduleStatus;
      paidInPayrollRunId: string | null;
    }[];
  }) {
    const recovered = r2(
      loan.schedule
        .filter((e) => e.status === LoanScheduleStatus.paid)
        .reduce((a, e) => a + e.emiAmount.toNumber(), 0),
    );
    const amount = loan.amount.toNumber();
    return {
      id: loan.id,
      employeeId: loan.employeeId,
      amount,
      emiAmount: loan.emiAmount.toNumber(),
      disbursementDate: loan.disbursementDate.toISOString().slice(0, 10),
      reason: loan.reason,
      remarks: loan.remarks,
      status: loan.status,
      // 036 F19: so the screen can say "someone else must approve this" before the 403 does.
      createdByUserId: loan.createdByUserId ?? null,
      totalRecovered: recovered,
      outstanding: r2(Math.max(amount - recovered, 0)),
      instalments: loan.schedule.length,
      schedule: loan.schedule.map((e) => ({
        month: e.month,
        emiAmount: e.emiAmount.toNumber(),
        status: e.status,
        paidInPayrollRunId: e.paidInPayrollRunId,
      })),
    };
  }
}
