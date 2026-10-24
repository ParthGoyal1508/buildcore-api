import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LoanStatus,
  PayrollRunStatus,
  Prisma,
  SalaryAdvanceStatus,
} from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';
import {
  AttendanceHistoryService,
  type AttendanceStatus,
} from '../../hr/punch/attendance-history.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import { parseFuelRecoveries } from '../engine/payroll-engine.service';
import { CompaniesService } from '../../settings/companies/companies.service';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (d: Prisma.Decimal | null | undefined) => d?.toNumber() ?? 0;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** Row 9 of the client's attendance sheet: one letter per weekday, Sunday first. */
const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_COLUMNS = 31;
/** Employees whose month of attendance is fetched at once; each fetch holds several connections. */
const ATTENDANCE_CONCURRENCY = 2;

/** Form D's codes. The client writes O for a weekly off, not W/O. */
const CODE: Record<AttendanceStatus, string> = {
  present: 'P',
  absent: 'A',
  weekly_off: 'O',
  holiday: 'H',
  on_leave: 'L',
};
export const NEW_JOINING = 'New Joining';
export const LEFT = 'Left';

const FONT = { name: 'Arial', size: 9 };
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFD9E1F2' },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF2CC' },
};
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' },
  right: { style: 'thin' },
};
const MONEY = '#,##0.00';
const DATE = 'dd-mm-yyyy';

/** The money on one payroll line, as `PayrollLineItem` stores it. */
export interface LineMoney {
  payableDays: number;
  otHours: number;
  otWages: number;
  basic: number;
  hra: number;
  conveyanceAllowance: number;
  siteAllowance: number;
  specialAllowance: number;
  reimbursementTotal: number;
  employeePf: number;
  employeeEsic: number;
  professionalTax: number;
  tds: number;
  loanEmiDeduction: number;
  advanceRecovered: number;
  fuelRecoveryDeduction: number;
  netPay: number;
  employerPf: number;
  employerEps: number;
  employerEsic: number;
}

/** One row of the wage register (Form B), before it is laid out. */
export interface WageFigures {
  daysWorked: number;
  otHours: number;
  basic: number;
  otPayment: number;
  hra: number;
  others: number;
  total: number;
  pf: number;
  esic: number;
  incomeTax: number;
  otherDeductions: number;
  recoveries: number;
  totalDeductions: number;
  netPayment: number;
  employerPf: number;
  employerEsic: number;
  reimbursement: number;
}

/**
 * A payroll line (or the lines of a regular and an F&F run for the same month, summed) as the
 * client's wage register reads it.
 *
 * - "Others" is every allowance that is not Basic or HRA, reimbursements included — the stored
 *   special allowance already carries them, and leaving them out would make Net Payment exceed
 *   Total − Deductions.
 * - "Others" under deductions is professional tax (an F&F line keeps its statutory deductions there
 *   too); "Recoveries" is the loan EMI, salary-advance and fuel recoveries, plus any advance taken
 *   off the bank transfer itself (`bankSheetRecovered`), so Net Payment is what reached the bank.
 */
export function wageFigures(
  lines: LineMoney[],
  bankSheetRecovered = 0,
): WageFigures {
  const sum = (pick: (l: LineMoney) => number) =>
    r2(lines.reduce((a, l) => a + pick(l), 0));
  const basic = sum((l) => l.basic);
  const otPayment = sum((l) => l.otWages);
  const hra = sum((l) => l.hra);
  const others = sum(
    (l) => l.conveyanceAllowance + l.siteAllowance + l.specialAllowance,
  );
  const pf = sum((l) => l.employeePf);
  const esic = sum((l) => l.employeeEsic);
  const incomeTax = sum((l) => l.tds);
  const otherDeductions = sum((l) => l.professionalTax);
  const recoveries = r2(
    sum(
      (l) => l.loanEmiDeduction + l.advanceRecovered + l.fuelRecoveryDeduction,
    ) + bankSheetRecovered,
  );
  return {
    daysWorked: sum((l) => l.payableDays),
    otHours: sum((l) => l.otHours),
    basic,
    otPayment,
    hra,
    others,
    total: r2(basic + otPayment + hra + others),
    pf,
    esic,
    incomeTax,
    otherDeductions,
    recoveries,
    totalDeductions: r2(pf + esic + incomeTax + otherDeductions + recoveries),
    netPayment: r2(sum((l) => l.netPay) - bankSheetRecovered),
    employerPf: sum((l) => l.employerPf + l.employerEps),
    employerEsic: sum((l) => l.employerEsic),
    reimbursement: sum((l) => l.reimbursementTotal),
  };
}

/**
 * Form D's code for each day of the month: P / A / O / H / L from the attendance computation, and
 * null before the joining date or after the last working day — those spans are merged and labelled
 * "New Joining" / "Left" when the sheet is written, as the client does by hand.
 */
export function dayCodes(
  days: { date: string; status: AttendanceStatus }[],
  joined: Date | null,
  left: Date | null,
): (string | null)[] {
  return days.map((d) => {
    const date = new Date(`${d.date}T00:00:00.000Z`);
    if (joined && date < joined) return null;
    if (left && date > left) return null;
    return CODE[d.status];
  });
}

interface Person {
  serial: number;
  id: string;
  code: string;
  name: string;
  fatherName: string;
  designation: string;
  category: string;
  siteName: string;
  mobile: string;
  aadhaar: string;
  dob: Date | null;
  pan: string;
  account: string;
  ifsc: string;
  bankName: string;
  uan: string;
  pfNo: string;
  esicNo: string;
  address: string;
  joined: Date | null;
  left: Date | null;
  joinedThisMonth: boolean;
  leftThisMonth: boolean;
  monthlyGross: number;
  monthlyBasic: number;
  pfGross: number;
  esicGross: number;
  wages: WageFigures | null;
  isFnf: boolean;
  /** Advance taken off the bank transfer rather than the run (033). */
  bankRecovered: number;
  /** When this person's pay went out: the latest run that paid them, if every one of them is paid. */
  paidOn: Date | null;
  edited: boolean;
  paymentMode: string;
  codes: (string | null)[];
  payDays: number | null;
  decryptFailed: boolean;
}

interface LoanRow {
  serial: number;
  name: string;
  type: string;
  particulars: string;
  damageDate: Date | null;
  amount: number;
  instalments: number;
  firstMonth: string;
  lastMonth: string;
  completedOn: Date | null;
  remarks: string;
}

