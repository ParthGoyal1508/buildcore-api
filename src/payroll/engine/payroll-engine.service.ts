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
  LoanScheduleStatus,
  LoanStatus,
  Prisma,
  PayrollRunStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { AttendanceHistoryService } from '../../hr/punch/attendance-history.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { ReimbursementsAdminService } from '../reimbursements-admin/reimbursements-admin.service';
import { SalaryAdvancesService } from '../advances/salary-advances.service';
import { TdsService } from '../tds/tds.service';
import {
  computePayrollLine,
  type AttendanceInput,
  type CompanyPayrollRates,
  type EmployeePayrollInput,
} from './payroll-computation';

/** `YYYY-MM`. */
const PERIOD = /^(\d{4})-(\d{2})$/;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Payroll generation and the run lifecycle (005 US5).
 *
 * Generation runs in a single transaction so a partially-computed run is never
 * visible: a payroll half-written is worse than one not written at all, because
 * someone will read it.
 *
 * The arithmetic itself lives in `payroll-computation.ts` as pure functions. This
 * service only gathers inputs and persists results — which is what makes the
 * highest-stakes numbers in the codebase testable without a database.
 */
@Injectable()
export class PayrollEngineService {
  private readonly hrPayroll: HrPayrollConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly attendance: AttendanceHistoryService,
    private readonly reimbursements: ReimbursementsAdminService,
    private readonly tds: TdsService,
    private readonly advances: SalaryAdvancesService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  /**
   * Computes and persists a Draft run for a company and period.
   *
   * Regenerating a Draft replaces its line items — an admin correcting attendance
   * and re-running is the normal path. A Processed or Paid run is immutable and
   * refuses (FR-015).
   */
  async generate(caller: Caller, companyId: string, period: string) {
    const { year, month } = this.parsePeriod(period);

    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { companyId, period, isFnf: false },
      }),
    );
    if (existing && existing.status !== PayrollRunStatus.draft) {
      throw new ConflictException(
        `Payroll for ${period} is already ${existing.status} and cannot be regenerated.`,
      );
    }

    const company = await this.companies.getPayrollRates(companyId);
    const rates: CompanyPayrollRates = {
      pfEmployerRatePercent: company.pfEmployerRate,
      esicEmployerRatePercent: company.esicEmployerRate,
      gratuityRatePercent: company.gratuityRate,
      bonusRatePercent: company.bonusRate,
      otMultiplier: company.otMultiplier,
    };

    // Only employees active as of the period are paid (FR-018). Read outside the
    // write transaction because attendance resolution below issues its own
    // queries per employee; holding a write transaction open across all of them
    // would lock the run for the duration of the whole computation.
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { companyId, isActive: true },
        orderBy: { employeeCode: 'asc' },
      }),
    );

    const lines: (Prisma.PayrollLineItemCreateManyInput & {
      employeeId: string;
    })[] = [];
    // Claim ids folded into this run, settled when it is processed (FR-038).
    const settledClaimIds: string[] = [];
    // Advance recoveries actually applied, so the balance is reduced by what was
    // recovered rather than what was owed (FR-055).
    const advanceRecoveries: { advanceId: string; amount: number }[] = [];
    // Employees the run could not tax correctly — surfaced instead of silently
    // deducting zero (FR-053).
    const exceptions: { employeeId: string; reason: string }[] = [];

    for (const employee of employees) {
      const attendance = await this.attendanceFor(caller, employee, month, year);
      const loanEmi = await this.currentCycleEmi(caller, employee.id, period);
      // Approved claims the admin chose to settle through payroll rather than
      // directly. Rejected, draft and withdrawn claims can never appear here
      // (FR-040) — the query that finds them cannot return one.
      const reimbursement =
        await this.reimbursements.pendingPayrollReimbursements(
          caller,
          employee.id,
        );
      settledClaimIds.push(...reimbursement.claimIds);

      // Gross for TDS purposes, before deductions — computed from the salary
      // structure scaled by attendance, which is what the engine derives below.
      const provisionalGross = this.provisionalGross(employee, attendance);
      const tdsResult = await this.tds.computeForEmployee(
        caller,
        employee,
        period,
        provisionalGross,
      );
      if (tdsResult.slabsMissing) {
        exceptions.push({
          employeeId: employee.id,
          reason: `No tax slabs configured for this financial year; TDS was not deducted.`,
        });
      }
      if (tdsResult.noPanRateApplied) {
        exceptions.push({
          employeeId: employee.id,
          reason: 'No PAN on file — the penal no-PAN rate was applied.',
        });
      }

      const advanceDue = await this.advances.recoveryDue(
        caller,
        employee.id,
        period,
      );

      const input: EmployeePayrollInput = {
        employeeId: employee.id,
        // Null for head-office staff; 008's P&L reads this to attribute labour
        // cost to a project (FR-046).
        projectId: null,
        basic: this.num(employee.basic),
        hra: this.num(employee.hra),
        conveyanceAllowance: this.num(employee.conveyanceAllowance),
        siteAllowance: this.num(employee.siteAllowance),
        specialAllowance: this.num(employee.specialAllowance),
        pfApplicable: employee.pfApplicable,
        pfUpperLimit: employee.pfUpperLimit,
        esicApplicable: employee.esicApplicable,
        esicUpperLimit: employee.esicUpperLimit,
        hoursPerDay:
          this.num(employee.hoursPerDay) || this.hrPayroll.standardHoursPerDay,
        loanEmiDeduction: loanEmi,
        tds: tdsResult.tds,
      };

      const figures = computePayrollLine(
        input,
        attendance,
        rates,
        this.hrPayroll.statutory,
      );

      // Advance recovery is applied last, against whatever net pay survives the
      // statutory deductions, TDS and the loan EMI. The order is documented in
      // FR-055 and matters: statutory dues are not negotiable, a loan EMI is a
      // contracted schedule, and an advance is the one recovery that can wait.
      const recoverable = Math.min(advanceDue.amount, figures.netPay);
      const advanceRecovered = recoverable > 0 ? r2(recoverable) : 0;
      if (advanceDue.advanceId && advanceRecovered > 0) {
        advanceRecoveries.push({
          advanceId: advanceDue.advanceId,
          amount: advanceRecovered,
        });
      }

      lines.push({
        payrollRunId: '',
        employeeId: employee.id,
        projectId: input.projectId,
        monthDays: figures.monthDays,
        payableDays: figures.payableDays,
        lopDays: figures.lopDays,
        otHours: figures.otHours,
        otWages: figures.otWages,
        basic: figures.basic,
        hra: figures.hra,
        conveyanceAllowance: figures.conveyanceAllowance,
        siteAllowance: figures.siteAllowance,
        // Reimbursements ride in special allowance: they are a payment to the
        // employee that is not salary, and they must not enter the PF/ESIC/PT
        // bases — which is why they are added here, after those were computed
        // from the salary structure, rather than passed into the engine.
        specialAllowance: r2(
          figures.specialAllowance + reimbursement.total,
        ),
        employeePf: figures.employeePf,
        employeeEsic: figures.employeeEsic,
        professionalTax: figures.professionalTax,
        tds: figures.tds,
        loanEmiDeduction: figures.loanEmiDeduction,
        netPay: r2(figures.netPay + reimbursement.total - advanceRecovered),
        employerPf: figures.employerPf,
        employerEps: figures.employerEps,
        employerEdli: figures.employerEdli,
        adminCharges: figures.adminCharges,
        employerEsic: figures.employerEsic,
        gratuity: figures.gratuity,
        bonus: figures.bonus,
      });
    }

    const run = await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const created = existing
        ? await tx.payrollRun.update({
            where: { id: existing.id },
            data: {
              generatedAt: new Date(),
              generatedByUserId: caller.userId,
            },
          })
        : await tx.payrollRun.create({
            data: {
              companyId,
              period,
              isFnf: false,
              status: PayrollRunStatus.draft,
              generatedAt: new Date(),
              generatedByUserId: caller.userId,
            },
          });

      // Replace rather than merge: a regeneration is a fresh answer to the same
      // question, and leaving a stale line for an employee who has since been
      // deactivated would quietly pay them.
      await tx.payrollLineItem.deleteMany({ where: { payrollRunId: created.id } });
      if (lines.length > 0) {
        await tx.payrollLineItem.createMany({
          data: lines.map((l) => ({ ...l, payrollRunId: created.id })),
        });
      }
      // Applied here, in the same transaction that writes the lines, so the
      // balance can never disagree with the deduction that reduced it.
      for (const rec of advanceRecoveries) {
        await this.advances.applyRecovery(tx, rec.advanceId, rec.amount);
      }

      return created;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.PAYROLL_RUN,
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: run.id,
      changes: { period, employeeCount: lines.length },
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      runId: run.id,
      period,
      status: run.status,
      lineCount: lines.length,
      // Surfaced on the run rather than buried: an admin about to process payroll
      // needs to see who could not be taxed correctly.
      exceptions,
      advanceRecoveries,
    };
  }

  /**
   * Advances a run's status.
   *
   * Draft → Processed freezes the figures (FR-015) and settles the loan schedule
   * entries the run deducted. Processed → Paid records disbursement. Neither
   * transition is reversible, and no other pair is permitted.
   */
  async setStatus(
    caller: Caller,
    runId: string,
    target: PayrollRunStatus,
  ) {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({ where: { id: runId } }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');

    const allowed: Record<PayrollRunStatus, PayrollRunStatus[]> = {
      draft: [PayrollRunStatus.processed],
      processed: [PayrollRunStatus.paid],
      paid: [],
    };
    if (!allowed[run.status].includes(target)) {
      throw new ConflictException(
        `A ${run.status} run cannot become ${target}.`,
      );
    }

    const updated = await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const next = await tx.payrollRun.update({
        where: { id: runId },
        data: {
          status: target,
          ...(target === PayrollRunStatus.processed
            ? { processedAt: new Date() }
            : { paidAt: new Date() }),
        },
      });

      if (target === PayrollRunStatus.processed) {
        await this.settleLoanSchedule(tx, runId, run.period);
        await this.materialiseSalarySlips(tx, runId, run.period);
        await this.settleReimbursements(tx, runId);
      }
      return next;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.PAYROLL_RUN,
      action: AuditAction.UPDATE,
      entityId: runId,
      changes: { from: run.status, to: target },
      accountId: caller.userId,
      companyId: run.companyId,
      ipAddress: caller.ipAddress,
    });

    return { runId, status: updated.status };
  }

  /**
   * Rejects any write against a run whose figures are frozen (FR-015).
   *
   * Called by every path that would touch a line item. Enforced here rather than
   * left to the UI because "processed payroll is immutable" is an integrity
   * guarantee, and a guarantee that only the client enforces is not one.
   */
  async assertRunMutable(caller: Caller, runId: string): Promise<void> {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        select: { status: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== PayrollRunStatus.draft) {
      throw new ConflictException(
        `This run is ${run.status}; its figures are immutable (FR-015).`,
      );
    }
  }

  /** Runs for a company, newest period first. */
  async list(caller: Caller, companyId: string) {
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findMany({
        where: { companyId },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  }

  /** One run with its line items. */
  async getRun(caller: Caller, runId: string) {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  /**
   * Resolves a period's attendance into payable days, LOP and overtime.
   *
   * Derived from the same per-day status the employee's own attendance screen
   * shows, via `AttendanceHistoryService` — payroll and the employee must never
   * disagree about whether a day was worked.
   */
  private async attendanceFor(
    caller: Caller,
    employee: { id: string; siteId: string; shiftId: string; companyId: string },
    month: number,
    year: number,
  ): Promise<AttendanceInput> {
    const { days } = await this.attendance.getMonthForEmployee(
      caller,
      employee,
      month,
      year,
    );

    let payableDays = 0;
    let lopDays = 0;
    let otHours = 0;

    for (const day of days) {
      otHours += day.otHours ?? 0;
      switch (day.status) {
        case 'present':
        case 'on_leave':
        case 'holiday':
        case 'weekly_off':
          // Paid days. Approved leave, holidays and weekly offs are paid; only an
          // unexplained absence costs the employee.
          payableDays += 1;
          break;
        case 'absent':
          lopDays += 1;
          break;
      }
    }

    return { monthDays: days.length, payableDays, lopDays, otHours };
  }

  /**
   * This period's EMI across every Active loan.
   *
   * Summed rather than taking the first, because an employee may hold more than
   * one loan and paying only one of them would silently under-recover (FR-014).
   */
  private async currentCycleEmi(
    caller: Caller,
    employeeId: string,
    period: string,
  ): Promise<number> {
    const entries = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.loanScheduleEntry.findMany({
        where: {
          month: period,
          status: { in: [LoanScheduleStatus.upcoming, LoanScheduleStatus.overdue] },
          loan: { employeeId, status: LoanStatus.active },
        },
      }),
    );
    return entries.reduce((sum, e) => sum + this.num(e.emiAmount), 0);
  }

  /**
   * Writes a `SalarySlip` row per line item when a run is processed.
   *
   * This is what supersedes 003's placeholder: that feature already serves
   * `/my/salary` from `payroll.SalarySlip`, but nothing ever populated it — the
   * spec described those figures as "assumed already done". Materialising them
   * here means the employee-facing payslip starts showing real computed numbers
   * without 003's read path changing at all.
   *
   * Written at Processed rather than at Draft because a draft's figures are still
   * expected to move; publishing them to employees mid-review would show numbers
   * that then change.
   */
  private async materialiseSalarySlips(
    tx: Prisma.TransactionClient,
    runId: string,
    period: string,
  ): Promise<void> {
    const lines = await tx.payrollLineItem.findMany({
      where: { payrollRunId: runId },
    });

    for (const l of lines) {
      const data = {
        monthDays: l.monthDays,
        payableDays: l.payableDays,
        lopDays: l.lopDays,
        otHours: l.otHours,
        earningBasic: l.basic,
        earningHra: l.hra,
        earningConveyance: l.conveyanceAllowance,
        earningSiteAllowance: l.siteAllowance,
        earningSpecialAllowance: l.specialAllowance,
        earningOt: l.otWages,
        deductionPf: l.employeePf,
        deductionEsic: l.employeeEsic,
        deductionPt: l.professionalTax,
        deductionTds: l.tds,
        deductionLoanEmi: l.loanEmiDeduction,
        // Salary advances arrive with the 2026-09-01 amendment (US15); until then
        // there is nothing to recover, and zero is the honest value.
        deductionAdvanceRecovery: 0,
        employerPf: l.employerPf,
        employerEps: l.employerEps,
        employerEdli: l.employerEdli,
        employerAdminCharges: l.adminCharges,
        employerGratuity: l.gratuity,
        employerBonus: l.bonus,
        netPay: l.netPay,
      };

      await tx.salarySlip.upsert({
        where: {
          employeeId_period: { employeeId: l.employeeId, period },
        },
        create: { employeeId: l.employeeId, period, ...data },
        update: data,
      });
    }
  }

  /**
   * Marks the schedule entries this run deducted as paid, and closes any loan
   * whose final instalment that was.
   */
  private async settleLoanSchedule(
    tx: Prisma.TransactionClient,
    runId: string,
    period: string,
  ): Promise<void> {
    const entries = await tx.loanScheduleEntry.findMany({
      where: {
        month: period,
        status: { in: [LoanScheduleStatus.upcoming, LoanScheduleStatus.overdue] },
        loan: { status: LoanStatus.active },
      },
      select: { id: true, loanId: true },
    });
    if (entries.length === 0) return;

    await tx.loanScheduleEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { status: LoanScheduleStatus.paid, paidInPayrollRunId: runId },
    });

    // A loan with nothing left outstanding is closed; leaving it Active would
    // keep deducting against a debt already repaid.
    const loanIds = [...new Set(entries.map((e) => e.loanId))];
    for (const loanId of loanIds) {
      const remaining = await tx.loanScheduleEntry.count({
        where: { loanId, status: { not: LoanScheduleStatus.paid } },
      });
      if (remaining === 0) {
        await tx.loan.update({
          where: { id: loanId },
          data: { status: LoanStatus.closed },
        });
      }
    }
  }

  /**
   * Marks payroll-settled reimbursement claims paid once the run carrying them is
   * processed.
   *
   * Deferred to processing rather than done at generation: a draft can be
   * regenerated, and a claim marked paid against a run that was then rebuilt would
   * be paid on paper but not in fact.
   */
  private async settleReimbursements(
    tx: Prisma.TransactionClient,
    runId: string,
  ): Promise<void> {
    const lines = await tx.payrollLineItem.findMany({
      where: { payrollRunId: runId },
      select: { employeeId: true },
    });
    if (lines.length === 0) return;

    await tx.reimbursementClaim.updateMany({
      where: {
        employeeId: { in: lines.map((l) => l.employeeId) },
        status: 'approved',
        paymentMode: 'payroll',
      },
      data: { status: 'paid', paymentReference: `payroll:${runId}` },
    });
  }

  /**
   * Attendance-scaled gross, used only to project TDS.
   *
   * Recomputed here rather than reusing the engine's own figure because TDS has to
   * be known *before* the line is computed — it is one of the deductions that goes
   * into it.
   */
  private provisionalGross(
    employee: {
      basic: Prisma.Decimal | null;
      hra: Prisma.Decimal | null;
      conveyanceAllowance: Prisma.Decimal | null;
      siteAllowance: Prisma.Decimal | null;
      specialAllowance: Prisma.Decimal | null;
    },
    attendance: AttendanceInput,
  ): number {
    const ratio =
      attendance.monthDays > 0
        ? attendance.payableDays / attendance.monthDays
        : 0;
    const total =
      this.num(employee.basic) +
      this.num(employee.hra) +
      this.num(employee.conveyanceAllowance) +
      this.num(employee.siteAllowance) +
      this.num(employee.specialAllowance);
    return r2(total * ratio);
  }

  private parsePeriod(period: string): { year: number; month: number } {
    const m = PERIOD.exec(period);
    if (!m) {
      throw new BadRequestException('period must be YYYY-MM.');
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) {
      throw new BadRequestException('period month must be between 01 and 12.');
    }
    return { year, month };
  }

  /** Prisma Decimal | number | null → number. */
  private num(v: Prisma.Decimal | number | null | undefined): number {
    if (v === null || v === undefined) return 0;
    return typeof v === 'number' ? v : v.toNumber();
  }
}
