import {
  blankSpans,
  dayCodes,
  type LineMoney,
  wageFigures,
} from './statutory-register.service';

const line = (over: Partial<LineMoney> = {}): LineMoney => ({
  payableDays: 31,
  otHours: 0,
  otWages: 0,
  basic: 20000,
  hra: 8000,
  conveyanceAllowance: 1600,
  siteAllowance: 0,
  specialAllowance: 400,
  reimbursementTotal: 0,
  employeePf: 1800,
  employeeEsic: 0,
  professionalTax: 200,
  tds: 0,
  loanEmiDeduction: 0,
  advanceRecovered: 0,
  fuelRecoveryDeduction: 0,
  netPay: 28000,
  employerPf: 450,
  employerEps: 1250,
  employerEsic: 0,
  ...over,
});

describe('wageFigures (040 Form B)', () => {
  it('maps a line onto the client columns and reconciles to net pay', () => {
    const w = wageFigures([line()]);
    expect(w).toMatchObject({
      daysWorked: 31,
      basic: 20000,
      hra: 8000,
      others: 2000,
      total: 30000,
      pf: 1800,
      otherDeductions: 200,
      recoveries: 0,
      totalDeductions: 2000,
      netPayment: 28000,
      employerPf: 1700,
    });
    expect(w.total - w.totalDeductions).toBe(w.netPayment);
  });

  it('puts loan, advance and fuel recoveries in Recoveries', () => {
    const w = wageFigures([
      line({
        loanEmiDeduction: 1000,
        advanceRecovered: 500,
        fuelRecoveryDeduction: 250.5,
        netPay: 26249.5,
      }),
    ]);
    expect(w.recoveries).toBe(1750.5);
    expect(w.total - w.totalDeductions).toBeCloseTo(w.netPayment, 2);
  });

  it('takes an advance recovered off the bank transfer out of net payment', () => {
    const w = wageFigures([line()], 3000);
    expect(w.recoveries).toBe(3000);
    expect(w.netPayment).toBe(25000);
    expect(w.total - w.totalDeductions).toBe(w.netPayment);
  });

  it('keeps reimbursements in Others so net still reconciles, and reports them', () => {
    const w = wageFigures([
      line({ specialAllowance: 1400, reimbursementTotal: 1000, netPay: 29000 }),
    ]);
    expect(w.others).toBe(3000);
    expect(w.reimbursement).toBe(1000);
    expect(w.total - w.totalDeductions).toBe(w.netPayment);
  });

  it('includes OT and sums a regular and an F&F line for the same month', () => {
    const w = wageFigures([
      line({ payableDays: 12, otHours: 4, otWages: 600, netPay: 28600 }),
      line({
        payableDays: 0,
        basic: 5000,
        hra: 0,
        conveyanceAllowance: 0,
        specialAllowance: 3000,
        employeePf: 0,
        professionalTax: 900,
        loanEmiDeduction: 2000,
        netPay: 5100,
        employerPf: 0,
        employerEps: 0,
      }),
    ]);
    expect(w.daysWorked).toBe(12);
    expect(w.otHours).toBe(4);
    expect(w.otPayment).toBe(600);
    expect(w.total).toBe(30600 + 8000);
    expect(w.netPayment).toBe(33700);
  });

  it('shows the floored net actually paid when deductions exceed wages', () => {
    const w = wageFigures([
      line({
        basic: 1000,
        hra: 0,
        conveyanceAllowance: 0,
        specialAllowance: 0,
        employeePf: 120,
        loanEmiDeduction: 5000,
        professionalTax: 0,
        netPay: 0,
      }),
    ]);
    expect(w.netPayment).toBe(0);
    expect(w.total - w.totalDeductions).toBeLessThan(0);
  });
});

describe('dayCodes (040 Form D)', () => {
  const days = (statuses: string[]) =>
    statuses.map((status, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      status: status as 'present',
    }));

  it('uses the client codes, O for a weekly off', () => {
    expect(
      dayCodes(
        days(['present', 'absent', 'weekly_off', 'holiday', 'on_leave']),
        null,
        null,
      ),
    ).toEqual(['P', 'A', 'O', 'H', 'L']);
  });

  it('blanks the days before joining and after leaving', () => {
    expect(
      dayCodes(
        days(['absent', 'present', 'present', 'absent']),
        new Date('2026-07-02'),
        new Date('2026-07-03'),
      ),
    ).toEqual([null, 'P', 'P', null]);
  });
});

describe('blankSpans', () => {
  it('finds the leading and trailing spans to merge', () => {
    expect(blankSpans([null, null, 'P', 'A', null])).toEqual([
      [0, 1],
      [4, 4],
    ]);
    expect(blankSpans(['P', 'P'])).toEqual([]);
  });
});
