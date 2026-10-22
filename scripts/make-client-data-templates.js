// Usage: node scripts/make-client-data-templates.js docs/Client_Data_Collection
// Builds the one-time client data collection workbooks into docs/Client_Data_Collection.
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });

// ── Lists ──────────────────────────────────────────────────────────────────
const L = {
  yesNo: ['Yes', 'No'],
  states: [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
    'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
    'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
    'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
    'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
  ],
  wageCycle: ['Weekly', 'Fortnightly', 'Monthly'],
  weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'No weekly off'],
  holidayType: ['National', 'Regional', 'Company'],
  leaveType: ['Earned leave', 'Casual leave', 'Sick leave', 'Leave without pay'],
  credit: ['Monthly', 'Yearly'],
  division: ['Contract', 'Own'],
  siteType: ['Site', 'Toll', 'Plant'],
  projectStatus: ['Planning', 'Ongoing', 'On hold', 'Completed'],
  activeInactive: ['Active', 'Inactive'],
  title: ['Mr', 'Ms', 'Mrs', 'Dr'],
  gender: ['Male', 'Female', 'Other'],
  labourGender: ['Male', 'Female'],
  marital: ['Single', 'Married', 'Divorced', 'Widowed'],
  employment: ['Full time', 'Contract', 'Daily wage'],
  calc: ['Monthly salary', 'Daily wage'],
  payMode: ['Bank transfer', 'Cash', 'Cheque'],
  loanType: ['Loan', 'Salary advance'],
  machineCategory: [
    'Road Construction & Highway Machinery', 'Highway Operation & Maintenance (O&M)',
    'Building Construction Machinery', 'General Civil Engineering & Site Equipment',
    'Quality Control Laboratory Equipment', 'Surveying & Measurement Equipment',
    'Mining, Quarry & Crusher Plant Machinery', 'Electrical, Mechanical & Utility Equipment',
    'Small Tools, Tackles & Site Accessories', 'Vehicle Fleet',
  ],
  ownership: ['Own', 'Hired', 'Leased'],
  machineStatus: ['Working', 'Idle', 'Repair'],
  meter: ['Hours', 'KM'],
  hireBasis: ['Per hour', 'Per day', 'Per month', 'Per km', 'Per trip'],
  machineDoc: ['Registration (RC)', 'Insurance', 'Fitness', 'Permit', 'PUC', 'Road tax', 'Other'],
  vendorType: [
    'Material supplier', 'Fuel supplier', 'Machinery hire', 'Service provider', 'Sub-contractor',
    'Labour contractor',
  ],
  unit: ['BAG', 'CUM', 'KG', 'NOS', 'MT', 'LTR', 'RMT', 'SQM'],
  engagement: ['Direct', 'Through contractor'],
  tracking: ['Individual (serial no.)', 'Bulk (quantity)'],
  condition: ['New', 'Good', 'Fair', 'Poor'],
  assetStatus: ['In use', 'Idle (in store)', 'Under repair', 'Scrapped'],
  role: [
    'Super Admin', 'Site Admin', 'Project Manager', 'HO User', 'Accountant', 'Site Engineer',
    'Store Keeper', 'Site User', 'General User', 'Viewer',
  ],
};

// ── Styles ─────────────────────────────────────────────────────────────────
const NAVY = 'FF0B2545';
const REQ = 'FFFDE2E1'; // required header fill
const OPT = 'FFE8EEF5'; // optional header fill
const thin = { style: 'thin', color: { argb: 'FFBFC7D5' } };
const border = { top: thin, bottom: thin, left: thin, right: thin };

const DATA_ROWS = 500;
const HEADER_ROW = 3;

/**
 * Column spec: { h: header, req?: bool, w?: width, list?: key of L, type?: 'date'|'number'|'text'|'time',
 * note: what to enter, ex: example }
 */
function addTableSheet(wb, lists, sheet, rows = DATA_ROWS) {
  const ws = wb.addWorksheet(sheet.name, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: sheet.freezeCols ?? 0 }],
    properties: { tabColor: { argb: sheet.tab ?? 'FF1F6FB2' } },
  });
  ws.getCell('A1').value = sheet.title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A2').value = sheet.hint;
  ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF555555' } };

  const header = ws.getRow(HEADER_ROW);
  sheet.cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.req ? `${c.h} *` : c.h;
    cell.font = { bold: true, color: { argb: NAVY } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.req ? REQ : OPT } };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    cell.border = border;
    if (c.note) cell.note = { texts: [{ text: c.note + (c.ex ? `\nExample: ${c.ex}` : '') }] };
    const col = ws.getColumn(i + 1);
    col.width = c.w ?? Math.max(14, Math.min(34, c.h.length + 4));
    if (c.type === 'text') col.numFmt = '@';
    if (c.type === 'date') col.numFmt = 'dd-mm-yyyy';
    if (c.type === 'number') col.numFmt = '#,##0.00';
  });
  header.height = 36;

  for (let r = HEADER_ROW + 1; r <= HEADER_ROW + rows; r++) {
    sheet.cols.forEach((c, i) => {
      const cell = ws.getRow(r).getCell(i + 1);
      if (c.list) {
        cell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [lists.ref(c.list)],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: c.h,
          error: 'Please pick a value from the list.',
        };
      } else if (c.type === 'date') {
        cell.dataValidation = {
          type: 'date',
          operator: 'greaterThan',
          allowBlank: true,
          formulae: [new Date(Date.UTC(1940, 0, 1))],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: c.h,
          error: 'Please enter a date, e.g. 15-04-2024.',
        };
      }
    });
  }
  (sheet.prefill ?? []).forEach((values, i) => {
    const row = ws.getRow(HEADER_ROW + 1 + i);
    values.forEach((v, j) => (row.getCell(j + 1).value = v));
  });
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: sheet.cols.length } };
  return ws;
}

