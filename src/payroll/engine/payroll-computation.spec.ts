import {
  computePayrollLine,
  professionalTaxFor,
  round2,
  type AttendanceInput,
  type CompanyPayrollRates,
  type EmployeePayrollInput,
  type StatutoryRates,
} from './payroll-computation';

/** The shipped statutory defaults, restated so a config change breaks a test. */
const STATUTORY: StatutoryRates = {
  pf: {
    employeeRatePercent: 12,
    wageCeiling: 15000,
    epsRatePercent: 8.33,
    edliRatePercent: 0.5,
    adminChargesPercent: 0.5,
  },
  esic: { employeeRatePercent: 0.75, wageCeiling: 21000 },
  professionalTaxSlabs: [
    { upToMonthlyGross: 7500, monthlyAmount: 0 },
    { upToMonthlyGross: 10000, monthlyAmount: 175 },
    { upToMonthlyGross: null, monthlyAmount: 200 },
  ],
};

const COMPANY: CompanyPayrollRates = {
  pfEmployerRatePercent: 12,
  esicEmployerRatePercent: 3.25,
  gratuityRatePercent: 4.81,
  bonusRatePercent: 8.33,
  otMultiplier: 2,
};

const employee = (over: Partial<EmployeePayrollInput> = {}): EmployeePayrollInput => ({
  employeeId: 'emp-1',
  projectId: null,
  basic: 20000,
  hra: 8000,
  conveyanceAllowance: 1600,
  siteAllowance: 2000,
  specialAllowance: 2400,
  pfApplicable: true,
  pfUpperLimit: true,
  esicApplicable: false,
  esicUpperLimit: true,
  hoursPerDay: 8,
  loanEmiDeduction: 0,
  tds: 0,
  ...over,
});

/** A full month with nothing unusual: 30 days, all payable, no OT. */
const fullMonth: AttendanceInput = {
  monthDays: 30,
  payableDays: 30,
  lopDays: 0,
  otHours: 0,
};

const run = (
  e: Partial<EmployeePayrollInput> = {},
  a: Partial<AttendanceInput> = {},
  c: Partial<CompanyPayrollRates> = {},
) =>
  computePayrollLine(
    employee(e),
    { ...fullMonth, ...a },
    { ...COMPANY, ...c },
    STATUTORY,
  );

describe('round2', () => {
  it('rounds half up at the paise boundary', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.344)).toBe(2.34);
    expect(round2(2.345)).toBe(2.35);
  });
});

describe('professionalTaxFor', () => {
  it('charges nothing in the lowest band', () => {
    expect(professionalTaxFor(7000, STATUTORY.professionalTaxSlabs)).toBe(0);
  });

  it('treats a slab ceiling as inclusive', () => {
    expect(professionalTaxFor(7500, STATUTORY.professionalTaxSlabs)).toBe(0);
    expect(professionalTaxFor(7500.01, STATUTORY.professionalTaxSlabs)).toBe(175);
  });

  it('uses the middle band', () => {
    expect(professionalTaxFor(9000, STATUTORY.professionalTaxSlabs)).toBe(175);
  });

  it('falls into the open-ended band for a high gross', () => {
    expect(professionalTaxFor(500000, STATUTORY.professionalTaxSlabs)).toBe(200);
  });
});

describe('computePayrollLine — earnings', () => {
  it('pays the full salary structure for a fully worked month', () => {
    const r = run();
    expect(r.basic).toBe(20000);
    expect(r.hra).toBe(8000);
    expect(r.conveyanceAllowance).toBe(1600);
    expect(r.siteAllowance).toBe(2000);
    expect(r.specialAllowance).toBe(2400);
    expect(r.gross).toBe(34000);
  });

  it('scales every earnings component by payable days', () => {
    // 15 of 30 days — exactly half of each component.
    const r = run({}, { payableDays: 15, lopDays: 15 });
    expect(r.basic).toBe(10000);
    expect(r.hra).toBe(4000);
    expect(r.conveyanceAllowance).toBe(800);
    expect(r.siteAllowance).toBe(1000);
    expect(r.specialAllowance).toBe(1200);
    expect(r.gross).toBe(17000);
  });

  it('handles a half payable day', () => {
    const r = run({}, { payableDays: 29.5, lopDays: 0.5 });
    // 20000 * 29.5/30
    expect(r.basic).toBe(19666.67);
  });

  it('returns zero earnings rather than NaN for a zero-day month', () => {
    // Not a real period, but a division by zero reaching a payslip is far worse
    // than a zero line.
    const r = run({}, { monthDays: 0, payableDays: 0 });
    expect(r.basic).toBe(0);
    expect(r.gross).toBe(0);
    expect(Number.isNaN(r.netPay)).toBe(false);
  });
});

describe('computePayrollLine — overtime', () => {
  it('pays OT at the company multiplier on the derived hourly rate', () => {
    // 20000 / (8 * 30) = 83.333/hr; 10 hrs at 2x = 1666.67
    const r = run({}, { otHours: 10 });
    expect(r.otWages).toBe(1666.67);
    expect(r.gross).toBe(round2(34000 + 1666.67));
  });

  it('honours a reconfigured multiplier rather than assuming 2x', () => {
    const r = run({}, { otHours: 10 }, { otMultiplier: 1.5 });
    expect(r.otWages).toBe(1250);
  });

  it('does not scale OT down by absence', () => {
    // The hours were genuinely worked. Scaling them by attendance would pay less
    // for the same overtime the more days the employee missed.
    const full = run({}, { otHours: 10 });
    const half = run({}, { otHours: 10, payableDays: 15, lopDays: 15 });
    expect(half.otWages).toBe(full.otWages);
  });

  it('pays no OT when the employee has no configured working hours', () => {
    const r = run({ hoursPerDay: 0 }, { otHours: 10 });
    expect(r.otWages).toBe(0);
  });
});

