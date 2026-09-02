import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  SalaryAdvanceStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
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
          status: { not: SalaryAdvanceStatus.closed },
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
        },
      }),
    );

    await this.audit(caller, companyId, advance.id, AuditAction.CREATE, {
      amount: dto.amount,
      recoveryMonth: dto.recoveryMonth,
      exceedsLimit,
    });

    return this.toView(advance, exceedsLimit ? limit : null);
  }

  /** Approves and disburses in one step — the money leaves when it is approved. */
  async approve(caller: Caller, advanceId: string) {
    const advance = await this.require(caller, advanceId);
    if (advance.status !== SalaryAdvanceStatus.pending) {
      throw new ConflictException(
        `A ${advance.status} advance cannot be approved.`,
      );
    }

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salaryAdvance.update({
        where: { id: advanceId },
        data: {
          status: SalaryAdvanceStatus.disbursed,
          approvedByUserId: caller.userId,
          disbursedOn: new Date(),
        },
      }),
    );

    await this.audit(
      caller,
      caller.companyId ?? '',
      advanceId,
      AuditAction.UPDATE,
      { approved: true },
    );
    return this.toView(updated, null);
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