/** A hidden sheet holding the dropdown lists, one per column, in the order `build` references. */
function listsSheet(wb, keys) {
  const ws = wb.addWorksheet('Lists', { state: 'hidden' });
  keys.forEach((k, i) => {
    ws.getRow(1).getCell(i + 1).value = k;
    L[k].forEach((v, j) => (ws.getRow(j + 2).getCell(i + 1).value = v));
  });
}

function instructionsSheet(wb, book) {
  const ws = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF2E7D32' } } });
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 10;
  ws.getColumn(4).width = 70;
  ws.getColumn(5).width = 28;
  let r = 1;
  const put = (text, font = {}) => {
    ws.getCell(`A${r}`).value = text;
    ws.getCell(`A${r}`).font = font;
    r++;
  };
  put(book.title, { bold: true, size: 16, color: { argb: NAVY } });
  put(`Filled by: ${book.owner}`, { bold: true });
  r++;
  for (const line of book.intro) put(line);
  r++;
  put('How to fill', { bold: true, size: 12, color: { argb: NAVY } });
  for (const line of [
    '• Each tab is one list. Fill one row per record, starting from the first empty row under the coloured header.',
    '• Columns marked * (red header) must be filled. Blue headers are optional — fill what you have.',
    '• Where a cell shows a dropdown, pick from it. Hover over a header to see what to enter.',
    '• Dates as DD-MM-YYYY (e.g. 15-04-2024). Amounts in rupees, numbers only — no ₹ sign or commas needed.',
    '• Keep account numbers, Aadhaar, PIN and mobile numbers as typed (the columns are set to text so leading zeros stay).',
    '• Names used to link tabs (company, site, project, department, vendor, employee code) must be spelt exactly the same everywhere.',
    '• Please do not rename tabs or columns, or add columns in the middle — add any extra information in a Remarks column at the end.',
    ...(book.extra ?? []),
  ])
    put(line);
  r++;
  put('Column guide', { bold: true, size: 12, color: { argb: NAVY } });
  const head = ws.getRow(r++);
  ['Tab', 'Column', 'Required', 'What to enter', 'Example / allowed values'].forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  });
  for (const sheet of book.sheets) {
    for (const c of sheet.cols) {
      const row = ws.getRow(r++);
      const allowed = c.list
        ? L[c.list].length > 8
          ? 'Pick from the dropdown'
          : L[c.list].join(' / ')
        : c.ex ?? '';
      [sheet.name, c.h, c.req ? 'Yes' : '', c.note ?? '', allowed].forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v;
        cell.alignment = { wrapText: true, vertical: 'top' };
        cell.border = border;
      });
      if (c.req) row.getCell(3).font = { bold: true, color: { argb: 'FFB3261E' } };
    }
  }
  return ws;
}

async function build(book) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BuildCore';
  wb.created = new Date();
  instructionsSheet(wb, book);
  const keys = [...new Set(book.sheets.flatMap((s) => s.cols.map((c) => c.list).filter(Boolean)))];
  // The data tabs reference the hidden Lists tab, which is added last so it sits at the end.
  const where = {};
  keys.forEach((k, i) => {
    const letter = String.fromCharCode(65 + i);
    where[k] = `Lists!$${letter}$2:$${letter}$${L[k].length + 1}`;
  });
  for (const sheet of book.sheets) addTableSheet(wb, { ref: (k) => where[k] }, sheet, sheet.rows);
  if (keys.length) listsSheet(wb, keys);
  await wb.xlsx.writeFile(path.join(OUT, book.file));
  return wb;
}

// ── Workbooks ──────────────────────────────────────────────────────────────
const C = (h, note, opts = {}) => ({ h, note, ...opts });

const BOOKS = [];

