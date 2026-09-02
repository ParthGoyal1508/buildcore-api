import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayrollRunStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import * as ExcelJS from 'exceljs';

import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const n = (d: Prisma.Decimal) => d.toNumber();

export interface RegisterRow {
  employeeCode: string;
  name: string;
  designationId: string | null;
  departmentId: string | null;
  projectId: string | null;
  daysPaid: number;
  lopDays: number;
  basic: number;
  hra: number;
  conveyance: number;
  siteAllowance: number;
  specialAllowance: number;
  otWages: number;
  gross: number;
  employeePf: number;
  employeeEsic: number;
  professionalTax: number;
  tds: number;
  loanEmi: number;
  totalDeductions: number;
  netPay: number;
}

/**
 * The salary register and deduction report (005 amendment US16).
 *
 * Both are read-only views over a processed run. They exist because payroll is
 * reviewed and signed off from a register, not from a list of individual payslips —
 * and because the deduction report is what reconciles against the challans.
 */
@Injectable()
export class PayrollRegisterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The salary register.
   *
   * Refuses a draft run: a register is what someone signs off, and signing off
   * figures still expected to move is the failure it exists to prevent.
   */
  async salaryRegister(
    caller: Caller,
    runId: string,
    filters: {
      departmentId?: string;
      projectId?: string;
      siteId?: string;
    } = {},
  ) {
    const run = await this.requireProcessedRun(caller, runId);

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
      }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));

    const rows: RegisterRow[] = [];
    for (const l of run.lineItems) {
      const e = byId.get(l.employeeId);
      if (!e) continue;

      if (filters.departmentId && e.departmentId !== filters.departmentId) continue;
      if (filters.siteId && e.siteId !== filters.siteId) continue;
      // Project filter reads the line's own projectId (FR-046/FR-060) — the
      // project the cost was attributed to, which may differ from where the
      // employee is posted today.
      if (filters.projectId && l.projectId !== filters.projectId) continue;

      const gross = r2(
        n(l.basic) +
          n(l.hra) +
          n(l.conveyanceAllowance) +
          n(l.siteAllowance) +
          n(l.specialAllowance) +
          n(l.otWages),
      );
      const totalDeductions = r2(
        n(l.employeePf) +
          n(l.employeeEsic) +
          n(l.professionalTax) +
          n(l.tds) +
          n(l.loanEmiDeduction),
      );

      rows.push({
        employeeCode: e.employeeCode,
        name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
        designationId: e.designationId,
        departmentId: e.departmentId,
        projectId: l.projectId,
        daysPaid: n(l.payableDays),
        lopDays: n(l.lopDays),
        basic: n(l.basic),
        hra: n(l.hra),
        conveyance: n(l.conveyanceAllowance),
        siteAllowance: n(l.siteAllowance),
        specialAllowance: n(l.specialAllowance),
        otWages: n(l.otWages),
        gross,
        employeePf: n(l.employeePf),
        employeeEsic: n(l.employeeEsic),
        professionalTax: n(l.professionalTax),
        tds: n(l.tds),
        loanEmi: n(l.loanEmiDeduction),
        totalDeductions,
        netPay: n(l.netPay),
      });
    }

    const sum = (pick: (r: RegisterRow) => number) =>
      r2(rows.reduce((a, r) => a + pick(r), 0));

    const totals = {
      gross: sum((r) => r.gross),
      totalDeductions: sum((r) => r.totalDeductions),
      netPay: sum((r) => r.netPay),
    };

    // FR-058: the register must agree with the run it came from. Only checked
    // when unfiltered — a filtered view is legitimately a subset, and comparing
    // it to the whole run would produce a false alarm every time.
    const filtered =
      Boolean(filters.departmentId || filters.projectId || filters.siteId);
    const runNetTotal = r2(
      run.lineItems.reduce((a, l) => a + n(l.netPay), 0),
    );
    const reconciliation =
      !filtered && Math.abs(totals.netPay - runNetTotal) > 0.01
        ? {
            ok: false as const,
            message: `Register net (${totals.netPay}) does not match the run's stored total (${runNetTotal}). Do not file this until the difference is explained.`,
          }
        : { ok: true as const };

    return {
      runId,
      period: run.period,
      status: run.status,
      filtered,
      rows,
      totals,
      reconciliation,
    };
  }

  /**
   * The deduction report: each head with its employee count and total.
   *
   * The statutory heads are exactly the figures the challans derive from, so the
   * two are reconcilable by construction — both read the same line items.
   */
  async deductionReport(caller: Caller, runId: string) {
    const run = await this.requireProcessedRun(caller, runId);

    const head = (
      label: string,
      pick: (l: (typeof run.lineItems)[number]) => number,
      statutory: boolean,
    ) => {
      const values = run.lineItems.map(pick).filter((v) => v > 0);
      return {
        head: label,
        statutory,
        employeeCount: values.length,
        total: r2(values.reduce((a, v) => a + v, 0)),
      };
    };

    const heads = [
      head('PF (employee)', (l) => n(l.employeePf), true),
      head('PF (employer)', (l) => n(l.employerPf), true),
      head('EPS', (l) => n(l.employerEps), true),
      head('EDLI', (l) => n(l.employerEdli), true),
      head('PF admin charges', (l) => n(l.adminCharges), true),
      head('ESIC (employee)', (l) => n(l.employeeEsic), true),
      head('ESIC (employer)', (l) => n(l.employerEsic), true),
      head('Professional tax', (l) => n(l.professionalTax), true),
      head('TDS', (l) => n(l.tds), true),
      head('Loan EMI', (l) => n(l.loanEmiDeduction), false),
    ];

    return {
      runId,
      period: run.period,
      status: run.status,
      heads,
      totals: {
        statutory: r2(
          heads.filter((h) => h.statutory).reduce((a, h) => a + h.total, 0),
        ),
        nonStatutory: r2(
          heads.filter((h) => !h.statutory).reduce((a, h) => a + h.total, 0),
        ),
      },
    };
  }

  /** The register as a spreadsheet. */
  async exportRegister(
    caller: Caller,
    runId: string,
    filters: { departmentId?: string; projectId?: string; siteId?: string } = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    const register = await this.salaryRegister(caller, runId, filters);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`Salary Register ${register.period}`);
    sheet.columns = [
      { header: 'Code', key: 'employeeCode', width: 14 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Days Paid', key: 'daysPaid', width: 11 },
      { header: 'LOP', key: 'lopDays', width: 9 },
      { header: 'Basic', key: 'basic', width: 13 },
      { header: 'HRA', key: 'hra', width: 13 },
      { header: 'Conveyance', key: 'conveyance', width: 13 },
      { header: 'Site Allw.', key: 'siteAllowance', width: 13 },
      { header: 'Special Allw.', key: 'specialAllowance', width: 14 },
      { header: 'OT', key: 'otWages', width: 12 },
      { header: 'Gross', key: 'gross', width: 14 },
      { header: 'PF', key: 'employeePf', width: 12 },
      { header: 'ESIC', key: 'employeeEsic', width: 12 },
      { header: 'PT', key: 'professionalTax', width: 10 },
      { header: 'TDS', key: 'tds', width: 12 },
      { header: 'Loan EMI', key: 'loanEmi', width: 12 },
      { header: 'Deductions', key: 'totalDeductions', width: 14 },
      { header: 'Net Pay', key: 'netPay', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of register.rows) sheet.addRow(row);

    const totals = sheet.addRow({
      employeeCode: '',
      name: 'TOTAL',
      gross: register.totals.gross,
      totalDeductions: register.totals.totalDeductions,
      netPay: register.totals.netPay,
    });
    totals.font = { bold: true };

    for (const key of [
      'basic', 'hra', 'conveyance', 'siteAllowance', 'specialAllowance',
      'otWages', 'gross', 'employeePf', 'employeeEsic', 'professionalTax',
      'tds', 'loanEmi', 'totalDeductions', 'netPay',
    ]) {
      sheet.getColumn(key).numFmt = '#,##0.00';
    }

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `salary-register-${register.period}.xlsx`,
    };
  }

  private async requireProcessedRun(caller: Caller, runId: string) {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === PayrollRunStatus.draft) {
      throw new BadRequestException(
        'That run is still a draft. A register is produced from a processed or paid run.',
      );
    }
    return run;
  }
}
