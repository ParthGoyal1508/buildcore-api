/**
 * HR completion: the parts of each employee's file a real HR department holds and the base seed
 * leaves blank — particulars, the document file, pay history, the leave policy, location
 * assignments, attendance corrections, tax declarations and the exit of anyone whose notice has
 * run out.
 *
 * Every section checks for its own rows before writing, so a rerun adds nothing. Per-employee
 * values (PAN, account numbers, addresses) come from a generator seeded by the employee code
 * rather than from one shared stream, so they stay the same whichever sections a run skips.
 *
 * Invariants mirrored from the app, not restated loosely:
 * - PF applicable ⇒ UAN and PF number both set (`EmployeesService.assertStatutoryConsistent`).
 * - Aadhaar, Bank Proof and Photograph are the company's mandatory types, and a missing one
 *   **blocks punching** (`assertMandatoryDocsComplete`) — so every active employee holds all
 *   three. The file is "slightly incomplete" only in the optional papers.
 * - A salary revision's new heads equal the employee's current heads for the latest revision,
 *   and each earlier revision's new heads equal the next one's previous heads.
 * - Leave and tax use the app's financial-year label (`2026-27`, `leave-days.financialYearOf`),
 *   not the `2026-2027` the context carries.
 * - An attendance correction is a `PendingAttendanceCorrection` plus the approval instance
 *   `ApprovalsService.submit` would create; applied ones also carry the `AttendanceModification`
 *   and `admin_correction` punches `AttendanceAdminService.mark` writes, times in UTC `HH:mm` as
 *   that service stores them.
 */
import { randomUUID } from 'crypto';

import {
  AttendanceStatusOverride,
  type Employee,
  ExitReason,
  HolidayType,
  LeaveCreditMode,
  LeaveLedgerKind,
  LeaveTypeCode,
  Permission,
  Prisma,
  PunchSource,
  PunchType,
  TaxDeclarationStatus,
  TaxRegime,
} from '@prisma/client';
import type { Sharp, SharpOptions } from 'sharp';

import {
  at,
  d,
  money,
  rng,
  type CompanyContext,
  type ModuleResult,
  type Rng,
} from './support';

// sharp's types resolve to its ESM declarations here; see `src/common/storage/image-fit.ts`.
type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: SharpFactory = require('sharp');

// ─── Reference lists ──────────────────────────────────────────────────────────

interface Town {
  city: string;
  district: string;
  state: string;
  pin: string;
  /** RTO code for a driving licence issued here. */
  rto: string;
  localities: string[];
}

const RAJASTHAN_TOWNS: Town[] = [
  {
    city: 'Deoli',
    district: 'Tonk',
    state: 'Rajasthan',
    pin: '304804',
    rto: 'RJ26',
    localities: [
      'Gandhi Nagar',
      'Kota Road',
      'Bheru Ji Ka Chowk',
      'Shiv Colony',
    ],
  },
  {
    city: 'Tonk',
    district: 'Tonk',
    state: 'Rajasthan',
    pin: '304001',
    rto: 'RJ26',
    localities: ['Chhawni', 'Purani Tonk', 'Bamor Gate', 'Civil Lines'],
  },
  {
    city: 'Malpura',
    district: 'Tonk',
    state: 'Rajasthan',
    pin: '304502',
    rto: 'RJ26',
    localities: ['Bajrang Colony', 'Sadar Bazar', 'Ward No. 9'],
  },
  {
    city: 'Uniyara',
    district: 'Tonk',
    state: 'Rajasthan',
    pin: '304024',
    rto: 'RJ26',
    localities: ['Kakod Road', 'Mali Mohalla', 'Ward No. 4'],
  },
  {
    city: 'Kota',
    district: 'Kota',
    state: 'Rajasthan',
    pin: '324005',
    rto: 'RJ20',
    localities: ['Talwandi', 'Mahaveer Nagar', 'Dadabari', 'Vigyan Nagar'],
  },
  {
    city: 'Bundi',
    district: 'Bundi',
    state: 'Rajasthan',
    pin: '323001',
    rto: 'RJ08',
    localities: ['Nainwa Road', 'Balchand Para', 'Lanka Gate'],
  },
  {
    city: 'Ajmer',
    district: 'Ajmer',
    state: 'Rajasthan',
    pin: '305001',
    rto: 'RJ01',
    localities: ['Vaishali Nagar', 'Adarsh Nagar', 'Panchsheel Nagar'],
  },
  {
    city: 'Kekri',
    district: 'Ajmer',
    state: 'Rajasthan',
    pin: '305404',
    rto: 'RJ01',
    localities: ['Bhadrakali Colony', 'Ajmer Road', 'Ward No. 12'],
  },
  {
    city: 'Jaipur',
    district: 'Jaipur',
    state: 'Rajasthan',
    pin: '302012',
    rto: 'RJ14',
    localities: ['Jhotwara', 'Murlipura', 'Vidhyadhar Nagar', 'Mansarovar'],
  },
  {
    city: 'Sawai Madhopur',
    district: 'Sawai Madhopur',
    state: 'Rajasthan',
    pin: '322001',
    rto: 'RJ25',
    localities: ['Bajaria', 'Alanpur', 'Shahar'],
  },
  {
    city: 'Bhilwara',
    district: 'Bhilwara',
    state: 'Rajasthan',
    pin: '311001',
    rto: 'RJ06',
    localities: ['Shastri Nagar', 'Subhash Nagar', 'Azad Nagar'],
  },
  {
    city: 'Dausa',
    district: 'Dausa',
    state: 'Rajasthan',
    pin: '303303',
    rto: 'RJ29',
    localities: ['Agra Road', 'Gupteshwar Road', 'Ward No. 17'],
  },
];

const OUTSTATION_TOWNS: Town[] = [
  {
    city: 'Lucknow',
    district: 'Lucknow',
    state: 'Uttar Pradesh',
    pin: '226021',
    rto: 'UP32',
    localities: ['Aliganj', 'Kapoorthala', 'Jankipuram'],
  },
  {
    city: 'Sitapur',
    district: 'Sitapur',
    state: 'Uttar Pradesh',
    pin: '261001',
    rto: 'UP34',
    localities: ['Lalbagh', 'Civil Lines', 'Tarinpur'],
  },
  {
    city: 'Rewari',
    district: 'Rewari',
    state: 'Haryana',
    pin: '123401',
    rto: 'HR36',
    localities: ['Model Town', 'Brass Market', 'Sector 4'],
  },
  {
    city: 'Gurugram',
    district: 'Gurugram',
    state: 'Haryana',
    pin: '122001',
    rto: 'HR26',
    localities: ['Sector 14', 'Jacobpura', 'New Colony'],
  },
];

const BANKS: Record<string, { prefix: string; accountDigits: number }> = {
  'State Bank of India': { prefix: 'SBIN', accountDigits: 11 },
  'HDFC Bank': { prefix: 'HDFC', accountDigits: 14 },
  'ICICI Bank': { prefix: 'ICIC', accountDigits: 12 },
  'Axis Bank': { prefix: 'UTIB', accountDigits: 15 },
  'Punjab National Bank': { prefix: 'PUNB', accountDigits: 16 },
  'Bank of Baroda': { prefix: 'BARB', accountDigits: 14 },
};

/** Fictional branch codes under real bank prefixes, by the town the account is held in. */
const BRANCH_CODES: Record<string, Record<string, string>> = {
  SBIN: {
    Deoli: '0031452',
    Tonk: '0030217',
    Kota: '0032608',
    Gurugram: '0050361',
    Lucknow: '0016742',
  },
  HDFC: {
    Deoli: '0004718',
    Tonk: '0002906',
    Kota: '0002144',
    Gurugram: '0001207',
    Lucknow: '0003519',
  },
  ICIC: {
    Deoli: '0006129',
    Tonk: '0004482',
    Kota: '0003970',
    Gurugram: '0000589',
    Lucknow: '0001834',
  },
  UTIB: {
    Deoli: '0003391',
    Tonk: '0001786',
    Kota: '0000815',
    Gurugram: '0000431',
    Lucknow: '0002077',
  },
  PUNB: { Deoli: '0412300', Tonk: '0157800', Kota: '0098100' },
  BARB: { Deoli: '0DEOLIX', Tonk: '0TONKXX', Kota: '0KOTAXX' },
};

const BRANCH_NAMES: Record<string, string> = {
  Deoli: 'Deoli',
  Tonk: 'Tonk',
  Kota: 'Kota Talwandi',
  Gurugram: 'Gurugram Sector 14',
  Lucknow: 'Lucknow Aliganj',
};

const FATHER_FIRST = [
  'Om Prakash',
  'Ram Niwas',
  'Jagdish Prasad',
  'Mohan Lal',
  'Shankar Lal',
  'Ramesh Chand',
  'Kailash Chand',
  'Satyanarayan',
  'Babu Lal',
  'Hanuman Sahai',
  'Radhey Shyam',
  'Prahlad Rai',
];
/** For a surname that already carries the middle name ("Lal Mali", "Singh Rathore"). */
const FATHER_SINGLE = [
  'Kanhaiya',
  'Bhawani',
  'Mahaveer',
  'Gopi',
  'Durga',
  'Bhagwan',
];
const FATHER_MUSLIM = ['Abdul Rashid', 'Mohammed Salim', 'Shakeel Ahmed'];
const WIFE_FIRST = [
  'Rekha',
  'Seema',
  'Anita',
  'Suman',
  'Mamta',
  'Kiran',
  'Meenakshi',
  'Priya',
];
const HUSBAND_FIRST = ['Rajesh', 'Vinod', 'Manish', 'Ashok', 'Naveen'];
const BROTHER_FIRST = ['Rahul', 'Vikas', 'Sunil', 'Pankaj', 'Amit', 'Deepak'];

