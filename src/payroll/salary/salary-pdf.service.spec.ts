import {
  bankRows,
  deductionRows,
  earningRows,
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
  it('maps every deduction to its own line, in the client’s order, ending with the total', () => {
    // `docs/HR_DOCS/Parth_Realcon_Payslip.docx`: PF, ESI, PT, Welfare, Loan, Advance, Mobile Bill,
    // Other Deduction, TDS. Since 2026-10-15 every one of its rows is printed: Welfare and Mobile
    // Bill have no counterpart in this system and carry null (an em dash on the page); the fuel
    // recovery is the "Other Deduction" and says so (020 FR-007).
    expect(deductionRows(slip)).toEqual([
      ['Provident Fund', 2160],
      ['ESI', 243],
      ['Professional Tax', 200],
      ['Welfare', null],
      ['Loan', 1500],
      ['Advance', 500],
      ['Mobile Bill', null],
      ['Other Deduction (Fuel Recovery)', 750],
      ['T.D.S.', 0],
      ['Total Deduction', 5353],
    ]);
  });

  it('prints a zero deduction rather than omitting the line', () => {
    // A payslip that silently drops nil rows makes an employee wonder whether TDS
    // was deducted and not shown, or genuinely nil.
    expect(deductionRows(slip).map(([label]) => label)).toContain('T.D.S.');
  });

  it('keeps employer contributions out of the deduction lines', () => {
    // They are informational; showing them among deductions would imply the employee paid them.
    // Asserted as a count on purpose: it has to be updated deliberately when a real deduction is
    // added — which is the check working, not noise.
    expect(deductionRows(slip)).toHaveLength(10);
    expect(deductionRows(slip).at(-1)?.[1]).toBe(slip.deductions.total);
  });

  it('takes no figure from anywhere but the view it was given', () => {
    // Same object in, same lines out — the mapping has no hidden second source.
    const other = { ...slip, earnings: { ...slip.earnings, basic: 1 } };
    expect(earningRows(other)[0]).toEqual(['Basic', 20000, 1]);
    expect(earningRows(slip)[0]).toEqual(['Basic', 20000, 18000]);
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
 * The client's revised payslip (2026-10-13), `docs/HR_DOCS/Parth_Realcon_Payslip.docx`.
 *
 * Rate is the full-month figure and Amount what was paid. The fixture has 2.5 LOP days so the two
 * must differ — a sample with LOP zero throughout would be no evidence that proration happened.
 */
describe('earnings, Rate and Amount', () => {
  it('prints the docx’s rows in its order, the system’s own heads after them, ending with gross', () => {
    // Changed deliberately on 2026-10-15: the client asked for their format strictly, so its
    // Dearness Allowance, Medical/Conveyance Reimbursement and Food Allowance rows are printed —
    // with dashes, since the salary structure pays none of them. Site Allowance and Overtime,
    // which it does pay, take the blank rows the docx leaves before Gross Earnings.
    expect(earningRows(slip)).toEqual([
      ['Basic', 20000, 18000],
      ['Dearness Allowance', null, null],
      ['House Rent Allowance', 8000, 7200],
      ['Conveyance Allowance', 1778, 1600],
      ['Special Allowance', 1333, 1200],
      ['Medical Reimbursement', null, null],
      ['Conveyance Reimbursement', null, null],
      ['Food Allowance', null, null],
      ['Site Allowance', 2778, 2500],
      ['Overtime', null, 1800],
      ['Gross Earnings', 35667, 32300],
    ]);
  });

  it('prints an em dash where a Rate was never recorded', async () => {
    // Every slip issued before 2026-10-02 is in this state. Printing the Amount instead would make
    // "no LOP this month" and "we never recorded it" look identical.
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
    expect(earningRows(legacy).every(([, rate]) => rate === null)).toBe(true);
    // …while the Amounts it did store are still there.
    expect(earningRows(legacy)[0]).toEqual(['Basic', null, 18000]);
    // And it still renders — a legacy slip must not fail to print.
    const pdf = await new SalaryPdfService().render(legacy, 'Asha Pawar');
    expect(pdf.length).toBeGreaterThan(500);
  });
});

describe('the employee panel and bank block', () => {
  const identity = {
    employeeName: 'Dinesh Sharma',
    companyName: 'Parth Realcon Private Limited',
    companyAddress: 'Deoli, Tonk, Rajasthan, 304804',
    joiningDate: new Date('2024-04-01T00:00:00.000Z'),
    designation: 'Billing Engineer',
    department: 'Projects',
    location: 'Tonk',
    bankName: 'State Bank of India',
    bankAccountNumberMasked: '*******4521',
    panNumber: 'BQHPP3499J',
    pfNumber: null,
    pfUan: '101849809716',
    fatherName: 'Hans Raj',
    esiNumber: '1234567890',
    bankBranch: 'Deoli',
    ifscCode: 'SBIN0001234',
    bankAccountHolderName: 'DINESH SHARMA',
  };

  it('pairs the fields the way the client’s payslip does', () => {
    const rows = identityRows(slip, identity);
    expect(rows.map(([left, right]) => [left[0], right[0]])).toEqual([
      ['Employee Name', 'Working Days'],
      ["Father's / Spouse's Name", 'Rest Days'],
      ['Employee Code', 'Leave / PL'],
      ['Designation', 'Total Days'],
      ['P.F. No.', 'E.S.I. No.'],
      ['O.T. Hours', 'Date of Joining'],
    ]);
    expect(rows[1][0]).toEqual(["Father's / Spouse's Name", 'Hans Raj']);
    expect(rows[4][1]).toEqual(['E.S.I. No.', '1234567890']);
  });

  it('keeps a label whose value is missing', () => {
    // A label that disappears with its value makes a payslip's shape depend on the employee.
    expect(identityRows(slip, identity)[4][0]).toEqual(['P.F. No.', '—']);
    // An identity built before the father's name existed still renders the row.
    const older = { ...identity, fatherName: undefined };
    expect(identityRows(slip, older)[1][0]).toEqual([
      "Father's / Spouse's Name",
      '—',
    ]);
  });

  it('takes days and overtime from the slip, and does not invent the worked/rest/leave split', () => {
    const rows = identityRows(slip, identity);
    expect(rows[3][1]).toEqual(['Total Days', '31']);
    expect(rows[5][0]).toEqual(['O.T. Hours', '12']);
    // The docx's six rows and no others (2026-10-15) — the paid / LOP row this used to add is
    // not in the client's format.
    expect(rows).toHaveLength(6);
    // The slip stores paid days, not their breakdown into worked, weekly off and leave.
    expect([rows[0][1][1], rows[1][1][1], rows[2][1][1]]).toEqual([
      '—',
      '—',
      '—',
    ]);
  });

  it('prints the bank block with the account masked and the bank’s own name for the holder', () => {
    expect(bankRows(identity)).toEqual([
      [
        ['Bank Name', 'State Bank of India'],
        ['Branch', 'Deoli'],
      ],
      [
        ['Account Holder', 'DINESH SHARMA'],
        ['Account No.', '*******4521'],
      ],
      [
        ['IFSC Code', 'SBIN0001234'],
        ['Payment Mode', 'Bank Transfer'],
      ],
    ]);
    // Without an account on file, no payment mode is asserted and the HR name stands in.
    const unbanked = bankRows({
      ...identity,
      bankAccountNumberMasked: null,
      bankAccountHolderName: null,
    });
    expect(unbanked[1][0]).toEqual(['Account Holder', 'Dinesh Sharma']);
    expect(unbanked[2][1]).toEqual(['Payment Mode', '—']);
  });

  it('renders the month as the sample words it', () => {
    expect(periodLabel('2026-09')).toBe('September 2026');
    // A malformed period prints itself rather than throwing: a payslip must still render.
    expect(periodLabel('nonsense')).toBe('nonsense');
  });

  it('renders the company header on one page, with or without a logo', async () => {
    // The docx's header is the company name and its logo — not the letterhead (2026-10-15).
    // A 1×1 PNG stands in for the logo.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const service = new SalaryPdfService();
    const plain = await service.render({ ...slip, identity }, 'Dinesh Sharma');
    const withLogo = await service.render(
      { ...slip, identity },
      'Dinesh Sharma',
      png,
    );
    expect(plain.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(withLogo.toString('latin1')).toContain('/Subtype /Image');
    expect(plain.toString('latin1')).not.toContain('/Subtype /Image');
    // One page: the payslip must fit on a single A4 sheet.
    for (const pdf of [plain, withLogo]) {
      expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    }

    // A logo that is not an image must not cost the employee their payslip.
    const garbage = await service.render(
      { ...slip, identity },
      'Dinesh Sharma',
      Buffer.from('not an image'),
    );
    expect(garbage.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
