import {
  deductionRows,
  earningRows,
  employerContributionRows,
  fullAndActualEarningRows,
  identityRows,
  periodLabel,
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
  // 021 T105. **Deliberately different from `earnings`**: this fixture has 2.5 LOP days, so Full and
  // Actual must not agree. The client's sample has LOP zero throughout and is therefore no evidence
  // that they do — which is the trap this fixture exists to avoid falling into.
  fullEarnings: {
    basic: 20000,
    hra: 8000,
    conveyance: 1778,
    siteAllowance: 2778,
    specialAllowance: 1333,
    // Overtime has no Full figure and never will — it is hours worked, not an entitlement.
    ot: null,
    total: 35667,
  },
  deductions: {
    pf: 2160,
    esic: 243,
    pt: 200,
    tds: 0,
    loanEmi: 1500,
    advanceRecovery: 500,
    // 020 FR-007. Non-zero on purpose: a fixture of zero would render the row and prove nothing about
    // whether the figure reaches it.
    fuelRecovery: 750,
    total: 5353,
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
      ['Fuel Recovery', 750],
      ['Total Deductions', 5353],
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
    // Eight since 020 FR-007 added the fuel recovery. Asserted as a count on purpose: it is what
    // catches an employer contribution leaking into this list, and it has to be updated deliberately
    // when a real deduction is added — which is the check working, not noise.
    expect(deductionLabels).toHaveLength(8);
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

/**
 * The client's payslip layout (021 FR-008f, tasks T104 and T105).
 *
 * `docs/NC0060_Payslip_Feb 2026.pdf` has **LOP zero in every row**, so Full and Actual are identical
 * all the way down it. That makes the sample no evidence at all that the two columns agree, and this
 * is where the proration is proven instead — against a slip with 2.5 LOP days, where they must not.
 */
describe('Full and Actual earnings (T105)', () => {
  it('prints both columns, and they differ when there was LOP', () => {
    const rows = fullAndActualEarningRows(slip);
    const basic = rows.find(([label]) => label === 'Basic');

    expect(basic).toEqual(['Basic', 20000, 18000]);
    // The assertion that matters: equal columns would mean the proration never happened, and the
    // sample would not have caught it.
    expect(basic?.[1]).not.toBe(basic?.[2]);
  });

  it('leaves overtime’s Full column empty rather than repeating the actual', () => {
    const ot = fullAndActualEarningRows(slip).find(
      ([label]) => label === 'Overtime',
    );
    // Overtime is hours worked, not an entitlement LOP can reduce. A repeat of the actual would
    // assert a monthly overtime entitlement that does not exist.
    expect(ot).toEqual(['Overtime', null, 1800]);
  });

  it('prints an em dash where a Full figure was never recorded', async () => {
    // Every slip issued before 2026-10-02 is in this state. Printing the Actual figure instead would
    // make "no LOP this month" and "we never recorded it" look identical to the reader.
    const legacy: SalarySlipView = {
      ...slip,
      fullEarnings: {
        basic: null,
        hra: null,
        conveyance: null,
        siteAllowance: null,
        specialAllowance: null,
        ot: null,
        total: null,
      },
    };
    const rows = fullAndActualEarningRows(legacy);
    expect(rows.every(([, full]) => full === null)).toBe(true);
    // And it still renders — a legacy slip must not fail to print.
    const pdf = await new SalaryPdfService().render(legacy, 'Asha Pawar');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('covers every earning the Actual column shows', () => {
    // A component present in one column and absent from the other is a payslip that does not add up.
    expect(fullAndActualEarningRows(slip).map(([label]) => label)).toEqual(
      earningRows(slip)
        .map(([label]) => label)
        .filter((label) => label !== 'Total Earnings'),
    );
  });
});

describe('the identity block (T104)', () => {
  const identity = {
    employeeName: 'Dixit Pabari',
    companyName: 'Next Creation Software (India) Private Limited',
    companyAddress: 'Madhapur, Hyderabad, Telangana, 500081',
    joiningDate: new Date('2023-06-19T00:00:00.000Z'),
    designation: 'Manager',
    department: 'Human Resources & Administration',
    location: 'Vadodara',
    bankName: 'HDFC Bank',
    bankAccountNumberMasked: '**********5513',
    panNumber: 'BQHPP3499J',
    pfNumber: null,
    pfUan: '101849809716',
  };

  it('pairs the fields the way the client’s payslip does', () => {
    const rows = identityRows(slip, identity);
    expect(rows[0]).toEqual([
      ['Name', 'Dixit Pabari'],
      ['Employee No', 'EMP0042'],
    ]);
    expect(rows[2]).toEqual([
      ['Designation', 'Manager'],
      ['Bank Account No', '**********5513'],
    ]);
  });

  it('keeps a label whose value is missing', () => {
    // The sample's own `PF No` is empty and the label is still printed. A label that disappears with
    // its value makes a payslip's shape depend on the employee, and two payslips that do not line up
    // invite the question of what else differs.
    const rows = identityRows(slip, identity);
    expect(rows[4]).toEqual([
      ['Location', 'Vadodara'],
      ['PF No', '—'],
    ]);
  });

  it('reports effective work days and LOP from the slip, not the identity', () => {
    const rows = identityRows(slip, identity);
    expect(rows[5][0]).toEqual(['Effective Work Days', '28.5']);
    expect(rows[6][0]).toEqual(['LOP', '2.5']);
  });

  it('renders the month as the sample words it', () => {
    expect(periodLabel('2026-02')).toBe('February 2026');
    // A malformed period prints itself rather than throwing: a payslip must still render.
    expect(periodLabel('nonsense')).toBe('nonsense');
  });

  it('renders with the header block', async () => {
    const pdf = await new SalaryPdfService().render(
      { ...slip, identity },
      'Dixit Pabari',
    );
    expect(pdf.length).toBeGreaterThan(500);
  });
});