BOOKS.push({
  file: '01_Company_Setup.xlsx',
  title: 'Company setup',
  owner: 'Directors / HR / Accounts',
  intro: [
    'The companies in the group and the settings every other module uses: departments, designations, shifts, holidays, leave rules and who signs letters.',
    'One row per GST registration in "Companies": a company registered in several states repeats its short code, legal name, PAN, CIN and TAN on each row. Please send each company logo (PNG) and letterhead separately.',
  ],
  sheets: [
    {
      name: 'Companies',
      title: 'Companies',
      hint: 'One row per GST registration. A company with several GSTINs repeats its Short Code, legal name, PAN, CIN and TAN on every row.',
      freezeCols: 1,
      cols: [
        C('Company Legal Name', 'Full registered name as on GST/PAN.', { req: true, w: 34, ex: 'Parth Realcon Pvt. Ltd.' }),
        C('Short Code', '2–10 letters, used in document and employee codes.', { req: true, ex: 'PRPL' }),
        C('Registered Address', 'Street address of this registration (the office this GSTIN is for).', { req: true, w: 40 }),
        C('City', '', { req: true }),
        C('State', '', { req: true, list: 'states' }),
        C('PIN Code', '6 digits.', { req: true, type: 'text' }),
        C('Phone', '', { type: 'text' }),
        C('Email', 'Official email.'),
        C('Website', ''),
        C('GSTIN', '15 characters. One row per GSTIN; its first two digits must match the State.', { type: 'text', ex: '27AAACP1234A1Z5' }),
        C('PAN', '10 characters.', { req: true, type: 'text', ex: 'AAACP1234A' }),
        C('CIN', 'Company Identification Number.', { type: 'text' }),
        C('TAN', 'For TDS.', { type: 'text' }),
        C('PF Establishment Code', '', { type: 'text' }),
        C('ESIC Code', '', { type: 'text' }),
        C('Professional Tax Reg. No.', '', { type: 'text' }),
        C('BOCW Reg. No.', 'Building & Other Construction Workers registration.', { type: 'text' }),
        C('Salary Debit Account No.', 'The company bank account salaries are paid from.', { type: 'text' }),
        C('Salary Bank Name', ''),
        C('Salary Bank IFSC', '', { type: 'text' }),
        C('Payroll Lock Day', 'Day of the month after which last month’s attendance is locked for payroll.', { type: 'number', ex: '7' }),
        C('PF Employer Rate %', 'Usually 12.', { type: 'number', ex: '12' }),
        C('ESIC Employer Rate %', 'Usually 3.25.', { type: 'number', ex: '3.25' }),
        C('Gratuity Rate %', 'Usually 4.81.', { type: 'number', ex: '4.81' }),
        C('Bonus Rate %', 'Usually 8.33.', { type: 'number', ex: '8.33' }),
        C('Overtime Multiplier', 'Overtime pay = hourly rate × this. Usually 2.', { type: 'number', ex: '2' }),
        C('Labour Wage Cycle', 'How often daily-wage labour is paid.', { list: 'wageCycle' }),
        C('Labour Full Day Hours', 'Hours between punch in and out that count as a full day.', { type: 'number', ex: '8' }),
        C('Labour Half Day Hours', 'Hours that count as a half day; fewer is short (not paid).', { type: 'number', ex: '4' }),
        C('Labour Overtime After (Hours)', 'Hours beyond this are overtime.', { type: 'number', ex: '8' }),
      ],
    },
    {
      name: 'Departments',
      title: 'Departments',
      hint: 'Every department, per company.',
      cols: [
        C('Company', 'Company short code from the Companies tab.', { req: true }),
        C('Department', '', { req: true, w: 30, ex: 'Accounts' }),
      ],
    },
    {
      name: 'Designations',
      title: 'Designations',
      hint: 'Every job title, per company.',
      cols: [
        C('Company', 'Company short code.', { req: true }),
        C('Designation', '', { req: true, w: 30, ex: 'Project Manager' }),
        C('Department', 'The department it usually sits in (optional).', { w: 26 }),
      ],
    },
    {
      name: 'Shifts',
      title: 'Shifts',
      hint: 'Working shifts for employees (staff). Labour hours are set in the Companies tab.',
      cols: [
        C('Company', 'Company short code.', { req: true }),
        C('Shift Name', '', { req: true, ex: 'General' }),
        C('In Time', '24-hour HH:MM.', { req: true, type: 'text', ex: '09:00' }),
        C('Out Time', '24-hour HH:MM.', { req: true, type: 'text', ex: '18:00' }),
        C('Grace Minutes', 'Minutes late allowed before it counts as late.', { type: 'number', ex: '15' }),
      ],
    },
    {
      name: 'Holidays',
      title: 'Holidays — current year',
      hint: 'Paid holidays for the year. Leave "Sites" blank if it applies to all sites.',
      cols: [
        C('Company', 'Company short code.', { req: true }),
        C('Holiday', '', { req: true, w: 28, ex: 'Diwali' }),
        C('Date', '', { req: true, type: 'date' }),
        C('Type', '', { list: 'holidayType' }),
        C('Sites (if not all)', 'Comma-separated site names, only for regional holidays.', { w: 36 }),
      ],
    },
    {
      name: 'Leave Policy',
      title: 'Leave policy',
      hint: 'How much leave staff get. One row per company and leave type.',
      cols: [
        C('Company', 'Company short code.', { req: true }),
        C('Leave Type', '', { req: true, list: 'leaveType', w: 20 }),
        C('Days Per Year', '', { req: true, type: 'number', ex: '12' }),
        C('Credited', 'Credited every month, or all at the start of the year.', { list: 'credit' }),
        C('Carry Forward?', 'Unused days move to next year.', { list: 'yesNo' }),
        C('Carry Forward Limit (Days)', 'Most days that can be carried.', { type: 'number', ex: '30' }),
        C('Pro-rate for New Joiners?', 'Someone joining mid-year gets a share.', { list: 'yesNo' }),
      ],
    },
    {
      name: 'Letter Signatories',
      title: 'Who signs letters',
      hint: 'People whose name and signature go on offer, appointment, experience and other letters. Send signature images separately.',
      cols: [
        C('Company', 'Company short code.', { req: true }),
        C('Signatory Full Name', '', { req: true, w: 28 }),
        C('Signatory Designation', '', { req: true, w: 26, ex: 'Director' }),
        C('Signs Which Letters', 'e.g. All, or Offer & Appointment only.', { w: 34 }),
      ],
    },
  ],
});