/**
 * The monthly Statutory Compliance Register (040), in the client's format —
 * `docs/HR_DOCS/4. Statutory Compliance Register for the month of July 2026 Ganga.xlsx` — with the
 * client's two wage registers (sheets B and C) merged into one, and their two attendance registers
 * (E and F) likewise:
 *
 * - Employee Register: identity, bank and UAN details for everyone on the register.
 * - Form B, Wage Register: the month's figures from the processed run, as paid.
 * - Form C, Register of Loans / Recoveries: loans, salary advances and fuel (damage/loss)
 *   recoveries disbursed or recovered in the month, or NIL.
 * - Form D, Attendance Register: the day grid, from the same computation payroll used.
 *
 * Everyone on the run is on it, together with anyone employed in the month whom the run missed (an
 * exit whose F&F is not yet processed, a joiner added after the run) — listed with a remark and no
 * wages, so the register shows the whole establishment rather than only who was paid. One serial
 * number per person, the same on every sheet.
 *
 * The figures are the run's, not the client's spreadsheet formulas (Basic = 40% of gross, a 24% PF
 * column): the register has to agree with the payslips, the challans and the bank file.
 */
@Injectable()
export class StatutoryRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: AttendanceHistoryService,
    private readonly projects: ProjectsService,
    private readonly referenceData: ReferenceDataService,
    private readonly pii: PiiCipherService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    // 041: the establishment heading the register — a branch's address and PF / ESIC codes.
    private readonly companies: CompaniesService,
  ) {}

  async export(
    caller: Caller,
    user: AuthenticatedUser,
    runId: string,
    filters: { projectId?: string; siteId?: string; branchId?: string } = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    const rls = caller.rls;
    const run = await withRlsContext(this.prisma, rls, (tx) =>
      tx.payrollRun.findFirst({ where: { id: runId } }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === PayrollRunStatus.draft) {
      throw new BadRequestException(
        'That run is still a draft. The statutory register is produced from a processed or paid run.',
      );
    }
    const [year, month] = run.period.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));
    const daysInMonth = monthEnd.getUTCDate();

    // The month's processed runs: the regular one and any F&F settlement for someone who left in it.
    const runs = await withRlsContext(this.prisma, rls, (tx) =>
      tx.payrollRun.findMany({
        where: {
          companyId: run.companyId,
          period: run.period,
          status: { not: PayrollRunStatus.draft },
        },
        include: { lineItems: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const runById = new Map(runs.map((r) => [r.id, r]));
    const linesByEmployee = new Map<
      string,
      (typeof runs)[number]['lineItems']
    >();
    for (const r of runs) {
      for (const l of r.lineItems) {
        linesByEmployee.set(l.employeeId, [
          ...(linesByEmployee.get(l.employeeId) ?? []),
          l,
        ]);
      }
    }

    // The establishment (041): the branch asked for, or the head office — whose address and codes
    // the company's own columns have always mirrored, so an unfiltered register reads as before.
    if (filters.branchId) {
      await this.companies.assertActiveBranch(run.companyId, filters.branchId, {
        allowInactive: true,
      });
    }
    const branch = await this.companies.getBranchIdentity(
      run.companyId,
      filters.branchId,
    );
    const company = {
      id: run.companyId,
      name: branch.name,
      address: branch.address,
      city: branch.city,
      pfEstablishmentCode: branch.pfEstablishmentCode,
      esicCode: branch.esicCode,
    };
    // A line records the branch it was filed under; someone on the register with no line this
    // month (a joiner, an unsettled leaver) is placed by the branch they are on now.
    const onBranch = (e: { id: string; branchId: string }) =>
      !filters.branchId ||
      (linesByEmployee
        .get(e.id)
        ?.some((l) => l.branchId === filters.branchId) ??
        e.branchId === filters.branchId);

    // Sites in scope, and the project whose name heads the wage register.
    const sites = await withRlsContext(this.prisma, rls, (tx) =>
      tx.site.findMany({
        where: { companyId: company.id },
        select: { id: true, name: true, projectId: true },
      }),
    );
    let siteIds = sites.map((s) => s.id);
    if (filters.siteId) {
      if (!siteIds.includes(filters.siteId)) {
        throw new BadRequestException(
          'That site does not belong to this company.',
        );
      }
      siteIds = [filters.siteId];
    } else if (filters.projectId) {
      const projectSites = await this.projects.getSitesByProject(
        filters.projectId,
        rls,
      );
      siteIds = siteIds.filter((id) => projectSites.includes(id));
    }
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const filtered = Boolean(filters.siteId || filters.projectId);

    // Everyone on a run line, and everyone employed at some point in the month at a site in scope.
    const employees = await withRlsContext(this.prisma, rls, (tx) =>
      tx.employee.findMany({
        where: {
          companyId: company.id,
          OR: [
            { id: { in: [...linesByEmployee.keys()] } },
            {
              OR: [
                { dateOfJoining: null },
                { dateOfJoining: { lte: monthEnd } },
              ],
            },
          ],
        },
      }),
    );
    const exits = await withRlsContext(this.prisma, rls, (tx) =>
      tx.exitRecord.findMany({
        where: { employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true, lastWorkingDay: true },
        orderBy: { lastWorkingDay: 'desc' },
      }),
    );
    const lastDay = new Map<string, Date>();
    for (const x of exits) {
      if (!lastDay.has(x.employeeId))
        lastDay.set(x.employeeId, x.lastWorkingDay);
    }
    const inScope = employees
      .filter((e) => siteIds.includes(e.siteId))
      .filter(onBranch)
      .filter((e) => {
        if (linesByEmployee.has(e.id)) return true;
        const left = lastDay.get(e.id);
        if (left) return left >= monthStart;
        // Deactivated without an exit record: only on the register if the run paid them.
        return e.isActive;
      })
      .sort((a, b) =>
        a.employeeCode.localeCompare(b.employeeCode, undefined, {
          numeric: true,
        }),
      );

    const ids = inScope.map((e) => e.id);
    const designations = await this.referenceData.findAll(
      'designation',
      user,
      company.id,
    );
    const designationName = new Map(
      designations.map((d) => [d.id as string, String(d.name ?? '')]),
    );

    const [slips, bankRecoveries] = await Promise.all([
      withRlsContext(this.prisma, rls, (tx) =>
        tx.salarySlip.findMany({
          where: { employeeId: { in: ids }, period: run.period },
        }),
      ),
      withRlsContext(this.prisma, rls, (tx) =>
        tx.bankSheetRecovery.findMany({
          where: { payrollRunId: { in: runs.map((r) => r.id) } },
        }),
      ),
    ]);
    const slipFor = new Map(slips.map((s) => [s.employeeId, s]));
    const bankRecovered = new Map<string, number>();
    for (const b of bankRecoveries) {
      bankRecovered.set(
        b.employeeId,
        r2((bankRecovered.get(b.employeeId) ?? 0) + num(b.amount)),
      );
    }

    // The attendance grid, from the computation payroll and the employee's own screen use.
    // A few employees at a time: each lookup runs several queries at once, and the whole workforce
    // in parallel exhausts the connection pool (seen against Neon with 18 employees).
    const grids = await mapInBatches(inScope, ATTENDANCE_CONCURRENCY, (e) =>
      this.history.getMonthForEmployee(
        caller,
        {
          id: e.id,
          siteId: e.siteId,
          shiftId: e.shiftId,
          companyId: e.companyId,
        },
        month,
        year,
      ),
    );

    const pfCeiling =
      this.config.get<HrPayrollConfig>('hrPayroll')?.statutory.pf.wageCeiling ??
      15000;
    const people: Person[] = inScope.map((e, i) => {
      const lines = linesByEmployee.get(e.id) ?? [];
      const slip = slipFor.get(e.id);
      const left = lastDay.get(e.id) ?? null;
      const joined = e.dateOfJoining;
      let decryptFailed = false;
      const reveal = (value: string | null) => {
        try {
          return this.pii.decrypt(value) ?? '';
        } catch {
          decryptFailed = true;
          return '';
        }
      };
      const fullRate = (
        slipValue: Prisma.Decimal | null | undefined,
        employeeValue: Prisma.Decimal | null,
      ) => (slipValue != null ? num(slipValue) : num(employeeValue));
      const monthlyBasic = fullRate(slip?.fullEarningBasic, e.basic);
      const monthlyGross = r2(
        monthlyBasic +
          fullRate(slip?.fullEarningHra, e.hra) +
          fullRate(slip?.fullEarningConveyance, e.conveyanceAllowance) +
          fullRate(slip?.fullEarningSiteAllowance, e.siteAllowance) +
          fullRate(slip?.fullEarningSpecialAllowance, e.specialAllowance),
      );
      const wages = lines.length
        ? wageFigures(
            lines.map((l) => ({
              payableDays: num(l.payableDays),
              otHours: num(l.otHours),
              otWages: num(l.otWages),
              basic: num(l.basic),
              hra: num(l.hra),
              conveyanceAllowance: num(l.conveyanceAllowance),
              siteAllowance: num(l.siteAllowance),
              specialAllowance: num(l.specialAllowance),
              reimbursementTotal: num(l.reimbursementTotal),
              employeePf: num(l.employeePf),
              employeeEsic: num(l.employeeEsic),
              professionalTax: num(l.professionalTax),
              tds: num(l.tds),
              loanEmiDeduction: num(l.loanEmiDeduction),
              advanceRecovered: num(l.advanceRecovered),
              fuelRecoveryDeduction: num(l.fuelRecoveryDeduction),
              netPay: num(l.netPay),
              employerPf: num(l.employerPf),
              employerEps: num(l.employerEps),
              employerEsic: num(l.employerEsic),
            })),
            bankRecovered.get(e.id) ?? 0,
          )
        : null;
      const isFnf = lines.some((l) => runById.get(l.payrollRunId)?.isFnf);
      const codes = dayCodes(grids[i].days, joined, left);
      const calendarPayDays = codes.filter(
        (c) => c === 'P' || c === 'O' || c === 'H' || c === 'L',
      ).length;
      // An F&F line stores no days (it is a settlement, not a month); the calendar says how many.
      if (wages && isFnf && wages.daysWorked === 0) {
        wages.daysWorked = calendarPayDays;
      }
      const pfWage = e.pfUpperLimit
        ? Math.min(wages?.basic ?? 0, pfCeiling)
        : wages?.basic ?? 0;
      const site = siteById.get(e.siteId);
      return {
        serial: i + 1,
        id: e.id,
        code: e.employeeCode,
        name: [e.firstName, e.lastName]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
        fatherName: e.fatherName ?? '',
        designation: e.designationId
          ? designationName.get(e.designationId) ?? ''
          : '',
        category: e.musterCategory ?? '',
        siteName: site?.name ?? '',
        mobile: e.mobile ?? '',
        aadhaar: reveal(e.aadhaarEncrypted),
        dob: e.dob,
        pan: reveal(e.panEncrypted),
        account: reveal(e.bankAccountNumberEncrypted),
        ifsc: e.ifscCode ?? '',
        bankName: e.bankName ?? '',
        uan: e.uan ?? '',
        pfNo: e.uan || e.pfNumber || '',
        esicNo:
          e.esicNumber ||
          (!e.esicApplicable || (wages && wages.esic === 0) ? 'N/A' : ''),
        address: [
          e.permanentAddress || e.presentAddress,
          e.permanentAddress ? e.permanentCity : e.presentCity,
          e.permanentAddress ? e.permanentState : e.presentState,
          e.permanentAddress ? e.permanentPinCode : e.presentPinCode,
        ]
          .filter(Boolean)
          .join(', '),
        joined,
        left,
        joinedThisMonth: Boolean(
          joined && joined >= monthStart && joined <= monthEnd,
        ),
        leftThisMonth: Boolean(left && left >= monthStart && left <= monthEnd),
        monthlyGross,
        monthlyBasic,
        pfGross: wages && wages.pf > 0 ? r2(pfWage) : 0,
        esicGross:
          wages && wages.esic > 0 ? wages.total - wages.reimbursement : 0,
        wages,
        isFnf,
        bankRecovered: bankRecovered.get(e.id) ?? 0,
        paidOn: paidOnFor(lines.map((l) => runById.get(l.payrollRunId))),
        edited: lines.some((l) => l.editedFields.length > 0),
        paymentMode: (e.paymentMode ?? '').toLowerCase(),
        codes,
        payDays: wages ? wages.daysWorked : null,
        decryptFailed,
      };
    });

    const loanRows = await this.loanRows(caller, people, run.period, runs, {
      monthStart,
      monthEnd,
    });

    await this.auditLog.record({
      entityType: AuditEntityType.PAYROLL_RUN,
      action: AuditAction.READ,
      entityId: run.id,
      changes: {
        export: 'statutory_register',
        period: run.period,
        employees: people.length,
        revealedFields: ['aadhaar', 'pan', 'bankAccountNumber'],
        ...(filters.siteId ? { siteId: filters.siteId } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
      },
      accountId: caller.userId,
      companyId: company.id,
      ipAddress: caller.ipAddress,
    });

    // The wage register's project line: the project asked for, or the one every site in scope
    // belongs to; otherwise there is no single project to name.
    const projectIds = new Set(
      (filters.projectId
        ? [filters.projectId]
        : inScope.map((e) => siteById.get(e.siteId)?.projectId ?? null)
      ).filter((id): id is string => Boolean(id)),
    );
    const project =
      projectIds.size === 1
        ? await withRlsContext(this.prisma, rls, (tx) =>
            tx.project.findFirst({
              where: { id: [...projectIds][0] },
              select: { name: true, location: true },
            }),
          )
        : null;
    const scopeLabel = filters.siteId
      ? siteById.get(filters.siteId)?.name ?? ''
      : '';

    const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    const establishment = [company.name, company.address, company.city]
      .filter(Boolean)
      .join(', ');
    const context: SheetContext = {
      year,
      month,
      daysInMonth,
      monthStart,
      monthEnd,
      monthLabel,
      establishmentLine:
        `Name of the Establishment - ${establishment}` +
        // For one branch a missing code is said on the sheet rather than silently left off: the
        // register is filed under that code (041 FR-017).
        (company.pfEstablishmentCode
          ? `     PF Code - ${company.pfEstablishmentCode}`
          : filters.branchId
          ? '     PF Code - (not recorded)'
          : '') +
        (company.esicCode
          ? `     ESIC Code - ${company.esicCode}`
          : filters.branchId
          ? '     ESIC Code - (not recorded)'
          : '') +
        `     Name of Owner -          LIN -          Month of ${monthLabel}`,
      projectLine: `Project Name - ${
        project
          ? [project.name, project.location].filter(Boolean).join(', ')
          : scopeLabel || company.name
      }`,
    };

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    writeEmployeeRegister(
      workbook.addWorksheet('A- EMPLOYEE REGISTER'),
      people,
    );
    writeWageRegister(
      workbook.addWorksheet('B- WAGES REGISTER'),
      people,
      context,
    );
    writeLoanRegister(
      workbook.addWorksheet('C- LOAN RECOVERIES'),
      loanRows,
      context,
    );
    writeAttendanceRegister(
      workbook.addWorksheet('D- ATTENDANCE REGISTER'),
      people,
      context,
    );

    const scope =
      (filtered
        ? `_${filenamePart(scopeLabel || project?.name || 'Project')}`
        : '') +
      (filters.branchId
        ? `_${filenamePart(branch.city || branch.state || 'Branch')}`
        : '');
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `Statutory_Register_${filenamePart(company.name)}${scope}_${
        MONTH_NAMES[month - 1]
      }_${year}.xlsx`,
    };
  }

  /**
   * Form C's rows: every loan, salary advance and fuel (damage/loss) recovery for someone on the
   * register that was given or recovered in the month. A loan's instalments are its schedule; an
   * advance is one instalment; a fuel recovery is one charge, recovered as headroom allows.
   */
  private async loanRows(
    caller: Caller,
    people: Person[],
    period: string,
    runs: {
      id: string;
      isFnf: boolean;
      processedAt: Date | null;
      paidAt: Date | null;
      lineItems: {
        id: string;
        employeeId: string;
        loanEmiDeduction: Prisma.Decimal;
        advanceRecovered: Prisma.Decimal;
        advanceRecoveryAdvanceId: string | null;
        fuelRecoveries: Prisma.JsonValue;
      }[];
    }[],
    range: { monthStart: Date; monthEnd: Date },
  ): Promise<LoanRow[]> {
    const rls = caller.rls;
    const ids = people.map((p) => p.id);
    const person = new Map(people.map((p) => [p.id, p]));
    const lines = runs.flatMap((r) => r.lineItems);
    const runIds = runs.map((r) => r.id);

    const [loans, bankRecoveries] = await Promise.all([
      withRlsContext(this.prisma, rls, (tx) =>
        tx.loan.findMany({
          where: {
            employeeId: { in: ids },
            status: { in: [LoanStatus.active, LoanStatus.closed] },
          },
          include: { schedule: { orderBy: { month: 'asc' } } },
          orderBy: { disbursementDate: 'asc' },
        }),
      ),
      withRlsContext(this.prisma, rls, (tx) =>
        tx.bankSheetRecovery.findMany({
          where: { payrollRunId: { in: runIds } },
        }),
      ),
    ]);
    const advanceIdsRecovered = new Set([
      ...lines
        .filter(
          (l) => l.advanceRecoveryAdvanceId && num(l.advanceRecovered) > 0,
        )
        .map((l) => l.advanceRecoveryAdvanceId as string),
      ...bankRecoveries.map((b) => b.salaryAdvanceId),
    ]);
    const advances = await withRlsContext(this.prisma, rls, (tx) =>
      tx.salaryAdvance.findMany({
        where: {
          employeeId: { in: ids },
          status: {
            in: [SalaryAdvanceStatus.disbursed, SalaryAdvanceStatus.closed],
          },
          OR: [
            { id: { in: [...advanceIdsRecovered] } },
            { disbursedOn: { gte: range.monthStart, lte: range.monthEnd } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const fuelApplied = new Map<string, number>();
    for (const l of lines) {
      for (const f of parseFuelRecoveries(l.fuelRecoveries)) {
        fuelApplied.set(
          f.recoveryId,
          r2((fuelApplied.get(f.recoveryId) ?? 0) + f.amount),
        );
      }
    }
    const fuel = fuelApplied.size
      ? await withRlsContext(this.prisma, rls, (tx) =>
          tx.operatorFuelRecovery.findMany({
            where: { id: { in: [...fuelApplied.keys()] } },
            include: {
              fuelVarianceException: {
                select: {
                  reason: true,
                  fuelEntry: { select: { date: true } },
                },
              },
            },
          }),
        )
      : [];

    // When a recovery finished: the payment date of the run that took the last of it.
    const runOfLine = new Map(
      runs.flatMap((r) => r.lineItems.map((l) => [l.id, r] as const)),
    );
    const runById = new Map(runs.map((r) => [r.id, r]));
    const dateOf = (run: (typeof runs)[number] | undefined) =>
      run ? indianDate(run.paidAt ?? run.processedAt) : null;
    const fnfEmployees = new Set(
      runs
        .filter((r) => r.isFnf)
        .flatMap((r) => r.lineItems.map((l) => l.employeeId)),
    );
    const out: (Omit<LoanRow, 'serial' | 'name'> & { employeeId: string })[] =
      [];

    for (const loan of loans) {
      const disbursedInMonth =
        loan.disbursementDate >= range.monthStart &&
        loan.disbursementDate <= range.monthEnd;
      const thisMonth = loan.schedule.find((s) => s.month === period);
      const recoveredHere = loan.schedule.filter(
        (s) => s.paidInPayrollRunId && runById.has(s.paidInPayrollRunId),
      );
      // An F&F settlement recovers the whole balance and deletes the unpaid schedule, so the loan
      // shows only as closed during the month.
      const settledInFnf =
        fnfEmployees.has(loan.employeeId) &&
        loan.status === LoanStatus.closed &&
        loan.updatedAt >= range.monthStart;
      if (
        !disbursedInMonth &&
        !thisMonth &&
        recoveredHere.length === 0 &&
        !settledInFnf
      ) {
        continue;
      }
      const months = loan.schedule.map((s) => s.month);
      const lastPaid = [...loan.schedule]
        .reverse()
        .find((s) => s.status === 'paid');
      const fullyPaid =
        loan.status === LoanStatus.closed ||
        (loan.schedule.length > 0 &&
          loan.schedule.every((s) => s.status === 'paid'));
      const recovered = r2(
        recoveredHere.reduce((a, s) => a + num(s.emiAmount), 0),
      );
      out.push({
        employeeId: loan.employeeId,
        type: 'Loan',
        particulars: loan.reason,
        damageDate: null,
        amount: num(loan.amount),
        instalments: loan.schedule.length,
        firstMonth: monthYear(months[0]),
        lastMonth: monthYear(months[months.length - 1]),
        completedOn: fullyPaid
          ? dateOf(runById.get(lastPaid?.paidInPayrollRunId ?? '')) ??
            indianDate(loan.updatedAt)
          : null,
        remarks: [
          disbursedInMonth
            ? `Disbursed ${ddmmyyyy(loan.disbursementDate)}`
            : '',
          recovered > 0 ? `Recovered this month ${money(recovered)}` : '',
          settledInFnf ? 'Balance recovered in F&F settlement' : '',
          thisMonth && !settledInFnf
            ? `Balance ${money(num(thisMonth.remainingBalance))}`
            : '',
          loan.remarks ?? '',
        ]
          .filter(Boolean)
          .join('; '),
      });
    }

    for (const a of advances) {
      const fromLines = lines.filter(
        (l) => l.advanceRecoveryAdvanceId === a.id,
      );
      const fromBank = bankRecoveries.filter((b) => b.salaryAdvanceId === a.id);
      const recovered = r2(
        fromLines.reduce((s, l) => s + num(l.advanceRecovered), 0) +
          fromBank.reduce((s, b) => s + num(b.amount), 0),
      );
      const recoveringRun =
        (fromLines[0] && runOfLine.get(fromLines[0].id)) ||
        (fromBank[0] && runById.get(fromBank[0].payrollRunId));
      out.push({
        employeeId: a.employeeId,
        type: 'Advance',
        particulars: a.reason,
        damageDate: null,
        amount: num(a.amount),
        instalments: 1,
        firstMonth: monthYear(a.recoveryMonth),
        lastMonth: monthYear(a.recoveryMonth),
        completedOn:
          a.status === SalaryAdvanceStatus.closed
            ? dateOf(recoveringRun || undefined) ?? indianDate(a.updatedAt)
            : null,
        remarks: [
          a.disbursedOn ? `Disbursed ${ddmmyyyy(a.disbursedOn)}` : '',
          recovered > 0 ? `Recovered this month ${money(recovered)}` : '',
          num(a.outstandingBalance) > 0
            ? `Balance ${money(num(a.outstandingBalance))}`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
      });
    }

    for (const f of fuel) {
      const recoveredNow = fuelApplied.get(f.id) ?? 0;
      const recoveredEarlier = r2(num(f.recoveredAmount) - recoveredNow);
      const fullyRecovered = num(f.recoveredAmount) >= num(f.amount) - 0.005;
      const line = lines.find((l) =>
        parseFuelRecoveries(l.fuelRecoveries).some(
          (x) => x.recoveryId === f.id,
        ),
      );
      out.push({
        employeeId: f.employeeId,
        type: 'Damage/Loss',
        particulars: [
          'Fuel shortage recovery',
          f.fuelVarianceException?.reason ?? '',
        ]
          .filter(Boolean)
          .join(' - '),
        damageDate: f.fuelVarianceException?.fuelEntry?.date ?? null,
        amount: num(f.amount),
        instalments: 1,
        // Recovered as each month's headroom allows, so the first month is only known when
        // nothing was taken before this one.
        firstMonth: recoveredEarlier > 0.005 ? '' : monthYear(period),
        lastMonth: fullyRecovered ? monthYear(period) : '',
        completedOn: fullyRecovered
          ? dateOf(line ? runOfLine.get(line.id) : undefined)
          : null,
        remarks: [
          recoveredEarlier > 0.005
            ? `Recovered earlier ${money(recoveredEarlier)}`
            : '',
          `Recovered this month ${money(recoveredNow)}`,
          fullyRecovered
            ? ''
            : `Balance ${money(r2(num(f.amount) - num(f.recoveredAmount)))}`,
        ]
          .filter(Boolean)
          .join('; '),
      });
    }

    return out
      .flatMap(({ employeeId, ...r }) => {
        const p = person.get(employeeId);
        return p ? [{ ...r, serial: p.serial, name: p.name }] : [];
      })
      .sort((a, b) => a.serial - b.serial);
  }
}

interface SheetContext {
  year: number;
  month: number;
  daysInMonth: number;
  monthStart: Date;
  monthEnd: Date;
  monthLabel: string;
  establishmentLine: string;
  projectLine: string;
}

// ── Sheet A: Employee Register ───────────────────────────────────────────────

function writeEmployeeRegister(ws: ExcelJS.Worksheet, people: Person[]) {
  const headers = [
    'Sr.',
    'Name',
    'Father name',
    'Designation',
    'Contact No.',
    'Adhaar card',
    'DOB',
    'Pan card',
    'Account number',
    'IFSC Code',
    'Bank name',
    'UAN Number',
    'Address',
    'Remarks',
  ];
  headers.forEach((h, i) => (ws.getCell(1, i + 1).value = h));
  styleHeader(ws, 1, 1, headers.length);
  people.forEach((p, i) => {
    const r = i + 2;
    const values: ExcelJS.CellValue[] = [
      p.serial,
      p.name,
      p.fatherName || null,
      p.designation || null,
      p.mobile || null,
      p.aadhaar || null,
      p.dob,
      p.pan || null,
      p.account || null,
      p.ifsc || null,
      p.bankName || null,
      p.uan || null,
      p.address || null,
      [
        p.joinedThisMonth ? NEW_JOINING : '',
        p.leftThisMonth && p.left ? `${LEFT} on ${ddmmyyyy(p.left)}` : '',
        p.decryptFailed ? 'Stored ID/bank details could not be read' : '',
      ]
        .filter(Boolean)
        .join('; ') || null,
    ];
    values.forEach((v, c) => (ws.getCell(r, c + 1).value = v));
    ws.getCell(r, 7).numFmt = DATE;
    styleBody(ws, r, 1, headers.length);
  });
  // Long digit strings stay text: Excel would print an Aadhaar or account number as 1.23E+11 and
  // drop an account's leading zeros.
  for (const c of [5, 6, 9, 12]) ws.getColumn(c).numFmt = '@';
  [6, 24, 22, 18, 13, 15, 11, 12, 20, 13, 22, 15, 40, 22].forEach(
    (w, i) => (ws.getColumn(i + 1).width = w),
  );
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: '1:1',
  };
}

// ── Sheet B: Form B, Wage Register ───────────────────────────────────────────

const WAGE_COLUMNS = [
  'Sl. No. in Employee register',
  'EMP.CODE',
  'PF.NO.',
  'ESIC.NO.',
  'Name',
  'Category Address *(HS/S/SS/US)',
  'Gross Salary',
  'Rate of\nWages',
  'No. of Days worked',
  'Overtime hours worked',
  'Basic',
  'Special\nBasic',
  'DA',
  'Payments\nOvertime',
  'HRA',
  '*Others',
  'Total',
  // R..Y sit under one "Deduction" heading.
  'PF',
  'ESIC',
  'Society',
  'Income Tax',
  'Insurance',
  'Others\n(Prof. Tax)',
  'Recoveries',
  'Total',
  'Net\nPayment',
  'Employer Share PF Welfare Fund',
  'Receipt by Employee/Bank\nTransaction ID',
  'Date of Payment',
  'Remarks',
  'PF GROSS',
  'ESIC GROSS',
  'PF',
  'ESIC',
  'ESIC\n(Employer)',
];
const DEDUCTION_FIRST = 18; // R
const DEDUCTION_LAST = 25; // Y
const WAGE_LAST = WAGE_COLUMNS.length; // AI
const WAGE_FIRST_ROW = 12;

function writeWageRegister(
  ws: ExcelJS.Worksheet,
  people: Person[],
  ctx: SheetContext,
) {
  const col = (n: number) => ws.getColumn(n).letter;
  const title = (row: number, text: ExcelJS.CellValue, bold = true) => {
    ws.mergeCells(row, 1, row, WAGE_LAST);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { ...FONT, bold, size: bold ? 11 : 9 };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
  };
  title(1, 'FORM B');
  title(2, 'WAGE REGISTER');
  title(3, 'Rate of Minimum Wages and since the date -', false);
  title(4, ctx.projectLine, false);
  ws.getRow(4).height = 30;
  title(5, ctx.establishmentLine, false);
  title(
    6,
    `Wage period: ${ddmmyyyy(ctx.monthStart)} to ${ddmmyyyy(ctx.monthEnd)}`,
    false,
  );
  title(7, 'Overtime: hours and payment as shown in columns J and N', false);
  title(8, `Month of ${ctx.monthLabel}`);
  title(9, '(Monthly/Fortnightly/Weekly/Daily/Piece Rated) - Monthly', false);

  // Header rows 10-11: each heading merged down the pair, "Deduction" over R..Y.
  WAGE_COLUMNS.forEach((label, i) => {
    const c = i + 1;
    if (c >= DEDUCTION_FIRST && c <= DEDUCTION_LAST) {
      ws.getCell(11, c).value = label;
    } else {
      ws.mergeCells(10, c, 11, c);
      ws.getCell(10, c).value = label;
    }
  });
  ws.mergeCells(10, DEDUCTION_FIRST, 10, DEDUCTION_LAST);
  ws.getCell(10, DEDUCTION_FIRST).value = 'Deduction';
  styleHeader(ws, 10, 1, WAGE_LAST);
  styleHeader(ws, 11, 1, WAGE_LAST);
  ws.getRow(10).height = 30;
  ws.getRow(11).height = 30;

  const money = new Set<number>([
    7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    31, 32, 33, 34, 35,
  ]);
  people.forEach((p, i) => {
    const r = WAGE_FIRST_ROW + i;
    const w = p.wages;
    const set = (c: number, v: ExcelJS.CellValue) =>
      (ws.getCell(r, c).value = v);
    set(1, p.serial);
    set(2, p.code);
    set(3, p.pfNo || null);
    set(4, p.esicNo || null);
    set(5, p.name);
    set(6, p.category || null);
    set(7, p.monthlyGross);
    set(8, p.monthlyBasic);
    if (w) {
      set(9, w.daysWorked);
      set(10, w.otHours);
      set(11, w.basic);
      set(12, 0);
      set(13, 0);
      set(14, w.otPayment);
      set(15, w.hra);
      set(16, w.others);
      set(17, {
        formula: `SUM(${col(11)}${r}:${col(16)}${r})`,
        result: w.total,
      });
      set(18, w.pf);
      set(19, w.esic);
      set(20, 0);
      set(21, w.incomeTax);
      set(22, 0);
      set(23, w.otherDeductions);
      set(24, w.recoveries);
      set(25, {
        formula: `SUM(${col(18)}${r}:${col(24)}${r})`,
        result: w.totalDeductions,
      });
      // The amount actually paid. Not a formula: net pay is floored where deductions exceed the
      // salary, and a formula would then show a figure nobody was paid.
      set(26, w.netPayment);
      set(27, w.employerPf);
      if (p.paidOn) {
        set(28, p.paymentMode.includes('cash') ? 'Cash' : 'Bank transfer');
        set(29, p.paidOn);
      }
      set(31, p.pfGross);
      set(32, r2(p.esicGross));
      set(33, w.pf);
      set(34, w.esic);
      set(35, w.employerEsic);
    }
    set(30, wageRemarks(p) || null);
    ws.getCell(r, 29).numFmt = DATE;
    styleBody(ws, r, 1, WAGE_LAST);
    for (const c of money) ws.getCell(r, c).numFmt = MONEY;
  });

  // Total row.
  const last = WAGE_FIRST_ROW + Math.max(people.length, 1) - 1;
  const totalRow = WAGE_FIRST_ROW + Math.max(people.length, 1);
  ws.mergeCells(totalRow, 1, totalRow, 6);
  ws.getCell(totalRow, 1).value = 'TOTAL';
  const summed = [7, 8, 9, 10, ...[...money].filter((c) => c > 10)];
  for (const c of summed) {
    const result = r2(
      people.reduce((a, p) => {
        const v = ws.getCell(WAGE_FIRST_ROW + people.indexOf(p), c).value;
        const n =
          typeof v === 'number'
            ? v
            : v && typeof v === 'object' && 'result' in v
            ? Number(v.result ?? 0)
            : 0;
        return a + n;
      }, 0),
    );
    ws.getCell(totalRow, c).value = {
      formula: `SUM(${col(c)}${WAGE_FIRST_ROW}:${col(c)}${last})`,
      result,
    };
    if (money.has(c)) ws.getCell(totalRow, c).numFmt = MONEY;
  }
  for (let c = 1; c <= WAGE_LAST; c++) {
    const cell = ws.getCell(totalRow, c);
    cell.font = { ...FONT, bold: true };
    cell.fill = TOTAL_FILL;
    cell.border = THIN;
  }

  const widths = [
    8, 10, 14, 13, 22, 11, 11, 10, 8, 9, 10, 8, 7, 10, 10, 10, 11, 9, 9, 8, 9,
    9, 9, 10, 10, 11, 11, 14, 11, 28, 11, 11, 9, 9, 9,
  ];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (const c of [3, 4]) ws.getColumn(c).numFmt = '@';
  ws.views = [{ state: 'frozen', xSplit: 5, ySplit: 11 }];
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: '10:11',
  };
}

function wageRemarks(p: Person): string {
  const w = p.wages;
  const notes: string[] = [];
  if (p.joinedThisMonth && p.joined)
    notes.push(`${NEW_JOINING} ${ddmmyyyy(p.joined)}`);
  if (p.leftThisMonth && p.left) notes.push(`${LEFT} on ${ddmmyyyy(p.left)}`);
  if (!w) {
    notes.push(
      p.leftThisMonth
        ? 'Not paid in this month’s payroll (F&F pending)'
        : 'Not in this month’s payroll',
    );
    return notes.join('; ');
  }
  if (p.isFnf) notes.push('Full & final settlement');
  if (p.isFnf && w.otherDeductions > 0)
    notes.push('Deduction Others = F&F statutory deductions');
  if (w.reimbursement > 0)
    notes.push(`*Others include reimbursement ${money(w.reimbursement)}`);
  if (Math.abs(w.total - w.totalDeductions - w.netPayment) > 0.01) {
    notes.push('Deductions exceed wages; net pay limited to what was paid');
  }
  if (p.bankRecovered > 0)
    notes.push(
      `Advance ${money(p.bankRecovered)} recovered from the bank transfer`,
    );
  if (p.edited) notes.push('Figures edited in payroll');
  return notes.join('; ');
}

// ── Sheet C: Form C, Register of Loans / Recoveries ──────────────────────────

function writeLoanRegister(
  ws: ExcelJS.Worksheet,
  rows: LoanRow[],
  ctx: SheetContext,
) {
  const LAST = 13;
  const title = (row: number, text: string, bold = true) => {
    ws.mergeCells(row, 1, row, LAST);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { ...FONT, bold, size: bold ? 11 : 9 };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
  };
  title(1, 'FORM C');
  title(2, 'REGISTER OF LOAN/RECOVERIES');
  title(3, ctx.establishmentLine, false);
  ws.getRow(3).height = 28;

  const headers = [
    'Sl. Number In Employee register',
    'Name',
    'Recovery Type\n(Damage/loss/fine/advance/loans)',
    'Particulars',
    'Date of damage/Loss*',
    'Amount',
    'Whether show cause issued*',
    'Explanation heard in presence of*',
    'Number of Instalments',
    'First Month/Year',
    'Last Month/Year',
    'Date of Complete\nRecovery',
    'Remarks',
  ];
  headers.forEach((h, i) => {
    ws.getCell(5, i + 1).value = h;
    ws.getCell(6, i + 1).value = String(i + 1);
  });
  styleHeader(ws, 5, 1, LAST);
  styleHeader(ws, 6, 1, LAST);
  ws.getRow(5).height = 42;

  if (rows.length === 0) {
    // As the client writes it when there is nothing to record.
    ws.mergeCells(7, 1, 9, LAST);
    const cell = ws.getCell(7, 1);
    cell.value = 'NIL';
    cell.font = { ...FONT, bold: true, size: 12 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN;
  }
  rows.forEach((row, i) => {
    const r = 7 + i;
    const values: ExcelJS.CellValue[] = [
      row.serial,
      row.name,
      row.type,
      row.particulars || null,
      row.damageDate,
      row.amount,
      // Show cause and explanation apply to a fine or damage; the system does not record them,
      // so they are left for the establishment to fill in rather than claimed either way.
      row.type === 'Damage/Loss' ? null : 'N/A',
      row.type === 'Damage/Loss' ? null : 'N/A',
      row.instalments,
      row.firstMonth || null,
      row.lastMonth || null,
      row.completedOn,
      row.remarks || null,
    ];
    values.forEach((v, c) => (ws.getCell(r, c + 1).value = v));
    ws.getCell(r, 5).numFmt = DATE;
    ws.getCell(r, 6).numFmt = MONEY;
    ws.getCell(r, 12).numFmt = DATE;
    styleBody(ws, r, 1, LAST);
  });
  [8, 22, 16, 28, 12, 12, 12, 14, 11, 11, 11, 13, 40].forEach(
    (w, i) => (ws.getColumn(i + 1).width = w),
  );
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };
}

// ── Sheet D: Form D, Attendance Register ─────────────────────────────────────

const A_FIRST_DAY = 8; // H
const A_LAST_DAY = A_FIRST_DAY + DAY_COLUMNS - 1; // AL
const A_PAY_DAYS = A_LAST_DAY + 1; // AM
const A_WEEKLY_OFF = A_PAY_DAYS + 1; // AN
const A_HOLIDAY = A_PAY_DAYS + 2; // AO
const A_PRESENT = A_PAY_DAYS + 3; // AP
const A_TOTAL = A_PAY_DAYS + 4; // AQ
const A_REMARKS = A_PAY_DAYS + 5; // AR
const A_FIRST_ROW = 10;

function writeAttendanceRegister(
  ws: ExcelJS.Worksheet,
  people: Person[],
  ctx: SheetContext,
) {
  const col = (n: number) => ws.getColumn(n).letter;
  const period = `${ddmmyyyy(ctx.monthStart)} TO ${ddmmyyyy(ctx.monthEnd)}`;
  const title = (row: number, text: string, bold = true) => {
    ws.mergeCells(row, 1, row, A_REMARKS);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { ...FONT, bold, size: bold ? 11 : 9 };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
  };
  title(1, 'FORM D');
  title(2, 'ATTENDANCE REGISTER');
  title(3, ctx.establishmentLine, false);
  ws.getRow(3).height = 28;
  ws.mergeCells(5, 1, 5, 7);
  ws.getCell(5, 1).value = `For the period From ${period}`;
  ws.getCell(5, 1).font = { ...FONT, bold: true };
  ws.mergeCells(5, A_FIRST_DAY, 5, A_LAST_DAY);
  ws.getCell(5, A_FIRST_DAY).value =
    'P = Present   A = Absent   O = Weekly off   H = Holiday   L = Leave';
  ws.getCell(5, A_FIRST_DAY).font = { ...FONT, italic: true };
  ws.mergeCells(6, A_PAY_DAYS, 6, A_TOTAL);
  ws.getCell(6, A_PAY_DAYS).value = 'SALARY SHEET PAY DAYS';
  ws.getCell(6, A_PAY_DAYS).font = { ...FONT, bold: true };
  ws.getCell(6, A_PAY_DAYS).alignment = { horizontal: 'center' };

  const lead = [
    'Sl. Number in\nEmployee register',
    'EMP. CODE',
    'Name',
    'Relay# or set work',
    'Category Address *(HS/S/SS/US)',
    'LOCATION',
    'DOJ',
  ];
  lead.forEach((label, i) => {
    ws.mergeCells(7, i + 1, 9, i + 1);
    ws.getCell(7, i + 1).value = label;
  });
  ws.mergeCells(7, A_FIRST_DAY, 7, A_LAST_DAY);
  ws.getCell(7, A_FIRST_DAY).value = `PLACE OF WORK*Date ${period}`;
  for (let d = 1; d <= DAY_COLUMNS; d++) {
    const c = A_FIRST_DAY + d - 1;
    if (d <= ctx.daysInMonth) {
      const date = new Date(Date.UTC(ctx.year, ctx.month - 1, d));
      ws.getCell(8, c).value = d;
      ws.getCell(9, c).value = WEEKDAY_LETTER[date.getUTCDay()];
    }
  }
  const tail = [
    'Summary No. of Days',
    'Weekly off',
    'Holiday',
    'PRESENT',
    'Total',
    'REMARKS',
  ];
  tail.forEach((label, i) => {
    ws.mergeCells(7, A_PAY_DAYS + i, 9, A_PAY_DAYS + i);
    ws.getCell(7, A_PAY_DAYS + i).value = label;
  });
  for (const r of [7, 8, 9]) styleHeader(ws, r, 1, A_REMARKS);

  people.forEach((p, i) => {
    const r = A_FIRST_ROW + i;
    const set = (c: number, v: ExcelJS.CellValue) =>
      (ws.getCell(r, c).value = v);
    set(1, p.serial);
    set(2, p.code);
    set(3, p.name);
    set(4, p.designation || null);
    set(5, p.category || null);
    set(6, p.siteName || null);
    set(7, p.joined);
    ws.getCell(r, 7).numFmt = DATE;

    const codes = p.codes.slice(0, ctx.daysInMonth);
    codes.forEach((code, d) => set(A_FIRST_DAY + d, code));
    styleBody(ws, r, 1, A_REMARKS);
    for (let c = A_FIRST_DAY; c <= A_LAST_DAY; c++) {
      const cell = ws.getCell(r, c);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (cell.value === 'A') {
        cell.font = { ...FONT, bold: true, color: { argb: 'FFC00000' } };
      }
    }
    // Days before joining and after leaving: one merged, labelled span, as the client marks them.
    const spans = blankSpans(codes);
    for (const [from, to] of spans) {
      const label =
        from === 0 && p.joined && p.joinedThisMonth ? NEW_JOINING : LEFT;
      const c1 = A_FIRST_DAY + from;
      const c2 = A_FIRST_DAY + to;
      if (c2 > c1) ws.mergeCells(r, c1, r, c2);
      const cell = ws.getCell(r, c1);
      cell.value = label;
      cell.font = { ...FONT, italic: true, color: { argb: 'FF808080' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    const days = `${col(A_FIRST_DAY)}${r}:${col(A_LAST_DAY)}${r}`;
    const count = (code: string) => codes.filter((c) => c === code).length;
    if (p.payDays !== null) {
      set(A_PAY_DAYS, p.payDays);
    }
    set(A_WEEKLY_OFF, { formula: `COUNTIF(${days},"O")`, result: count('O') });
    set(A_HOLIDAY, { formula: `COUNTIF(${days},"H")`, result: count('H') });
    set(A_PRESENT, { formula: `COUNTIF(${days},"P")`, result: count('P') });
    const total = count('O') + count('H') + count('P') + count('L');
    set(A_TOTAL, {
      formula: `${col(A_WEEKLY_OFF)}${r}+${col(A_HOLIDAY)}${r}+${col(
        A_PRESENT,
      )}${r}+COUNTIF(${days},"L")`,
      result: total,
    });
    const notes: string[] = [];
    if (count('L'))
      notes.push(`Leave ${count('L')} day${count('L') > 1 ? 's' : ''}`);
    if (count('A')) notes.push(`Absent ${count('A')}`);
    if (p.payDays === null) notes.push('Not in this month’s payroll');
    else if (Math.abs(p.payDays - total) > 0.001)
      notes.push(`Pay days ${p.payDays} as settled in payroll`);
    set(A_REMARKS, notes.join('; ') || null);
  });

  const last = A_FIRST_ROW + Math.max(people.length, 1) - 1;
  const totalRow = A_FIRST_ROW + Math.max(people.length, 1);
  ws.mergeCells(totalRow, 1, totalRow, 7);
  ws.getCell(totalRow, 1).value = 'TOTAL';
  const results: Record<number, number> = {
    [A_PAY_DAYS]: people.reduce((a, p) => a + (p.payDays ?? 0), 0),
    [A_WEEKLY_OFF]: people.reduce(
      (a, p) => a + p.codes.filter((c) => c === 'O').length,
      0,
    ),
    [A_HOLIDAY]: people.reduce(
      (a, p) => a + p.codes.filter((c) => c === 'H').length,
      0,
    ),
    [A_PRESENT]: people.reduce(
      (a, p) => a + p.codes.filter((c) => c === 'P').length,
      0,
    ),
    [A_TOTAL]: people.reduce(
      (a, p) => a + p.codes.filter((c) => c && c !== 'A').length,
      0,
    ),
  };
  for (const c of [A_PAY_DAYS, A_WEEKLY_OFF, A_HOLIDAY, A_PRESENT, A_TOTAL]) {
    ws.getCell(totalRow, c).value = {
      formula: `SUM(${col(c)}${A_FIRST_ROW}:${col(c)}${last})`,
      result: r2(results[c]),
    };
  }
  for (let c = 1; c <= A_REMARKS; c++) {
    const cell = ws.getCell(totalRow, c);
    cell.font = { ...FONT, bold: true };
    cell.fill = TOTAL_FILL;
    cell.border = THIN;
  }

  [7, 10, 22, 16, 9, 16, 11].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (let c = A_FIRST_DAY; c <= A_LAST_DAY; c++) ws.getColumn(c).width = 3.6;
  for (let c = A_PAY_DAYS; c <= A_TOTAL; c++) ws.getColumn(c).width = 9;
  ws.getColumn(A_REMARKS).width = 30;
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 9 }];
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: '7:9',
  };
}

/** Index ranges of consecutive nulls (before joining / after leaving) in a row of day codes. */
export function blankSpans(codes: (string | null)[]): [number, number][] {
  const spans: [number, number][] = [];
  let start = -1;
  codes.forEach((c, i) => {
    if (c === null && start < 0) start = i;
    if (c !== null && start >= 0) {
      spans.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) spans.push([start, codes.length - 1]);
  return spans;
}

// ── Shared ───────────────────────────────────────────────────────────────────

function styleHeader(
  ws: ExcelJS.Worksheet,
  row: number,
  from: number,
  to: number,
) {
  for (let c = from; c <= to; c++) {
    const cell = ws.getCell(row, c);
    cell.font = { ...FONT, bold: true };
    cell.fill = HEADER_FILL;
    cell.border = THIN;
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
  }
}

function styleBody(
  ws: ExcelJS.Worksheet,
  row: number,
  from: number,
  to: number,
) {
  for (let c = from; c <= to; c++) {
    const cell = ws.getCell(row, c);
    cell.font = FONT;
    cell.border = THIN;
    cell.alignment = { vertical: 'middle', wrapText: c === to };
  }
}

/**
 * The date a person's pay went out, as a date in India: the latest `paidAt` of the runs that paid
 * them, or null while any of those runs is not yet marked paid.
 */
function paidOnFor(
  runs: ({ status: PayrollRunStatus; paidAt: Date | null } | undefined)[],
): Date | null {
  if (runs.length === 0) return null;
  const dates: Date[] = [];
  for (const r of runs) {
    if (!r || r.status !== PayrollRunStatus.paid || !r.paidAt) return null;
    dates.push(r.paidAt);
  }
  return indianDate(new Date(Math.max(...dates.map((d) => d.getTime()))));
}

/** A timestamp as the calendar date it falls on in India (UTC+5:30), at UTC midnight. */
function indianDate(at: Date | null): Date | null {
  if (!at) return null;
  const ist = new Date(at.getTime() + 330 * 60_000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/** `items.map(fn)` with at most `size` calls in flight, results in input order. */
async function mapInBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function ddmmyyyy(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(
    d.getUTCMonth() + 1,
  ).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

/** "2026-07" → "07/2026". */
function monthYear(period: string | undefined): string {
  if (!period) return '';
  const [y, m] = period.split('-');
  return m && y ? `${m}/${y}` : period;
}

function money(n: number): string {
  return `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function filenamePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Company'
  );
}
