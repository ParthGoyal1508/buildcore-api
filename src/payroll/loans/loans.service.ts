import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LoanScheduleStatus,
  LoanStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import type { CreateLoanDto, ListLoansQueryDto } from './dto/create-loan.dto';
import { generateSchedule, nextPeriod, periodOf } from './loan-schedule';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
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
        select: { id: true, isActive: true },
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
   * Approves a pending loan so payroll begins recovering it.
   *
   * Separate from creation because generation and approval are different acts by
   * potentially different people, and the engine must not start deducting from
   * someone's salary on the strength of an unreviewed record.
   */
  async approve(caller: Caller, loanId: string) {
    const loan = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.findFirst({ where: { id: loanId } }),
    );
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.pending) {
      throw new ConflictException(`A ${loan.status} loan cannot be approved.`);
    }

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.active, approvedByUserId: caller.userId },
        include: { schedule: { orderBy: { month: 'asc' } } },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOAN,
      action: AuditAction.UPDATE,
      entityId: loanId,
      changes: { from: LoanStatus.pending, to: LoanStatus.active },
      accountId: caller.userId,
      companyId: loan.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toView(updated);
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

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      await tx.loanScheduleEntry.deleteMany({
        where: { loanId, status: { not: LoanScheduleStatus.paid } },
      });
      await tx.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.closed,
          remarks: reason
            ? `${loan.remarks ? `${loan.remarks}\n` : ''}Closed early: ${reason}`
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