BOOKS.push({
  file: '02_Clients_Projects_Sites.xlsx',
  title: 'Clients, projects and sites',
  owner: 'Projects / Accounts',
  intro: [
    'Who you work for (clients), the projects (contracts) and the physical sites where people punch attendance.',
    'Please also send each project’s BOQ Excel as it is — the system imports BOQs directly — and the work order / LOI PDFs.',
  ],
  extra: [
    '• Site latitude/longitude: open the site in Google Maps, right-click the exact spot and click the numbers at the top to copy them, e.g. 18.5204, 73.8567.',
    '• Include the head office as a site (Head Office? = Yes on the project) so office staff can punch attendance there.',
  ],
  sheets: [
    {
      name: 'Clients',
      title: 'Clients',
      hint: 'Every client (NHAI, PWD, private companies…).',
      freezeCols: 1,
      cols: [
        C('Client Name', '', { req: true, w: 34, ex: 'NHAI — PIU Nagpur' }),
        C('Contact Person', ''),
        C('Phone', '', { type: 'text' }),
        C('Email', ''),
        C('Address', '', { w: 40 }),
        C('State', '', { list: 'states' }),
        C('GSTIN', '', { type: 'text' }),
        C('PAN', '', { type: 'text' }),
      ],
    },
    {
      name: 'Projects',
      title: 'Projects',
      hint: 'One row per project / contract.',
      freezeCols: 2,
      cols: [
        C('Company', 'Company short code that holds the contract.', { req: true }),
        C('Project Code', 'Your internal project code.', { req: true, type: 'text', ex: 'PR-2024-07' }),
        C('Project Name', '', { req: true, w: 40, ex: '4-laning of Medshi–Washim section' }),
        C('Client', 'Exactly as in the Clients tab.', { req: true, w: 28 }),
        C('Branch GSTIN', 'The company GSTIN this project bills from. Blank = head office.', { type: 'text', w: 20 }),
        C('Division', 'Contract (for a client) or Own (own development).', { list: 'division' }),
        C('Project Type', 'Site, toll plaza or plant.', { list: 'siteType' }),
        C('Head Office?', 'Yes only for the head-office entry.', { list: 'yesNo' }),
        C('Location', 'Town / district.'),
        C('Contract Value (₹)', 'Agreement value excluding GST.', { req: true, type: 'number' }),
        C('Quoted % (+ above / − below)', 'Tender quoted percentage vs estimate.', { type: 'number', ex: '-12.5' }),
        C('Work Order / Agreement No.', '', { type: 'text' }),
        C('Start Date', 'Agreement / appointed date.', { req: true, type: 'date' }),
        C('Expected End Date', '', { type: 'date' }),
        C('Status', '', { list: 'projectStatus' }),
        C('Project Manager (Emp. Code)', 'Employee code from the Employees workbook.', { type: 'text' }),
        C('Department / Authority Type', 'e.g. NHAI, PWD, Irrigation, Private.'),
        C('Work Type', 'e.g. Road, Bridge, Building.'),
        C('CGST + SGST Applicable?', 'Yes for intra-state billing, No for IGST.', { list: 'yesNo' }),
        C('Client Retention %', 'Retention held by the client on each bill.', { type: 'number', ex: '5' }),
        C('Site Purchase Limit (₹)', 'Most a site may purchase without HO approval.', { type: 'number' }),
        C('Description', '', { w: 40 }),
      ],
    },
    {
      name: 'Sites',
      title: 'Sites / locations',
      hint: 'Every place people work and punch attendance: project sites, camps, plants, offices.',
      freezeCols: 1,
      cols: [
        C('Site Name', 'Short and unique.', { req: true, w: 30, ex: 'Medshi Camp' }),
        C('Company', 'Company short code.', { req: true }),
        C('Project Code', 'The project this site belongs to (blank for head office).', { type: 'text' }),
        C('Address', '', { w: 40 }),
        C('Latitude', 'From Google Maps.', { req: true, type: 'text', ex: '20.2034' }),
        C('Longitude', 'From Google Maps.', { req: true, type: 'text', ex: '77.0471' }),
        C('Attendance Radius (m)', 'How far from the point a punch is accepted. 200 is typical; larger for long road stretches.', { req: true, type: 'number', ex: '200' }),
        C('Weekly Off Day', '', { list: 'weekday' }),
        C('Status', '', { list: 'activeInactive' }),
      ],
    },
  ],
});

