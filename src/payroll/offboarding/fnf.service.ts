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
  LeaveTypeCode,
  LoanScheduleStatus,
  LoanStatus,
  PayrollRunStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { SalaryAdvancesService } from '../advances/salary-advances.service';
import { computePayrollLine } from '../engine/payroll-computation';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface FnfComputation {
  employeeId: string;
  lastWorkingDay: string;
  period: string;
  /** Salary earned up to and including the last working day. */
  pendingSalary: number;
  /** Earned-leave balance × daily rate. */
  leaveEncashment: {
    balanceDays: number;
    dailyRate: number;
    amount: number;
  };
  /** Outstanding principal across every active loan. */
  loanRecovery: number;
  /** Outstanding salary advances, recovered in full at exit (FR-056). */
  advanceRecovery: number;
  statutoryDeductions: number;
  netPayable: number;
  /** Anything the caller should see before processing an irreversible run. */
  warnings: string[];
}

/**
 * Full & Final settlement (005 US11, FR-032/FR-033).
 *
 * Computed on demand and only persisted when processed, because an F&F is
 * reviewed and negotiated before it is paid — storing a draft settlement would
 * create a figure someone could act on before it was agreed.
 *
 * Processing it produces a normal `PayrollRun` flagged `isFnf`, so it inherits the
 * whole Draft → Processed → Paid lifecycle and its immutability rules rather than
 * getting a parallel one (FR-033).
 */
@Injectable()
export class FnfService {
  private readonly hrPayroll: HrPayrollConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly advances: SalaryAdvancesService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  /** Computes the settlement without writing anything. */
  async compute(caller: Caller, employeeId: string): Promise<FnfComputation> {
    const { employee, exit } = await this.requireExit(caller, employeeId);
    const lastWorkingDay = exit.lastWorkingDay;
    const period = `${lastWorkingDay.getUTCFullYear()}-${String(
      lastWorkingDay.getUTCMonth() + 1,
    ).padStart(2, '0')}`;

    const warnings: string[] = [];

    // ── Pending salary, pro-rated to the last working day ────────────────────
    const monthDays = new Date(
      Date.UTC(
        lastWorkingDay.getUTCFullYear(),
        lastWorkingDay.getUTCMonth() + 1,
        0,
      ),
    ).getUTCDate();
    const payableDays = lastWorkingDay.getUTCDate();

    const rates = await this.companies.getPayrollRates(employee.companyId);
    const n = (d: Prisma.Decimal | null) => (d ? d.toNumber() : 0);

    const figures = computePayrollLine(
      {
        employeeId: employee.id,
        projectId: null,
        basic: n(employee.basic),
        hra: n(employee.hra),
        conveyanceAllowance: n(employee.conveyanceAllowance),
        siteAllowance: n(employee.siteAllowance),
        specialAllowance: n(employee.specialAllowance),
        pfApplicable: employee.pfApplicable,
        pfUpperLimit: employee.pfUpperLimit,
        esicApplicable: employee.esicApplicable,
        esicUpperLimit: employee.esicUpperLimit,
        hoursPerDay:
          n(employee.hoursPerDay) || this.hrPayroll.standardHoursPerDay,
        // Loans are recovered in full below as a lump sum, not as this month's
        // EMI — an exiting employee does not get to keep the balance.
        loanEmiDeduction: 0,
        tds: 0,
      },
      {
        monthDays,
        payableDays,
        lopDays: monthDays - payableDays,
        otHours: 0,
      },
      {
        pfEmployerRatePercent: rates.pfEmployerRate,
        esicEmployerRatePercent: rates.esicEmployerRate,
        gratuityRatePercent: rates.gratuityRate,
        bonusRatePercent: rates.bonusRate,
        otMultiplier: rates.otMultiplier,
      },
      this.hrPayroll.statutory,
    );

    // ── Earned-leave encashment ─────────────────────────────────────────────
    // The daily rate is derived from the full monthly gross, not the pro-rated
    // one: a day of accrued leave is worth a normal day's pay, regardless of
    // which month the employee happens to leave in.
    const fullMonthlyGross = r2(
      n(employee.basic) +
        n(employee.hra) +
        n(employee.conveyanceAllowance) +
        n(employee.siteAllowance) +
        n(employee.specialAllowance),
    );
    const dailyRate = monthDays > 0 ? r2(fullMonthlyGross / monthDays) : 0;

    const elBalance = await this.earnedLeaveBalance(caller, employee.id);
    const leaveEncashment = {
      balanceDays: elBalance,
      dailyRate,
      amount: r2(elBalance * dailyRate),
    };

    // ── Loan recovery ───────────────────────────────────────────────────────
    const loanRecovery = await this.outstandingLoanPrincipal(
      caller,
      employee.id,
    );
    // An exiting employee does not keep an outstanding advance either — it is
    // recovered here rather than left against a payroll run that will never come.
    const advanceRecovery = await this.advances.outstandingFor(
      caller,
      employee.id,
    );
    if (advanceRecovery > 0) {
      warnings.push(
        `Outstanding salary advance of ${advanceRecovery} will be recovered in full from this settlement.`,
      );
    }
    if (loanRecovery > 0) {
      warnings.push(
        `Outstanding loan principal of ${loanRecovery} will be recovered in full from this settlement.`,
      );
    }

    const statutoryDeductions = r2(
      figures.employeePf + figures.employeeEsic + figures.professionalTax,
    );

    const netPayable = r2(
      figures.gross +
        leaveEncashment.amount -
        statutoryDeductions -
        loanRecovery -
        advanceRecovery,
    );
    if (netPayable < 0) {
      warnings.push(
        'The settlement is negative — recoveries exceed what is owed. This must be collected separately; payroll will not pay a negative amount.',
      );
    }

    return {
      employeeId: employee.id,
      lastWorkingDay: lastWorkingDay.toISOString().slice(0, 10),
      period,
      pendingSalary: figures.gross,
      leaveEncashment,
      loanRecovery,
      advanceRecovery,
      statutoryDeductions,
      netPayable,
      warnings,
    };
  }

