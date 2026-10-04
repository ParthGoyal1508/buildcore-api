import { Injectable, NotFoundException } from '@nestjs/common';
import { PayrollRunStatus, SalarySlip } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { EmployeesService } from '../../hr/employees/employees.service';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';

/** Payroll runs an employee may see a slip for. A `draft` run has no publishable
 * figures — its numbers are still being worked on (FR-024). */
const PUBLISHED_STATUSES = [
  PayrollRunStatus.processed,
  PayrollRunStatus.paid,
] as const;

/** The payslip projection served as JSON and rendered to PDF (data-model.md
 * "Salary Slip"). Grouped rather than flat, because that is how a payslip reads. */
/**
 * The identity and bank block the client's payslip opens with (021 FR-008f, task T104).
 *
 * Every field is on `docs/NC0060_Payslip_Feb 2026.pdf` and none of it is on a payslip this product
 * printed before. Nullable throughout rather than defaulted to a blank string: the PDF renders an
 * em dash for an absent fact, and an empty string would print as a gap somebody would read as a
 * rendering bug. The sample itself has an empty `PF No` and still shows the label.
 */
export interface SlipIdentity {
  employeeName: string;
  companyName: string;
  /** One block, newline-separated, as the sample prints it. */
  companyAddress: string | null;
  joiningDate: Date | null;
  designation: string | null;
  department: string | null;
  location: string | null;
  bankName: string | null;
  /**
   * The employee's account number, **masked**.
   *
   * The bank transfer sheet renders it unmasked because a bank needs it to move money. A payslip
   * does not: the employee knows their own account, and a payslip is emailed, forwarded and printed.
   */
  bankAccountNumberMasked: string | null;
  panNumber: string | null;
  pfNumber: string | null;
  pfUan: string | null;
}

export interface SalarySlipView {
  period: string;
  employeeCode: string;
  /**
   * Added 2026-10-02 (T104). Optional so every existing caller and test keeps compiling — the PDF
   * renders the header block when it is present and the old centred heading when it is not.
   */
  identity?: SlipIdentity;
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
  /**
   * The same components **unprorated** — the sample's "Full" column beside its "Actual" (T105).
   *
   * `null` for a slip issued before the figures were stored, and `null` is printed as an em dash
   * rather than as the Actual figure: Full equal to Actual means "no LOP this month", and a reader
   * must be able to tell that from "we never recorded it". LOP is zero throughout the sample, so the
   * sample is **no evidence** that the two columns agree — which is why the proration is tested
   * directly rather than against it.
   */
  fullEarnings: {
    basic: number | null;
    hra: number | null;
    conveyance: number | null;
    siteAllowance: number | null;
    specialAllowance: number | null;
    ot: number | null;
    total: number | null;
  };
  deductions: {
    pf: number;
    esic: number;
    pt: number;
    tds: number;
    loanEmi: number;
    advanceRecovery: number;
    /** 020 FR-007. Fuel lost on a machine, recovered from the operator who ran it. */
    fuelRecovery: number;
    /** Summed from the fields above by `Object.values`, so a new deduction is counted the moment it
     * is added rather than when somebody remembers to extend this. */
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
    /**
     * For the PAN and the account number on the payslip's identity block (T104). The account number
     * is **masked** here, unlike on the bank transfer sheet — see `maskAccount`.
     */
    private readonly pii: PiiCipherService,
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

    const identity = await this.identityFor(caller, employee);
    return toView(slip, employee.employeeCode, identity);
  }

  /**
   * The identity and bank block the payslip opens with (021 FR-008f, task T104).
   *
   * Two extra reads, both small and both unavoidable: the department and designation are **ids** on
   * `Employee` with no Prisma relation — `settings.Department` is in another schema and Principle I
   * forbids the join — and the company block lives in `settings.Company`.
   *
   * The company is read with `isSuperAdmin: true` for the reason every company read in this codebase
   * is: `Company` is the tenant root and has no `companyId` of its own to match a policy against.
   *
   * **Failures here degrade the block, never the payslip.** A missing designation prints an em dash;
   * it does not fail the request. An employee cannot be left unable to see their pay because a
   * reference table was unreachable.
   */
  private async identityFor(
    caller: Caller,
    employee: {
      firstName: string | null;
      lastName: string | null;
      companyId: string;
      departmentId: string | null;
      designationId: string | null;
      dateOfJoining: Date | null;
      bankName: string | null;
      bankAccountNumberEncrypted: string | null;
      panEncrypted: string | null;
      pfNumber: string | null;
      uan: string | null;
    },
  ): Promise<SlipIdentity> {
    const [company, department, designation] = await Promise.all([
      withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.company.findUnique({
          where: { id: employee.companyId },
          select: {
            name: true,
            address: true,
            city: true,
            state: true,
            pinCode: true,
          },
        }),
      ),
      employee.departmentId
        ? withRlsContext(this.prisma, caller.rls, (tx) =>
            tx.department.findUnique({
              where: { id: employee.departmentId as string },
              select: { name: true },
            }),
          )
        : Promise.resolve(null),
      employee.designationId
        ? withRlsContext(this.prisma, caller.rls, (tx) =>
            tx.designation.findUnique({
              where: { id: employee.designationId as string },
              select: { name: true },
            }),
          )
        : Promise.resolve(null),
    ]);