BOOKS.push({
  file: '03_Employees.xlsx',
  title: 'Employees (staff on payroll)',
  owner: 'HR',
  intro: [
    'Every staff member on monthly or daily payroll. Daily-wage site labour paid through muster goes in 07_Labour instead.',
    'Aadhaar, PAN and bank details are sensitive — please share this file only over a secure channel, not on open WhatsApp groups.',
  ],
  extra: [
    '• Employee Code: give your existing codes if you have them; leave blank and the system will number them.',
    '• Salary columns are monthly amounts for monthly staff. For daily-wage staff fill Daily Rate instead.',
  ],
  sheets: [
    {
      name: 'Employees',
      title: 'Employees',
      hint: 'One row per employee, current staff only (people who have left can go in a separate copy if you want their history).',
      freezeCols: 3,
      rows: 1500,
      cols: [
        C('Employee Code', 'Existing code, or blank to auto-number.', { type: 'text', ex: 'PR0012' }),
        C('First Name', '', { req: true }),
        C('Last Name', ''),
        C('Company', 'Company short code.', { req: true }),
        C('Title', '', { list: 'title', w: 8 }),
        C("Father's / Husband's Name", '', { w: 26 }),
        C('Date of Birth', '', { req: true, type: 'date' }),
        C('Gender', '', { req: true, list: 'gender' }),
        C('Marital Status', '', { list: 'marital' }),
        C('Mobile', '10 digits.', { req: true, type: 'text' }),
        C('Alternate Mobile', '', { type: 'text' }),
        C('Email', 'Personal or official — used for login and payslips.', { w: 26 }),
        C('Date of Joining', '', { req: true, type: 'date' }),
        C('Department', 'As in 01_Company_Setup.', { req: true }),
        C('Designation', 'As in 01_Company_Setup.', { req: true }),
        C('Employment Type', '', { req: true, list: 'employment' }),
        C('Site / Location', 'Where they work and punch — site name from 02_Clients_Projects_Sites.', { req: true, w: 24 }),
        C('Shift', 'Shift name from 01_Company_Setup.', { req: true }),
        C('Branch GSTIN', 'The company GSTIN whose PF / ESIC establishment they are filed under. Blank = head office.', { type: 'text', w: 20 }),
        C('Reporting To (Emp. Code)', '', { type: 'text' }),
        C('Probation End Date', '', { type: 'date' }),
        C('Confirmation Date', '', { type: 'date' }),
        C('Salary Basis', 'Monthly salary, or paid per day worked.', { req: true, list: 'calc' }),
        C('Basic (Monthly ₹)', '', { type: 'number' }),
        C('HRA (Monthly ₹)', '', { type: 'number' }),
        C('Conveyance (Monthly ₹)', '', { type: 'number' }),
        C('Site Allowance (Monthly ₹)', '', { type: 'number' }),
        C('Special Allowance (Monthly ₹)', '', { type: 'number' }),
        C('Daily Rate (₹)', 'Only for daily-wage staff.', { type: 'number' }),
        C('Hours Per Day', 'Only for daily-wage staff.', { type: 'number', ex: '8' }),
        C('Salary Payment Mode', '', { list: 'payMode' }),
        C('PF Applicable?', '', { list: 'yesNo' }),
        C('PF Capped at ₹15,000?', 'Yes if PF is worked out on a wage capped at ₹15,000.', { list: 'yesNo' }),
        C('ESIC Applicable?', '', { list: 'yesNo' }),
        C('UAN', '12 digits.', { type: 'text' }),
        C('PF Number', '', { type: 'text' }),
        C('ESIC Number', '', { type: 'text' }),
        C('Aadhaar Number', '12 digits.', { type: 'text' }),
        C('PAN', '', { type: 'text' }),
        C('Bank Name', ''),
        C('Bank Branch', ''),
        C('Bank Account Number', '', { type: 'text', w: 22 }),
        C('IFSC', '11 characters.', { type: 'text' }),
        C('Account Holder Name', 'As printed on the passbook / cheque.', { w: 24 }),
        C('Present Address', '', { w: 36 }),
        C('Present City', ''),
        C('Present State', '', { list: 'states' }),
        C('Present PIN', '', { type: 'text' }),
        C('Permanent Address', '', { w: 36 }),
        C('Permanent City', ''),
        C('Permanent State', '', { list: 'states' }),
        C('Permanent PIN', '', { type: 'text' }),
        C('Emergency Contact Name', ''),
        C('Emergency Contact Relation', ''),
        C('Emergency Contact Phone', '', { type: 'text' }),
      ],
    },
    {
      name: 'Opening Leave Balance',
      title: 'Opening leave balance',
      hint: 'Leave each employee has left on the go-live date.',
      cols: [
        C('Employee Code', '', { req: true, type: 'text' }),
        C('Employee Name', 'For checking only.', { w: 26 }),
        C('Leave Type', '', { req: true, list: 'leaveType', w: 20 }),
        C('Balance (Days)', '', { req: true, type: 'number' }),
        C('As On Date', '', { req: true, type: 'date' }),
      ],
    },
    {
      name: 'Loans & Advances',
      title: 'Outstanding loans and salary advances',
      hint: 'Only amounts still being recovered from salary.',
      cols: [
        C('Employee Code', '', { req: true, type: 'text' }),
        C('Employee Name', 'For checking only.', { w: 26 }),
        C('Type', '', { req: true, list: 'loanType' }),
        C('Amount Given (₹)', '', { req: true, type: 'number' }),
        C('Date Given', '', { type: 'date' }),
        C('Monthly Deduction (₹)', '', { req: true, type: 'number' }),
        C('Outstanding (₹)', 'Still to be recovered on the go-live date.', { req: true, type: 'number' }),
        C('As On Date', '', { req: true, type: 'date' }),
        C('Remarks', '', { w: 30 }),
      ],
    },
  ],
});

