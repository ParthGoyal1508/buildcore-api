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
      const n = (d: Prisma.Decimal) => d.toNumber();

      if (type === 'pf') {
        if (!e.pfApplicable) continue;
        const employer = n(line.employerPf);
        const eps = n(line.employerEps);
        const edli = n(line.employerEdli);
        const admin = n(line.adminCharges);
        if (!e.uan) missing.push({ employeeCode: e.employeeCode, name });
        rows.push({
          employeeCode: e.employeeCode,
          name,
          statutoryNumber: e.uan,
          wages: n(line.basic),
          employeeContribution: n(line.employeePf),
          employerContribution: employer,
          eps,
          edli,
          adminCharges: admin,
          total: r2(n(line.employeePf) + employer + eps + edli + admin),
        });
        continue;
      }

      if (type === 'esic') {
        if (!e.esicApplicable) continue;
        const employeeEsic = n(line.employeeEsic);
        const employerEsic = n(line.employerEsic);
        // An ESIC-applicable employee whose gross exceeded the ceiling contributes
        // nothing this month; they are correctly absent from the challan rather
        // than present with zeros, which a filing would reject.
        if (employeeEsic === 0 && employerEsic === 0) continue;
        if (!e.esicNumber) missing.push({ employeeCode: e.employeeCode, name });
        rows.push({
          employeeCode: e.employeeCode,
          name,
          statutoryNumber: e.esicNumber,
          wages: r2(
            n(line.basic) +
              n(line.hra) +
              n(line.conveyanceAllowance) +
              n(line.siteAllowance) +
              n(line.specialAllowance) +
              n(line.otWages),
          ),
          employeeContribution: employeeEsic,
          employerContribution: employerEsic,
          total: r2(employeeEsic + employerEsic),
        });
        continue;
      }

      // Professional tax is an employee-side deduction with no employer share.
      const pt = n(line.professionalTax);
      if (pt === 0) continue;
      rows.push({
        employeeCode: e.employeeCode,
        name,
        statutoryNumber: null,
        wages: r2(
          n(line.basic) +
            n(line.hra) +
            n(line.conveyanceAllowance) +
            n(line.siteAllowance) +
            n(line.specialAllowance) +
            n(line.otWages),
        ),
        employeeContribution: pt,
        employerContribution: 0,
        total: pt,
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