// ─── Small helpers ────────────────────────────────────────────────────────────

const hash = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};
/** A generator for one employee, independent of what else a run draws. */
const rngFor = (key: string): Rng => rng(1101 + (hash(key) % 1_000_000_007));

const digits = (r: Rng, n: number): string =>
  Array.from({ length: n }, () => String(r.int(0, 9))).join('');
const letters = (r: Rng, n: number): string =>
  Array.from({ length: n }, () => String.fromCharCode(65 + r.int(0, 25))).join(
    '',
  );
const mobile = (r: Rng): string =>
  `${r.pick(['9', '8', '7', '6'])}${digits(r, 9)}`;

const iso = (t: Date): string => t.toISOString().slice(0, 10);
/** The IST calendar day an instant falls on, as a `@db.Date` value. */
const dayOf = (t: Date): Date =>
  d(new Date(t.getTime() + 330 * 60_000).toISOString().slice(0, 10));
const addDays = (t: Date, n: number): Date => {
  const c = new Date(t);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
};
const addMonths = (t: Date, n: number): Date => {
  const c = new Date(t);
  c.setUTCMonth(c.getUTCMonth() + n);
  return c;
};
const round100 = (n: number): number => Math.round(n / 100) * 100;
const num = (v: Prisma.Decimal | null): number => (v ? v.toNumber() : 0);
const fmtDate = (t: Date): string =>
  t.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
/** An IST wall-clock time on `day`, as the UTC `HH:mm` the attendance admin path stores. */
const utcHhmm = (day: Date, h: number, m: number): string =>
  at(day, h, m).toISOString().slice(11, 16);

/** Leave and TDS label a financial year '2026-27' (`leave-days.financialYearOf`). */
const appFy = (ctxFy: string): string =>
  `${ctxFy.slice(0, 4)}-${ctxFy.slice(-2)}`;

/** City, state and PIN of a site, read off its address line. */
function siteTown(address: string | null): {
  city: string;
  state: string;
  pin: string;
} {
  const text = address ?? '';
  const pin = text.match(/(\d{6})\s*$/)?.[1] ?? '304804';
  const state = /Haryana/.test(text)
    ? 'Haryana'
    : /Uttar Pradesh/.test(text)
    ? 'Uttar Pradesh'
    : 'Rajasthan';
  const parts = text
    .replace(/\d{6}\s*$/, '')
    .split(',')
    .map((p) => p.replace(/\(.*?\)/g, '').trim())
    .filter((p) => p && p !== state);
  // The last part is usually the district; the town is the part before it when that names a
  // place ("Deoli, Tonk", "Tehsil Deoli, Tonk", "Itaunja, Lucknow") rather than a road or a camp.
  const prev = (parts[parts.length - 2] ?? '').replace(/^Tehsil /, '');
  const placeLike =
    /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(prev) &&
    !/(Road|Mohalla|Chowk|Colony|Works|Camp|Chauraha|Nagar)$/.test(prev);
  const city = (placeLike ? prev : parts[parts.length - 1] ?? 'Deoli').trim();
  return { city, state, pin };
}

/** The bank branch town nearest to where somebody lives. */
function branchTown(city: string, state: string): string {
  if (state === 'Haryana') return 'Gurugram';
  if (state === 'Uttar Pradesh') return 'Lucknow';
  if (['Kota', 'Bundi', 'Morak'].includes(city)) return 'Kota';
  if (['Tonk', 'Malpura', 'Jaipur', 'Dausa', 'Sawai Madhopur'].includes(city))
    return 'Tonk';
  return 'Deoli';
}