BOOKS.push({
  file: '04_Plant_Machinery.xlsx',
  title: 'Plant and machinery',
  owner: 'Plant / Mechanical department',
  intro: [
    'Every machine and vehicle, owned or hired, with its papers. The "Machinery Master" tab can be uploaded into the system as it is (Plant → Import master list).',
    'Same columns as your PRPL Construction Equipment & Machinery Master List, with a few added at the end.',
  ],
  extra: [
    '• Project / Location must be a site name exactly as in 02_Clients_Projects_Sites, so the machine is placed at that site.',
    '• Hired machines: fill the hire vendor and rate columns too.',
  ],
  sheets: [
    {
      name: 'Machinery Master',
      title: 'Plant & machinery master list',
      hint: 'One row per machine or vehicle.',
      freezeCols: 3,
      rows: 1000,
      cols: [
        C('S.No.', '', { w: 7 }),
        C('Category', 'Machine group.', { req: true, list: 'machineCategory', w: 30 }),
        C('Equipment / Machinery Name', 'What the machine is, e.g. Excavator, Tipper, Transit Mixer.', { req: true, w: 28 }),
        C('Asset Code', 'Your existing code, if any.', { type: 'text' }),
        C('Make', '', { ex: 'Tata Hitachi' }),
        C('Model', '', { ex: 'EX 200' }),
        C('Registration / Serial No.', 'Vehicle number, or serial number if not registered.', { type: 'text', w: 22 }),
        C('Ownership (Own/Hired/Leased)', '', { req: true, list: 'ownership' }),
        C('Project / Location', 'Site where it is working now.', { w: 24 }),
        C('Operator / In-charge', '', { w: 22 }),
        C('Purchase / Hire Date', '', { type: 'date' }),
        C('Current Hours / KM', 'Meter reading today.', { type: 'number' }),
        C('Last Service Date', '', { type: 'date' }),
        C('Next Service Due', 'Date or reading.', {}),
        C('Insurance / Permit Expiry', '', { type: 'date' }),
        C('Status (Working/Idle/Repair)', '', { list: 'machineStatus' }),
        C('Remarks', '', { w: 30 }),
        C('Mfg Year', '', { type: 'number', ex: '2021' }),
        C('Engine No.', '', { type: 'text' }),
        C('Chassis No.', '', { type: 'text' }),
        C('Supplier / Dealer', 'Who it was bought from.'),
        C('Cost (₹)', 'Purchase price (owned machines).', { type: 'number' }),
        C('Registered Owner', 'As on the RC.'),
        C('Hire Vendor', 'Only for hired machines — vendor as in 05_Vendors_Contractors.', { w: 24 }),
        C('Hire Rate (₹)', '', { type: 'number' }),
        C('Hire Rate Basis', '', { list: 'hireBasis' }),
      ],
    },
    {
      name: 'Machine Documents',
      title: 'Machine papers',
      hint: 'RC, insurance, fitness, permit, PUC and tax — one row per document. Please send scans named by registration number.',
      cols: [
        C('Registration / Serial No.', 'Same as in Machinery Master.', { req: true, type: 'text', w: 24 }),
        C('Document', '', { req: true, list: 'machineDoc', w: 18 }),
        C('Document No.', '', { type: 'text', w: 22 }),
        C('Issue Date', '', { type: 'date' }),
        C('Expiry Date', '', { type: 'date' }),
        C('Remarks', '', { w: 30 }),
      ],
    },
    {
      name: 'Machine Groups',
      title: 'Machine group settings',
      hint: 'Optional: how each group is measured and how much fuel it should use.',
      prefill: L.machineCategory.map((c) => [c]),
      cols: [
        C('Machine Group', 'From the Category list.', { req: true, w: 40 }),
        C('Meter', 'Hour meter or odometer.', { list: 'meter' }),
        C('Fuel Norm (Litres per Hour or KM)', 'Expected diesel use, to flag excess.', { type: 'number' }),
        C('Fuel Variance Allowed %', 'How far over the norm before it is flagged.', { type: 'number', ex: '10' }),
        C('Target Working Time per Month', 'Hours (or km) a month you expect, for utilisation.', { type: 'number', ex: '200' }),
      ],
    },
  ],
});

BOOKS.push({
  file: '05_Vendors_Contractors.xlsx',
  title: 'Vendors and contractors',
  owner: 'Accounts / Purchase',
  intro: [
    'Everyone you buy from or pay: material suppliers, fuel pumps, machinery hire, service providers, sub-contractors and labour contractors.',
  ],
  sheets: [
    {
      name: 'Vendors',
      title: 'Vendors',
      hint: 'One row per vendor.',
      freezeCols: 2,
      rows: 1000,
      cols: [
        C('Vendor Code', 'Existing code, or blank to auto-number.', { type: 'text' }),
        C('Vendor Name', 'As on their GST certificate.', { req: true, w: 32 }),
        C('Vendor Type', '', { req: true, list: 'vendorType', w: 20 }),
        C('GSTIN', '', { type: 'text' }),
        C('PAN', '', { type: 'text' }),
        C('TDS Section', 'e.g. 194C, 194I, 194J.', { type: 'text' }),
        C('TDS Rate %', '', { type: 'number', ex: '2' }),
        C('Address', '', { w: 36 }),
        C('City', ''),
        C('State', '', { list: 'states' }),
        C('PIN Code', '', { type: 'text' }),
        C('Contact Person', ''),
        C('Phone', '', { type: 'text' }),
        C('Email', ''),
        C('Bank Name', ''),
        C('Bank Branch', ''),
        C('Bank Account Number', '', { type: 'text', w: 22 }),
        C('IFSC', '', { type: 'text' }),
        C('Account Holder Name', '', { w: 24 }),
        C('Supplies / Services', 'What they supply, e.g. Cement, Steel, Diesel, JCB hire.', { w: 30 }),
        C('Status', '', { list: 'activeInactive' }),
      ],
    },
    {
      name: 'Contractor Compliance',
      title: 'Sub-contractor and labour contractor compliance',
      hint: 'Only for sub-contractors and labour contractors.',
      cols: [
        C('Vendor Name', 'As in the Vendors tab.', { req: true, w: 32 }),
        C('Labour Licence No.', '', { type: 'text' }),
        C('PF Registration', '', { type: 'text' }),
        C('ESIC Registration', '', { type: 'text' }),
        C('BOCW Registration', '', { type: 'text' }),
        C('Insurance Policy No.', 'Workmen compensation / EC policy.', { type: 'text' }),
        C('Policy Expiry', '', { type: 'date' }),
      ],
    },
  ],
});

