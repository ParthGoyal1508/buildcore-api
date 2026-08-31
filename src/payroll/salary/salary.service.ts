import { Injectable, NotFoundException } from '@nestjs/common';
import { PayrollRunStatus, SalarySlip } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { EmployeesService } from '../../hr/employees/employees.service';

/** Payroll runs an employee may see a slip for. A `draft` run has no publishable
 * figures — its numbers are still being worked on (FR-024). */
const PUBLISHED_STATUSES = [
  PayrollRunStatus.processed,
  PayrollRunStatus.paid,
] as const;

/** The payslip projection served as JSON and rendered to PDF (data-model.md
 * "Salary Slip"). Grouped rather than flat, because that is how a payslip reads. */
export interface SalarySlipView {
  period: string;
  employeeCode: string;
  monthDays: number;
  payableDays: number;
  lopDays: number;
  otHours: number;
  earnings: {
    basic: number;
    hra: number;
    conveyance: number;
    siteAllowance: number;
    specialAllowance: number;
    ot: number;
    total: number;
  };
  deductions: {
    pf: number;
    esic: number;
    pt: number;
    tds: number;
    loanEmi: number;
    advanceRecovery: number;
    total: number;
  };
  /** Informational only — shown to the employee, never subtracted from net pay. */
  employerContributions: {
    pf: number;
    eps: number;
    edli: number;
    adminCharges: number;
    gratuity: number;
    bonus: number;
    total: number;
  };
  netPay: number;
  netPayInWords: string;
  minimumWagesNote: string | null;
}

/**
 * Salary slip retrieval (US5).
 *
 * This service formats a payslip; it never computes one. The figures come from
 * `payroll.SalarySlip`, written by whichever feature owns payroll processing — so
 * a slip served here and a slip printed by payroll can never disagree.
 */
@Injectable()
export class SalaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
  ) {}

  /** Periods whose run has been processed or paid (FR-024). */
  async getAvailablePeriods(caller: Caller): Promise<string[]> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const runs = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findMany({
        where: {
          companyId: employee.companyId,
          status: { in: [...PUBLISHED_STATUSES] },
        },
        select: { period: true },
        orderBy: { period: 'desc' },
      }),
    );

    // Intersected with the employee's own slips: a run being published says the
    // company's payroll is done, not that this particular employee has a slip in
    // it (a mid-month joiner may not). Offering a period with nothing behind it
    // would send the employee to a 404.
    const slips = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salarySlip.findMany({
        where: { employeeId: employee.id },
        select: { period: true },
      }),
    );
    const owned = new Set(slips.map((s) => s.period));

    return runs.map((r) => r.period).filter((period) => owned.has(period));
  }

  /** The caller's own slip for a published period (FR-025). */
  async getSlip(caller: Caller, period: string): Promise<SalarySlipView> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { companyId: employee.companyId, period },
      }),
    );
    // Same 404 for "no run", "still draft", and "no slip". Distinguishing them
    // would tell the caller whether a payroll period exists and how far along it
    // is, which is not their business to learn from a 404.
    if (!run || !PUBLISHED_STATUSES.includes(run.status as never)) {
      throw new NotFoundException(
        `No published salary slip exists for ${period}.`,
      );
    }

    const slip = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.salarySlip.findFirst({ where: { employeeId: employee.id, period } }),
    );
    if (!slip) {
      throw new NotFoundException(
        `No published salary slip exists for ${period}.`,
      );
    }

    return toView(slip, employee.employeeCode);
  }
}

const n = (value: { toNumber(): number }): number => value.toNumber();
const sum = (...values: number[]): number =>
  Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

function toView(slip: SalarySlip, employeeCode: string): SalarySlipView {
  const earnings = {
    basic: n(slip.earningBasic),
    hra: n(slip.earningHra),
    conveyance: n(slip.earningConveyance),
    siteAllowance: n(slip.earningSiteAllowance),
    specialAllowance: n(slip.earningSpecialAllowance),
    ot: n(slip.earningOt),
  };
  const deductions = {
    pf: n(slip.deductionPf),
    esic: n(slip.deductionEsic),
    pt: n(slip.deductionPt),
    tds: n(slip.deductionTds),
    loanEmi: n(slip.deductionLoanEmi),
    advanceRecovery: n(slip.deductionAdvanceRecovery),
  };
  const employerContributions = {
    pf: n(slip.employerPf),
    eps: n(slip.employerEps),
    edli: n(slip.employerEdli),
    adminCharges: n(slip.employerAdminCharges),
    gratuity: n(slip.employerGratuity),
    bonus: n(slip.employerBonus),
  };

  const netPay = n(slip.netPay);
  return {
    period: slip.period,
    employeeCode,
    monthDays: slip.monthDays,
    payableDays: n(slip.payableDays),
    lopDays: n(slip.lopDays),
    otHours: n(slip.otHours),
    earnings: { ...earnings, total: sum(...Object.values(earnings)) },
    deductions: { ...deductions, total: sum(...Object.values(deductions)) },
    employerContributions: {
      ...employerContributions,
      total: sum(...Object.values(employerContributions)),
    },
    netPay,
    netPayInWords: rupeesInWords(netPay),
    minimumWagesNote: slip.minimumWagesNote,
  };
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

/** Under 100, spelled out. */
function twoDigitsInWords(value: number): string {
  if (value < 20) {
    return ONES[value];
  }
  const tens = TENS[Math.floor(value / 10)];
  const ones = ONES[value % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * A non-negative integer in words, on the Indian numbering system.
 *
 * The crore group recurses rather than calling `twoDigitsInWords` directly: a
 * figure of a hundred crore or more has a three-digit crore count, and spelling it
 * with a two-digit speller would silently produce `undefined` in the middle of a
 * payslip.
 */
function integerInWords(value: number): string {
  if (value === 0) {
    return 'Zero';
  }

  const groups: Array<[number, string]> = [
    [10_000_000, 'Crore'],
    [100_000, 'Lakh'],
    [1_000, 'Thousand'],
    [100, 'Hundred'],
  ];

  let remainder = value;
  const parts: string[] = [];
  for (const [divisor, label] of groups) {
    const count = Math.floor(remainder / divisor);
    if (count > 0) {
      parts.push(
        `${
          count >= 100 ? integerInWords(count) : twoDigitsInWords(count)
        } ${label}`,
      );
      remainder %= divisor;
    }
  }
  if (remainder > 0) {
    parts.push(twoDigitsInWords(remainder));
  }
  return parts.join(' ');
}

/**
 * A rupee amount in words, on the Indian numbering system (lakh/crore).
 *
 * Not a generic English number speller: an Indian payslip is expected to read
 * "One Lakh Twenty Thousand", and rendering "One Hundred Twenty Thousand" on a
 * statutory wage document would look wrong to every person who receives one.
 */
export function rupeesInWords(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '';
  }
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const rupees = Math.floor(absolute);
  const paise = Math.round((absolute - rupees) * 100);

  const rupeeWords = `${negative ? 'Minus ' : ''}${integerInWords(
    rupees,
  )} Rupees`;
  return paise > 0
    ? `${rupeeWords} and ${twoDigitsInWords(paise)} Paise Only`
    : `${rupeeWords} Only`;
}