/** A passport-size head-and-shoulders silhouette, as a scanned photograph stand-in. */
async function photographJpeg(r: Rng): Promise<Buffer> {
  const bg = r.pick(['#dfe8f1', '#e6ecf2', '#eef1f4', '#dde6ee']);
  const fg = r.pick(['#9aa7b4', '#a3adb8', '#8f9ba8']);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="385">` +
    `<rect width="300" height="385" fill="${bg}"/>` +
    `<circle cx="150" cy="150" r="70" fill="${fg}"/>` +
    `<path d="M30 385 C40 280 95 245 150 245 C205 245 260 280 270 385 Z" fill="${fg}"/>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

// ─── Shapes read once per company ─────────────────────────────────────────────

type EmployeeRow = Employee;

interface People {
  employees: EmployeeRow[];
  byId: Map<string, EmployeeRow>;
  designation: Map<string, string>;
  department: Map<string, string>;
  sites: Map<
    string,
    { id: string; name: string; address: string | null; isCamp: boolean }
  >;
  /** userId → role names. */
  rolesOf: Map<string, string[]>;
  superAdminUserId: string;
  hrUserId: string;
  /** Whoever does HR's work on `day`: the HR executive, or Head Office once they have left. */
  hrActorOn: (day: Date) => string;
  /** Still employed on `day` (an accepted resignation ends on its last working day). */
  activeOn: (e: EmployeeRow, day: Date) => boolean;
  /** Employees whose accepted resignation has reached its last working day. */
  exiting: Map<string, { lastWorkingDay: Date; resignationDate: Date }>;
}

const nameOf = (e: EmployeeRow): string =>
  [e.firstName, e.lastName].filter(Boolean).join(' ');

async function loadPeople(ctx: CompanyContext): Promise<People> {
  const { prisma, company } = ctx;
  const employees = await prisma.employee.findMany({
    where: { companyId: company.id },
    orderBy: { employeeCode: 'asc' },
  });
  const [designations, departments, sites, resignations] = await Promise.all([
    prisma.designation.findMany({ where: { companyId: company.id } }),
    prisma.department.findMany({ where: { companyId: company.id } }),
    prisma.site.findMany({ where: { companyId: company.id } }),
    prisma.resignation.findMany({
      where: { companyId: company.id, status: 'accepted', deletedAt: null },
    }),
  ]);
  const userIds = employees.map((e) => e.userId).filter(Boolean) as string[];
  const roles = await prisma.userRole.findMany({
    where: { userId: { in: userIds } },
    include: { role: { select: { name: true } } },
  });
  const rolesOf = new Map<string, string[]>();
  for (const r of roles) {
    rolesOf.set(r.userId, [...(rolesOf.get(r.userId) ?? []), r.role.name]);
  }
  const designation = new Map(designations.map((x) => [x.id, x.name]));
  const superAdmin = employees.find(
    (e) => e.userId && rolesOf.get(e.userId)?.includes('Super Admin'),
  );
  const hr = employees.find(
    (e) =>
      e.userId && designation.get(e.designationId ?? '') === 'HR Executive',
  );
  const exiting = new Map<
    string,
    { lastWorkingDay: Date; resignationDate: Date }
  >();
  for (const r of resignations) {
    const lwd = r.agreedLastWorkingDay ?? r.expectedLastWorkingDay;
    if (lwd <= ctx.today) {
      exiting.set(r.employeeId, {
        lastWorkingDay: lwd,
        resignationDate: r.resignationDate,
      });
    }
  }
  const activeOn = (e: EmployeeRow, day: Date) => {
    const x = exiting.get(e.id);
    return !x || x.lastWorkingDay >= day;
  };
  const headOffice = employees.filter(
    (e) => e.userId && rolesOf.get(e.userId)?.includes('Head Office'),
  );
  const hrActorOn = (day: Date) => {
    if (hr?.userId && activeOn(hr, day)) return hr.userId;
    return (
      headOffice.find((e) => activeOn(e, day))?.userId ??
      superAdmin?.userId ??
      ''
    );
  };
  return {
    employees,
    byId: new Map(employees.map((e) => [e.id, e])),
    designation,
    department: new Map(departments.map((x) => [x.id, x.name])),
    sites: new Map(
      sites.map((s) => [
        s.id,
        {
          id: s.id,
          name: s.name,
          address: s.address,
          isCamp: s.projectId !== null,
        },
      ]),
    ),
    rolesOf,
    superAdminUserId: superAdmin?.userId ?? employees[0]?.userId ?? '',
    hrUserId: hr?.userId ?? superAdmin?.userId ?? '',
    hrActorOn,
    activeOn,
    exiting,
  };
}

const usersWithRole = (p: People, role: string): EmployeeRow[] =>
  p.employees.filter(
    (e) => e.userId && p.rolesOf.get(e.userId)?.includes(role),
  );

// ─── 1. Particulars ───────────────────────────────────────────────────────────

/** Where an employee is from, and the identity numbers HR holds — stable per employee. */
interface Identity {
  pan: string;
  aadhaar: string;
  account: string;
  home: Town;
  homeLine: string;
  fatherName: string;
}

function identityOf(
  e: EmployeeRow,
  siteState: string,
  local = false,
): Identity {
  const r = rngFor(`${e.employeeCode}:identity`);
  const surname = (e.lastName ?? e.firstName ?? 'X').split(' ').pop() ?? 'X';
  const pan = `${letters(r, 3)}P${surname[0].toUpperCase()}${digits(
    r,
    4,
  )}${letters(r, 1)}`;
  const aadhaar = `${r.int(2, 9)}${digits(r, 11)}`;
  const bank = BANKS[e.bankName ?? ''] ?? BANKS['State Bank of India'];
  const account =
    bank.prefix === 'HDFC'
      ? `50100${digits(r, bank.accountDigits - 5)}`
      : bank.prefix === 'UTIB'
      ? `9${r.int(16, 24)}010${digits(r, bank.accountDigits - 6)}`
      : `${r.int(1, 6)}${digits(r, bank.accountDigits - 1)}`;
  const outstation = r.rand() < 0.6;
  const home = local
    ? RAJASTHAN_TOWNS[0]
    : siteState !== 'Rajasthan' && outstation
    ? r.pick(OUTSTATION_TOWNS.filter((t) => t.state === siteState))
    : r.pick(RAJASTHAN_TOWNS);
  const homeLine =
    `${r.pick(['H.No.', 'House No.', 'Plot No.'])} ${r.int(3, 240)}, ` +
    `${r.pick(home.localities)}, ${home.city}` +
    (home.district !== home.city ? `, Distt. ${home.district}` : '');
  const last = e.lastName ?? '';
  const fatherName = /Khan$/.test(last)
    ? `${r.pick(FATHER_MUSLIM)} ${last}`
    : /^(Lal|Singh)\b/.test(last)
    ? `${r.pick(FATHER_SINGLE)} ${last}`
    : `${r.pick(FATHER_FIRST)} ${last}`.trim();
  return { pan, aadhaar, account, home, homeLine, fatherName };
}

async function fillParticulars(
  ctx: CompanyContext,
  p: People,
): Promise<number> {
  const { prisma, company } = ctx;
  const companyRow = await prisma.company.findUniqueOrThrow({
    where: { id: company.id },
    select: {
      pfEstablishmentCode: true,
      city: true,
      state: true,
      pinCode: true,
    },
  });
  const hq = {
    city: companyRow.city ?? 'Deoli',
    state: companyRow.state ?? 'Rajasthan',
    pin: companyRow.pinCode ?? '304804',
  };

  // Reporting lines: Director at the top; Project Manager, Accounts and HR to the Director; field
  // trades to the Site Incharge of their own camp; everyone else to the Project Manager.
  const designationOf = (e: EmployeeRow) =>
    p.designation.get(e.designationId ?? '') ?? '';
  const director = p.employees.find((e) => designationOf(e) === 'Director');
  const pm = p.employees.find((e) => designationOf(e) === 'Project Manager');
  const siteIncharges = usersWithRole(p, 'Site Incharge').filter(
    (e) => e.id !== pm?.id && !p.exiting.has(e.id),
  );
  const managerOf = (e: EmployeeRow): string | null => {
    const role = designationOf(e);
    if (role === 'Director') return null;
    if (['Project Manager', 'Accountant', 'HR Executive'].includes(role)) {
      return director?.id ?? null;
    }
    if (
      ['Plant Operator', 'Surveyor', 'Site Supervisor', 'Draughtsman'].includes(
        role,
      )
    ) {
      const local = siteIncharges.find(
        (s) => s.siteId === e.siteId && s.id !== e.id,
      );
      if (local) return local.id;
    }
    return pm && pm.id !== e.id ? pm.id : director?.id ?? null;
  };

  let filled = 0;
  for (const [index, e] of p.employees.entries()) {
    if (e.panEncrypted) continue; // already filled
    const r = rngFor(`${e.employeeCode}:particulars`);
    const site = p.sites.get(e.siteId);
    const town = siteTown(site?.address ?? null);
    const role = designationOf(e);
    const isDirector = role === 'Director';
    const id = identityOf(e, town.state, isDirector);
    // Directors, accounts and HR work out of the company's own town whatever site they are
    // attached to; everyone else lives where their site is.
    const officeRole = ['Director', 'Accountant', 'HR Executive'].includes(
      role,
    );
    if (officeRole) Object.assign(town, hq);
    const female = e.gender === 'female';
    const married = e.maritalStatus === 'married';

    // Present address: field staff live in the camp's staff quarters; office staff rent in town
    // unless that town is home.
    const livesAtHome = id.home.city === town.city;
    const present = livesAtHome
      ? {
          presentAddress: id.homeLine,
          presentCity: id.home.city,
          presentState: id.home.state,
          presentPinCode: id.home.pin,
        }
      : site?.isCamp && !officeRole
      ? {
          presentAddress: `Staff quarters, ${site.name}, ${(site.address ?? '')
            .replace(/\s*\d{6}\s*$/, '')
            .trim()}`,
          presentCity: town.city,
          presentState: town.state,
          presentPinCode: town.pin,
        }
      : {
          presentAddress: `${r.pick(['Flat', 'House No.', 'Room'])} ${r.int(
            2,
            60,
          )}, ${r.pick([
            'Gaurav Path',
            'Kota Road',
            'Shiv Colony',
            'Gandhi Nagar',
          ])}, ${town.city}`,
          presentCity: town.city,
          presentState: town.state,
          presentPinCode: town.pin,
        };

    // The account the bank holds: its branch is where the employee banks from, and the name is
    // as the bank spells it — usually the full name in capitals, occasionally not quite HR's.
    const bank = BANKS[e.bankName ?? ''] ?? BANKS['State Bank of India'];
    const bTown = branchTown(present.presentCity, present.presentState);
    const branchCode =
      BRANCH_CODES[bank.prefix]?.[bTown] ??
      BRANCH_CODES[bank.prefix]?.Deoli ??
      '0031452';
    let holder = nameOf(e).toUpperCase();
    const singleSurname = !(e.lastName ?? '').includes(' ');
    if (index % 5 === 3 && singleSurname && e.gender === 'male') {
      // The bank added the "Kumar" the employee never writes.
      holder = `${(e.firstName ?? '').toUpperCase()} KUMAR ${(
        e.lastName ?? ''
      ).toUpperCase()}`;
    } else if (index % 7 === 5) {
      // An old account opened on an initial.
      holder = `${(e.firstName ?? '?')[0]} ${(e.lastName ?? '').toUpperCase()}`;
    }

    const doj = e.dateOfJoining ?? d('2023-04-01');
    const probationEnd = isDirector ? null : addMonths(doj, 6);
    const offerDate = isDirector ? null : addDays(doj, -r.int(8, 24));
    const seniorRole = [
      'Project Manager',
      'Accountant',
      'HR Executive',
      'Quantity Surveyor',
      'Senior Engineer',
    ].includes(role);

    // Emergency contact consistent with marital status and gender. A wife takes the family name
    // alone ("Rathore"), a brother the full one ("Singh Rathore").
    const surname = e.lastName ?? '';
    const familyName = surname.split(' ').pop() ?? '';
    const emergency = married
      ? {
          emergencyContactName: female
            ? `${r.pick(HUSBAND_FIRST)} ${surname}`.trim()
            : `${r.pick(WIFE_FIRST)} ${familyName}`.trim(),
          emergencyContactRelation: 'Spouse',
        }
      : r.rand() < 0.6
      ? {
          emergencyContactName: id.fatherName,
          emergencyContactRelation: 'Father',
        }
      : {
          emergencyContactName: `${r.pick(BROTHER_FIRST)} ${surname}`.trim(),
          emergencyContactRelation: 'Brother',
        };

    await prisma.employee.update({
      where: { id: e.id },
      data: {
        title: female ? (married ? 'Mrs' : 'Ms') : 'Mr',
        fatherName: id.fatherName,
        ...present,
        permanentAddress: id.homeLine,
        permanentCity: id.home.city,
        permanentState: id.home.state,
        permanentPinCode: id.home.pin,
        alternateMobile: mobile(r),
        ...emergency,
        emergencyContactPhone: mobile(r),
        panEncrypted: ctx.encryptPii(id.pan),
        aadhaarEncrypted: ctx.encryptPii(id.aadhaar),
        bankAccountNumberEncrypted: ctx.encryptPii(id.account),
        bankAccountHolderName: holder,
        bankBranch: BRANCH_NAMES[bTown] ?? bTown,
        ifscCode: `${bank.prefix}${branchCode}`,
        payMode: 'NEFT',
        pfNumber:
          e.pfApplicable && !e.pfNumber
            ? `${
                companyRow.pfEstablishmentCode ?? 'RJ/JPR/0000000'
              }/000/${String(index + 1).padStart(7, '0')}`
            : e.pfNumber,
        hoursPerDay: e.hoursPerDay ?? money(8),
        probationEndDate: probationEnd,
        // The base seed confirmed everyone on their joining day; confirmation follows probation.
        confirmationDate:
          probationEnd &&
          e.confirmationDate &&
          iso(e.confirmationDate) === iso(doj)
            ? addDays(probationEnd, r.int(1, 12))
            : e.confirmationDate,
        offerLetterIssued: offerDate !== null,
        offerLetterIssuedDate: offerDate,
        appointmentLetterIssued: !isDirector,
        appointmentLetterIssuedDate: isDirector ? null : doj,
        ndaSigned: seniorRole,
        ndaSignedDate: seniorRole ? doj : null,
        reportingToEmployeeId: managerOf(e),
        idCardIssued: true,
        bankVerificationDone: true,
        safetyInductionCompleted: site?.isCamp
          ? true
          : e.safetyInductionCompleted,
      },
    });
    filled++;
  }
  return filled;
}

// ─── 2. Document file ─────────────────────────────────────────────────────────

interface DocPlan {
  code: string;
  fileName: string;
  title: string;
  body: string;
  number?: string;
  expiresAt?: Date;
  jpeg?: boolean;
  /** When it was filed, where the paper's own date fixes it. */
  uploadedAt?: Date;
  /** An earlier version this one replaced. */
  previous?: { expiresAt?: Date; uploadedAt: Date; fileName: string };
}

async function fileDocuments(
  ctx: CompanyContext,
  p: People,
): Promise<{ documents: number; versions: number }> {
  const { prisma, company } = ctx;
  const types = await prisma.documentType.findMany({
    where: { companyId: company.id, isActive: true },
  });
  const typeId = new Map(types.map((t) => [t.code, t.id]));
  const held = await prisma.employeeDocument.findMany({
    where: { employeeId: { in: p.employees.map((e) => e.id) } },
    select: { employeeId: true },
  });
  const hasFile = new Set(held.map((h) => h.employeeId));
  const fresh = await prisma.employee.findMany({
    where: { companyId: company.id },
  });

  let documents = 0;
  let versions = 0;
  for (const e of fresh) {
    if (hasFile.has(e.id)) continue;
    const r = rngFor(`${e.employeeCode}:documents`);
    const name = nameOf(e);
    const slug = name.replace(/\s+/g, '_');
    const role = p.designation.get(e.designationId ?? '') ?? '';
    const site = p.sites.get(e.siteId);
    const town = siteTown(site?.address ?? null);
    const id = identityOf(e, town.state, role === 'Director');
    const doj = e.dateOfJoining ?? d('2023-04-01');
    const dob = e.dob ? fmtDate(e.dob) : '—';
    const so = e.gender === 'female' ? 'D/o' : 'S/o';
    const header = `${name}, ${so} ${id.fatherName}`;
    const isDirector = role === 'Director';
    const graduate = [
      'Director',
      'Project Manager',
      'Site Engineer',
      'Senior Engineer',
      'Quantity Surveyor',
      'Accountant',
      'Safety Officer',
      'HR Executive',
    ].includes(role);
    const fieldTrade = [
      'Plant Operator',
      'Surveyor',
      'Site Supervisor',
    ].includes(role);
    const born = e.dob?.getUTCFullYear() ?? 1990;

    const plans: DocPlan[] = [
      {
        code: 'AADHAAR',
        fileName: `aadhaar_${slug.toLowerCase()}.pdf`,
        title: 'Aadhaar — scanned copy (front and back)',
        body: `${header}\nDate of birth: ${dob}\nAddress: ${id.homeLine}, ${
          id.home.state
        } ${id.home.pin}\n\nAadhaar No.: XXXX XXXX ${id.aadhaar.slice(
          -4,
        )}\n\nSelf-attested copy received by HR.`,
        number: `XXXX XXXX ${id.aadhaar.slice(-4)}`,
      },
      {
        code: 'BANK_PROOF',
        fileName:
          r.rand() < 0.5
            ? `cancelled_cheque_${slug}.pdf`
            : `passbook_${slug}.pdf`,
        title: `${
          e.bankName ?? 'Bank'
        } — cancelled cheque / passbook front page`,
        body: `Account holder: ${
          e.bankAccountHolderName ?? name.toUpperCase()
        }\nBank: ${e.bankName}\nBranch: ${e.bankBranch ?? ''}\nIFSC: ${
          e.ifscCode ?? ''
        }\nAccount No.: XXXXXXXX${id.account.slice(
          -4,
        )}\n\nVerified against the salary account opening form.`,
      },
      {
        code: 'PHOTO',
        fileName: `IMG_${iso(doj).replace(/-/g, '')}_${r.int(
          100000,
          235959,
        )}.jpg`,
        title: 'Photograph',
        body: '',
        jpeg: true,
      },
    ];
    if (r.rand() < 0.95) {
      plans.push({
        code: 'PAN',
        fileName: `PAN_${slug}.pdf`,
        title: 'PAN card — scanned copy',
        body: `Name: ${name.toUpperCase()}\nFather's name: ${id.fatherName.toUpperCase()}\nDate of birth: ${dob}\nPermanent Account Number: XXXXXX${id.pan.slice(
          6,
        )}\n\nSelf-attested copy.`,
        number: `XXXXXX${id.pan.slice(6)}`,
      });
    }
    const school = `${r.pick([
      'Govt. Sr. Sec. School',
      'Adarsh Vidya Mandir',
      'Saraswati Vidya Mandir',
      'Kendriya Vidyalaya',
    ])}, ${id.home.city}`;
    if (r.rand() < 0.85) {
      plans.push({
        code: 'MARKSHEET_10',
        fileName: `10th_marksheet_${slug}.pdf`,
        title: 'Secondary School Examination — marksheet',
        body: `${header}\nSchool: ${school}\nYear of passing: ${
          born + 16
        }\nResult: First Division (${r.int(61, 88)}%)`,
      });
    }
    if (r.rand() < 0.8) {
      plans.push({
        code: 'MARKSHEET_12',
        fileName: `12th_marksheet_${slug}.pdf`,
        title: 'Senior Secondary Examination — marksheet',
        body: `${header}\nSchool: ${school}\nStream: ${
          graduate ? 'Science (PCM)' : r.pick(['Science', 'Arts', 'Commerce'])
        }\nYear of passing: ${born + 18}\nResult: ${r.pick([
          'First',
          'Second',
        ])} Division`,
      });
    }
    if (graduate && r.rand() < 0.9) {
      const degree =
        role === 'Accountant'
          ? 'Bachelor of Commerce'
          : role === 'HR Executive'
          ? 'Master of Business Administration (HR)'
          : role === 'Safety Officer'
          ? 'Diploma in Industrial Safety'
          : 'Bachelor of Technology (Civil Engineering)';
      plans.push({
        code: 'DEGREE',
        fileName: `degree_${slug}.pdf`,
        title: 'Degree certificate',
        body: `This is to certify that ${name} has been awarded the degree of\n${degree}\n${r.pick(
          [
            'Rajasthan Technical University, Kota',
            'University of Rajasthan, Jaipur',
            'Maharshi Dayanand Saraswati University, Ajmer',
            'Kota University',
          ],
        )}\nYear: ${born + 22}`,
      });
    }
    const priorYears = doj.getUTCFullYear() - (born + 22);
    if (!isDirector && priorYears >= 3 && r.rand() < 0.65) {
      const prior = r.pick([
        'Ravindra Infracon Pvt. Ltd., Jaipur',
        'Shree Balaji Constructions, Kota',
        'Hadoti Road Builders, Bundi',
        'Gajraj Buildcon Pvt. Ltd., Ajmer',
      ]);
      plans.push({
        code: 'EXPERIENCE_LETTER',
        fileName: `experience_letter_${slug}.pdf`,
        title: 'Experience certificate',
        body: `To whom it may concern\n\nThis is to certify that ${name} worked with ${prior} from ${
          born + 23
        } to ${doj.getUTCFullYear()} as ${role}. During this period the conduct and work were found satisfactory.\n\nWe wish ${
          e.gender === 'female' ? 'her' : 'him'
        } success.\n\nFor ${prior}\nAuthorised Signatory`,
      });
    }
    if (!isDirector && r.rand() < 0.85) {
      plans.push({
        code: 'OFFER_LETTER',
        fileName: `offer_letter_${e.employeeCode}.pdf`,
        title: `${company.name} — offer of employment`,
        body: `Ref: ${company.shortCode}/HR/OFR/${doj.getUTCFullYear()}/${r.int(
          10,
          99,
        )}\n\nDear ${name},\n\nWe are pleased to offer you the position of ${role} at ${
          site?.name ?? 'our site'
        }. Kindly report on ${fmtDate(
          doj,
        )}.\n\nSigned copy returned by the candidate.`,
      });
    }
    if (!isDirector && r.rand() < 0.9) {
      plans.push({
        code: 'APPOINTMENT_LETTER',
        fileName: `appointment_letter_${e.employeeCode}.pdf`,
        title: `${company.name} — letter of appointment`,
        body: `Ref: ${company.shortCode}/HR/APT/${doj.getUTCFullYear()}/${r.int(
          10,
          99,
        )}\nDate: ${fmtDate(doj)}\n\n${name}\n${
          id.homeLine
        }\n\nYou are appointed as ${role} with effect from ${fmtDate(
          doj,
        )} on probation of six months, on the terms set out overleaf.\n\nAccepted and signed by the employee.`,
      });
    }
    if (!isDirector && r.rand() < 0.6) {
      plans.push({
        code: 'JOINING_LETTER_SIGNED',
        fileName: `joining_report_${e.employeeCode}.pdf`,
        title: 'Joining report',
        body: `I, ${name}, report for duty as ${role} at ${
          site?.name ?? ''
        } on ${fmtDate(
          doj,
        )} (forenoon).\n\nSigned: ${name}\nCountersigned: Head Office`,
      });
    }
    if (e.pfApplicable && r.rand() < 0.85) {
      plans.push({
        code: 'PF_FORM_11',
        fileName: `form11_${e.employeeCode}.pdf`,
        title: 'EPF Form 11 — declaration form',
        body: `${header}\nUAN: ${e.uan ?? ''}\nPrevious membership of EPF: ${
          priorYears >= 3 ? 'Yes' : 'No'
        }\nInternational worker: No\n\nDeclaration signed by the member.`,
      });
    }
    if (e.pfApplicable && r.rand() < 0.7) {
      plans.push({
        code: 'PF_FORM_2_NOMINATION',
        fileName: `form2_nomination_${e.employeeCode}.pdf`,
        title: 'EPF Form 2 (revised) — nomination and declaration',
        body: `Member: ${name}\nUAN: ${e.uan ?? ''}\nNominee: ${
          e.emergencyContactName ?? id.fatherName
        } (${e.emergencyContactRelation ?? 'Father'}) — 100%`,
      });
    }
    if ((site?.isCamp || fieldTrade) && r.rand() < 0.8) {
      const issued = d(
        `2026-0${r.int(4, 7)}-${String(r.int(2, 26)).padStart(2, '0')}`,
      );
      const renewed = r.rand() < 0.25;
      plans.push({
        code: 'MEDICAL_FITNESS',
        fileName: `medical_fitness_${slug}_${issued.getUTCFullYear()}.pdf`,
        title: 'Certificate of medical fitness',
        body: `Certified that ${name}, aged ${
          2026 - born
        }, has been examined and is found medically fit for work at a road construction site, including work at height and near operating machinery.\n\nDate of examination: ${fmtDate(
          issued,
        )}\nDr. ${r.pick([
          'R. K. Meena',
          'S. Jain',
          'A. Saxena',
        ])}, MBBS — Govt. Hospital, ${town.city}`,
        expiresAt: addDays(addMonths(issued, 12), -1),
        uploadedAt: at(addDays(issued, r.int(2, 6)), 12, r.int(0, 59)),
        previous: renewed
          ? {
              expiresAt: addDays(addMonths(issued, 0), -3),
              uploadedAt: at(addMonths(issued, -12), 11, r.int(5, 55)),
              fileName: `medical_fitness_${slug}_${
                issued.getUTCFullYear() - 1
              }.pdf`,
            }
          : undefined,
      });
    }
    if (role === 'Plant Operator' || (site?.isCamp && r.rand() < 0.4)) {
      const issuedYear = born + r.int(19, 24);
      const transport = role === 'Plant Operator';
      // A transport licence runs five years; the plant operator's falls due soon.
      const expiry = transport
        ? addDays(ctx.today, r.int(18, 26))
        : // A private licence, renewed as it fell due: valid well into the future.
          d(
            `${2028 + r.int(0, 12)}-${String(r.int(1, 12)).padStart(
              2,
              '0',
            )}-15`,
          );
      plans.push({
        code: 'DRIVING_LICENCE',
        fileName: `DL_${slug}.pdf`,
        title: 'Driving licence — scanned copy',
        body: `Name: ${name}\n${so} ${id.fatherName}\nLicence No.: ${
          id.home.rto
        } ${issuedYear}00${digits(r, 5)}\nClass of vehicle: ${
          transport ? 'LMV, HGMV (Transport)' : 'MCWG, LMV'
        }\nValid till: ${fmtDate(expiry)}`,
        number: `${id.home.rto} ${issuedYear}00${digits(r, 5)}`,
        expiresAt: expiry,
      });
    }
    if (
      role === 'Store Keeper' ||
      (role === 'Site Supervisor' && r.rand() < 0.5)
    ) {
      plans.push({
        code: 'POLICE_VERIFICATION',
        fileName: `police_verification_${slug}.pdf`,
        title: 'Character and antecedent verification',
        body: `Police Station ${id.home.city}, District ${id.home.district}\n\nVerified that ${header}, resident of ${id.homeLine}, has no criminal record at this police station.\n\nSHO, PS ${id.home.city}`,
      });
    }

    for (const plan of plans) {
      const documentTypeId = typeId.get(plan.code);
      if (!documentTypeId) continue;
      const bytes = plan.jpeg
        ? await photographJpeg(r)
        : await ctx.renderPdf(plan.title, plan.body);
      const fileRef = await ctx.writeBlob('employee-documents', bytes);
      const uploadedAt = at(
        d(`2026-0${r.int(4, 6)}-${String(r.int(1, 28)).padStart(2, '0')}`),
        r.int(10, 17),
        r.int(0, 59),
      );
      const mimeType = plan.jpeg ? 'image/jpeg' : 'application/pdf';
      const created = await prisma.employeeDocument.create({
        data: {
          employeeId: e.id,
          documentTypeId,
          fileRef,
          fileName: plan.fileName,
          mimeType,
          sizeBytes: bytes.length,
          documentNumber: plan.number ?? null,
          expiresAt: plan.expiresAt ?? null,
          uploadedByUserId: p.hrUserId,
          uploadedAt: plan.uploadedAt ?? uploadedAt,
        },
      });
      documents++;
      if (plan.previous) {
        const oldBytes = await ctx.renderPdf(
          plan.title,
          `${plan.body.split('\n\n')[0]}\n\n(Previous year's certificate.)`,
        );
        const oldRef = await ctx.writeBlob('employee-documents', oldBytes);
        await prisma.employeeDocumentVersion.create({
          data: {
            documentId: created.id,
            employeeId: e.id,
            fileRef: oldRef,
            fileName: plan.previous.fileName,
            mimeType: 'application/pdf',
            sizeBytes: oldBytes.length,
            documentNumber: null,
            expiresAt: plan.previous.expiresAt ?? null,
            uploadedByUserId: p.hrUserId,
            uploadedAt: plan.previous.uploadedAt,
            replacedByUserId: p.hrUserId,
            replacedAt: created.uploadedAt,
          },
        });
        versions++;
      }
    }
  }
  return { documents, versions };
}

// ─── 3. Salary revisions ──────────────────────────────────────────────────────

async function reviseSalaries(ctx: CompanyContext, p: People): Promise<number> {
  const { prisma, company } = ctx;
  const revised = new Set(
    (
      await prisma.salaryRevision.findMany({
        where: { companyId: company.id },
        select: { employeeId: true },
      })
    ).map((s) => s.employeeId),
  );
  let count = 0;
  for (const e of p.employees) {
    if (revised.has(e.id) || !e.basic) continue;
    const r = rngFor(`${e.employeeCode}:revisions`);
    const doj = e.dateOfJoining ?? d('2023-04-01');
    const isDirector = p.designation.get(e.designationId ?? '') === 'Director';

    // The cycles this employee was eligible for: an April appraisal needs six months' service.
    const cycles = ['2024-04-01', '2025-04-01', '2026-04-01']
      .map(d)
      .filter((c) => addMonths(doj, 6) <= c);
    // One in six missed the latest cycle (performance or late confirmation).
    if (!isDirector && r.rand() < 0.17) cycles.pop();
    if (cycles.length === 0) continue;

    // Walk backwards from today's pay: each cycle's new heads are the next one's previous heads.
    let next = {
      basic: num(e.basic),
      hra: num(e.hra),
      conveyance: num(e.conveyanceAllowance),
      siteAllowance: num(e.siteAllowance),
      specialAllowance: num(e.specialAllowance),
    };
    const rows: Prisma.SalaryRevisionCreateManyInput[] = [];
    for (const cycle of [...cycles].reverse()) {
      const pct = isDirector
        ? r.pick([10, 12, 15])
        : r.pick([7, 8, 9, 10, 10, 12]);
      const basic = round100(next.basic / (1 + pct / 100));
      const prev = {
        basic,
        hra: Math.round(basic * 0.4),
        conveyance: next.conveyance,
        siteAllowance: next.siteAllowance,
        specialAllowance: round100(next.specialAllowance / (1 + pct / 100)),
      };
      const fy = `${cycle.getUTCFullYear()}-${String(
        (cycle.getUTCFullYear() + 1) % 100,
      ).padStart(2, '0')}`;
      rows.push({
        companyId: company.id,
        employeeId: e.id,
        effectiveFrom: cycle,
        previousBasic: money(prev.basic),
        previousHra: money(prev.hra),
        previousConveyance: money(prev.conveyance),
        previousSiteAllowance: money(prev.siteAllowance),
        previousSpecialAllowance: money(prev.specialAllowance),
        basic: money(next.basic),
        hra: money(next.hra),
        conveyance: money(next.conveyance),
        siteAllowance: money(next.siteAllowance),
        specialAllowance: money(next.specialAllowance),
        remarks: isDirector
          ? `Director's remuneration revised per Board resolution for FY ${fy} (${pct}%).`
          : `Annual appraisal FY ${fy} — ${pct}% increment on basic and special allowance.`,
        createdByUserId: p.superAdminUserId,
        createdAt: at(addDays(cycle, r.int(4, 12)), 16, r.int(0, 59)),
      });
      next = prev;
    }
    await prisma.salaryRevision.createMany({ data: rows });
    count += rows.length;
  }
  return count;
}

// ─── 4. Leave ─────────────────────────────────────────────────────────────────

async function configureLeave(
  ctx: CompanyContext,
  p: People,
): Promise<{ policies: number; openings: number; balances: number }> {
  const { prisma, company } = ctx;
  const fy = appFy(ctx.fy);

  // Databases seeded before 2026-10-19 carry leave balances under '2026-2027', a label the app
  // never reads (it reads '2026-27'), so they only shadow the real ones. Remove them.
  await prisma.leaveBalance.deleteMany({
    where: { financialYear: ctx.fy, employee: { companyId: company.id } },
  });

  // The policy the crediting job has been applying all year (its built-in default), saved by HR
  // so the screen reads as configured: 1.5 EL a month carried to 45, 8 CL and 7 SL a year.
  let policies = 0;
  const policyRows = [
    {
      leaveType: LeaveTypeCode.earned,
      annualDays: 18,
      creditMode: LeaveCreditMode.monthly,
      carryForward: true,
      carryForwardCap: 45,
    },
    {
      leaveType: LeaveTypeCode.casual,
      annualDays: 8,
      creditMode: LeaveCreditMode.yearly,
      carryForward: false,
      carryForwardCap: null,
    },
    {
      leaveType: LeaveTypeCode.sick,
      annualDays: 7,
      creditMode: LeaveCreditMode.yearly,
      carryForward: false,
      carryForwardCap: null,
    },
  ];
  const existingPolicies = await prisma.leavePolicy.findMany({
    where: { companyId: company.id },
  });
  for (const row of policyRows) {
    if (existingPolicies.some((x) => x.leaveType === row.leaveType)) continue;
    await prisma.leavePolicy.create({
      data: {
        companyId: company.id,
        leaveType: row.leaveType,
        annualDays: money(row.annualDays),
        creditMode: row.creditMode,
        carryForward: row.carryForward,
        carryForwardCap:
          row.carryForwardCap === null ? null : money(row.carryForwardCap),
        prorateJoiners: true,
        updatedByUserId: p.hrUserId,
        createdAt: at(d(`${fy.slice(0, 4)}-03-28`), 15, 10),
      },
    });
    policies++;
  }

  // Earned leave brought over from the paper register when the year opened — what the opening
  // balance import records, and what stops the job inventing a carry-forward from nothing.
  let openings = 0;
  const imported = new Set(
    (
      await prisma.leaveLedgerEntry.findMany({
        where: {
          companyId: company.id,
          financialYear: fy,
          kind: LeaveLedgerKind.opening_import,
        },
        select: { employeeId: true },
      })
    ).map((x) => x.employeeId),
  );
  const fyStart = d(`${fy.slice(0, 4)}-04-01`);
  for (const e of p.employees) {
    if (imported.has(e.id)) continue;
    const doj = e.dateOfJoining ?? fyStart;
    const years = (fyStart.getTime() - doj.getTime()) / (365.25 * 86_400_000);
    if (years < 0.5) continue;
    const r = rngFor(`${e.employeeCode}:leave`);
    const days = Math.min(45, Math.round(years * r.int(5, 9) * 2) / 2);
    if (days <= 0) continue;
    await prisma.leaveLedgerEntry.create({
      data: {
        companyId: company.id,
        employeeId: e.id,
        leaveType: LeaveTypeCode.earned,
        financialYear: fy,
        kind: LeaveLedgerKind.opening_import,
        period: fy,
        days: money(days),
        reason: `Opening balance from the leave register as on 31 Mar ${fy.slice(
          0,
          4,
        )}`,
        createdByUserId: p.hrUserId,
        createdAt: at(addDays(fyStart, 6), 12, 30),
      },
    });
    await prisma.leaveBalance.upsert({
      where: {
        employeeId_leaveType_financialYear: {
          employeeId: e.id,
          leaveType: LeaveTypeCode.earned,
          financialYear: fy,
        },
      },
      create: {
        employeeId: e.id,
        leaveType: LeaveTypeCode.earned,
        financialYear: fy,
        opening: money(days),
      },
      update: { opening: { increment: days } },
    });
    openings++;
  }

  // Approved applications debit the year's balance at approval (`LeaveService.decide`); the base
  // seed approved some without debiting, so bring `used` up to what they cost.
  let balances = 0;
  const approved = await prisma.leaveApplication.findMany({
    where: {
      employeeId: { in: p.employees.map((e) => e.id) },
      status: 'approved',
      leaveType: { not: LeaveTypeCode.lwp },
      fromDate: { gte: fyStart, lt: addMonths(fyStart, 12) },
    },
  });
  const usedBy = new Map<string, number>();
  for (const a of approved) {
    const k = `${a.employeeId}|${a.leaveType}`;
    usedBy.set(k, (usedBy.get(k) ?? 0) + a.dayCount.toNumber());
  }
  for (const [k, used] of usedBy) {
    const [employeeId, leaveType] = k.split('|') as [string, LeaveTypeCode];
    const balance = await prisma.leaveBalance.findUnique({
      where: {
        employeeId_leaveType_financialYear: {
          employeeId,
          leaveType,
          financialYear: fy,
        },
      },
    });
    if (balance && balance.used.toNumber() >= used) continue;
    await prisma.leaveBalance.upsert({
      where: {
        employeeId_leaveType_financialYear: {
          employeeId,
          leaveType,
          financialYear: fy,
        },
      },
      create: { employeeId, leaveType, financialYear: fy, used: money(used) },
      update: { used: money(used) },
    });
    balances++;
  }
  return { policies, openings, balances };
}

// ─── 5a. Location assignments ─────────────────────────────────────────────────

async function assignLocations(
  ctx: CompanyContext,
  p: People,
): Promise<number> {
  const { prisma, company } = ctx;
  const assigned = new Set(
    (
      await prisma.employeeLocationAssignment.findMany({
        where: { companyId: company.id },
        select: { employeeId: true },
      })
    ).map((x) => x.employeeId),
  );
  const goLive = d('2026-04-01');
  const firstMover = p.employees.find(
    (e) =>
      p.sites.get(e.siteId)?.isCamp &&
      [
        'Senior Engineer',
        'Site Engineer',
        'Surveyor',
        'Site Supervisor',
      ].includes(p.designation.get(e.designationId ?? '') ?? ''),
  );
  const camps = [...p.sites.values()].filter((s) => s.isCamp);
  let count = 0;
  for (const e of p.employees) {
    if (assigned.has(e.id)) continue;
    const role = p.designation.get(e.designationId ?? '') ?? '';
    const site = p.sites.get(e.siteId);
    const from =
      e.dateOfJoining && e.dateOfJoining > goLive ? e.dateOfJoining : goLive;
    const rows: Prisma.EmployeeLocationAssignmentCreateManyInput[] = [];
    if (role === 'Project Manager' || role === 'Director') {
      // Exempt from the fence: they move between every camp in a day.
      rows.push({
        companyId: company.id,
        employeeId: e.id,
        siteId: null,
        isMobile: true,
        effectiveFrom: from,
        assignedByUserId: p.superAdminUserId,
        reason:
          role === 'Director'
            ? 'Director — visits all sites and client offices; no fixed fence.'
            : `Project Manager — covers ${camps
                .map((c) => c.name.split(' — ')[0])
                .join(', ')} daily.`,
        createdAt: at(addDays(from, 2), 11, 0),
      });
    } else {
      // One engineer per company moved camps mid-year; the earlier posting stays in the history.
      const moved = site?.isCamp && camps.length > 1 && e.id === firstMover?.id;
      if (moved) {
        const earlier = camps.find((c) => c.id !== e.siteId);
        rows.push({
          companyId: company.id,
          employeeId: e.id,
          siteId: earlier?.id ?? e.siteId,
          isMobile: false,
          effectiveFrom: from,
          assignedByUserId: p.hrUserId,
          reason: `Posted at ${earlier?.name ?? site?.name}.`,
          createdAt: at(addDays(from, 2), 11, 30),
        });
        const shift = d('2026-08-03');
        rows.push({
          companyId: company.id,
          employeeId: e.id,
          siteId: e.siteId,
          isMobile: false,
          effectiveFrom: shift,
          assignedByUserId: p.hrUserId,
          reason: `Shifted to ${site?.name} on the Project Manager's instruction.`,
          createdAt: at(addDays(shift, -2), 17, 15),
        });
      } else {
        rows.push({
          companyId: company.id,
          employeeId: e.id,
          siteId: e.siteId,
          isMobile: false,
          effectiveFrom: from,
          assignedByUserId: p.hrUserId,
          reason: `Posted at ${site?.name ?? 'site'}.`,
          createdAt: at(addDays(from, 2), 11, 30),
        });
      }
    }
    await prisma.employeeLocationAssignment.createMany({ data: rows });
    count += rows.length;
  }
  return count;
}

// ─── 5b. Site holidays ────────────────────────────────────────────────────────

async function siteHolidays(
  ctx: CompanyContext,
  p: People,
): Promise<{ holidays: number; holidaySites: number }> {
  const { prisma, company } = ctx;
  const sites = [...p.sites.values()];
  const byState = (state: string) =>
    sites.filter((s) => siteTown(s.address).state === state).map((s) => s.id);
  const camps = sites.filter((s) => s.isCamp).map((s) => s.id);

  const plan: {
    name: string;
    date: string;
    type: HolidayType;
    siteIds: string[] | null;
  }[] = [
    {
      name: 'Dussehra',
      date: '2026-10-20',
      type: HolidayType.national,
      siteIds: null,
    },
    {
      name: 'Raksha Bandhan',
      date: '2026-08-28',
      type: HolidayType.company,
      siteIds: null,
    },
  ];
  const rajasthan = byState('Rajasthan');
  const haryana = byState('Haryana');
  if (rajasthan.length && rajasthan.length < sites.length) {
    plan.push({
      name: 'Rajasthan Diwas',
      date: '2027-03-30',
      type: HolidayType.regional,
      siteIds: rajasthan,
    });
  }
  if (haryana.length) {
    plan.push({
      name: 'Haryana Day',
      date: '2026-11-01',
      type: HolidayType.regional,
      siteIds: haryana,
    });
  }
  if (camps.length && camps.length < sites.length && !haryana.length) {
    // The camps stop for Govardhan Puja with the labour; head office works.
    plan.push({
      name: 'Govardhan Puja',
      date: '2026-11-09',
      type: HolidayType.regional,
      siteIds: camps,
    });
  }

  let holidays = 0;
  let holidaySites = 0;
  for (const h of plan) {
    const key = {
      companyId_date_name: {
        companyId: company.id,
        date: d(h.date),
        name: h.name,
      },
    };
    let row = await prisma.holiday.findUnique({ where: key });
    if (!row) {
      row = await prisma.holiday.create({
        data: {
          companyId: company.id,
          name: h.name,
          date: d(h.date),
          type: h.type,
          appliesToAllSites: h.siteIds === null,
        },
      });
      holidays++;
    }
    if (h.siteIds) {
      const result = await prisma.holidaySite.createMany({
        data: h.siteIds.map((siteId) => ({ holidayId: row.id, siteId })),
        skipDuplicates: true,
      });
      holidaySites += result.count;
    }
  }
  return { holidays, holidaySites };
}

// ─── 5c. Inter-company transfer ───────────────────────────────────────────────

/**
 * One transfer per company, into it from the other: a field employee who came across with group
 * equipment or a contract. Recorded in the destination company's run, where the employee now is;
 * the employee row itself already sits in the destination with its code, as
 * `EmployeesService.transfer` leaves it.
 */
async function recordTransfer(ctx: CompanyContext, p: People): Promise<number> {
  const { prisma, company } = ctx;
  const other = await prisma.company.findFirst({
    where: { id: { not: company.id } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (!other) return 0;
  const otherAdmin = await prisma.user.findFirst({
    where: {
      companyId: other.id,
      userRoles: { some: { role: { name: 'Super Admin' } } },
    },
    select: { id: true },
  });
  const designationOf = (e: EmployeeRow) =>
    p.designation.get(e.designationId ?? '') ?? '';
  // The older company received a plant operator with group equipment; the younger one a safety
  // officer for a new contract — two different stories rather than one mirrored.
  const companies = await prisma.company.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const wanted =
    companies[0]?.id === company.id
      ? ['Plant Operator', 'Safety Officer']
      : ['Safety Officer', 'Plant Operator'];
  const candidate =
    p.employees.find((e) => !e.userId && designationOf(e) === wanted[0]) ??
    p.employees.find((e) => !e.userId && designationOf(e) === wanted[1]);
  if (!candidate) return 0;
  const already = await prisma.employeeTransfer.findFirst({
    where: { employeeId: candidate.id },
  });
  if (already) return 0;
  const doj = candidate.dateOfJoining ?? d('2023-04-01');
  const transferDate = d(`${Math.max(doj.getUTCFullYear() + 1, 2024)}-07-01`);
  const role = designationOf(candidate);
  await prisma.employeeTransfer.create({
    data: {
      employeeId: candidate.id,
      fromCompanyId: other.id,
      toCompanyId: company.id,
      transferDate,
      reason:
        role === 'Plant Operator'
          ? `Moved from ${other.name} with the sensor paver he operates, which was shifted to ${company.name}'s works.`
          : `Reassigned from ${other.name} to ${company.name} for the new contract's safety staffing.`,
      codeRetained: false,
      newEmployeeCode: candidate.employeeCode,
      transferredByUserId: otherAdmin?.id ?? p.superAdminUserId,
      createdAt: at(transferDate, 12, 0),
    },
  });
  return 1;
}

// ─── 5d. Attendance corrections ───────────────────────────────────────────────

interface CorrectionPlan {
  employee: EmployeeRow;
  day: Date;
  outcome: 'applied' | 'awaiting_hr' | 'awaiting_site' | 'rejected';
  remarks: string;
  rejection?: string;
}

async function attendanceCorrections(
  ctx: CompanyContext,
  p: People,
): Promise<{ corrections: number; modifications: number }> {
  const { prisma, company } = ctx;
  const existing = await prisma.pendingAttendanceCorrection.count({
    where: { companyId: company.id },
  });
  if (existing > 0) return { corrections: 0, modifications: 0 };

  const chain = await prisma.approvalChain.findFirst({
    where: {
      companyId: company.id,
      actionType: 'attendance_correction',
      isActive: true,
    },
    include: { levels: { orderBy: { position: 'asc' } } },
  });
  if (!chain || chain.levels.length === 0)
    return { corrections: 0, modifications: 0 };

  // Days with no punches at all, recent enough to be outside a locked payroll month when the
  // correction is still open, and not a holiday, Sunday or leave day.
  const from = addDays(ctx.today, -32);
  const punches = await prisma.punchRecord.findMany({
    where: {
      employeeId: { in: p.employees.map((e) => e.id) },
      punchDate: { gte: from },
    },
    select: { employeeId: true, punchDate: true },
  });
  const punched = new Set(
    punches.map((x) => `${x.employeeId}|${iso(x.punchDate)}`),
  );
  const holidays = new Set(
    (
      await prisma.holiday.findMany({
        where: { companyId: company.id, date: { gte: from } },
        select: { date: true },
      })
    ).map((h) => iso(h.date)),
  );
  const leaves = await prisma.leaveApplication.findMany({
    where: {
      employeeId: { in: p.employees.map((e) => e.id) },
      status: { in: ['approved', 'pending'] },
    },
  });
  const onLeave = (employeeId: string, day: Date) =>
    leaves.some(
      (l) =>
        l.employeeId === employeeId && l.fromDate <= day && l.toDate >= day,
    );
  // Never before the first recorded punch: a day nobody has attendance for is not a gap.
  const firstPunchDay = punches.reduce(
    (m, x) => (x.punchDate < m ? x.punchDate : m),
    ctx.today,
  );
  const gaps = (e: EmployeeRow, start: Date, end: Date): Date[] => {
    const out: Date[] = [];
    const first = start < firstPunchDay ? firstPunchDay : start;
    for (let t = new Date(first); t <= end; t = addDays(t, 1)) {
      if (t.getUTCDay() === 0 || holidays.has(iso(t))) continue;
      if (punched.has(`${e.id}|${iso(t)}`) || onLeave(e.id, t)) continue;
      out.push(new Date(t));
    }
    return out;
  };

  const lastPunchDay = punches.reduce(
    (m, x) => (x.punchDate > m ? x.punchDate : m),
    from,
  );
  const october = d(`${iso(ctx.today).slice(0, 7)}-01`);
  // Field and office staff; not the Director, nor HR or the Head Office approvers, who would be
  // submitting or deciding their own day.
  const candidates = p.employees.filter(
    (e) =>
      e.isActive &&
      !p.exiting.has(e.id) &&
      !(
        e.userId &&
        ['Super Admin', 'Head Office'].some((role) =>
          p.rolesOf.get(e.userId)?.includes(role),
        )
      ),
  );
  const plans: CorrectionPlan[] = [];
  const used = new Set<string>();
  const take = (
    outcome: CorrectionPlan['outcome'],
    start: Date,
    end: Date,
    remarks: string,
    rejection?: string,
  ) => {
    for (const e of candidates) {
      if (used.has(e.id)) continue;
      const day = gaps(e, start, end)[0];
      if (!day) continue;
      used.add(e.id);
      plans.push({ employee: e, day, outcome, remarks, rejection });
      return;
    }
  };
  take(
    'applied',
    from,
    addDays(october, -1),
    'Working at the far end of the stretch with no mobile network; punch could not be taken. Present as per site diary.',
  );
  take(
    'applied',
    october,
    addDays(lastPunchDay, -5),
    'Phone not charged — attended the PWD joint measurement at site. In/out times confirmed by the Site Incharge.',
  );
  // The narrow window first, so the wider one cannot take its only candidate.
  take(
    'awaiting_site',
    addDays(lastPunchDay, -3),
    lastPunchDay,
    'Forgot to punch after returning from the bank with the site imprest. Present full day.',
  );
  take(
    'awaiting_hr',
    october,
    addDays(lastPunchDay, -1),
    'Deputed to the quarry for material inspection the whole day; no punch possible there.',
  );
  take(
    'rejected',
    from,
    addDays(october, -1),
    'Was at the client office in Tonk for bill follow-up; please mark present.',
    'No movement-register entry or visit record for that day. Apply for leave for the date instead.',
  );

  const siteIncharges = usersWithRole(p, 'Site Incharge');
  const headOffice = usersWithRole(p, 'Head Office');
  const approverAt = (
    position: number,
    e: EmployeeRow,
    originator: string,
    when: Date,
  ) => {
    const pool = position === 1 ? siteIncharges : headOffice;
    const others = pool.filter(
      (x) =>
        x.userId !== originator && x.id !== e.id && p.activeOn(x, dayOf(when)),
    );
    return (
      others.find((x) => x.siteId === e.siteId) ??
      others[0] ??
      pool.find((x) => x.id !== e.id)
    )?.userId;
  };

  let corrections = 0;
  let modifications = 0;
  const now = new Date();
  for (const plan of plans) {
    const e = plan.employee;
    const r = rngFor(`${e.employeeCode}:${iso(plan.day)}:correction`);
    const inTime = utcHhmm(plan.day, 8, r.int(40, 58));
    const outTime = utcHhmm(plan.day, 18, r.int(2, 35));
    const correctionId = randomUUID();
    const submittedOn = addDays(
      plan.day,
      plan.outcome === 'awaiting_site' ? 1 : r.int(1, 2),
    );
    // Nothing may be stamped after the moment the seed runs.
    const past = (t: Date) =>
      t > now ? new Date(now.getTime() - 3_600_000) : t;
    const submittedAt = past(at(submittedOn, 10, r.int(5, 50)));
    const originator = p.hrActorOn(submittedOn);
    const decisions: {
      position: number;
      action: 'approve' | 'reject';
      at: Date;
      reason: string | null;
    }[] = [];
    if (plan.outcome !== 'awaiting_site') {
      decisions.push({
        position: 1,
        action: plan.outcome === 'rejected' ? 'reject' : 'approve',
        at: past(at(submittedOn, 16, r.int(0, 59))),
        reason: plan.outcome === 'rejected' ? plan.rejection ?? null : null,
      });
    }
    if (plan.outcome === 'applied') {
      decisions.push({
        position: 2,
        action: 'approve',
        at: past(at(addDays(submittedOn, 1), 11, r.int(0, 59))),
        reason: null,
      });
    }
    const finalLevel = chain.levels.length;
    const state =
      plan.outcome === 'applied'
        ? 'approved'
        : plan.outcome === 'rejected'
        ? 'rejected'
        : 'pending';
    const currentPosition =
      plan.outcome === 'awaiting_site'
        ? 1
        : plan.outcome === 'awaiting_hr'
        ? 2
        : decisions[decisions.length - 1].position;
    const lastAt = decisions.length
      ? decisions[decisions.length - 1].at
      : submittedAt;

    const instance = await prisma.approvalInstance.create({
      data: {
        companyId: company.id,
        chainId: chain.id,
        entityType: 'attendance_correction',
        entityId: correctionId,
        subject: `${nameOf(e)} — ${iso(
          plan.day,
        )}, manual attendance correction`,
        href: '/dashboard/hr/attendance',
        viewPermission: Permission.ATTENDANCE,
        originatorUserId: originator,
        currentPosition: Math.min(currentPosition, finalLevel),
        state,
        createdAt: submittedAt,
        updatedAt: lastAt,
      },
    });
    for (const dec of decisions) {
      const actor = approverAt(dec.position, e, originator, dec.at);
      if (!actor) continue;
      await prisma.approvalDecision.create({
        data: {
          approvalInstanceId: instance.id,
          companyId: company.id,
          round: 1,
          position: dec.position,
          actorUserId: actor,
          action: dec.action,
          reason: dec.reason,
          decidedAt: dec.at,
        },
      });
    }

    const payload = {
      employeeId: e.id,
      date: iso(plan.day),
      inTime,
      outTime,
      statusOverride: AttendanceStatusOverride.present,
      remarks: plan.remarks,
    };
    await prisma.pendingAttendanceCorrection.create({
      data: {
        id: correctionId,
        companyId: company.id,
        employeeId: e.id,
        date: plan.day,
        payload: payload as Prisma.InputJsonValue,
        submittedByUserId: originator,
        approvalInstanceId: instance.id,
        appliedAt: plan.outcome === 'applied' ? lastAt : null,
        createdAt: submittedAt,
      },
    });
    corrections++;

    if (plan.outcome === 'applied') {
      // What `mark` writes once the chain completes: both sides as admin corrections, and the
      // before/after log the Modifications modal and the employee's own view render.
      for (const [type, time] of [
        [PunchType.in, inTime],
        [PunchType.out, outTime],
      ] as const) {
        await prisma.punchRecord.create({
          data: {
            employeeId: e.id,
            type,
            capturedAt: new Date(`${iso(plan.day)}T${time}:00.000Z`),
            receivedAt: lastAt,
            punchDate: plan.day,
            source: PunchSource.admin_correction,
            statusOverride: AttendanceStatusOverride.present,
            remarks: plan.remarks,
            adminEdited: true,
            editedByUserId: originator,
            editedAt: lastAt,
            createdAt: lastAt,
          },
        });
      }
      await prisma.attendanceModification.create({
        data: {
          employeeId: e.id,
          date: plan.day,
          actorUserId: originator,
          before: { inTime: null, outTime: null, statusOverride: null },
          after: { inTime, outTime, statusOverride: 'present' },
          reason: plan.remarks,
          createdAt: lastAt,
        },
      });
      modifications++;
    }
  }
  return { corrections, modifications };
}

// ─── 5e. Tax declarations ─────────────────────────────────────────────────────

const CEILINGS: Record<string, number> = {
  '80C': 150000,
  '80D': 25000,
  '80CCD1B': 50000,
};

async function taxDeclarations(
  ctx: CompanyContext,
  p: People,
): Promise<{ declarations: number; lines: number }> {
  const { prisma } = ctx;
  const fy = appFy(ctx.fy);
  const declared = new Set(
    (
      await prisma.taxDeclaration.findMany({
        where: {
          employeeId: { in: p.employees.map((e) => e.id) },
          financialYear: fy,
        },
        select: { employeeId: true },
      })
    ).map((x) => x.employeeId),
  );
  const monthlyGross = (e: EmployeeRow) =>
    num(e.basic) +
    num(e.hra) +
    num(e.conveyanceAllowance) +
    num(e.siteAllowance) +
    num(e.specialAllowance);

  let declarations = 0;
  let lines = 0;
  // Staff earning ₹70,000 a month or more: at or near the point where tax bites under either
  // regime. Below that the new regime's rebate leaves nothing to declare.
  const taxable = p.employees
    .filter((e) => monthlyGross(e) >= 70000 && !p.exiting.has(e.id))
    .sort((a, b) => monthlyGross(b) - monthlyGross(a));
  for (const [index, e] of taxable.entries()) {
    if (declared.has(e.id)) continue;
    const r = rngFor(`${e.employeeCode}:tax`);
    const gross = monthlyGross(e);
    const hasRent = e.presentAddress
      ? !e.presentAddress.startsWith('Staff quarters') &&
        e.presentCity !== e.permanentCity
      : false;
    // Most choose by arithmetic: the old regime pays only with large deductions.
    const regime = index % 2 === 0 ? TaxRegime.old : TaxRegime.new;
    const plan: {
      sectionCode: string;
      declared: number;
      proofRef?: string;
      verified?: boolean;
    }[] = [];
    if (regime === TaxRegime.old) {
      const c80 = gross > 150000 ? 180000 : r.pick([95000, 120000, 150000]);
      plan.push({
        sectionCode: '80C',
        declared: c80,
        proofRef:
          index === 0
            ? r.pick([
                'LIC premium receipts (Jun 2026) + PPF passbook to Sep 2026',
                'ELSS statement (Apr 2026) + children tuition fee receipts',
              ])
            : undefined,
        verified: index === 0,
      });
      plan.push({
        sectionCode: '80D',
        declared: gross > 150000 ? 37500 : r.pick([15000, 18000, 22000]),
      });
      if (gross > 120000)
        plan.push({ sectionCode: '80CCD1B', declared: 50000 });
      if (hasRent) {
        const rent = r.pick([7000, 8000, 9000, 12000]) * 12;
        plan.push({
          sectionCode: 'HRA',
          declared: rent,
          proofRef:
            index === 2
              ? 'Rent receipts Apr–Sep 2026; landlord PAN on file'
              : undefined,
          verified: index === 2,
        });
      }
    }
    const createdAt = at(
      d(`2026-04-${String(r.int(10, 28)).padStart(2, '0')}`),
      15,
      r.int(0, 59),
    );
    const decl = await prisma.taxDeclaration.create({
      data: {
        employeeId: e.id,
        financialYear: fy,
        regime,
        createdAt,
        updatedAt: createdAt,
      },
    });
    declarations++;
    for (const line of plan) {
      const ceiling = CEILINGS[line.sectionCode];
      await prisma.taxDeclarationLine.create({
        data: {
          declarationId: decl.id,
          sectionCode: line.sectionCode,
          declaredAmount: money(line.declared),
          cappedAmount: money(
            ceiling ? Math.min(line.declared, ceiling) : line.declared,
          ),
          status: line.verified
            ? TaxDeclarationStatus.verified
            : TaxDeclarationStatus.declared,
          proofRef: line.proofRef ?? null,
          verifiedByUserId: line.verified ? p.hrUserId : null,
          verifiedAt: line.verified ? at(d('2026-10-07'), 12, 40) : null,
        },
      });
      lines++;
    }
  }
  return { declarations, lines };
}

// ─── 5f. Exits ────────────────────────────────────────────────────────────────

async function exitRecords(ctx: CompanyContext, p: People): Promise<number> {
  const { prisma } = ctx;
  let count = 0;
  for (const [employeeId, x] of p.exiting) {
    const e = p.byId.get(employeeId);
    if (!e || !e.isActive) continue;
    const open = await prisma.exitRecord.findFirst({ where: { employeeId } });
    if (open) continue;
    const initiator = e.userId === p.hrUserId ? p.superAdminUserId : p.hrUserId;
    await prisma.exitRecord.create({
      data: {
        employeeId,
        lastWorkingDay: x.lastWorkingDay,
        reason: ExitReason.resignation,
        remarks: `Resigned on ${fmtDate(
          x.resignationDate,
        )}; relieved on ${fmtDate(
          x.lastWorkingDay,
        )} after handover. Clearance and full-and-final settlement in progress.`,
        initiatedByUserId: initiator,
        createdAt: at(addDays(x.lastWorkingDay, -3), 15, 30),
      },
    });
    count++;
  }
  return count;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Left empty on purpose: FaceEnrolment, ReEnrolmentRequest and PunchRefusal (nobody has enrolled
 * through the camera flow yet, so there is nothing to refuse or re-enrol), SalaryAdvance (the
 * payroll module's), the exit clearance waivers (nothing is owed on the open exits yet), and
 * reimbursements (already seeded).
 */
export async function seedHr(ctx: CompanyContext): Promise<ModuleResult> {
  let p = await loadPeople(ctx);
  if (p.employees.length === 0) return {};

  const employees = await fillParticulars(ctx, p);
  // Re-read: the document file and declarations quote the particulars just written.
  p = await loadPeople(ctx);
  const docs = await fileDocuments(ctx, p);
  const salaryRevisions = await reviseSalaries(ctx, p);
  const leave = await configureLeave(ctx, p);
  const locationAssignments = await assignLocations(ctx, p);
  const holidays = await siteHolidays(ctx, p);
  const transfers = await recordTransfer(ctx, p);
  const corrections = await attendanceCorrections(ctx, p);
  const tax = await taxDeclarations(ctx, p);
  const exits = await exitRecords(ctx, p);

  const result: ModuleResult = {
    employees,
    documents: docs.documents,
    'document versions': docs.versions,
    'salary revisions': salaryRevisions,
    'leave policies': leave.policies,
    'leave openings': leave.openings,
    'leave balances fixed': leave.balances,
    'location assignments': locationAssignments,
    holidays: holidays.holidays,
    'holiday sites': holidays.holidaySites,
    transfers,
    'attendance corrections': corrections.corrections,
    'attendance modifications': corrections.modifications,
    'tax declarations': tax.declarations,
    'tax lines': tax.lines,
    'exit records': exits,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, n]) => n > 0),
  ) as ModuleResult;
}
