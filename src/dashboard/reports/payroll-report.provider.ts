import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { PayrollRegisterService } from '../../payroll/registers/payroll-register.service';
import type { DashboardContext } from '../context';
import type {
  FilterSpec,
  ReportData,
  ReportProvider,
  ReportRunParams,
} from './report.types';

/**
 * The salary register over a range of months (spec FR-019).
 *
 * A placeholder blaming "the payroll module", built since 005 — the same false blame the
 * dashboard's widgets carried, from the same cause: a placeholder outliving the thing it
 * stood in for, with nothing to make it fail.
 *
 * ## Every processed run in the range, not "the run for the month"
 *
 * `PayrollRun` is not unique on `(companyId, period)` — the live data has two runs for
 * 2026-09 — so "the September run" is a question with no single answer. The period is a
 * column instead, and a month with two runs produces both, which is the only honest
 * answer available. Drafts are excluded: a register is what somebody signs off.
 *
 * ## Read through the register service, not rebuilt
 *
 * `salaryRegister` already computes gross, total deductions and net per employee, and
 * already reconciles the register's net against the run's stored total. Re-deriving pay
 * here would be a second answer to "what was this person paid", and the one somebody
 * quotes would be whichever screen they opened last.
 *
 * The register's `designationId`, `departmentId` and `projectId` are deliberately **not**
 * carried: they are ids, and a cuid under a column headed "Department" is the defect the
 * Employee report shipped with. A register is read for the money, and resolving three
 * masters to put three more columns on it is work nobody asked for.
 */
@Injectable()
export class PayrollReportProvider implements ReportProvider {
  readonly id = 'payroll';
  readonly name = 'Payroll';
  /** `PAYROLL` — this is every employee's pay, as a download. */
  readonly requires = [Permission.PAYROLL];
  readonly filters: FilterSpec[] = [
    { key: 'fromDate', label: 'From', type: 'date' },
    { key: 'toDate', label: 'To', type: 'date' },
  ];

  constructor(private readonly register: PayrollRegisterService) {}

  isAvailable(): boolean {
    return true;
  }

  async run(
    ctx: DashboardContext,
    params: ReportRunParams,
  ): Promise<ReportData> {
    const { from, to } = periodsOf(params);
    const runs = await this.register.processedRunsBetween(ctx.caller, from, to);

    const rows: Record<string, unknown>[] = [];
    for (const run of runs) {
      const register = await this.register.salaryRegister(ctx.caller, run.id);
      for (const row of register.rows) {
        rows.push({
          period: register.period,
          employeeCode: row.employeeCode,
          name: row.name,
          daysPaid: row.daysPaid,
          lopDays: row.lopDays,
          basic: row.basic,
          hra: row.hra,
          conveyance: row.conveyance,
          siteAllowance: row.siteAllowance,
          specialAllowance: row.specialAllowance,
          otWages: row.otWages,
          gross: row.gross,
          employeePf: row.employeePf,
          employeeEsic: row.employeeEsic,
          professionalTax: row.professionalTax,
          tds: row.tds,
          loanEmi: row.loanEmi,
          totalDeductions: row.totalDeductions,
          netPay: row.netPay,
        });
      }
    }

    return {
      // Said rather than left as "no rows": the reason an empty payroll report is empty
      // is almost always that nobody has processed the run yet, and a reader told only
      // that it returned nothing goes looking for missing employees instead.
      ...(runs.length === 0
        ? {
            note:
              `No processed payroll run falls between ${from} and ${to}. A register is ` +
              `produced from a processed or paid run, so a run still in draft produces ` +
              `none — process it first.`,
          }
        : {}),
      columns: [
        { key: 'period', label: 'Period' },
        { key: 'employeeCode', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'daysPaid', label: 'Days paid', type: 'number' },
        { key: 'lopDays', label: 'LOP days', type: 'number' },
        { key: 'basic', label: 'Basic', type: 'money' },
        { key: 'hra', label: 'HRA', type: 'money' },
        { key: 'conveyance', label: 'Conveyance', type: 'money' },
        { key: 'siteAllowance', label: 'Site allowance', type: 'money' },
        { key: 'specialAllowance', label: 'Special allowance', type: 'money' },
        { key: 'otWages', label: 'Overtime', type: 'money' },
        { key: 'gross', label: 'Gross', type: 'money' },
        { key: 'employeePf', label: 'PF', type: 'money' },
        { key: 'employeeEsic', label: 'ESIC', type: 'money' },
        { key: 'professionalTax', label: 'Professional tax', type: 'money' },
        { key: 'tds', label: 'TDS', type: 'money' },
        { key: 'loanEmi', label: 'Loan EMI', type: 'money' },
        { key: 'totalDeductions', label: 'Deductions', type: 'money' },
        { key: 'netPay', label: 'Net pay', type: 'money' },
      ],
      rows,
    };
  }
}

/**
 * The `YYYY-MM` range a run was asked for, defaulting to the current month.
 *
 * Months rather than dates, because payroll is monthly: a range of 2026-09-15 to
 * 2026-10-14 does not describe a set of payroll runs, and taking the months either date
 * falls in is the only reading that does.
 */
function periodsOf(params: ReportRunParams): { from: string; to: string } {
  const month = (value: string | undefined): string | null =>
    value && /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : null;
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  const from = month(params.fromDate) ?? thisMonth;
  const to = month(params.toDate) ?? from;
  // A range given backwards is a typo, not a request for nothing.
  return from <= to ? { from, to } : { from: to, to: from };
}