  /**
   * Persists the settlement as an F&F-flagged payroll run in Draft.
   *
   * Left in Draft rather than processed automatically: the run then goes through
   * the same review the monthly payroll does, and processing it is what triggers
   * the employee deactivation (FR-034) — an irreversible step that should be an
   * explicit act.
   */
  async process(caller: Caller, employeeId: string, periodOverride?: string) {
    const { employee, exit } = await this.requireExit(caller, employeeId);
    if (exit.fnfPayrollRunId) {
      throw new ConflictException(
        'This exit already has an F&F run; it cannot be settled twice.',
      );
    }

    const computed = await this.compute(caller, employeeId);
    const period = periodOverride ?? computed.period;

    const run = await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          companyId: employee.companyId,
          period,
          isFnf: true,
          status: PayrollRunStatus.draft,
          generatedAt: new Date(),
          generatedByUserId: caller.userId,
        },
      });

      await tx.payrollLineItem.create({
        data: {
          payrollRunId: created.id,
          employeeId,
          monthDays: 0,
          payableDays: 0,
          lopDays: 0,
          otHours: 0,
          otWages: 0,
          // The settlement's components are folded into the line the same way a
          // monthly run's are, so every downstream reader (challans, register,
          // bank sheet) handles an F&F run without special-casing it.
          basic: computed.pendingSalary,
          hra: 0,
          conveyanceAllowance: 0,
          siteAllowance: 0,
          specialAllowance: computed.leaveEncashment.amount,
          employeePf: 0,
          employeeEsic: 0,
          professionalTax: computed.statutoryDeductions,
          tds: 0,
          loanEmiDeduction: r2(
            computed.loanRecovery + computed.advanceRecovery,
          ),
          netPay: Math.max(computed.netPayable, 0),
          employerPf: 0,
          employerEps: 0,
          employerEdli: 0,
          adminCharges: 0,
          employerEsic: 0,
          gratuity: 0,
          bonus: 0,
        },
      });

      await tx.exitRecord.update({
        where: { id: exit.id },
        data: { fnfPayrollRunId: created.id },
      });

      // Closed here rather than waiting for the run to be processed: the
      // settlement recovers the whole outstanding principal, so the schedule has
      // nothing left to collect and leaving it open would double-recover if the
      // employee were ever reactivated.
      await tx.loanScheduleEntry.deleteMany({
        where: {
          status: { not: LoanScheduleStatus.paid },
          loan: { employeeId, status: LoanStatus.active },
        },
      });
      await tx.loan.updateMany({
        where: { employeeId, status: LoanStatus.active },
        data: { status: LoanStatus.closed },
      });

      await tx.salaryAdvance.updateMany({
        where: { employeeId, status: { not: 'closed' } },
        data: { outstandingBalance: 0, status: 'closed' },
      });

      return created;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.PAYROLL_RUN,
      action: AuditAction.CREATE,
      entityId: run.id,
      changes: {
        isFnf: true,
        employeeId,
        netPayable: computed.netPayable,
      },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      runId: run.id,
      period,
      status: run.status,
      settlement: computed,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireExit(caller: Caller, employeeId: string) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    const exit = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.exitRecord.findFirst({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!exit) {
      throw new BadRequestException(
        'No exit has been initiated for that employee.',
      );
    }
    return { employee, exit };
  }

  /** Current-year earned-leave balance: opening + accrued − used. */
  private async earnedLeaveBalance(
    caller: Caller,
    employeeId: string,
  ): Promise<number> {
    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveBalance.findMany({
        where: { employeeId, leaveType: LeaveTypeCode.earned },
        orderBy: { financialYear: 'desc' },
        take: 1,
      }),
    );
    if (rows.length === 0) return 0;
    const b = rows[0];
    return r2(
      Math.max(
        b.opening.toNumber() + b.accrued.toNumber() - b.used.toNumber(),
        0,
      ),
    );
  }

  /** What is still owed across every active loan. */
  private async outstandingLoanPrincipal(
    caller: Caller,
    employeeId: string,
  ): Promise<number> {
    const entries = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loanScheduleEntry.findMany({
        where: {
          status: { not: LoanScheduleStatus.paid },
          loan: { employeeId, status: LoanStatus.active },
        },
        select: { emiAmount: true },
      }),
    );
    return r2(entries.reduce((a, e) => a + e.emiAmount.toNumber(), 0));
  }
}
