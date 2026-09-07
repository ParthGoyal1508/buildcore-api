/**
 * A production-shaped demo dataset for local development.
 *
 * DESTRUCTIVE and local-only. Run it after `prisma migrate reset --skip-seed`, which
 * is what actually drops and rebuilds the schema; this fills the empty database.
 *
 * It exists because `prisma/seed.ts` seeds the minimum needed to log in and open
 * `/my/*` — two accounts, one company, one site — which is enough to test a screen and
 * not enough to see what one looks like in use. Every dashboard widget reads zero,
 * every list is empty, and a layout that works with three rows can be wrong with
 * thirty. This seeds two companies with staff, sites, projects, a month of attendance,
 * leave, stores, plant, assets and labour, so the app can be judged as it will be used.
 *
 * Deliberately NOT a replacement for `prisma/seed.ts`: that one is what CI and a
 * first-run developer get, and keeping it small keeps it fast and predictable.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

// ─── Guards ───────────────────────────────────────────────────────────────────
// Both are refusals, not warnings. This script wipes nothing itself, but it writes
// fabricated staff, salaries and attendance — rows that are worse in a real database
// than deletions, because they look real.
function assertLocal() {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-demo.ts must never run with NODE_ENV=production.');
  }
  const host = url.match(/@([^:/?]+)/)?.[1];
  if (
    !host ||
    !['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host)
  ) {
    throw new Error(
      `seed-demo.ts refuses a non-local DATABASE_URL (host: ${
        host ?? 'unparseable'
      }). ` + 'It writes fabricated employees, salaries and attendance.',
    );
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * The whole calendar here is the business timezone's, not the machine's.
 *
 * `config.ts` sets `Asia/Kolkata` and the app derives "today" from it — so a seed that
 * builds its dates in UTC produces attendance the dashboard cannot see for five and a
 * half hours of every day. Between 18:30 and 24:00 UTC the two dates differ, and
 * today's punches land on yesterday: Present Today reads 0 and Absent Today reads
 * everybody. India has no daylight saving, so a fixed offset is exact rather than an
 * approximation worth a date library.
 */
const IST_OFFSET_MIN = 330;

/** The business-timezone calendar date, as the UTC midnight a `@db.Date` stores. */
const dateOnly = (t: Date) => {
  const ist = new Date(t.getTime() + IST_OFFSET_MIN * 60_000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
};
/** The instant at which an IST wall-clock time on `day` actually occurs. */
const at = (day: Date, h: number, m: number) =>
  new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m) -
      IST_OFFSET_MIN * 60_000,
  );
