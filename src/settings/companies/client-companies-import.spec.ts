import * as ExcelJS from 'exceljs';
import { planCompanies, readCompanyRows } from './client-companies-import';

/** The client's own Companies tab (2026-10-22), as their screenshots show it. */
const HEADER = [
  'Company Legal Name *',
  'Short Code *',
  'Registered Address *',
  'City *',
  'State *',
  'PIN Code *',
  'Phone',
  'Email',
  'Website',
  'GSTIN',
  'PAN *',
  'CIN',
  'TAN',
  'PF Establishment Code',
];
const PRPL = 'PARTH REALCON PRIVATE LIMITED';
const TE = 'TIRUPATI ENTERPRISES';
const CIN = 'U70109RJ2022PTC081146';
const ROWS: (string | number | null)[][] = [
  [
    PRPL,
    'PRPL',
    '28 A GANDHI NAGAR WARD NO 15, TELI MOHALLA, DEOLI',
    'DEOLI',
    'RAJASTHAN',
    304804,
    9784570406,
    'parth.deoli@gmail.com',
    null,
    '08AAMCP8659H1ZO',
    'AAMCP8659H',
    CIN,
    null,
    null,
  ],
  [
    PRPL,
    'PRPL',
    'KH No 53/18 & 19, Block I, Village Holambi Kalan',
    'Delhi',
    'Delhi',
    110082,
    9784570406,
    'info@parthrealcon.com',
    null,
    '07AAMCP8659H1ZQ',
    'AAMCP8659H',
    null,
    null,
    null,
  ],
  [
    PRPL,
    'PRPL',
    '4-44, Ganeshwadi School, Risala Road',
    'Hingoli',
    'Maharashtra',
    431513,
    9784570406,
    null,
    null,
    '27AAMCP8659H1ZO',
    'AAMCP8659H',
    CIN,
    null,
    null,
  ],
  [
    PRPL,
    'PRPL',
    'Near Kribhco Fertilizer Limited, Jalalabad Road',
    'SHAHJAHANPUR',
    'Uttar Pradesh',
    242223,
    9784570406,
    null,
    null,
    '09AAMCP8659H1ZM',
    'AAMCP8659H',
    null,
    null,
    null,
  ],
  [
    PRPL,
    'PRPL',
    'Kaknu Thambala, Charan Jivabhai, Talav Faliya',
    'GODHRA',
    'Gujarat',
    389001,
    9784570406,
    null,
    null,
    '24AAMCP8659H1ZU',
    'AAMCP8659H',
    null,
    null,
    null,
  ],
  [
    TE,
    'TE',
    'Geeta Bhawan, Teli Mohalla, Deoli',
    'DEOLI',
    'RAJASTHAN',
    304804,
    9828031478,
    'svkjain1975@gmail.com',
    'www.tirupatigroups.in',
    '08AFOPJ3554P1ZQ',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296202',
  ],
  [
    TE,
    'TE',
    'Parshuram Colony, Bharawas Road',
    'Rewari',
    'Haryana',
    123401,
    9828031478,
    null,
    null,
    '06AFOPJ3554P1ZU',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296203',
  ],
  [
    TE,
    'TE',
    'In Front of SDPO Office, Bus Stand Road, Civil Line',
    'Washim',
    'Maharashtra',
    444505,
    9828031478,
    null,
    null,
    '27AFOPJ3554P1ZQ',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296204',
  ],
  [
    TE,
    'TE',
    'Moh Naveen Nagar, Near Reliance Petrol Pump, Jalalabad',
    'SHAHJAHANPUR',
    'Uttar Pradesh',
    242221,
    9828031478,
    null,
    null,
    '09AFOPJ3554P1ZO',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296205',
  ],
  [
    TE,
    'TE',
    'Kanku Thambhla Bus Stop, Talav Faliyu',
    'GODHRA',
    'Gujarat',
    389002,
    9828031478,
    null,
    null,
    '24AFOPJ3554P1ZW',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296206',
  ],
  [
    TE,
    'TE',
    'Ground Floor, NH 139, Near Electric Board, Hardutta',
    'Aurangabad',
    'Bihar',
    824111,
    9828031478,
    null,
    null,
    '10AFOPJ3554P1Z5',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    'RJRAJ1296207',
  ],
  [
    TE,
    'TE',
    'House No. 64, Ward No. 2, Village Sandhara',
    'Mandsaur',
    'Madhya Pradesh',
    458775,
    9828031478,
    null,
    null,
    '23AFOPJ3554P1ZY',
    'AFOPJ3554P',
    null,
    'JDHS14418F',
    null,
  ],
];