describe('computePayrollLine — provident fund', () => {
  it('caps PF wage at the statutory ceiling when pfUpperLimit is set', () => {
    // basic 20000 > ceiling 15000, so contributions compute on 15000.
    const r = run();
    expect(r.employeePf).toBe(1800); // 12% of 15000
    expect(r.employerEps).toBe(1249.5); // 8.33% of 15000
    expect(r.employerPf).toBe(round2(1800 - 1249.5));
    expect(r.employerEdli).toBe(75); // 0.5%
    expect(r.adminCharges).toBe(75); // 0.5%
  });

  it('computes on full basic when pfUpperLimit is not set', () => {
    const r = run({ pfUpperLimit: false });
    expect(r.employeePf).toBe(2400); // 12% of 20000
  });

  it('computes PF on EARNED basic, not the full structure', () => {
    // Half a month worked, no ceiling: PF follows what was actually earned.
    const r = run({ pfUpperLimit: false }, { payableDays: 15, lopDays: 15 });
    expect(r.basic).toBe(10000);
    expect(r.employeePf).toBe(1200);
  });

  it('contributes nothing when PF does not apply', () => {
    const r = run({ pfApplicable: false });
    expect(r.employeePf).toBe(0);
    expect(r.employerPf).toBe(0);
    expect(r.employerEps).toBe(0);
    expect(r.employerEdli).toBe(0);
    expect(r.adminCharges).toBe(0);
  });

  it('never produces a negative employer PF share', () => {
    // A company configured below the EPS rate would otherwise yield a negative
    // provident-fund portion.
    const r = run({}, {}, { pfEmployerRatePercent: 5 });
    expect(r.employerPf).toBe(0);
  });
});

describe('computePayrollLine — ESIC', () => {
  it('applies on gross when eligible', () => {
    const r = run({ esicApplicable: true, basic: 8000, hra: 2000, conveyanceAllowance: 0, siteAllowance: 0, specialAllowance: 0 });
    expect(r.gross).toBe(10000);
    expect(r.employeeEsic).toBe(75); // 0.75%
    expect(r.employerEsic).toBe(325); // 3.25%
  });

  it('stops entirely above the wage ceiling — a threshold, not a cap', () => {
    // Gross 34000 is above the 21000 ceiling, so nothing is contributed at all.
    const r = run({ esicApplicable: true });
    expect(r.employeeEsic).toBe(0);
    expect(r.employerEsic).toBe(0);
  });

  it('still applies above the ceiling when the employee opts out of the limit', () => {
    const r = run({ esicApplicable: true, esicUpperLimit: false });
    expect(r.employeeEsic).toBe(255); // 0.75% of 34000
  });

  it('contributes nothing when ESIC does not apply', () => {
    const r = run({ esicApplicable: false });
    expect(r.employeeEsic).toBe(0);
    expect(r.employerEsic).toBe(0);
  });
});

describe('computePayrollLine — deductions and net pay', () => {
  it('sums every deduction into the total', () => {
    const r = run({ tds: 500, loanEmiDeduction: 2000 });
    expect(r.totalDeductions).toBe(
      round2(r.employeePf + r.employeeEsic + r.professionalTax + 500 + 2000),
    );
  });

  it('nets gross less total deductions', () => {
    const r = run({ tds: 500, loanEmiDeduction: 2000 });
    expect(r.netPay).toBe(round2(r.gross - r.totalDeductions));
  });

  it('floors net pay at zero rather than going negative', () => {
    // A recovery larger than the month's gross carries forward; it does not turn
    // the payslip into a bill.
    const r = run({ loanEmiDeduction: 999999 });
    expect(r.netPay).toBe(0);
  });

  it('defaults TDS to whatever was supplied, with zero meaning zero', () => {
    expect(run().tds).toBe(0);
    expect(run({ tds: 1234.56 }).tds).toBe(1234.56);
  });
});

describe('computePayrollLine — employer costs', () => {
  it('accrues gratuity and bonus on earned basic at the company rates', () => {
    const r = run();
    expect(r.gratuity).toBe(962); // 4.81% of 20000
    expect(r.bonus).toBe(1666); // 8.33% of 20000
  });

  it('scales gratuity and bonus with attendance, since basic does', () => {
    const r = run({}, { payableDays: 15, lopDays: 15 });
    expect(r.gratuity).toBe(481);
  });
});

describe('computePayrollLine — a fully worked example', () => {
  it('reconciles every figure end to end', () => {
    const r = run(
      { esicApplicable: true, esicUpperLimit: true, tds: 1000, loanEmiDeduction: 1500 },
      { payableDays: 26, lopDays: 4, otHours: 12 },
    );

    // Earnings scaled 26/30, plus 12 OT hours at 2x of 83.333/hr.
    expect(r.basic).toBe(17333.33);
    expect(r.otWages).toBe(2000);
    expect(r.gross).toBe(
      round2(17333.33 + 6933.33 + 1386.67 + 1733.33 + 2080 + 2000),
    );

    // Above the ESIC ceiling, so no ESIC; PF on the capped wage.
    expect(r.employeeEsic).toBe(0);
    expect(r.employeePf).toBe(1800);
    expect(r.professionalTax).toBe(200);

    expect(r.totalDeductions).toBe(round2(1800 + 0 + 200 + 1000 + 1500));
    expect(r.netPay).toBe(round2(r.gross - r.totalDeductions));
    // Attendance passes through unchanged for the payslip's own display.
    expect(r.payableDays).toBe(26);
    expect(r.lopDays).toBe(4);
    expect(r.otHours).toBe(12);
  });
});