const daysAgo = (n: number) => {
  const t = dateOnly(new Date());
  t.setUTCDate(t.getUTCDate() - n);
  return t;
};
/** Deterministic jitter, so two runs produce the same database. */
let seedState = 42;
const rand = () =>
  (seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const money = (n: number) => new Prisma.Decimal(n);

interface StaffSpec {
  first: string;
  last: string;
  gender: 'male' | 'female';
  dept: string;
  desig: string;
  basic: number;
  joined: string;
  mobile: string;
}

interface CompanySpec {
  name: string;
  shortCode: string;
  city: string;
  state: string;
  pin: string;
  gstin: string;
  pan: string;
  emailDomain: string;
  sites: { name: string; lat: number; lng: number; address: string }[];
  clients: { name: string; city: string }[];
  projects: {
    code: string;
    name: string;
    client: number;
    value: number;
    start: string;
    end: string;
    status: 'planning' | 'ongoing' | 'on_hold' | 'completed';
    location: string;
  }[];
  staff: StaffSpec[];
}

const DEPARTMENTS = [
  'Projects',
  'Engineering',
  'Accounts & Finance',
  'Stores & Procurement',
  'Human Resources',
  'Safety',
  'Plant & Machinery',
];

const DESIGNATIONS = [
  'Project Manager',
  'Site Engineer',
  'Senior Engineer',
  'Quantity Surveyor',
  'Accountant',
  'Store Keeper',
  'Safety Officer',
  'HR Executive',
  'Site Supervisor',
  'Draughtsman',
  'Plant Operator',
  'Surveyor',
];

const COMPANIES: CompanySpec[] = [
  {
    name: 'Parth Realcon Private Limited',
    shortCode: 'PRPL',
    city: 'Bengaluru',
    state: 'Karnataka',
    pin: '560103',
    gstin: '29AAGCP4821H1Z5',
    pan: 'AAGCP4821H',
    emailDomain: 'parthrealcon.com',
    sites: [
      {
        name: 'Whitefield Tech Park — Phase II',
        lat: 12.8897076,
        lng: 77.676732,
        address: 'Survey No. 42, Whitefield Main Road, Bengaluru 560066',
      },
      {
        name: 'Sarjapur Residency',
        lat: 12.901,
        lng: 77.6874,
        address: 'Sarjapur–Attibele Road, Bengaluru 562125',
      },
      {
        name: 'Head Office — Koramangala',
        lat: 12.9352,
        lng: 77.6245,
        address: '4th Block, Koramangala, Bengaluru 560034',
      },
    ],
    clients: [
      { name: 'Prestige Estates Projects Ltd', city: 'Bengaluru' },
      {
        name: 'Karnataka Industrial Areas Development Board',
        city: 'Bengaluru',
      },
    ],
    projects: [
      {
        code: 'PRPL-2401',
        name: 'Whitefield Tech Park — Phase II',
        client: 0,
        value: 184500000,
        start: '2026-01-15',
        end: '2027-06-30',
        status: 'ongoing',
        location: 'Whitefield, Bengaluru',
      },
      {
        code: 'PRPL-2402',
        name: 'Sarjapur Residency — Towers A & B',
        client: 0,
        value: 96200000,
        start: '2026-04-01',
        end: '2027-09-30',
        status: 'ongoing',
        location: 'Sarjapur, Bengaluru',
      },
      {
        code: 'PRPL-2403',
        name: 'KIADB Industrial Shed — Harohalli',
        client: 1,
        value: 41800000,
        start: '2026-08-01',
        end: '2027-02-28',
        status: 'planning',
        location: 'Harohalli, Ramanagara',
      },
    ],
    staff: [
      {
        first: 'Rajesh',
        last: 'Kulkarni',
        gender: 'male',
        dept: 'Projects',
        desig: 'Project Manager',
        basic: 62000,
        joined: '2021-06-14',
        mobile: '9845012301',
      },
      {
        first: 'Sneha',
        last: 'Iyer',
        gender: 'female',
        dept: 'Engineering',
        desig: 'Senior Engineer',
        basic: 48000,
        joined: '2022-02-01',
        mobile: '9845012302',
      },
      {
        first: 'Vikram',
        last: 'Shetty',
        gender: 'male',
        dept: 'Engineering',
        desig: 'Site Engineer',
        basic: 34000,
        joined: '2023-07-10',
        mobile: '9845012303',
      },
      {
        first: 'Anitha',
        last: 'Reddy',
        gender: 'female',
        dept: 'Accounts & Finance',
        desig: 'Accountant',
        basic: 38000,
        joined: '2021-11-22',
        mobile: '9845012304',
      },
      {
        first: 'Mohammed',
        last: 'Irfan',
        gender: 'male',
        dept: 'Stores & Procurement',
        desig: 'Store Keeper',
        basic: 26000,
        joined: '2023-01-09',
        mobile: '9845012305',
      },
      {
        first: 'Deepak',
        last: 'Nair',
        gender: 'male',
        dept: 'Safety',
        desig: 'Safety Officer',
        basic: 31000,
        joined: '2022-09-05',
        mobile: '9845012306',
      },
      {
        first: 'Priya',
        last: 'Menon',
        gender: 'female',
        dept: 'Human Resources',
        desig: 'HR Executive',
        basic: 29000,
        joined: '2023-03-20',
        mobile: '9845012307',
      },
      {
        first: 'Suresh',
        last: 'Gowda',
        gender: 'male',
        dept: 'Engineering',
        desig: 'Site Supervisor',
        basic: 24000,
        joined: '2020-08-17',
        mobile: '9845012308',
      },
      {
        first: 'Kavya',
        last: 'Rao',
        gender: 'female',
        dept: 'Engineering',
        desig: 'Quantity Surveyor',
        basic: 36000,
        joined: '2024-01-08',
        mobile: '9845012309',
      },
      {
        first: 'Manjunath',
        last: 'Patil',
        gender: 'male',
        dept: 'Plant & Machinery',
        desig: 'Plant Operator',
        basic: 22000,
        joined: '2022-05-30',
        mobile: '9845012310',
      },
    ],
  },
  {
    name: 'Shreeji Buildtech Private Limited',
    shortCode: 'SBPL',
    city: 'Pune',
    state: 'Maharashtra',
    pin: '411045',
    gstin: '27AAJCS9134K1ZP',
    pan: 'AAJCS9134K',
    emailDomain: 'shreejibuildtech.in',
    sites: [
      {
        name: 'Hinjewadi IT Campus',
        lat: 18.5913,
        lng: 73.7389,
        address: 'Phase 2, Hinjewadi, Pune 411057',
      },
      {
        name: 'Baner Corporate Office',
        lat: 18.559,
        lng: 73.7868,
        address: 'Baner Road, Pune 411045',
      },
    ],
    clients: [
      { name: 'Panchshil Realty', city: 'Pune' },
      {
        name: 'Maharashtra Industrial Development Corporation',
        city: 'Mumbai',
      },
    ],
    projects: [
      {
        code: 'SBPL-2411',
        name: 'Hinjewadi IT Campus — Block C',
        client: 0,
        value: 213700000,
        start: '2025-11-01',
        end: '2027-03-31',
        status: 'ongoing',
        location: 'Hinjewadi, Pune',
      },
      {
        code: 'SBPL-2412',
        name: 'MIDC Effluent Treatment Plant — Ranjangaon',
        client: 1,
        value: 58900000,
        start: '2026-03-15',
        end: '2026-12-31',
        status: 'on_hold',
        location: 'Ranjangaon, Pune',
      },
    ],
    staff: [
      {
        first: 'Amit',
        last: 'Deshpande',
        gender: 'male',
        dept: 'Projects',
        desig: 'Project Manager',
        basic: 58000,
        joined: '2020-03-02',
        mobile: '9822045101',
      },
      {
        first: 'Pooja',
        last: 'Joshi',
        gender: 'female',
        dept: 'Engineering',
        desig: 'Senior Engineer',
        basic: 45000,
        joined: '2021-09-13',
        mobile: '9822045102',
      },
      {
        first: 'Nilesh',
        last: 'Kadam',
        gender: 'male',
        dept: 'Engineering',
        desig: 'Site Engineer',
        basic: 32000,
        joined: '2023-04-24',
        mobile: '9822045103',
      },
      {
        first: 'Shruti',
        last: 'Bhosale',
        gender: 'female',
        dept: 'Accounts & Finance',
        desig: 'Accountant',
        basic: 36000,
        joined: '2022-06-06',
        mobile: '9822045104',
      },
      {
        first: 'Ganesh',
        last: 'Pawar',
        gender: 'male',
        dept: 'Stores & Procurement',
        desig: 'Store Keeper',
        basic: 25000,
        joined: '2021-12-01',
        mobile: '9822045105',
      },
      {
        first: 'Rohit',
        last: 'Sawant',
        gender: 'male',
        dept: 'Safety',
        desig: 'Safety Officer',
        basic: 30000,
        joined: '2023-08-14',
        mobile: '9822045106',
      },
      {
        first: 'Meera',
        last: 'Kulkarni',
        gender: 'female',
        dept: 'Human Resources',
        desig: 'HR Executive',
        basic: 28000,
        joined: '2024-02-19',
        mobile: '9822045107',
      },
      {
        first: 'Sandeep',
        last: 'Jadhav',
        gender: 'male',
        dept: 'Engineering',
        desig: 'Surveyor',
        basic: 27000,
        joined: '2022-10-10',
        mobile: '9822045108',
      },
      {
        first: 'Ashwini',
        last: 'Gaikwad',
        gender: 'female',
        dept: 'Engineering',
        desig: 'Draughtsman',
        basic: 26000,
        joined: '2023-11-27',
        mobile: '9822045109',
      },
    ],
  },
];

// ─── Reference data shared by both companies ──────────────────────────────────
const SKILLS = [
  { name: 'Mason', code: 'MSN', rate: 850 },
  { name: 'Carpenter', code: 'CRP', rate: 900 },
  { name: 'Bar Bender', code: 'BRB', rate: 880 },
  { name: 'Electrician', code: 'ELC', rate: 950 },
  { name: 'Helper', code: 'HLP', rate: 620 },
  { name: 'Painter', code: 'PNT', rate: 780 },
];

const ITEMS: {
  code: string;
  name: string;
  unit: 'BAG' | 'CUM' | 'KG' | 'NOS' | 'MT' | 'LTR' | 'RMT' | 'SQM';
  cat: string;
}[] = [
  {
    code: 'CEM-OPC53',
    name: 'OPC 53 Grade Cement',
    unit: 'BAG',
    cat: 'Cement & Binders',
  },
  { code: 'CEM-PPC', name: 'PPC Cement', unit: 'BAG', cat: 'Cement & Binders' },
  { code: 'AGG-MSAND', name: 'M-Sand', unit: 'CUM', cat: 'Aggregates' },
  { code: 'AGG-20MM', name: '20mm Jelly', unit: 'CUM', cat: 'Aggregates' },
  { code: 'STL-TMT12', name: 'TMT Bar Fe500D 12mm', unit: 'MT', cat: 'Steel' },
  { code: 'STL-TMT16', name: 'TMT Bar Fe500D 16mm', unit: 'MT', cat: 'Steel' },
  {
    code: 'ELE-WIRE25',
    name: 'FR Copper Wire 2.5 sqmm',
    unit: 'RMT',
    cat: 'Electrical',
  },
  { code: 'PLM-CPVC20', name: 'CPVC Pipe 20mm', unit: 'RMT', cat: 'Plumbing' },
  { code: 'FIN-PUTTY', name: 'Wall Putty', unit: 'KG', cat: 'Finishes' },
  { code: 'SAF-HELMET', name: 'Safety Helmet', unit: 'NOS', cat: 'Safety' },
];

const VENDORS: {
  code: string;
  name: string;
  type:
    | 'material'
    | 'fuel'
    | 'hire'
    | 'service'
    | 'subcontractor'
    | 'labour_contractor';
}[] = [
  { code: 'V-1001', name: 'Ultratech Cement Ltd', type: 'material' },
  { code: 'V-1002', name: 'Sri Balaji Steel Traders', type: 'material' },
  { code: 'V-1003', name: 'Indian Oil — Retail Outlet', type: 'fuel' },
  { code: 'V-1004', name: 'Sundaram Equipment Hire', type: 'hire' },
  {
    code: 'V-1005',
    name: 'Ashok Labour Contractors',
    type: 'labour_contractor',
  },
  { code: 'V-1006', name: 'Precision Survey Services', type: 'service' },
];

const EQUIPMENT: {
  code: string;
  name: string;
  cat: string;
  own: 'owned' | 'hired';
  power: 'diesel' | 'petrol' | 'electric' | 'manual';
  meter: 'hours' | 'km';
}[] = [
  {
    code: 'EQ-EXC-01',
    name: 'JCB 3DX Backhoe Loader',
    cat: 'Earthmoving',
    own: 'owned',
    power: 'diesel',
    meter: 'hours',
  },
  {
    code: 'EQ-TRN-01',
    name: 'Tata LPT 1613 Tipper',
    cat: 'Transport',
    own: 'owned',
    power: 'diesel',
    meter: 'km',
  },
  {
    code: 'EQ-CRN-01',
    name: 'Potain MC 85 Tower Crane',
    cat: 'Lifting',
    own: 'hired',
    power: 'electric',
    meter: 'hours',
  },
  {
    code: 'EQ-CNC-01',
    name: 'Schwing Stetter Batching Plant',
    cat: 'Concreting',
    own: 'owned',
    power: 'electric',
    meter: 'hours',
  },
  {
    code: 'EQ-GEN-01',
    name: 'Kirloskar 125 kVA DG Set',
    cat: 'Power',
    own: 'owned',
    power: 'diesel',
    meter: 'hours',
  },
];

const ASSETS: {
  code: string;
  name: string;
  cat: string;
  mode: 'serialised' | 'bulk';
  cost: number;
  rate: number;
}[] = [
  {
    code: 'AST-LPT-001',
    name: 'Dell Latitude 5440 Laptop',
    cat: 'IT Equipment',
    mode: 'serialised',
    cost: 78000,
    rate: 31.67,
  },
  {
    code: 'AST-LPT-002',
    name: 'Lenovo ThinkPad E14 Laptop',
    cat: 'IT Equipment',
    mode: 'serialised',
    cost: 65000,
    rate: 31.67,
  },
  {
    code: 'AST-TTL-001',
    name: 'Leica TS07 Total Station',
    cat: 'Survey Instruments',
    mode: 'serialised',
    cost: 425000,
    rate: 15,
  },
  {
    code: 'AST-DRL-001',
    name: 'Bosch GSB 600 Impact Drill',
    cat: 'Power Tools',
    mode: 'serialised',
    cost: 6800,
    rate: 15,
  },
  {
    code: 'AST-SCF-001',
    name: 'Cuplock Scaffolding Set',
    cat: 'Scaffolding',
    mode: 'bulk',
    cost: 240000,
    rate: 10,
  },
  {
    code: 'AST-VBR-001',
    name: 'Concrete Needle Vibrator',
    cat: 'Power Tools',
    mode: 'serialised',
    cost: 18500,
    rate: 15,
  },
];

const LABOUR_NAMES = [
  'Ramesh Yadav',
  'Sunil Kumar',
  'Dinesh Sahani',
  'Mukesh Paswan',
  'Ravi Mandal',
  'Santosh Rai',
  'Bablu Kumar',
  'Vijay Thakur',
  'Arun Das',
  'Pappu Sharma',
  'Naresh Prasad',
  'Jitendra Singh',
];

async function main() {
  assertLocal();
  console.log('Seeding a production-shaped demo dataset…\n');

  // The same RLS bypass `withRlsContext()` sets for system writes. Session-wide
  // (`is_local = false`) because this whole script is one short-lived connection.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const password = await hash('secret42');
  const fy = '2026-2027';
  const today = dateOnly(new Date());

  // Roles come from migration 20260830090000_seed_default_roles, which `migrate reset`
  // has already applied — re-seeding them here would fight it.
  const roleByName = new Map(
    (await prisma.role.findMany()).map((r) => [r.name, r.id] as const),
  );
  const roleId = (name: string) => {
    const id = roleByName.get(name);
    if (!id) throw new Error(`Role "${name}" is missing — did migrations run?`);
    return id;
  };

  // ── One cross-company Super Admin, so there is somebody who can see both ─────
  const superAdmin = await prisma.user.create({
    data: {
      email: 'admin@buildcore.dev',
      username: 'admin',
      firstname: 'Super',
      lastname: 'Admin',
      displayName: 'Super Admin',
      password,
      userRoles: { create: { roleId: roleId('Super Admin') } },
    },
  });
  console.log('  Super Admin        admin@buildcore.dev / secret42');

  const totals = { employees: 0, punches: 0, workers: 0, assets: 0 };
  let firstCompanyId: string | null = null;

  for (const spec of COMPANIES) {
    const company = await prisma.company.create({
      data: {
        name: spec.name,
        shortCode: spec.shortCode,
        gstin: spec.gstin,
        pan: spec.pan,
        tan: `${spec.shortCode.slice(0, 4)}${Math.floor(
          10000 + rand() * 89999,
        )}A`,
        address: spec.sites[spec.sites.length - 1].address,
        city: spec.city,
        state: spec.state,
        pinCode: spec.pin,
        pfEstablishmentCode: `${spec.state
          .slice(0, 2)
          .toUpperCase()}/BNG/${Math.floor(100000 + rand() * 899999)}`,
        esicCode: `${Math.floor(10 + rand() * 89)}000${Math.floor(
          100000 + rand() * 899999,
        )}`,
        // The statutory rates a real Indian payroll runs on.
        payrollLockDay: 5,
        pfEmployerRate: money(13),
        esicEmployerRate: money(3.25),
        gratuityRate: money(4.81),
        bonusRate: money(8.33),
      },
    });
    console.log(`\n  ${company.name} (${company.shortCode})`);
    // The Super Admin needs a home company even though CROSS_COMPANY_ACCESS lets
    // them see past it: the company-scoped widgets resolve against the caller's own
    // `companyId`, so an account without one reads zero employees on a database with
    // nineteen. The schema says as much on the field; it is easy to miss when seeding.
    if (!firstCompanyId) {
      firstCompanyId = company.id;
      await prisma.user.update({
        where: { id: superAdmin.id },
        data: { companyId: company.id },
      });
    }

    // ── Masters ───────────────────────────────────────────────────────────────
    const depts = new Map<string, string>();
    for (const name of DEPARTMENTS) {
      const row = await prisma.department.create({
        data: { companyId: company.id, name },
      });
      depts.set(name, row.id);
    }
    const desigs = new Map<string, string>();
    for (const name of DESIGNATIONS) {
      const row = await prisma.designation.create({
        data: { companyId: company.id, name },
      });
      desigs.set(name, row.id);
    }

    const generalShift = await prisma.shift.create({
      data: {
        companyId: company.id,
        name: 'General (9:00 – 18:00)',
        inTime: at(today, 9, 0),
        outTime: at(today, 18, 0),
      },
    });
    await prisma.shift.create({
      data: {
        companyId: company.id,
        name: 'Site Shift (8:00 – 17:00)',
        inTime: at(today, 8, 0),
        outTime: at(today, 17, 0),
      },
    });

    const clients = [];
    for (const c of spec.clients) {
      clients.push(
        await prisma.client.create({
          data: {
            companyId: company.id,
            name: c.name,
            address: c.city,
            contactPerson: pick([
              'Ravi Menon',
              'S. Krishnan',
              'Anil Bhatia',
              'Neha Verma',
            ]),
            phone: `9${Math.floor(700000000 + rand() * 299999999)}`,
          },
        }),
      );
    }

    const projects = [];
    for (const p of spec.projects) {
      projects.push(
        await prisma.project.create({
          data: {
            companyId: company.id,
            code: p.code,
            name: p.name,
            clientId: clients[p.client].id,
            location: p.location,
            contractValue: money(p.value),
            startDate: d(p.start),
            expectedEndDate: d(p.end),
            status: p.status,
          },
        }),
      );
    }

    const sites = [];
    for (const [i, s] of spec.sites.entries()) {
      sites.push(
        await prisma.site.create({
          data: {
            companyId: company.id,
            name: s.name,
            address: s.address,
            latitude: money(s.lat),
            longitude: money(s.lng),
            geofenceRadiusMeters: 500,
            weeklyOffDay: 0, // Sunday
            projectId: projects[i]?.id ?? null,
          },
        }),
      );
    }

    for (const h of [
      { name: 'Republic Day', date: '2027-01-26' },
      { name: 'Holi', date: '2027-03-22' },
      { name: 'Independence Day', date: '2026-08-15' },
      { name: 'Gandhi Jayanti', date: '2026-10-02' },
      { name: 'Diwali', date: '2026-11-08' },
    ]) {
      await prisma.holiday.create({
        data: { companyId: company.id, name: h.name, date: d(h.date) },
      });
    }

    // ── Staff, each with a login of their own ─────────────────────────────────
    const employees = [];
    for (const [i, s] of spec.staff.entries()) {
      const isManager = s.desig === 'Project Manager';
      const email =
        `${s.first}.${s.last}`.toLowerCase() + '@' + spec.emailDomain;
      const user = await prisma.user.create({
        data: {
          email,
          username: `${s.first}.${s.last}`.toLowerCase(),
          firstname: s.first,
          lastname: s.last,
          displayName: `${s.first} ${s.last}`,
          password,
          companyId: company.id,
          // A manager needs the back office; everyone else lives in My Workspace.
          // Matching what these people would actually be given, so the permission
          // filtering has something real to do.
          userRoles: {
            create: {
              roleId: roleId(
                isManager
                  ? 'Site Admin'
                  : s.dept === 'Accounts & Finance'
                  ? 'Accountant'
                  : s.dept === 'Stores & Procurement'
                  ? 'Store Keeper'
                  : s.desig === 'Site Engineer' || s.desig === 'Senior Engineer'
                  ? 'Site Engineer'
                  : 'Site User',
              ),
            },
          },
        },
      });

      const gross = s.basic / 0.5; // basic is 50% of gross, the usual Indian split
      const employee = await prisma.employee.create({
        data: {
          userId: user.id,
          companyId: company.id,
          siteId: sites[i % sites.length].id,
          shiftId: generalShift.id,
          employeeCode: `${spec.shortCode}-${String(1001 + i)}`,
          firstName: s.first,
          lastName: s.last,
          gender: s.gender,
          maritalStatus: rand() > 0.45 ? 'married' : 'single',
          dob: d(
            `19${80 + Math.floor(rand() * 18)}-0${
              1 + Math.floor(rand() * 9)
            }-1${Math.floor(rand() * 9)}`,
          ),
          departmentId: depts.get(s.dept)!,
          designationId: desigs.get(s.desig)!,
          employmentType: 'full_time',
          dateOfJoining: d(s.joined),
          confirmationDate: d(s.joined),
          calculationMode: 'monthly',
          mobile: s.mobile,
          email,
          // A gross split the way an Indian payslip splits it.
          basic: money(s.basic),
          hra: money(Math.round(s.basic * 0.4)),
          conveyanceAllowance: money(1600),
          siteAllowance: money(isManager ? 5000 : 2500),
          specialAllowance: money(Math.round(gross - s.basic * 1.4 - 4100)),
          pfApplicable: true,
          esicApplicable: gross <= 21000,
          uan: `10${Math.floor(1000000000 + rand() * 8999999999)}`,
          paymentMode: 'bank',
          bankName: pick([
            'HDFC Bank',
            'ICICI Bank',
            'State Bank of India',
            'Axis Bank',
          ]),
          ifscCode: pick([
            'HDFC0001234',
            'ICIC0004321',
            'SBIN0009876',
            'UTIB0005678',
          ]),
          presentCity: spec.city,
          presentState: spec.state,
          presentPinCode: spec.pin,
          emergencyContactName: `${pick([
            'Sunita',
            'Ramesh',
            'Lata',
            'Prakash',
          ])} ${s.last}`,
          emergencyContactRelation: pick([
            'Spouse',
            'Father',
            'Mother',
            'Brother',
          ]),
          emergencyContactPhone: `9${Math.floor(
            700000000 + rand() * 299999999,
          )}`,
          idCardIssued: true,
          safetyInductionCompleted: true,
          bankVerificationDone: true,
          siteAccessGranted: true,
        },
      });
      employees.push(employee);
      totals.employees++;
    }
    console.log(
      `    ${employees.length} employees, ${sites.length} sites, ${projects.length} projects`,
    );

    // ── Leave: balances for everyone, a history, and a live queue ─────────────
    for (const e of employees) {
      for (const [type, opening, accrued, used] of [
        ['earned', 12, 6, 3],
        ['casual', 6, 3, 1],
        ['sick', 6, 3, 0],
        ['lwp', 0, 0, 0],
      ] as const) {
        await prisma.leaveBalance.create({
          data: {
            employeeId: e.id,
            leaveType: type,
            financialYear: fy,
            opening: money(opening),
            accrued: money(accrued),
            used: money(Math.round(used * rand())),
          },
        });
      }
    }

    // Two settled applications, one approved leave covering today (so the "On Leave"
    // widget is not permanently zero), and two still pending (so is "Pending
    // Approvals" — and the notifications bell).
    const onLeaveToday = employees[3];
    await prisma.leaveApplication.create({
      data: {
        employeeId: onLeaveToday.id,
        leaveType: 'casual',
        fromDate: daysAgo(1),
        toDate: daysAgo(-1),
        dayCount: money(3),
        reason: 'Family function out of station.',
        status: 'approved',
        decidedByUserId: superAdmin.id,
        decidedAt: daysAgo(4),
      },
    });
    await prisma.leaveApplication.create({
      data: {
        employeeId: employees[1].id,
        leaveType: 'earned',
        fromDate: daysAgo(21),
        toDate: daysAgo(19),
        dayCount: money(3),
        reason: 'Annual leave.',
        status: 'approved',
        decidedByUserId: superAdmin.id,
        decidedAt: daysAgo(24),
      },
    });
    await prisma.leaveApplication.create({
      data: {
        employeeId: employees[5].id,
        leaveType: 'sick',
        fromDate: daysAgo(-3),
        toDate: daysAgo(-4),
        dayCount: money(2),
        reason: 'Medical procedure, doctor advised rest.',
        status: 'pending',
      },
    });
    await prisma.leaveApplication.create({
      data: {
        employeeId: employees[7].id,
        leaveType: 'casual',
        fromDate: daysAgo(-7),
        toDate: daysAgo(-7),
        dayCount: money(1),
        reason: "Son's school admission.",
        status: 'pending',
      },
    });

    // ── A month of attendance ────────────────────────────────────────────────
    // Skips Sundays (weeklyOffDay 0), varies in/out times, and leaves the odd day
    // unpunched so the Absent count is not always zero. Today is punched in but not
    // out for most people, which is what the board looks like mid-morning.
    for (let back = 30; back >= 0; back--) {
      const day = daysAgo(back);
      if (day.getUTCDay() === 0) continue;
      for (const e of employees) {
        if (e.id === onLeaveToday.id && back <= 1) continue;
        if (rand() < 0.06) continue; // absent
        const inH = 8 + Math.floor(rand() * 2);
        const inM = Math.floor(rand() * 55);
        await prisma.punchRecord.create({
          data: {
            employeeId: e.id,
            type: 'in',
            capturedAt: at(day, inH, inM),
            punchDate: day,
            latitude: money(spec.sites[0].lat),
            longitude: money(spec.sites[0].lng),
            geofenceResult: 'in_range',
            faceMatchResult: 'matched',
            // `PunchRecord_employee_capture_required` (migration 20260901195604) makes
            // photo, face result, coordinates and geofence result all mandatory when
            // the source is the employee themselves — an employee punch without
            // evidence is exactly what that constraint exists to reject.
            photoRef: `punches/${e.id}/${day
              .toISOString()
              .slice(0, 10)}-in.jpg`,
          },
        });
        totals.punches++;
        // Not everyone has punched out yet today — that is the point of the board.
        if (back === 0 && rand() < 0.75) continue;
        await prisma.punchRecord.create({
          data: {
            employeeId: e.id,
            type: 'out',
            capturedAt: at(
              day,
              17 + Math.floor(rand() * 2),
              Math.floor(rand() * 55),
            ),
            punchDate: day,
            latitude: money(spec.sites[0].lat),
            longitude: money(spec.sites[0].lng),
            geofenceResult: 'in_range',
            faceMatchResult: 'matched',
            photoRef: `punches/${e.id}/${day
              .toISOString()
              .slice(0, 10)}-out.jpg`,
          },
        });
        totals.punches++;
      }
    }

    // ── Reimbursements: a category set and a live queue ───────────────────────
    const cats = [];
    for (const c of [
      { code: 'TRV', name: 'Travel' },
      { code: 'FUEL', name: 'Fuel & Conveyance' },
      { code: 'FOOD', name: 'Food & Refreshments' },
      { code: 'SITE', name: 'Site Expenses' },
    ]) {
      cats.push(
        await prisma.reimbursementCategory.create({
          data: { companyId: company.id, code: c.code, name: c.name },
        }),
      );
    }
    for (const [i, claim] of [
      {
        emp: 0,
        cat: 0,
        amount: 4250,
        desc: 'Client meeting travel — Bengaluru to Hosur',
      },
      {
        emp: 2,
        cat: 1,
        amount: 1830,
        desc: 'Diesel for site pickup, 3 refills',
      },
      {
        emp: 6,
        cat: 3,
        amount: 950,
        desc: 'Stationery and printing for site office',
      },
    ].entries()) {
      await prisma.reimbursementClaim.create({
        data: {
          employeeId: employees[claim.emp].id,
          companyId: company.id,
          categoryId: cats[claim.cat].id,
          amount: money(claim.amount),
          expenseDate: daysAgo(3 + i * 4),
          description: claim.desc,
        },
      });
    }

    // ── Partners, stores, plant, assets ──────────────────────────────────────
    for (const v of VENDORS) {
      await prisma.vendor.create({
        data: {
          companyId: company.id,
          code: `${spec.shortCode}-${v.code}`,
          name: v.name,
          type: v.type,
        },
      });
    }

    const itemCats = new Map<string, string>();
    for (const name of [...new Set(ITEMS.map((i) => i.cat))]) {
      const row = await prisma.itemCategory.create({
        data: { companyId: company.id, name },
      });
      itemCats.set(name, row.id);
    }
    for (const it of ITEMS) {
      await prisma.item.create({
        data: {
          companyId: company.id,
          code: it.code,
          name: it.name,
          categoryId: itemCats.get(it.cat)!,
          unit: it.unit,
        },
      });
    }

    const eqCats = new Map<string, string>();
    for (const e of EQUIPMENT) {
      if (eqCats.has(e.cat)) continue;
      const row = await prisma.equipmentCategory.create({
        data: { companyId: company.id, name: e.cat, meterType: e.meter },
      });
      eqCats.set(e.cat, row.id);
    }
    for (const e of EQUIPMENT) {
      await prisma.equipment.create({
        data: {
          companyId: company.id,
          code: `${spec.shortCode}-${e.code}`,
          name: e.name,
          categoryId: eqCats.get(e.cat)!,
          ownership: e.own,
          powerSource: e.power,
          meterType: e.meter,
          deployedSiteId: sites[0].id,
        },
      });
    }

    const astCats = new Map<string, string>();
    for (const a of ASSETS) {
      if (astCats.has(a.cat)) continue;
      const row = await prisma.assetCategory.create({
        data: { companyId: company.id, name: a.cat, trackingMode: a.mode },
      });
      astCats.set(a.cat, row.id);
    }
    for (const [i, a] of ASSETS.entries()) {
      await prisma.asset.create({
        data: {
          companyId: company.id,
          assetCode: `${spec.shortCode}-${a.code}`,
          name: a.name,
          categoryId: astCats.get(a.cat)!,
          trackingMode: a.mode,
          capitalisationDate: daysAgo(120 + i * 40),
          currentSiteId: sites[i % sites.length].id,
          purchaseCost: money(a.cost),
          depreciationRatePercent: money(a.rate),
          salvageValue: money(Math.round(a.cost * 0.05)),
          status: i < 2 ? 'allocated' : 'idle',
        },
      });
      totals.assets++;
    }

    // ── Labour: skills, project rates, and a registered workforce ────────────
    const skills = new Map<string, string>();
    for (const s of SKILLS) {
      const row = await prisma.skillCategory.create({
        data: { companyId: company.id, name: s.name, code: s.code },
      });
      skills.set(s.name, row.id);
    }
    for (const project of projects) {
      for (const s of SKILLS) {
        await prisma.wageRate.create({
          data: {
            companyId: company.id,
            projectId: project.id,
            skillCategoryId: skills.get(s.name)!,
            dailyRate: money(s.rate + Math.floor(rand() * 60) - 30),
            effectiveFrom: daysAgo(180),
          },
        });
      }
    }
    for (const [i, name] of LABOUR_NAMES.entries()) {
      const skill = SKILLS[i % SKILLS.length];
      await prisma.labourWorker.create({
        data: {
          companyId: company.id,
          labourCode: `${spec.shortCode}-W${String(2001 + i)}`,
          fullName: name,
          phone: `9${Math.floor(700000000 + rand() * 299999999)}`,
          gender: 'male',
          dateOfBirth: d(
            `19${85 + Math.floor(rand() * 15)}-0${
              1 + Math.floor(rand() * 9)
            }-1${Math.floor(rand() * 9)}`,
          ),
          skillCategoryId: skills.get(skill.name)!,
          engagementType: i % 3 === 0 ? 'contractor' : 'direct',
          siteId: sites[i % sites.length].id,
        },
      });
      totals.workers++;
    }
    console.log(
      `    ${LABOUR_NAMES.length} labour workers, ${ASSETS.length} assets, ${ITEMS.length} items, ${EQUIPMENT.length} machines`,
    );
  }

  console.log(
    `\n  Totals: ${totals.employees} employees, ${totals.punches} punches, ${totals.workers} labour workers, ${totals.assets} assets`,
  );
  console.log(
    '\n  Every login is  <first>.<last>@<company-domain>  with password  secret42',
  );
  console.log(
    '  e.g.  rajesh.kulkarni@parthrealcon.com   (Site Admin, Parth Realcon)',
  );
  console.log(
    '        amit.deshpande@shreejibuildtech.in (Site Admin, Shreeji Buildtech)',
  );
  console.log(
    '        admin@buildcore.dev                (Super Admin, both companies)\n',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
