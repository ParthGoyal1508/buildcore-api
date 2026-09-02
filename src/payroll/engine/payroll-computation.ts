/**
 * The payroll computation, as pure functions.
 *
 * Deliberately free of Prisma, Nest and configuration lookups: this is the
 * highest-stakes arithmetic in the codebase, and every component below can be
 * asserted directly against a worked example without a database or a running
 * application. `PayrollEngineService` does the reading and writing; this file
 * decides the numbers.
 *
 * Money is handled in rupees as `number` and rounded to paise at each component
 * boundary. That is safe here because every input is already a two-decimal value
 * and the operations are multiplication by a rate and addition — the range that
 * would lose precision in a float is far beyond any payroll figure.
 */

export interface StatutoryRates {
  pf: {
    employeeRatePercent: number;
    wageCeiling: number;
    epsRatePercent: number;
    edliRatePercent: number;
    adminChargesPercent: number;
  };
  esic: {
    employeeRatePercent: number;
    wageCeiling: number;
  };
  professionalTaxSlabs: {
    upToMonthlyGross: number | null;
    monthlyAmount: number;
  }[];
}

/** Per-company rates that live on `settings.Company` (002 FR-002, 005 FR-014a). */
export interface CompanyPayrollRates {
  pfEmployerRatePercent: number;
  esicEmployerRatePercent: number;
  gratuityRatePercent: number;
  bonusRatePercent: number;
  otMultiplier: number;
}

/** The employee's salary structure and statutory applicability. */
export interface EmployeePayrollInput {
  employeeId: string;
  projectId: string | null;
  basic: number;
  hra: number;
  conveyanceAllowance: number;
  siteAllowance: number;
  specialAllowance: number;
  pfApplicable: boolean;
  /** Cap PF wage at the statutory ceiling rather than using full basic. */
  pfUpperLimit: boolean;
  esicApplicable: boolean;
  esicUpperLimit: boolean;
  hoursPerDay: number;
  /** Sum of the current cycle's EMI across every Active loan. */
  loanEmiDeduction: number;
  /** Manually entered; zero unless an admin supplies one (spec clarification). */
  tds: number;
}

/** What the attendance layer resolved for this employee, for this period. */
export interface AttendanceInput {
  monthDays: number;
  payableDays: number;
  lopDays: number;
  otHours: number;
}

export interface PayrollLineFigures {
  monthDays: number;
  payableDays: number;
  lopDays: number;
  otHours: number;
  otWages: number;
  basic: number;
  hra: number;
  conveyanceAllowance: number;
  siteAllowance: number;
  specialAllowance: number;
  gross: number;
  employeePf: number;
  employeeEsic: number;
  professionalTax: number;
  tds: number;
  loanEmiDeduction: number;
  totalDeductions: number;
  netPay: number;
  employerPf: number;
  employerEps: number;
  employerEdli: number;
  adminCharges: number;
  employerEsic: number;
  gratuity: number;
  bonus: number;
}

/** Rounds to paise. Applied at every component boundary, never only at the end. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const pct = (amount: number, percent: number) => round2((amount * percent) / 100);

/**
 * Professional tax for a monthly gross.
 *
 * Slabs are inclusive of their upper bound and evaluated in order, so the first
 * band whose ceiling the gross does not exceed wins. The final band must be
 * open-ended (`upToMonthlyGross: null`); config validation enforces that, and the
 * fallback here returns the last band's amount rather than zero, because silently
 * charging nothing to the highest earners is the worse failure.
 */
export function professionalTaxFor(
  monthlyGross: number,
  slabs: StatutoryRates['professionalTaxSlabs'],
): number {
  for (const slab of slabs) {
    if (slab.upToMonthlyGross === null) return slab.monthlyAmount;
    if (monthlyGross <= slab.upToMonthlyGross) return slab.monthlyAmount;
  }
  return slabs.length ? slabs[slabs.length - 1].monthlyAmount : 0;
}

/**
 * Computes one employee's payroll line for one period.
 *
 * Order matters and is deliberate: earnings are scaled by attendance first, then
 * gross is formed, then statutory deductions are computed against the *earned*
 * figures rather than the full salary structure — an employee who worked half the
 * month contributes PF on what they earned, not on what they would have earned.
 */