BOOKS.push({
  file: '06_Inventory.xlsx',
  title: 'Inventory — items and opening stock',
  owner: 'Stores / Purchase',
  intro: [
    'The materials you stock (cement, steel, aggregates, diesel, spares…) and what each store holds on the go-live date.',
  ],
  sheets: [
    {
      name: 'Item Categories',
      title: 'Item categories',
      hint: 'How items are grouped.',
      cols: [C('Item Category', '', { req: true, w: 30, ex: 'Cement' })],
    },
    {
      name: 'Items',
      title: 'Items',
      hint: 'One row per material. Unit must be one of the listed units.',
      freezeCols: 2,
      rows: 1000,
      cols: [
        C('Item Code', 'Existing code, or blank to auto-number.', { type: 'text' }),
        C('Item Name', '', { req: true, w: 34, ex: 'OPC 53 Grade Cement' }),
        C('Item Category', 'As in the Item Categories tab.', { req: true, w: 22 }),
        C('Unit', '', { req: true, list: 'unit' }),
        C('HSN Code', '', { type: 'text' }),
        C('Reorder Level', 'Warn when stock falls below this.', { type: 'number' }),
        C('Description', '', { w: 34 }),
      ],
    },
    {
      name: 'Opening Stock',
      title: 'Opening stock',
      hint: 'Stock in each store / site on the go-live date.',
      rows: 2000,
      cols: [
        C('Store / Site', 'Site name from 02_Clients_Projects_Sites.', { req: true, w: 26 }),
        C('Item Name', 'As in the Items tab.', { req: true, w: 34 }),
        C('Quantity', 'In the item’s unit.', { req: true, type: 'number' }),
        C('Rate (₹ per Unit)', 'Average or last purchase rate.', { req: true, type: 'number' }),
        C('As On Date', '', { req: true, type: 'date' }),
      ],
    },
    {
      name: 'Vendor Rates',
      title: 'Agreed vendor rates (optional)',
      hint: 'Rates agreed with suppliers, used to check purchase orders.',
      cols: [
        C('Vendor Name', 'As in 05_Vendors_Contractors.', { req: true, w: 30 }),
        C('Item Name', 'As in the Items tab.', { req: true, w: 30 }),
        C('Rate (₹ per Unit)', '', { req: true, type: 'number' }),
        C('Valid From', '', { type: 'date' }),
      ],
    },
  ],
});

BOOKS.push({
  file: '07_Labour.xlsx',
  title: 'Site labour (daily wage, muster)',
  owner: 'Site in-charge / HR',
  intro: [
    'Daily-wage labour who are marked on the muster at sites. Staff on payroll go in 03_Employees instead.',
    'Face photos are taken in the app when each labour is registered, so no photos are needed here.',
  ],
  sheets: [
    {
      name: 'Labour',
      title: 'Labour',
      hint: 'One row per labour currently working.',
      freezeCols: 1,
      rows: 2000,
      cols: [
        C('Labour Full Name', '', { req: true, w: 28 }),
        C('Gender', 'Decides the daily rate.', { req: true, list: 'labourGender' }),
        C("Father's Name", '', { w: 24 }),
        C('Mobile', '', { type: 'text' }),
        C('Date of Birth', '', { type: 'date' }),
        C('Aadhaar Number', '', { type: 'text' }),
        C('Bank Account Number', '', { type: 'text', w: 22 }),
        C('Site', 'Site name from 02_Clients_Projects_Sites.', { req: true, w: 24 }),
        C('Engaged', 'Directly by you, or through a labour contractor.', { req: true, list: 'engagement' }),
        C('Contractor', 'Labour contractor name as in 05_Vendors_Contractors.', { w: 26 }),
        C('Skill', 'e.g. Mason, Carpenter, Helper.'),
        C('Special Daily Rate (₹)', 'Only if this person is paid differently from the site rate.', { type: 'number' }),
      ],
    },
    {
      name: 'Site Wage Rates',
      title: 'Daily wage rates by site',
      hint: 'The daily rate paid at each site, for male and female labour.',
      cols: [
        C('Site', '', { req: true, w: 26 }),
        C('Male Daily Rate (₹)', '', { req: true, type: 'number' }),
        C('Female Daily Rate (₹)', '', { req: true, type: 'number' }),
        C('Effective From', '', { req: true, type: 'date' }),
      ],
    },
    {
      name: 'Supervisors',
      title: 'Site supervisors',
      hint: 'Who marks labour attendance, and at which sites.',
      cols: [
        C('Supervisor Full Name', '', { req: true, w: 26 }),
        C('Mobile', 'For their login.', { req: true, type: 'text' }),
        C('Email', ''),
        C('Sites', 'Comma-separated site names.', { req: true, w: 40 }),
      ],
    },
  ],
});

