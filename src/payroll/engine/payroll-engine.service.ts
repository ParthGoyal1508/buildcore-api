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

import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_PAYROLL_RUN } from '../../approvals/default-chains';
import { AuditLogService } from '../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { AttendanceHistoryService } from '../../hr/punch/attendance-history.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { FuelRecoveryService } from '../../plant/fuel-recovery/fuel-recovery.service';
import { applyDeductionCeiling } from './deduction-ceiling';
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
    // 020 FR-006/FR-007. `plant` owns the recovery; this module reads what is owed and records what
    // it took, through exactly two methods. It must not query `plant`'s schema (Principle I).
    private readonly fuelRecovery: FuelRecoveryService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
    /**
     * 036 F6. `processed → paid` is money having left, so it waits for the run's approval chain —
     * the same gate the bank sheet uses, through the same single implementation.
     */
    private readonly approvals: ApprovalService,
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
    // 020 FR-007a. Read per run rather than per line — it cannot change mid-run, and reading it once
    // means a company lowering it takes effect on the next run with no restart.
    const deductionCeilingPercent =
      await this.companies.getDeductionCeilingPercent(companyId);
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

    /**
     * Fuel recoveries owed by these employees (020 FR-006, FR-007).
     *
     * Read once for the whole run rather than per employee — a per-employee query would be one round
     * trip per payslip. Only `approved` rows come back, which is where FR-006's "no payroll line until
     * approved" is actually enforced: there is no query here that could surface a pending one.
     */
    const fuelDue = await this.fuelRecovery.dueForEmployees(
      companyId,
      employees.map((employee) => employee.id),
    );
    /** What each line takes, so the balance is later reduced by what was recovered, not what was
     * owed — the same distinction FR-055 draws for advances. */
    const fuelRecoveries: {
      employeeId: string;
      recoveryId: string;
      amount: number;
    }[] = [];

    const lines: (Prisma.PayrollLineItemCreateManyInput & {
      employeeId: string;
    })[] = [];
    // Advance recoveries this draft takes, so the balance is reduced by what was
    // recovered rather than what was owed (FR-055) — when the run is processed (036 F1).
    const advanceRecoveries: { advanceId: string; amount: number }[] = [];
    // Employees the run could not tax correctly — surfaced instead of silently
    // deducting zero (FR-053).
    const exceptions: { employeeId: string; reason: string }[] = [];

    for (const employee of employees) {
      const attendance = await this.attendanceFor(
        caller,
        employee,
        month,
        year,
      );
      const loanEmi = await this.currentCycleEmi(caller, employee.id, period);
      // Approved claims the admin chose to settle through payroll rather than
      // directly. Rejected, draft and withdrawn claims can never appear here
      // (FR-040) — the query that finds them cannot return one.
      const reimbursement =
        await this.reimbursements.pendingPayrollReimbursements(
          caller,
          employee.id,
        );

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

      /**
       * Fuel recovery, last of all and under the statutory ceiling (020 FR-007, FR-007a to FR-007c).
       *
       * **Last deliberately, and the ceiling counts everything before it.** Statutory dues are not
       * negotiable, a loan EMI is a contracted schedule, an advance is money the employee asked for —
       * a fuel recovery is the company recovering a loss, and it is the one that should wait. So it
       * takes only the headroom left under half the gross wages once every other deduction is counted.
       *
       * `figures.totalDeductions` already sums PF, ESIC, professional tax, TDS and the loan EMI, so
       * the ceiling sees them as one figure rather than a list this code has to keep in step. A
       * deduction added to the engine later is included automatically, which is the failure mode worth
       * designing against: a missing deduction here would not error, it would silently raise the
       * ceiling.
       */
      let fuelRecovered = 0;
      for (const due of fuelDue.get(employee.id) ?? []) {
        const ceiling = applyDeductionCeiling({
          grossWages: figures.gross,
          existingDeductions: [
            figures.totalDeductions,
            advanceRecovered,
            fuelRecovered,
          ],
          requested: due.balance,
          ceilingPercent: deductionCeilingPercent,
        });
        if (ceiling.applied <= 0) break;
        fuelRecovered = r2(fuelRecovered + ceiling.applied);
        fuelRecoveries.push({
          employeeId: employee.id,
          recoveryId: due.recoveryId,
          amount: ceiling.applied,
        });
      }
      const lineFuelRecoveries = fuelRecoveries
        .filter((rec) => rec.employeeId === employee.id)
        .map((rec) => ({ recoveryId: rec.recoveryId, amount: rec.amount }));

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
        specialAllowance: r2(figures.specialAllowance + reimbursement.total),
        employeePf: figures.employeePf,
        employeeEsic: figures.employeeEsic,
        professionalTax: figures.professionalTax,
        tds: figures.tds,
        loanEmiDeduction: figures.loanEmiDeduction,
        fuelRecoveryDeduction: fuelRecovered,
        // 036 F1–F4. What this line takes and from where, kept on the line so that processing —
        // not generation — applies it, and applies exactly this. Recomputing it at processing would
        // let a balance or a claim that changed in between produce a deduction nobody reviewed.
        advanceRecovered,
        advanceRecoveryAdvanceId:
          advanceRecovered > 0 ? advanceDue.advanceId : null,
        fuelRecoveries:
          lineFuelRecoveries.length > 0
            ? (lineFuelRecoveries as Prisma.InputJsonValue)
            : Prisma.DbNull,
        reimbursementClaimIds: reimbursement.claimIds,
        reimbursementTotal: reimbursement.total,
        netPay: r2(
          figures.netPay +
            reimbursement.total -
            advanceRecovered -
            fuelRecovered,
        ),
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
      let created;
      if (existing) {
        // 036 F6. Conditional on the run *still* being a draft: the status was read before the
        // computation above, which takes seconds, and a run processed in between must not have its
        // frozen lines deleted and rewritten here.
        const claimed = await tx.payrollRun.updateMany({
          where: { id: existing.id, status: PayrollRunStatus.draft },
          data: {
            generatedAt: new Date(),
            generatedByUserId: caller.userId,
            exceptions: exceptions as Prisma.InputJsonValue,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException(
            `Payroll for ${period} was processed while it was being regenerated; it can no longer be regenerated.`,
          );
        }
        created = await tx.payrollRun.findFirstOrThrow({
          where: { id: existing.id },
        });
      } else {
        created = await tx.payrollRun.create({
          data: {
            companyId,
            period,
            isFnf: false,
            status: PayrollRunStatus.draft,
            generatedAt: new Date(),
            generatedByUserId: caller.userId,
            exceptions: exceptions as Prisma.InputJsonValue,
          },
        });
      }

      // Replace rather than merge: a regeneration is a fresh answer to the same
      // question, and leaving a stale line for an employee who has since been
      // deactivated would quietly pay them.
      await tx.payrollLineItem.deleteMany({
        where: { payrollRunId: created.id },
      });
      if (lines.length > 0) {
        await tx.payrollLineItem.createMany({
          data: lines.map((l) => ({ ...l, payrollRunId: created.id })),
        });
      }

      /**
       * 036 F1/F2 (decision 1): **no advance or fuel balance is touched here.**
       *
       * Until 036 this transaction applied each recovery to its balance as the draft was written —
       * and a draft is regenerated whenever attendance is corrected, so each regeneration took the
       * recovery again. An advance could close having been deducted once, or not at all. The
       * amounts are now only *recorded on the line*; `setStatus` applies them when the run is
       * processed, once, in the transaction that freezes it.
       */
      return created;
    }).catch((error: unknown) => {
      // 036: two people pressing Generate at once. Both pass the "is there a run?" read, and the
      // second insert hits the one-regular-run-per-period index (or the one-line-per-employee
      // index, when both are regenerating). The database is right; the message should say so.
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          `Payroll for ${period} is being generated by someone else right now. Wait a moment, then reload the run.`,
        );
      }
      throw error;
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
      // needs to see who could not be taxed correctly. Also kept on the run since 036 F7.
      exceptions,
      // What processing will recover — planned, not yet applied (036 F1). Same shape as before.
      advanceRecoveries,
    };
  }

  /**
   * Advances a run's status.
   *
   * Draft → Processed freezes the figures (FR-015) and settles what the run deducted: loan schedule
   * entries, reimbursement claims, and — since 036 F1/F2 — salary advance and fuel recoveries.
   * Processed → Paid records disbursement, and only once the run's approval chain has approved it
   * (036 F6). Neither transition is reversible, and no other pair is permitted.
   *
   * **Race-safe (036 F6).** The status is read here for the message, but the move itself is an
   * `updateMany` conditional on the status still being what was read, inside the transaction that
   * does the settling. Two "process" requests at once used to both pass the read and both settle;
   * now the second matches no row and gets a 409, and its transaction — settlement included — rolls
   * back. That is also what makes settlement exactly-once if a client retries.
   */
  async setStatus(caller: Caller, runId: string, target: PayrollRunStatus) {
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

    if (target === PayrollRunStatus.paid) {
      await this.assertApprovedForPayment(run.companyId, runId);
    }

    const updated = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const now = new Date();
        const moved = await tx.payrollRun.updateMany({
          where: { id: runId, status: run.status },
          data: {
            status: target,
            ...(target === PayrollRunStatus.processed
              ? { processedAt: now, recoveriesSettledAt: now }
              : { paidAt: now }),
          },
        });
        if (moved.count !== 1) {
          throw new ConflictException(
            'This payroll run was changed by someone else a moment ago. Reload it to see where it stands.',
          );
        }

        if (target === PayrollRunStatus.processed) {
          await this.settleRecoveries(tx, runId);
          await this.settleLoanSchedule(tx, run);
          await this.materialiseSalarySlips(tx, runId, run.period);
          await this.settleReimbursements(tx, runId);
        }
        return tx.payrollRun.findFirstOrThrow({ where: { id: runId } });
      },
    );

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
   * Refuses `processed → paid` until the run's approval chain has approved it (036 F6).
   *
   * `ApprovalService.mayTakeEffect` rather than a status read of our own — FR-018's rule has one
   * implementation, and it is the one the bank sheet already obeys. A run marked paid while its
   * approval was still pending is a payment recorded against figures nobody agreed.
   */
  private async assertApprovedForPayment(
    companyId: string,
    runId: string,
  ): Promise<void> {
    const gate = await this.approvals.mayTakeEffect({
      actionType: ACTION_PAYROLL_RUN,
      entityType: ACTION_PAYROLL_RUN,
      entityId: runId,
      companyId,
    });
    if (gate.allowed) return;
    if (gate.state === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_NOT_SUBMITTED',
        message:
          'This payroll run has not been submitted for approval, so it cannot be marked paid yet.',
      });
    }
    throw new ConflictException({
      statusCode: 409,
      code: 'PAYROLL_RUN_NOT_APPROVED',
      message:
        gate.state === 'pending'
          ? `This payroll run is awaiting ${
              gate.levelLabel ?? 'approval'
            }. It can be marked paid once every level has approved.`
          : `This payroll run was ${gate.state} and cannot be marked paid.`,
    });
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

  /**
   * One run with its line items, each carrying the employee's code and name (2026-10-17): the line
   * stores only the employee id, and a register of ids is unreadable to the people checking it.
   */
  async getRun(caller: Caller, runId: string) {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
        },
      }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));
    const nameOf = (employeeId: string) => {
      const e = byId.get(employeeId);
      const name = e
        ? [e.firstName, e.lastName].filter(Boolean).join(' ').trim()
        : '';
      return {
        employeeCode: e?.employeeCode ?? undefined,
        name: name || undefined,
      };
    };
    // 036 F7. Kept on the run since 036; a run generated before has none recorded, which is `[]`
    // rather than `null` so the screen has one shape to read. Each carries the employee's code and
    // name for the same reason the lines do.
    const exceptions = (
      Array.isArray(run.exceptions)
        ? (run.exceptions as { employeeId: string; reason: string }[])
        : []
    ).map((x) => ({ ...x, ...nameOf(x.employeeId) }));
    return {
      ...run,
      exceptions,
      lineItems: run.lineItems.map((line) => ({
        ...line,
        ...nameOf(line.employeeId),
        // 036 F8. The server's own totals, so run detail stops adding columns up itself — it was
        // missing conveyance, site, special, fuel and advance, and its totals did not match net.
        ...lineTotals(line),
      })),
    };
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
    employee: {
      id: string;
      siteId: string;
      shiftId: string;
      companyId: string;
    },
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
          status: {
            in: [LoanScheduleStatus.upcoming, LoanScheduleStatus.overdue],
          },
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

    // 021 FR-008f (T105). The payslip prints each earning as Full beside Actual: the monthly
    // entitlement beside what LOP left of it. `PayrollLineItem` holds only the prorated figures, so
    // the entitlement comes from the salary structure — read **now**, at the moment the slip is
    // written, and stored on it. Reading it when the slip is *displayed* would let next year's
    // salary revision rewrite the Full column of a payslip already issued.
    const structures = await tx.employee.findMany({
      where: { id: { in: lines.map((l) => l.employeeId) } },
      select: {
        id: true,
        basic: true,
        hra: true,
        conveyanceAllowance: true,
        siteAllowance: true,
        specialAllowance: true,
      },
    });
    const structureOf = new Map(structures.map((e) => [e.id, e]));

    for (const l of lines) {
      const full = structureOf.get(l.employeeId);
      const data = {
        // Null when the employee's row has gone between the run and this write — rare, and an em
        // dash on the payslip is the honest rendering of it.
        fullEarningBasic: full?.basic ?? null,
        fullEarningHra: full?.hra ?? null,
        fullEarningConveyance: full?.conveyanceAllowance ?? null,
        fullEarningSiteAllowance: full?.siteAllowance ?? null,
        // Deliberately **not** `+ reimbursement.total`, unlike the Actual figure. A reimbursement
        // rides in special allowance because it must not enter the PF/ESIC/PT bases; it is not part
        // of a monthly entitlement, and printing it in the Full column would make the structure
        // look like it changed.
        fullEarningSpecialAllowance: full?.specialAllowance ?? null,
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
        // 036 F3. Was hard-coded 0 — a placeholder from before advances existed that outlived
        // them — while net pay had the advance taken out, so the slip's deductions did not add up
        // to gross − net for anybody repaying one.
        deductionAdvanceRecovery: l.advanceRecovered,
        // 020 FR-007. Its own line on the payslip, named as a fuel recovery — not folded into the
        // loan or advance line above. A deduction an employee cannot see explained is a grievance
        // waiting to happen, and "why is my pay short" is not answered by a figure under a heading
        // about a loan they never took.
        deductionFuelRecovery: l.fuelRecoveryDeduction,
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
   *
   * 036 F5. Only **this run's company and this run's employees** — those whose line actually took an
   * EMI. The query used to be every active loan with an instalment due this month, in any company:
   * a Super Admin processing with no company selected (RLS off) marked other companies' EMIs paid
   * against a run that never deducted them.
   */
  private async settleLoanSchedule(
    tx: Prisma.TransactionClient,
    run: { id: string; companyId: string; period: string },
  ): Promise<void> {
    const deducted = await tx.payrollLineItem.findMany({
      where: { payrollRunId: run.id, loanEmiDeduction: { gt: 0 } },
      select: { employeeId: true },
    });
    if (deducted.length === 0) return;

    const entries = await tx.loanScheduleEntry.findMany({
      where: {
        month: run.period,
        status: {
          in: [LoanScheduleStatus.upcoming, LoanScheduleStatus.overdue],
        },
        loan: {
          status: LoanStatus.active,
          companyId: run.companyId,
          employeeId: { in: deducted.map((l) => l.employeeId) },
        },
      },
      select: { id: true, loanId: true },
    });
    if (entries.length === 0) return;

    await tx.loanScheduleEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { status: LoanScheduleStatus.paid, paidInPayrollRunId: run.id },
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
   * Marks the reimbursement claims this run carried as paid, once it is processed.
   *
   * Deferred to processing rather than done at generation: a draft can be
   * regenerated, and a claim marked paid against a run that was then rebuilt would
   * be paid on paper but not in fact.
   *
   * 036 F4. **Exactly the claim ids written on the run's lines**, not every approved payroll-mode
   * claim the employee has by the time somebody presses Process — a claim approved after the draft
   * was generated is not in its special allowance and was being marked paid anyway.
   * `settleRecoveries` has already refused the run if any of these stopped being payable.
   */
  private async settleReimbursements(
    tx: Prisma.TransactionClient,
    runId: string,
  ): Promise<void> {
    const lines = await tx.payrollLineItem.findMany({
      where: { payrollRunId: runId },
      select: { reimbursementClaimIds: true },
    });
    const claimIds = lines.flatMap((l) => l.reimbursementClaimIds ?? []);
    await this.reimbursements.settlePayrollClaims(tx, claimIds, runId);
  }

  /**
   * Applies the advance and fuel recoveries the run's lines took (036 F1/F2, decision 1).
   *
   * Runs inside the `draft → processed` transaction, after the conditional status move, so it
   * happens once per run: a retried or concurrent "process" matches no row and rolls back before
   * reaching here.
   *
   * **Refuses a stale draft rather than settling it.** Net pay was computed from the balances and
   * claims as they stood at generation. If, since then, an advance was recovered elsewhere (a bank
   * sheet, an F&F, another month's run), a fuel recovery was reversed, or a claim was paid directly
   * or withdrawn, the frozen line would deduct money that is no longer owed or pay a claim twice.
   * Regenerating the draft fixes all of these, so the refusal says that — and because it is thrown
   * inside the transaction, nothing is half-settled.
   */
  private async settleRecoveries(
    tx: Prisma.TransactionClient,
    runId: string,
  ): Promise<void> {
    const lines = await tx.payrollLineItem.findMany({
      where: { payrollRunId: runId },
      select: {
        id: true,
        employeeId: true,
        advanceRecovered: true,
        advanceRecoveryAdvanceId: true,
        fuelRecoveries: true,
        reimbursementClaimIds: true,
      },
    });

    const advanceIds = lines
      .map((l) => l.advanceRecoveryAdvanceId)
      .filter((id): id is string => !!id);
    const fuelPlans = lines.flatMap((l) =>
      parseFuelRecoveries(l.fuelRecoveries).map((rec) => ({
        ...rec,
        lineId: l.id,
      })),
    );
    const claimIds = lines.flatMap((l) => l.reimbursementClaimIds ?? []);

    const [advances, fuel, claims] = await Promise.all([
      advanceIds.length
        ? tx.salaryAdvance.findMany({
            where: { id: { in: advanceIds } },
            select: { id: true, status: true, outstandingBalance: true },
          })
        : [],
      fuelPlans.length
        ? tx.operatorFuelRecovery.findMany({
            where: { id: { in: fuelPlans.map((p) => p.recoveryId) } },
            select: {
              id: true,
              status: true,
              amount: true,
              recoveredAmount: true,
            },
          })
        : [],
      claimIds.length
        ? tx.reimbursementClaim.findMany({
            where: { id: { in: claimIds } },
            select: { id: true, status: true, paymentMode: true },
          })
        : [],
    ]);

    const stale = findStaleRecoveries(lines, { advances, fuel, claims });
    if (stale.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_DRAFT_STALE',
        message:
          'Some recoveries or claims in this draft changed after it was generated, so processing it ' +
          'would deduct or pay the wrong amount. Regenerate the draft, then process it.',
        stale,
      });
    }

    for (const line of lines) {
      const amount = this.num(line.advanceRecovered);
      if (line.advanceRecoveryAdvanceId && amount > 0) {
        await this.advances.applyRecovery(
          tx,
          line.advanceRecoveryAdvanceId,
          amount,
        );
      }
    }
    for (const plan of fuelPlans) {
      await this.fuelRecovery.recordRecovered(
        tx,
        plan.recoveryId,
        plan.amount,
        plan.lineId,
      );
    }
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

/** Sum of decimals as a 2-dp Decimal, so it serialises exactly like the columns beside it. */
const sumDecimal = (values: (Prisma.Decimal | number | null)[]) =>
  new Prisma.Decimal(
    r2(
      values.reduce<number>(
        (a, v) =>
          a + (v === null ? 0 : typeof v === 'number' ? v : v.toNumber()),
        0,
      ),
    ).toFixed(2),
  );

/**
 * A line's gross and total deductions, as the server computes them (036 F8).
 *
 * `gross` is every earning on the line, reimbursements included (they ride in special allowance);
 * `totalDeductions` is every employee deduction, fuel and advance included. `gross −
 * totalDeductions = netPay` for every line whose deductions did not exceed gross (the engine floors
 * net pay at zero there). Returned as Decimals so they serialise as the columns do.
 */
export function lineTotals(line: {
  basic: Prisma.Decimal;
  hra: Prisma.Decimal;
  conveyanceAllowance: Prisma.Decimal;
  siteAllowance: Prisma.Decimal;
  specialAllowance: Prisma.Decimal;
  otWages: Prisma.Decimal;
  employeePf: Prisma.Decimal;
  employeeEsic: Prisma.Decimal;
  professionalTax: Prisma.Decimal;
  tds: Prisma.Decimal;
  loanEmiDeduction: Prisma.Decimal;
  fuelRecoveryDeduction: Prisma.Decimal;
  advanceRecovered: Prisma.Decimal;
}): { gross: Prisma.Decimal; totalDeductions: Prisma.Decimal } {
  return {
    gross: sumDecimal([
      line.basic,
      line.hra,
      line.conveyanceAllowance,
      line.siteAllowance,
      line.specialAllowance,
      line.otWages,
    ]),
    totalDeductions: sumDecimal([
      line.employeePf,
      line.employeeEsic,
      line.professionalTax,
      line.tds,
      line.loanEmiDeduction,
      line.fuelRecoveryDeduction,
      line.advanceRecovered,
    ]),
  };
}

/** `PayrollLineItem.fuelRecoveries` → typed rows, tolerating null and malformed JSON. */
export function parseFuelRecoveries(
  value: Prisma.JsonValue | null | undefined,
): { recoveryId: string; amount: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => v as { recoveryId?: unknown; amount?: unknown })
    .filter(
      (v) => typeof v?.recoveryId === 'string' && typeof v?.amount === 'number',
    )
    .map((v) => ({
      recoveryId: v.recoveryId as string,
      amount: v.amount as number,
    }));
}

/** One reason a draft can no longer be processed as it stands (036 F1/F2/F4). */
export interface StaleRecovery {
  employeeId: string;
  kind: 'advance' | 'fuel_recovery' | 'reimbursement';
  id: string;
  reason: string;
}

/**
 * What in a draft no longer matches the balances and claims it was computed from (036).
 *
 * Pure, so the rule is tested without a database. Half a paisa of tolerance on the money checks:
 * both sides are 2-dp figures and a floating-point sum must not refuse a run over 1e-12.
 */
export function findStaleRecoveries(
  lines: {
    employeeId: string;
    advanceRecovered: Prisma.Decimal | number;
    advanceRecoveryAdvanceId: string | null;
    fuelRecoveries: Prisma.JsonValue | null;
    reimbursementClaimIds: string[];
  }[],
  current: {
    advances: {
      id: string;
      status: string;
      outstandingBalance: Prisma.Decimal | number;
    }[];
    fuel: {
      id: string;
      status: string;
      amount: Prisma.Decimal | number;
      recoveredAmount: Prisma.Decimal | number;
    }[];
    claims: { id: string; status: string; paymentMode: string | null }[];
  },
): StaleRecovery[] {
  const num = (v: Prisma.Decimal | number) =>
    typeof v === 'number' ? v : v.toNumber();
  const advances = new Map(current.advances.map((a) => [a.id, a]));
  const fuel = new Map(current.fuel.map((f) => [f.id, f]));
  const claims = new Map(current.claims.map((c) => [c.id, c]));
  const stale: StaleRecovery[] = [];

  // Fuel is summed per recovery across lines: one recovery is one employee's, but the check must
  // not depend on that.
  const fuelPlanned = new Map<string, { employeeId: string; amount: number }>();

  for (const line of lines) {
    const advanceAmount = num(line.advanceRecovered);
    if (line.advanceRecoveryAdvanceId && advanceAmount > 0) {
      const advance = advances.get(line.advanceRecoveryAdvanceId);
      if (!advance || advance.status !== 'disbursed') {
        stale.push({
          employeeId: line.employeeId,
          kind: 'advance',
          id: line.advanceRecoveryAdvanceId,
          reason: 'The advance is no longer outstanding.',
        });
      } else if (advanceAmount > num(advance.outstandingBalance) + 0.005) {
        stale.push({
          employeeId: line.employeeId,
          kind: 'advance',
          id: advance.id,
          reason: `The draft recovers ${advanceAmount.toFixed(
            2,
          )} but only ${num(advance.outstandingBalance).toFixed(
            2,
          )} is outstanding now.`,
        });
      }
    }
    for (const rec of parseFuelRecoveries(line.fuelRecoveries)) {
      const prior = fuelPlanned.get(rec.recoveryId);
      fuelPlanned.set(rec.recoveryId, {
        employeeId: line.employeeId,
        amount: r2((prior?.amount ?? 0) + rec.amount),
      });
    }
    for (const claimId of line.reimbursementClaimIds ?? []) {
      const claim = claims.get(claimId);
      if (
        !claim ||
        claim.status !== 'approved' ||
        claim.paymentMode !== 'payroll'
      ) {
        stale.push({
          employeeId: line.employeeId,
          kind: 'reimbursement',
          id: claimId,
          reason: claim
            ? `The claim is now ${claim.status}${
                claim.paymentMode && claim.paymentMode !== 'payroll'
                  ? ` (${claim.paymentMode})`
                  : ''
              }, not awaiting payment through payroll.`
            : 'The claim no longer exists.',
        });
      }
    }
  }

  for (const [recoveryId, plan] of fuelPlanned) {
    const row = fuel.get(recoveryId);
    const balance = row ? r2(num(row.amount) - num(row.recoveredAmount)) : 0;
    if (!row || row.status !== 'approved') {
      stale.push({
        employeeId: plan.employeeId,
        kind: 'fuel_recovery',
        id: recoveryId,
        reason: 'The fuel recovery is no longer awaiting payroll.',
      });
    } else if (plan.amount > balance + 0.005) {
      stale.push({
        employeeId: plan.employeeId,
        kind: 'fuel_recovery',
        id: recoveryId,
        reason: `The draft recovers ${plan.amount.toFixed(
          2,
        )} but only ${balance.toFixed(2)} is outstanding now.`,
      });
    }
  }
  return stale;
}
