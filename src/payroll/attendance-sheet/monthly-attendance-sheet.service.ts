import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayrollRunStatus, Permission } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import {
  AttendanceHistoryService,
  type AttendanceStatus,
} from '../../hr/punch/attendance-history.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { SitesService } from '../../projects/sites/sites.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';

/** The day columns the client's sheet always carries, 31, whatever the month's length. */
const DAY_COLUMNS = 31;
/** Fixed columns before the days: Sr. No, E Code, Employee Name, Designation. */
const LEAD_COLUMNS = 4;
/** First day column (E) and the first column after the days (AJ), 1-based. */
const FIRST_DAY_COL = LEAD_COLUMNS + 1;
const PRESENT_COL = FIRST_DAY_COL + DAY_COLUMNS;
const HEADER_ROW_1 = 7;
const HEADER_ROW_2 = 8;
const FIRST_DATA_ROW = 9;
/** The sheet's own divisor: Rate = Salary / 30, whatever the month (sample column AN). */
const RATE_DIVISOR = 30;

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
/** The sample writes "Sept"; the other months take their usual three letters. */
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'June',
  'July',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The codes the client's sheet uses for a day, by the status `statusForDay` decides. */
const CODE: Record<AttendanceStatus, string> = {
  present: 'P',
  absent: 'A',
  weekly_off: 'W/O',
  holiday: 'H',
  on_leave: 'L',
};
const NEW_JOINING = 'NEW JOINING';
const LEFT = 'LEFT';

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFB4C6E7' },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFE699' },
};
const THIN: ExcelJS.Borders = {
  top: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' },
  right: { style: 'thin' },
  diagonal: {},
};
const FONT = { name: 'Arial', size: 9 };

export interface MonthlyAttendanceQuery {
  companyId: string;
  year: number;
  month: number;
  projectId?: string;
  siteId?: string;
  departmentId?: string;
}

/**
 * The monthly staff attendance download (2026-10-17), in the client's own format — the "Staff
 * Attendance" tab of `docs/Payment_Docs/06 Baireddipalle ( Phase 2,Staff Attendance Sept.- 2026.xlsx`:
 * a header block naming the company, site and month with the code legend; Sr. No, E Code, name and
 * designation; 31 day columns headed by weekday and date; then Present Days, Absent, Total Payable
 * Days, Salary, Rate, Amount and Remark, and a total row. One worksheet per site, as the client keeps
 * one per site.
 *
 * Each day's code comes from `AttendanceHistoryService` — the computation payroll and the employee's
 * own screen use — so this sheet cannot disagree with either about whether a day was worked.
 *
 * Lives in `payroll` because Total Payable Days is the payroll's figure where the month has been run,
 * and `hr` cannot read payroll (it is the other way round).
 */
