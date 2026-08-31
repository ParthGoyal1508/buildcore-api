import {
  deductionRows,
  earningRows,
  employerContributionRows,
  SalaryPdfService,
} from './salary-pdf.service';
import { rupeesInWords, SalarySlipView } from './salary.service';

/**
 * Payslip figure-to-PDF mapping (T056).
 *
 * The property this protects is the one that matters on a wage document: the PDF
 * must show exactly the figures the JSON response shows, on the lines they belong
 * on. Everything below is asserted against the same `SalarySlipView` the JSON
 * endpoint returns, because that is the single object both outputs are built from.
 */
const slip: SalarySlipView = {
  period: '2026-07',
  employeeCode: 'EMP0042',
  monthDays: 31,
  payableDays: 28.5,
  lopDays: 2.5,
  otHours: 12,
  earnings: {
    basic: 18000,
    hra: 7200,
    conveyance: 1600,
    siteAllowance: 2500,
    specialAllowance: 1200,
    ot: 1800,
    total: 32300,
  },
  deductions: {
    pf: 2160,
    esic: 243,
    pt: 200,
    tds: 0,
    loanEmi: 1500,
    advanceRecovery: 500,
    total: 4603,
  },
  employerContributions: {
    pf: 1980,
    eps: 1250,
    edli: 75,
    adminCharges: 90,
    gratuity: 866,
    bonus: 1499,
    total: 5760,
  },
  netPay: 27697,
  netPayInWords: rupeesInWords(27697),
  minimumWagesNote: 'Wages paid meet the notified minimum wage for the state.',
};

describe('SalaryPdfService figure mapping', () => {
  it('maps every earning to its own line, ending with the total', () => {
    expect(earningRows(slip)).toEqual([
      ['Basic', 18000],
      ['HRA', 7200],
      ['Conveyance', 1600],
      ['Site Allowance', 2500],
      ['Special Allowance', 1200],
      ['Overtime', 1800],
      ['Total Earnings', 32300],
    ]);
  });

  it('maps every deduction to its own line, ending with the total', () => {
    expect(deductionRows(slip)).toEqual([
      ['PF', 2160],
      ['ESIC', 243],
      ['Professional Tax', 200],
      ['TDS', 0],
      ['Loan EMI', 1500],
      ['Advance Recovery', 500],
      ['Total Deductions', 4603],
    ]);
  });

  it('prints a zero deduction rather than omitting the line', () => {
    // A payslip that silently drops nil rows makes an employee wonder whether TDS
    // was deducted and not shown, or genuinely nil.
    expect(deductionRows(slip).map(([label]) => label)).toContain('TDS');
  });

  it('keeps employer contributions out of the deduction lines', () => {
    // They are informational; showing them among deductions would imply the
    // employee paid them.
    const deductionLabels = deductionRows(slip).map(([label]) => label);
    const employerTotal = employerContributionRows(slip).reduce(
      (sum, [, amount]) => sum + amount,
      0,
    );
    expect(employerTotal).toBe(slip.employerContributions.total);
    expect(deductionRows(slip).reduce((s, [, a]) => s + a, 0)).not.toBe(
      employerTotal,
    );
    expect(deductionLabels).toHaveLength(7);
  });

  it('takes no figure from anywhere but the view it was given', () => {
    // Same object in, same lines out — the mapping has no hidden second source.
    const other = { ...slip, earnings: { ...slip.earnings, basic: 1 } };
    expect(earningRows(other)[0]).toEqual(['Basic', 1]);
    expect(earningRows(slip)[0]).toEqual(['Basic', 18000]);
  });

  it('renders a PDF document from the same view', async () => {
    const pdf = await new SalaryPdfService().render(slip, 'Asha Kumari');
    expect(pdf.length).toBeGreaterThan(0);
    // `%PDF` is the format's magic number; anything else is not a payslip.
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});

describe('rupeesInWords', () => {
  it('spells a whole amount', () => {
    expect(rupeesInWords(27697)).toBe(
      'Twenty Seven Thousand Six Hundred Ninety Seven Rupees Only',
    );
  });

  it('uses the Indian lakh grouping, not thousands all the way up', () => {
    // "One Hundred Twenty Thousand" on an Indian payslip would read as wrong to
    // every person who receives one.
    expect(rupeesInWords(120000)).toBe('One Lakh Twenty Thousand Rupees Only');
  });

  it('spells crores', () => {
    expect(rupeesInWords(12500000)).toBe(
      'One Crore Twenty Five Lakh Rupees Only',
    );
  });

  it('handles a crore count of a hundred or more', () => {
    expect(rupeesInWords(1000000000)).toBe('One Hundred Crore Rupees Only');
  });

  it('includes paise when there are any', () => {
    expect(rupeesInWords(1250.75)).toBe(
      'One Thousand Two Hundred Fifty Rupees and Seventy Five Paise Only',
    );
  });

  it('spells zero rather than returning an empty string', () => {
    expect(rupeesInWords(0)).toBe('Zero Rupees Only');
  });
});
