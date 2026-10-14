import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Employee,
  PayrollLineItem,
  PayrollRunStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import * as ExcelJS from 'exceljs';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';

export type ChallanType = 'pf' | 'esic' | 'pt';

export interface ChallanRow {
  employeeCode: string;
  name: string;
  /** Statutory identifier for the scheme: UAN for PF, ESIC number for ESIC. */
  statutoryNumber: string | null;
  wages: number;
  employeeContribution: number;
  employerContribution: number;
  total: number;
  /** PF only — the employer share splits across these heads. */
  eps?: number;
  edli?: number;
  adminCharges?: number;
}

export interface ChallanView {
  type: ChallanType;
  period: string;
  runStatus: PayrollRunStatus;
  rows: ChallanRow[];
  totals: {
    wages: number;
    employeeContribution: number;
    employerContribution: number;
    total: number;
    eps?: number;
    edli?: number;
    adminCharges?: number;
  };
  /** Employees the scheme applies to but who have no statutory number on file. */
  missingStatutoryNumber: { employeeCode: string; name: string }[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type ChallanLine = Pick<
  PayrollLineItem,
  | 'basic'
  | 'hra'
  | 'conveyanceAllowance'
  | 'siteAllowance'
  | 'specialAllowance'
  | 'otWages'
  | 'employeePf'
  | 'employerPf'
  | 'employerEps'
  | 'employerEdli'
  | 'adminCharges'
  | 'employeeEsic'
  | 'employerEsic'
  | 'professionalTax'
>;

/** Earned wages for the month — the ESIC/PT base, and the register's gross. */
function grossOf(line: ChallanLine): number {
  const n = (d: Prisma.Decimal) => d.toNumber();
  return r2(
    n(line.basic) +
      n(line.hra) +
      n(line.conveyanceAllowance) +
      n(line.siteAllowance) +
      n(line.specialAllowance) +
      n(line.otWages),
  );
}

/**
 * One employee's figures on one scheme's challan, or null when they are not on it.
 *
 * Pulled out of `get` on 2026-10-15 so the Group Dashboard's PF + ESIC figure and the
 * Statutory Calendar's amounts come from **this** rule rather than a second copy of it.
 * Who is on a challan is not obvious — ESIC drops an applicable employee who earned above
 * the ceiling, PT drops a zero deduction — and a dashboard total that disagreed with the
 * Challans screen by one such employee would be found by the person filing, not by us.
 */
function challanShare(
  type: ChallanType,
  line: ChallanLine,
  employee: Pick<Employee, 'pfApplicable' | 'esicApplicable'>,
): Omit<ChallanRow, 'employeeCode' | 'name' | 'statutoryNumber'> | null {
  const n = (d: Prisma.Decimal) => d.toNumber();

  if (type === 'pf') {
    if (!employee.pfApplicable) return null;
    const employer = n(line.employerPf);
    const eps = n(line.employerEps);
    const edli = n(line.employerEdli);
    const admin = n(line.adminCharges);
    return {
      wages: n(line.basic),
      employeeContribution: n(line.employeePf),
      employerContribution: employer,
      eps,
      edli,
      adminCharges: admin,
      total: r2(n(line.employeePf) + employer + eps + edli + admin),
    };
  }

  if (type === 'esic') {
    if (!employee.esicApplicable) return null;
    const employeeEsic = n(line.employeeEsic);
    const employerEsic = n(line.employerEsic);
    // An ESIC-applicable employee whose gross exceeded the ceiling contributes
    // nothing this month; they are correctly absent from the challan rather
    // than present with zeros, which a filing would reject.
    if (employeeEsic === 0 && employerEsic === 0) return null;
    return {
      wages: grossOf(line),
      employeeContribution: employeeEsic,
      employerContribution: employerEsic,
      total: r2(employeeEsic + employerEsic),
    };
  }

  // Professional tax is an employee-side deduction with no employer share.
  const pt = n(line.professionalTax);
  if (pt === 0) return null;
  return {
    wages: grossOf(line),
    employeeContribution: pt,
    employerContribution: 0,
    total: pt,
  };
}

/**
 * A processed run reduced to the figures the Group Dashboard shows (2026-10-15).
 *
 * `pf`, `esic` and `pt` are each scheme's challan **total** — employee plus employer
 * shares, PF's EPS/EDLI/admin heads included — exactly what the Challans screen's total
 * row reads for that period. `tds` is the income tax deducted on the run's slips.
 */
export interface RunStatutoryTotals {
  companyId: string;
  runId: string;
  /** `YYYY-MM`. */
  period: string;
  employees: number;
  gross: number;
  pf: number;
  esic: number;
  pt: number;
  tds: number;
}

/** A run counts once it is processed; `paid` is a processed run that has also been paid. */
const SETTLED_RUN_STATUSES = [
  PayrollRunStatus.processed,
  PayrollRunStatus.paid,
];

/**
 * Statutory challans as a derived view (005 US6, research.md §5).
 *
 * There is deliberately no `Challan` table. FR-019 requires the figures to trace
 * exactly to the payroll run with zero independent recomputation, and a read that
 * reshapes the run's own line items is definitionally unable to drift from them —
 * whereas a stored snapshot would carry its own staleness problem for no benefit at
 * these volumes.
 */
@Injectable()
export class ChallansService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Each company's **latest** processed run, summarised (Group Dashboard, 2026-10-15).
   *
   * Two statements for any number of companies: `distinct` on `companyId`, ordered by
   * period descending, picks one run per company in the database; the line items for
   * all of them come back in the second. A company with no processed run is simply
   * absent from the result — the card says "No run yet" rather than ₹0.
   */
  async latestRunTotals(
    rls: RlsContext,
    companyIds: string[],
  ): Promise<RunStatutoryTotals[]> {
    if (companyIds.length === 0) return [];
    return withRlsContext(this.prisma, rls, async (tx) => {
      const runs = await tx.payrollRun.findMany({
        where: {
          companyId: { in: companyIds },
          isFnf: false,
          status: { in: SETTLED_RUN_STATUSES },
        },
        distinct: ['companyId'],
        orderBy: [{ companyId: 'asc' }, { period: 'desc' }],
        select: { id: true, companyId: true, period: true },
      });
      return this.totalsFor(tx, runs);
    });
  }

  /**
   * The processed runs for the given periods across these companies, summarised — the
   * Statutory Calendar's amounts. Unprocessed periods are absent, never zero.
   */
  async runTotalsForPeriods(
    rls: RlsContext,
    companyIds: string[],
    periods: string[],
  ): Promise<RunStatutoryTotals[]> {
    if (companyIds.length === 0 || periods.length === 0) return [];
    return withRlsContext(this.prisma, rls, async (tx) => {
      const runs = await tx.payrollRun.findMany({
        where: {
          companyId: { in: companyIds },
          period: { in: periods },
          isFnf: false,
          status: { in: SETTLED_RUN_STATUSES },
        },
        select: { id: true, companyId: true, period: true },
      });
      return this.totalsFor(tx, runs);
    });
  }

  /** One read of every line in these runs, reduced through {@link challanShare}. */
  private async totalsFor(
    tx: Prisma.TransactionClient,
    runs: { id: string; companyId: string; period: string }[],
  ): Promise<RunStatutoryTotals[]> {
    if (runs.length === 0) return [];
    const lines = await tx.payrollLineItem.findMany({
      where: { payrollRunId: { in: runs.map((r) => r.id) } },
      include: {
        employee: { select: { pfApplicable: true, esicApplicable: true } },
      },
    });

    const totals = new Map<string, RunStatutoryTotals>(
      runs.map((run) => [
        run.id,
        {
          companyId: run.companyId,
          runId: run.id,
          period: run.period,
          employees: 0,
          gross: 0,
          pf: 0,
          esic: 0,
          pt: 0,
          tds: 0,
        },
      ]),
    );
    for (const line of lines) {
      const t = totals.get(line.payrollRunId);
      if (!t) continue;
      t.employees += 1;
      t.gross += grossOf(line);
      t.pf += challanShare('pf', line, line.employee)?.total ?? 0;
      t.esic += challanShare('esic', line, line.employee)?.total ?? 0;
      t.pt += challanShare('pt', line, line.employee)?.total ?? 0;
      t.tds += line.tds.toNumber();
    }
    return [...totals.values()].map((t) => ({
      ...t,
      gross: r2(t.gross),
      pf: r2(t.pf),
      esic: r2(t.esic),
      pt: r2(t.pt),
      tds: r2(t.tds),
    }));
  }

  async get(
    caller: Caller,
    companyId: string,
    type: ChallanType,
    period: string,
  ): Promise<ChallanView> {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { companyId, period, isFnf: false },
        include: { lineItems: true },
      }),
    );

    if (!run) {
      throw new NotFoundException(
        `No payroll run exists for ${period}. Generate and process payroll first.`,
      );
    }
    // A draft's figures are still expected to move. Filing a challan from them
    // would submit numbers that then change, so this is refused explicitly rather
    // than served with a caveat.
    if (run.status === PayrollRunStatus.draft) {
      throw new BadRequestException(
        `Payroll for ${period} is still a draft. Challans are derived from a processed run.`,
      );
    }

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
      }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));

    const rows: ChallanRow[] = [];
    const missing: { employeeCode: string; name: string }[] = [];

    for (const line of run.lineItems) {
      const e = byId.get(line.employeeId);
      if (!e) continue;
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
      const share = challanShare(type, line, e);
      if (!share) continue;

      if (type === 'pf' && !e.uan) {
        missing.push({ employeeCode: e.employeeCode, name });
      }
      if (type === 'esic' && !e.esicNumber) {
        missing.push({ employeeCode: e.employeeCode, name });
      }
      rows.push({
        employeeCode: e.employeeCode,
        name,
        statutoryNumber:
          type === 'pf' ? e.uan : type === 'esic' ? e.esicNumber : null,
        ...share,
      });
    }

    const sum = (pick: (r: ChallanRow) => number | undefined) =>
      r2(rows.reduce((a, r) => a + (pick(r) ?? 0), 0));

    return {
      type,
      period,
      runStatus: run.status,
      rows,
      totals: {
        wages: sum((r) => r.wages),
        employeeContribution: sum((r) => r.employeeContribution),
        employerContribution: sum((r) => r.employerContribution),
        total: sum((r) => r.total),
        ...(type === 'pf'
          ? {
              eps: sum((r) => r.eps),
              edli: sum((r) => r.edli),
              adminCharges: sum((r) => r.adminCharges),
            }
          : {}),
      },
      missingStatutoryNumber: missing,
    };
  }

  /** The same view as a spreadsheet, for filing. */
  async export(
    caller: Caller,
    companyId: string,
    type: ChallanType,
    period: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const view = await this.get(caller, companyId, type, period);

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(`${type.toUpperCase()} ${period}`);

    const base = [
      { header: 'Employee Code', key: 'employeeCode', width: 16 },
      { header: 'Name', key: 'name', width: 28 },
      {
        header: type === 'pf' ? 'UAN' : type === 'esic' ? 'ESIC No.' : 'Ref',
        key: 'statutoryNumber',
        width: 20,
      },
      { header: 'Wages', key: 'wages', width: 14 },
      { header: 'Employee', key: 'employeeContribution', width: 14 },
      { header: 'Employer', key: 'employerContribution', width: 14 },
    ];
    sheet.columns =
      type === 'pf'
        ? [
            ...base,
            { header: 'EPS', key: 'eps', width: 12 },
            { header: 'EDLI', key: 'edli', width: 12 },
            { header: 'Admin', key: 'adminCharges', width: 12 },
            { header: 'Total', key: 'total', width: 14 },
          ]
        : [...base, { header: 'Total', key: 'total', width: 14 }];

    sheet.getRow(1).font = { bold: true };
    for (const row of view.rows) sheet.addRow(row);

    const totals = sheet.addRow({
      employeeCode: '',
      name: '',
      statutoryNumber: 'TOTAL',
      ...view.totals,
    });
    totals.font = { bold: true };

    for (const key of [
      'wages',
      'employeeContribution',
      'employerContribution',
      'eps',
      'edli',
      'adminCharges',
      'total',
    ]) {
      const col = sheet.getColumn(key);
      if (col) col.numFmt = '#,##0.00';
    }

    // Surfaced in the file itself, not just the API: whoever files this needs to
    // see that some employees are missing the number the filing requires.
    if (view.missingStatutoryNumber.length > 0) {
      const gaps = workbook.addWorksheet('Missing Statutory Number');
      gaps.columns = [
        { header: 'Employee Code', key: 'employeeCode', width: 16 },
        { header: 'Name', key: 'name', width: 28 },
      ];
      gaps.getRow(1).font = { bold: true };
      for (const m of view.missingStatutoryNumber) gaps.addRow(m);
    }

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `${type}-challan-${period}.xlsx`,
    };
  }
}