@Injectable()
export class MonthlyAttendanceSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: AttendanceHistoryService,
    private readonly sites: SitesService,
    private readonly projects: ProjectsService,
    private readonly referenceData: ReferenceDataService,
  ) {}

  async build(
    caller: Caller,
    user: AuthenticatedUser,
    query: MonthlyAttendanceQuery,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { year, month } = query;
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));
    const daysInMonth = monthEnd.getUTCDate();
    const period = `${year}-${String(month).padStart(2, '0')}`;

    const company = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.company.findFirst({
        where: { id: query.companyId },
        select: { id: true, name: true },
      }),
    );
    if (!company) throw new NotFoundException('Company not found');

    // Sites in scope: one, a project's, or all of the company's.
    const companySites = await this.sites.listForCompany(
      caller.rls,
      company.id,
    );
    let siteIds = companySites.map((s) => s.id);
    if (query.siteId) {
      if (!siteIds.includes(query.siteId)) {
        throw new BadRequestException(
          'That site does not belong to this company.',
        );
      }
      siteIds = [query.siteId];
    } else if (query.projectId) {
      const projectSites = await this.projects.getSitesByProject(
        query.projectId,
        caller.rls,
      );
      siteIds = siteIds.filter((id) => projectSites.includes(id));
    }
    const siteName = new Map(companySites.map((s) => [s.id, s.name]));

    // Everyone employed at some point in the month: joined by its end, not gone before its start.
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: {
          companyId: company.id,
          siteId: { in: siteIds },
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: monthEnd } }],
        },
        orderBy: [{ siteId: 'asc' }, { employeeCode: 'asc' }],
      }),
    );
    const exits = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.exitRecord.findMany({
        where: { employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true, lastWorkingDay: true },
      }),
    );
    const lastDay = new Map(exits.map((e) => [e.employeeId, e.lastWorkingDay]));
    const inMonth = employees.filter((e) => {
      const left = lastDay.get(e.id);
      return !left || left >= monthStart;
    });

    // Payable days as payroll settled them, where the month has been run.
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: {
          companyId: company.id,
          period,
          isFnf: false,
          status: { not: PayrollRunStatus.draft },
        },
        include: {
          lineItems: { select: { employeeId: true, payableDays: true } },
        },
      }),
    );
    const payrollDays = new Map(
      (run?.lineItems ?? []).map((l) => [
        l.employeeId,
        l.payableDays.toNumber(),
      ]),
    );

    const designations = await this.referenceData.findAll(
      'designation',
      user,
      company.id,
    );
    const designationName = new Map(
      designations.map((d) => [d.id as string, String(d.name ?? '')]),
    );

    // Salary is shown only to someone who may see pay.
    const showPay = user.permissions.includes(Permission.PAYROLL);

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const bySite = new Map<string, typeof inMonth>();
    for (const e of inMonth) {
      bySite.set(e.siteId, [...(bySite.get(e.siteId) ?? []), e]);
    }
    const sheetSites = siteIds.filter((id) => bySite.has(id));
    if (sheetSites.length === 0) {
      // An empty workbook would open as nothing at all; one empty sheet says what was asked.
      sheetSites.push(siteIds[0] ?? '');
    }

    const usedNames = new Set<string>();
    for (const siteId of sheetSites) {
      const people = bySite.get(siteId) ?? [];
      const rows = await Promise.all(
        people.map(async (e) => {
          const days = await this.history.getMonthForEmployee(
            caller,
            {
              id: e.id,
              siteId: e.siteId,
              shiftId: e.shiftId,
              companyId: e.companyId,
            },
            month,
            year,
          );
          const joined = e.dateOfJoining;
          const left = lastDay.get(e.id);
          const codes = days.days.map((d) => {
            const date = new Date(`${d.date}T00:00:00.000Z`);
            if (joined && date < joined) return NEW_JOINING;
            if (left && date > left) return LEFT;
            return CODE[d.status];
          });
          const count = (code: string) =>
            codes.filter((c) => c === code).length;
          const present = count('P');
          // Without a run for the month, the days the calendar pays for: worked, weekly offs,
          // holidays and approved leave. Marked provisional in the remark.
          const provisional = !payrollDays.has(e.id);
          const payable = provisional
            ? present + count('W/O') + count('H') + count('L')
            : payrollDays.get(e.id) ?? 0;
          const salary = monthlySalary(e);
          return {
            code: e.employeeCode,
            name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
            designation: e.designationId
              ? designationName.get(e.designationId) ?? ''
              : '',
            codes,
            present,
            absent: count('A'),
            payable,
            salary: showPay ? salary : null,
            remark: [
              count('L') ? `${count('L')} LEAVE` : '',
              provisional ? 'Payroll not run' : '',
            ]
              .filter(Boolean)
              .join(', '),
          };
        }),
      );

      const name = uniqueSheetName(
        siteName.get(siteId) ?? 'Staff Attendance',
        usedNames,
      );
      this.writeSheet(workbook.addWorksheet(name), {
        companyName: company.name,
        siteLabel: siteName.get(siteId) ?? '',
        year,
        month,
        daysInMonth,
        rows,
      });
    }

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `Attendance_${filenamePart(company.name)}_${
        MONTH_NAMES[month - 1]
      }_${year}.xlsx`,
    };
  }

  private writeSheet(
    ws: ExcelJS.Worksheet,
    input: {
      companyName: string;
      siteLabel: string;
      year: number;
      month: number;
      daysInMonth: number;
      rows: {
        code: string;
        name: string;
        designation: string;
        codes: string[];
        present: number;
        absent: number;
        payable: number;
        salary: number | null;
        remark: string;
      }[];
    },
  ) {
    const col = (n: number) => ws.getColumn(n).letter;
    const lastDayCol = FIRST_DAY_COL + DAY_COLUMNS - 1;
    const [absentCol, payableCol, salaryCol, rateCol, amountCol, remarkCol] = [
      PRESENT_COL + 1,
      PRESENT_COL + 2,
      PRESENT_COL + 3,
      PRESENT_COL + 4,
      PRESENT_COL + 5,
      PRESENT_COL + 6,
    ];

    // Header block, rows 1-6, as the sample lays it out.
    ws.mergeCells('A1:C1');
    ws.getCell('A1').value = `Company: ${input.companyName}`;
    ws.mergeCells('A2:C2');
    ws.getCell('A2').value = `Site: ${input.siteLabel}`;
    ws.getCell('A3').value = 'Month:';
    ws.getCell('B3').value = MONTH_SHORT[input.month - 1];
    ws.getCell('C3').value = input.year;
    ws.getCell('D4').value = new Date(Date.UTC(input.year, input.month - 1, 1));
    ws.getCell('E4').value = 'to';
    ws.mergeCells('F4:J4');
    ws.getCell('F4').value = new Date(Date.UTC(input.year, input.month, 0));
    ws.getCell('D4').numFmt = 'dd-mmm-yy';
    ws.getCell('F4').numFmt = 'dd-mmm-yy';
    const legend: [string, string][] = [
      ['Present Days', 'P'],
      ['Absent', '"A"'],
      ['Week Off', 'W/O'],
      ['Holiday', '"H"'],
      ['Leave', 'L'],
    ];
    legend.forEach(([label, code], i) => {
      ws.mergeCells(`L${i + 1}:O${i + 1}`);
      ws.getCell(`L${i + 1}`).value = label;
      ws.getCell(`P${i + 1}`).value = code;
    });
    ws.mergeCells('A6:C6');
    ws.getCell('A6').value = 'STAFF ATTENDANCE';
    for (const addr of ['A1', 'A2', 'A3', 'A6']) {
      ws.getCell(addr).font = { ...FONT, bold: true, size: 10 };
    }

    // Two header rows: names merged down the pair, weekday over date for each day.
    const lead = ['Sr. No', 'E Code', 'Employee Name', 'Designation'];
    const tail = [
      'Present Days',
      'Absent',
      'Total Payable Days',
      'Salary',
      'Rate',
      'Amount',
      'Remark',
    ];
    lead.forEach((label, i) => {
      ws.mergeCells(HEADER_ROW_1, i + 1, HEADER_ROW_2, i + 1);
      ws.getCell(HEADER_ROW_1, i + 1).value = label;
    });
    tail.forEach((label, i) => {
      const c = PRESENT_COL + i;
      ws.mergeCells(HEADER_ROW_1, c, HEADER_ROW_2, c);
      ws.getCell(HEADER_ROW_1, c).value = label;
    });
    for (let d = 1; d <= DAY_COLUMNS; d++) {
      const c = FIRST_DAY_COL + d - 1;
      if (d <= input.daysInMonth) {
        const date = new Date(Date.UTC(input.year, input.month - 1, d));
        ws.getCell(HEADER_ROW_1, c).value = WEEKDAYS[date.getUTCDay()];
        ws.getCell(HEADER_ROW_2, c).value = date;
        ws.getCell(HEADER_ROW_2, c).numFmt = 'd';
      }
    }
    for (let c = 1; c <= remarkCol; c++) {
      for (const r of [HEADER_ROW_1, HEADER_ROW_2]) {
        const cell = ws.getCell(r, c);
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

    // One row per employee.
    input.rows.forEach((row, i) => {
      const r = FIRST_DATA_ROW + i;
      const cells: (string | number | ExcelJS.CellFormulaValue | null)[] = [
        i + 1,
        row.code,
        row.name,
        row.designation,
        ...Array.from({ length: DAY_COLUMNS }, (_, d) => row.codes[d] ?? null),
      ];
      cells.forEach((v, j) => (ws.getCell(r, j + 1).value = v));
      const days = `${col(FIRST_DAY_COL)}${r}:${col(lastDayCol)}${r}`;
      ws.getCell(r, PRESENT_COL).value = {
        formula: `COUNTIF(${days},"P")`,
        result: row.present,
      };
      ws.getCell(r, absentCol).value = {
        formula: `COUNTIF(${days},"A")`,
        result: row.absent,
      };
      ws.getCell(r, payableCol).value = row.payable;
      if (row.salary !== null) {
        const rate = row.salary / RATE_DIVISOR;
        ws.getCell(r, salaryCol).value = row.salary;
        ws.getCell(r, rateCol).value = {
          formula: `${col(salaryCol)}${r}/${RATE_DIVISOR}`,
          result: rate,
        };
        ws.getCell(r, amountCol).value = {
          formula: `${col(rateCol)}${r}*${col(payableCol)}${r}`,
          result: rate * row.payable,
        };
      }
      ws.getCell(r, remarkCol).value = row.remark || null;
      for (let c = 1; c <= remarkCol; c++) {
        const cell = ws.getCell(r, c);
        cell.font = FONT;
        cell.border = THIN;
        if (c >= FIRST_DAY_COL && c <= lastDayCol) {
          cell.alignment = { horizontal: 'center' };
          const v = String(cell.value ?? '');
          if (v === NEW_JOINING || v === LEFT) {
            cell.font = { ...FONT, size: 7, color: { argb: 'FF808080' } };
          } else if (v === 'A') {
            cell.font = { ...FONT, bold: true, color: { argb: 'FFC00000' } };
          }
        }
      }
    });

    // Total row: present count per day, then the sums the sample totals.
    const first = FIRST_DATA_ROW;
    const last = FIRST_DATA_ROW + Math.max(input.rows.length, 1) - 1;
    const totalRow = FIRST_DATA_ROW + input.rows.length;
    ws.mergeCells(totalRow, 1, totalRow, LEAD_COLUMNS);
    ws.getCell(totalRow, 1).value = 'Total';
    const sum = (c: number) => ({
      formula: `SUM(${col(c)}${first}:${col(c)}${last})`,
      result: 0,
    });
    for (let d = 0; d < input.daysInMonth; d++) {
      const c = FIRST_DAY_COL + d;
      ws.getCell(totalRow, c).value = {
        formula: `COUNTIF(${col(c)}${first}:${col(c)}${last},"P")`,
        result: input.rows.filter((r) => r.codes[d] === 'P').length,
      };
    }
    const totals: [number, number][] = [
      [PRESENT_COL, input.rows.reduce((s, r) => s + r.present, 0)],
      [absentCol, input.rows.reduce((s, r) => s + r.absent, 0)],
      [payableCol, input.rows.reduce((s, r) => s + r.payable, 0)],
    ];
    for (const [c, result] of totals) {
      ws.getCell(totalRow, c).value = { ...sum(c), result };
    }
    if (input.rows.some((r) => r.salary !== null)) {
      ws.getCell(totalRow, amountCol).value = {
        ...sum(amountCol),
        result: input.rows.reduce(
          (s, r) => s + ((r.salary ?? 0) / RATE_DIVISOR) * r.payable,
          0,
        ),
      };
    }
    for (let c = 1; c <= remarkCol; c++) {
      const cell = ws.getCell(totalRow, c);
      cell.font = { ...FONT, bold: true };
      cell.fill = TOTAL_FILL;
      cell.border = THIN;
    }

    // Widths as the sample has them.
    ws.getColumn(1).width = 6.3;
    ws.getColumn(2).width = 9.1;
    ws.getColumn(3).width = 25.9;
    ws.getColumn(4).width = 20;
    for (let c = FIRST_DAY_COL; c <= lastDayCol; c++)
      ws.getColumn(c).width = 4.9;
    for (const c of [PRESENT_COL, absentCol, payableCol])
      ws.getColumn(c).width = 9;
    for (const c of [salaryCol, rateCol, amountCol]) {
      ws.getColumn(c).width = 11;
      ws.getColumn(c).numFmt = '#,##0';
    }
    ws.getColumn(remarkCol).width = 16;
    ws.views = [
      { state: 'frozen', xSplit: LEAD_COLUMNS, ySplit: HEADER_ROW_2 },
    ];
    ws.pageSetup = {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }
}

/** The monthly gross from the employee's salary heads, or a daily rate × 30 for a daily-rated one. */
function monthlySalary(e: {
  basic: { toNumber(): number } | null;
  hra: { toNumber(): number } | null;
  conveyanceAllowance: { toNumber(): number } | null;
  siteAllowance: { toNumber(): number } | null;
  specialAllowance: { toNumber(): number } | null;
  dailyRate: { toNumber(): number } | null;
  calculationMode: string | null;
}): number {
  if (e.calculationMode === 'daily' && e.dailyRate) {
    return Math.round(e.dailyRate.toNumber() * RATE_DIVISOR * 100) / 100;
  }
  return [
    e.basic,
    e.hra,
    e.conveyanceAllowance,
    e.siteAllowance,
    e.specialAllowance,
  ]
    .map((v) => v?.toNumber() ?? 0)
    .reduce((a, b) => a + b, 0);
}

function filenamePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Company'
  );
}

/** Excel's rules: at most 31 characters, none of `\ / ? * [ ] :`, unique in the workbook. */
function uniqueSheetName(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[\\/?*[\]:]/g, ' ')
      .trim()
      .slice(0, 28) || 'Site';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base.slice(0, 26)} ${n}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