function sheetOf(rows = ROWS) {
  const sheet = new ExcelJS.Workbook().addWorksheet('Companies');
  sheet.addRow(['Companies']);
  sheet.addRow(['One row per company in the group.']);
  sheet.addRow(HEADER);
  for (const row of rows) sheet.addRow(row);
  return sheet;
}

describe('client Companies tab → companies and branches (041)', () => {
  it('makes 2 companies and 12 branches', () => {
    const { plans, problems } = planCompanies(readCompanyRows(sheetOf()));
    expect(problems).toEqual([]);
    expect(plans.map((p) => [p.shortCode, p.branches.length])).toEqual([
      ['PRPL', 5],
      ['TE', 7],
    ]);
  });

  it('puts PRPL’s head office in the CIN’s state, and TE’s on its first row', () => {
    const { plans } = planCompanies(readCompanyRows(sheetOf()));
    const head = (code: string) =>
      plans
        .find((p) => p.shortCode === code)!
        .branches.find((b) => b.isHeadOffice)!;
    expect(head('PRPL')).toMatchObject({
      gstin: '08AAMCP8659H1ZO',
      state: 'Rajasthan',
      city: 'DEOLI',
    });
    expect(head('TE')).toMatchObject({
      gstin: '08AFOPJ3554P1ZQ',
      pfEstablishmentCode: 'RJRAJ1296202',
    });
  });

  it('reads the PIN and phone as text and the state in its canonical spelling', () => {
    const [row] = readCompanyRows(sheetOf());
    expect(row).toMatchObject({
      pinCode: '304804',
      phone: '9784570406',
      state: 'Rajasthan',
    });
  });

  it('refuses rows of one company that disagree on the PAN, naming them', () => {
    const rows = ROWS.map((r) => [...r]);
    rows[3][10] = 'AAMCP0000X';
    const { problems } = planCompanies(readCompanyRows(sheetOf(rows)));
    expect(problems.join('\n')).toMatch(
      /Rows 4, 5, 6, 7, 8 \(PRPL\): pan differs/,
    );
  });

  it('refuses a GSTIN in the wrong state', () => {
    const rows = ROWS.map((r) => [...r]);
    rows[4][9] = '08AAMCP8659H1ZU';
    const { problems } = planCompanies(readCompanyRows(sheetOf(rows)));
    expect(problems.join('\n')).toMatch(
      /Row 8 \(PRPL\): GSTIN 08AAMCP8659H1ZU starts 08, but Gujarat is 24/,
    );
  });

  it('takes the company-wide settings from the head-office row, and drops a stray comma', () => {
    const sheet = new ExcelJS.Workbook().addWorksheet('Companies');
    sheet.addRow([
      'Company Legal Name *',
      'Short Code *',
      'State *',
      'GSTIN',
      'PAN *',
      'CIN',
      'ESIC Code',
      'Salary Debit Account No.',
      'Payroll Lock Day',
      'Labour Wage Cycle',
      'Labour Full Day Hours',
    ]);
    sheet.addRow([
      PRPL,
      'PRPL',
      'Delhi',
      '07AAMCP8659H1ZQ',
      'AAMCP8659H',
      null,
      null,
      '09310400000999',
      1,
      null,
      null,
    ]);
    sheet.addRow([
      PRPL,
      'PRPL',
      'RAJASTHAN',
      '08AAMCP8659H1ZO',
      'AAMCP8659H',
      CIN,
      '15000833350001000,',
      '09310400000813',
      2,
      'Monthly',
      8,
    ]);
    const { plans, problems } = planCompanies(readCompanyRows(sheet));
    expect(problems).toEqual([]);
    expect(plans[0].settings).toEqual({
      payrollDebitAccountNumber: '09310400000813',
      payrollLockDay: '2',
      labourWageCycle: 'Monthly',
      labourFullDayHours: '8',
    });
    expect(plans[0].branches[0]).toMatchObject({
      isHeadOffice: true,
      esicCode: '15000833350001000',
    });
  });
});