    return {
      employeeName: [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' ')
        .trim(),
      companyName: company?.name ?? '',
      // One block, newline-separated, as the sample prints it. Empty parts are dropped rather than
      // leaving a line of commas.
      companyAddress:
        [company?.address, company?.city, company?.state, company?.pinCode]
          .filter((part) => part?.trim())
          .join(', ') || null,
      joiningDate: employee.dateOfJoining,
      designation: designation?.name ?? null,
      department: department?.name ?? null,
      // The sample's "Location" is the employee's work city. This product holds that on the company
      // for now; an employee-level work location arrives with the location-assignment work (020
      // FR-011) and this is the line that changes when it does.
      location: company?.city ?? null,
      bankName: employee.bankName,
      // **Masked**, unlike the bank transfer sheet. A bank needs the full number to move money; an
      // employee already knows their own, and a payslip is emailed, forwarded and printed.
      bankAccountNumberMasked: maskAccount(
        this.pii.decrypt(employee.bankAccountNumberEncrypted),
      ),
      panNumber: this.pii.decrypt(employee.panEncrypted),
      pfNumber: employee.pfNumber,
      pfUan: employee.uan,
    };
  }
}

/**
 * Last four digits behind asterisks, or `null`.
 *
 * Four, matching how a bank prints it on a statement, so the employee can recognise their own
 * account without the payslip carrying enough to pay into it.
 */
function maskAccount(account: string | null): string | null {
  if (!account) return null;
  const digits = account.trim();
  if (digits.length <= 4) return digits;
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

const n = (value: { toNumber(): number }): number => value.toNumber();
/** The nullable form. A missing figure stays missing rather than becoming zero. */
const nn = (value: { toNumber(): number } | null): number | null =>
  value === null ? null : value.toNumber();
const sum = (...values: number[]): number =>
  Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

/**
 * A stored slip as the view every output is built from.
 *
 * Exported since 2026-10-02 so slip **delivery** uses it too (021 FR-005). Three code paths — the
 * JSON endpoint, the PDF download and the emailed attachment — now read the same rows through the
 * same mapper. Two independent mappings could still round or label a figure differently, and a
 * payslip that disagrees with the screen is a wage dispute.
 */
export function slipViewFrom(
  slip: SalarySlip,
  employeeCode: string,
  identity?: SlipIdentity,
): SalarySlipView {
  return toView(slip, employeeCode, identity);
}

function toView(
  slip: SalarySlip,
  employeeCode: string,
  identity?: SlipIdentity,
): SalarySlipView {
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
    // 020 FR-007. Named separately on the payslip the employee reads, which is the point of the
    // requirement: a recovery folded into the loan line leaves somebody unable to find out why their
    // pay fell short.
    fuelRecovery: n(slip.deductionFuelRecovery),
  };
  // T105. `null` where the slip predates the columns — propagated rather than filled in, so the
  // PDF can say "not recorded" instead of asserting the two columns agreed.
  const fullEarnings = {
    basic: nn(slip.fullEarningBasic),
    hra: nn(slip.fullEarningHra),
    conveyance: nn(slip.fullEarningConveyance),
    siteAllowance: nn(slip.fullEarningSiteAllowance),
    specialAllowance: nn(slip.fullEarningSpecialAllowance),
    // Overtime has no "full" figure and never will: it is worked hours, not an entitlement that LOP
    // can reduce. Null is the honest value, not a copy of the actual.
    ot: null,
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
    ...(identity ? { identity } : {}),
    monthDays: slip.monthDays,
    payableDays: n(slip.payableDays),
    lopDays: n(slip.lopDays),
    otHours: n(slip.otHours),
    earnings: { ...earnings, total: sum(...Object.values(earnings)) },
    fullEarnings: {
      ...fullEarnings,
      // The total covers the components that *are* recorded, plus the actual overtime, so Full and
      // Actual agree on a month with no LOP — which is what the sample shows. Null only when no
      // component was recorded at all, because a total over nothing is not zero.
      total: Object.values(fullEarnings).every((v) => v === null)
        ? null
        : sum(...Object.values(fullEarnings).map((v) => v ?? 0), earnings.ot),
    },
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