BOOKS.push({
  file: '08_Assets.xlsx',
  title: 'Assets (non-machinery)',
  owner: 'Admin / IT / Accounts',
  intro: [
    'Office and site assets that are not plant & machinery: laptops, phones, furniture, survey instruments, tools, site containers.',
  ],
  sheets: [
    {
      name: 'Asset Categories',
      title: 'Asset categories',
      hint: 'How assets are grouped and depreciated.',
      cols: [
        C('Asset Category', '', { req: true, w: 26, ex: 'Laptops' }),
        C('Tracked As', 'Each piece separately, or as a quantity.', { req: true, list: 'tracking', w: 22 }),
        C('Depreciation Rate %', '', { type: 'number', ex: '40' }),
        C('Useful Life (Years)', '', { type: 'number', ex: '3' }),
        C('Issued to a Person?', 'Yes if someone signs for it.', { list: 'yesNo' }),
        C('Needs Periodic Inspection?', '', { list: 'yesNo' }),
        C('Inspection Every (Days)', '', { type: 'number' }),
      ],
    },
    {
      name: 'Assets',
      title: 'Assets',
      hint: 'One row per serial-numbered item, or one row per lot for bulk items.',
      freezeCols: 2,
      rows: 1000,
      cols: [
        C('Asset Code', 'Existing tag, or blank to auto-number.', { type: 'text' }),
        C('Asset Description', '', { req: true, w: 30, ex: 'Dell Latitude 5430' }),
        C('Asset Category', 'As in the Asset Categories tab.', { req: true, w: 22 }),
        C('Manufacturer', ''),
        C('Model No.', '', { type: 'text' }),
        C('Serial No.', '', { type: 'text' }),
        C('Quantity', '1 for serial-numbered items.', { req: true, type: 'number' }),
        C('Unit', 'For bulk items, e.g. Nos, Sets.'),
        C('Purchase Date', '', { type: 'date' }),
        C('Purchase Cost (₹)', '', { req: true, type: 'number' }),
        C('Vendor', ''),
        C('Location / Site', 'Site name from 02_Clients_Projects_Sites.', { req: true, w: 24 }),
        C('With (Emp. Code)', 'Employee it is issued to.', { type: 'text' }),
        C('Condition', '', { list: 'condition' }),
        C('Status', '', { list: 'assetStatus' }),
      ],
    },
  ],
});

BOOKS.push({
  file: '09_Users_Access.xlsx',
  title: 'Users and access',
  owner: 'Directors / IT',
  intro: [
    'Who should log in to the system and what they may see. Employees automatically get a self-service login for their own attendance, leave and payslips — list here only people who need more than that.',
  ],
  sheets: [
    {
      name: 'Users',
      title: 'Users',
      hint: 'One row per person who needs access.',
      cols: [
        C('Full Name', '', { req: true, w: 26 }),
        C('Email', 'Used to log in.', { req: true, w: 28 }),
        C('Mobile', '', { type: 'text' }),
        C('Employee Code', 'If they are an employee.', { type: 'text' }),
        C('Company', 'Company short code.', { req: true }),
        C('Role', 'See the Roles tab.', { req: true, list: 'role', w: 18 }),
        C('Sites', 'For site roles: comma-separated site names.', { w: 34 }),
        C('All Companies?', 'Yes only for people who must see every company in the group.', { list: 'yesNo' }),
      ],
    },
    {
      name: 'Roles',
      title: 'Roles available',
      hint: 'For reference. Tell us if you need a different combination.',
      prefill: [
        ['Super Admin', 'Everything, in every company, including settings, approvals and machinery disposal.'],
        ['Site Admin', 'Everything for their company except machinery disposal.'],
        ['Project Manager', 'Projects, daily work reports, attendance and machinery for their projects.'],
        ['HO User', 'Head office: HR, payroll, projects, finance, inventory, vendors, labour and reports.'],
        ['Accountant', 'Payroll, challans, loans, inventory and reports.'],
        ['Site Engineer', 'Attendance, daily work reports, machinery logbook and fuel, and stores at site.'],
        ['Store Keeper', 'Inventory only.'],
        ['Site User', 'Dashboard and their own workspace.'],
        ['General User', 'Their own attendance, leave, payslips and claims only (every employee).'],
        ['Viewer', 'Dashboard and reports, read only.'],
      ],
      cols: [C('Role', '', { w: 18 }), C('What They Can Do', '', { w: 90 })],
      rows: 0,
    },
  ],
});

(async () => {
  for (const book of BOOKS) await build(book);

  // An index of the files.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Index');
  ws.getCell('A1').value = 'BuildCore — one-time data collection';
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  ws.getCell('A2').value =
    'Please fill these workbooks so we can load your existing data before go-live. Each file has an Instructions tab.';
  ws.getCell('A3').value =
    'Fill in this order — later files refer to names in earlier ones (company short code, site names, employee codes, vendor names).';
  const head = ws.getRow(5);
  ['File', 'What it covers', 'Filled by', 'Tabs'].forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  });
  BOOKS.forEach((b, i) => {
    const row = ws.getRow(6 + i);
    [b.file, b.title, b.owner, b.sheets.map((s) => s.name).join(', ')].forEach((v, j) => {
      const c = row.getCell(j + 1);
      c.value = v;
      c.alignment = { wrapText: true, vertical: 'top' };
      c.border = border;
    });
  });
  const after = 7 + BOOKS.length;
  ws.getCell(`A${after}`).value = 'Also please send, as they are:';
  ws.getCell(`A${after}`).font = { bold: true };
  [
    '• BOQ Excel for each project (imported directly).',
    '• Company logos, letterheads and signatory signatures (PNG/JPG).',
    '• Machine papers (RC, insurance, fitness, permit, PUC) — scans named by registration number.',
    '• Work orders / LOIs per project (PDF).',
  ].forEach((t, i) => (ws.getCell(`A${after + 1 + i}`).value = t));
  [30, 50, 28, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  await wb.xlsx.writeFile(path.join(OUT, '00_Index.xlsx'));
  console.log('written', BOOKS.length + 1, 'files to', OUT);
})();