export function computePayrollLine(
  employee: EmployeePayrollInput,
  attendance: AttendanceInput,
  company: CompanyPayrollRates,
  statutory: StatutoryRates,
): PayrollLineFigures {
  const { monthDays, payableDays, lopDays, otHours } = attendance;

  // Guard against a zero-day month producing a division by zero. A period with no
  // days is not a real period, and returning NaN through to a payslip would be
  // far worse than treating the ratio as zero.
  const dayRatio = monthDays > 0 ? payableDays / monthDays : 0;

  const basic = round2(employee.basic * dayRatio);
  const hra = round2(employee.hra * dayRatio);
  const conveyanceAllowance = round2(employee.conveyanceAllowance * dayRatio);
  const siteAllowance = round2(employee.siteAllowance * dayRatio);
  const specialAllowance = round2(employee.specialAllowance * dayRatio);

  // Overtime is paid against the full-month hourly rate, not the attendance-scaled
  // one: the hours were genuinely worked, so scaling them down by absence would
  // pay less for the same overtime the more days an employee missed.
  const hoursPerDay = employee.hoursPerDay > 0 ? employee.hoursPerDay : 0;
  const monthlyHours = hoursPerDay * monthDays;
  const hourlyRate = monthlyHours > 0 ? employee.basic / monthlyHours : 0;
  const otWages = round2(hourlyRate * otHours * company.otMultiplier);

  const gross = round2(
    basic + hra + conveyanceAllowance + siteAllowance + specialAllowance + otWages,
  );

  // ── PF ────────────────────────────────────────────────────────────────────
  // PF wage is basic (as earned). `pfUpperLimit` caps it at the statutory
  // ceiling — the common arrangement where an employer contributes on the
  // ceiling rather than on full basic.
  const pfWageBase = basic;
  const pfWage = employee.pfUpperLimit
    ? Math.min(pfWageBase, statutory.pf.wageCeiling)
    : pfWageBase;

  const employeePf = employee.pfApplicable
    ? pct(pfWage, statutory.pf.employeeRatePercent)
    : 0;
  const employerPfTotal = employee.pfApplicable
    ? pct(pfWage, company.pfEmployerRatePercent)
    : 0;
  const employerEps = employee.pfApplicable
    ? pct(pfWage, statutory.pf.epsRatePercent)
    : 0;
  // The employer's PF share is split between the pension scheme and the provident
  // fund proper; what is left after EPS is the PF portion. Floored at zero so a
  // company configured with an employer rate below the EPS rate cannot produce a
  // negative contribution.
  const employerPf = round2(Math.max(employerPfTotal - employerEps, 0));
  const employerEdli = employee.pfApplicable
    ? pct(pfWage, statutory.pf.edliRatePercent)
    : 0;
  const adminCharges = employee.pfApplicable
    ? pct(pfWage, statutory.pf.adminChargesPercent)
    : 0;

  // ── ESIC ──────────────────────────────────────────────────────────────────
  // ESIC applies on gross and stops entirely above the wage ceiling — it is an
  // eligibility threshold, not a cap on the contributory amount.
  const esicApplies =
    employee.esicApplicable &&
    (!employee.esicUpperLimit || gross <= statutory.esic.wageCeiling);
  const employeeEsic = esicApplies
    ? pct(gross, statutory.esic.employeeRatePercent)
    : 0;
  const employerEsic = esicApplies
    ? pct(gross, company.esicEmployerRatePercent)
    : 0;

  // ── Other ─────────────────────────────────────────────────────────────────
  const professionalTax = professionalTaxFor(
    gross,
    statutory.professionalTaxSlabs,
  );
  const gratuity = pct(basic, company.gratuityRatePercent);
  const bonus = pct(basic, company.bonusRatePercent);

  const totalDeductions = round2(
    employeePf +
      employeeEsic +
      professionalTax +
      employee.tds +
      employee.loanEmiDeduction,
  );

  // Never negative: a deduction stack exceeding gross means the recovery has to
  // carry forward, not that the employee owes the company this month's payslip.
  const netPay = round2(Math.max(gross - totalDeductions, 0));

  return {
    monthDays,
    payableDays: round2(payableDays),
    lopDays: round2(lopDays),
    otHours: round2(otHours),
    otWages,
    basic,
    hra,
    conveyanceAllowance,
    siteAllowance,
    specialAllowance,
    gross,
    employeePf,
    employeeEsic,
    professionalTax,
    tds: round2(employee.tds),
    loanEmiDeduction: round2(employee.loanEmiDeduction),
    totalDeductions,
    netPay,
    employerPf,
    employerEps,
    employerEdli,
    adminCharges,
    employerEsic,
    gratuity,
    bonus,
  };
}
