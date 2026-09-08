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
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, resolve as resolvePath } from 'path';

import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from 'argon2';
import * as PDFDocument from 'pdfkit';

import {
  encryptBlob,
  parseEncryptionKey,
} from '../src/common/storage/blob-cipher';

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

/**
 * Renders a letter and writes it into the local blob store, returning its reference.
 *
 * The Letters register's only action is Download, so seeding letter rows whose blob
 * does not exist would give every row a button that 404s — worse than no rows at all.
 * Going through the same cipher, namespace and reference shape `LocalStorageAdapter`
 * uses costs a dozen lines and makes the screen genuinely work.
 */
async function writeLetterPdf(title: string, body: string): Promise<string> {
  const pdf: Buffer = await new Promise((done, fail) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => done(Buffer.concat(chunks)));
    doc.on('error', fail);
    doc.fontSize(14).text(title, { align: 'center' }).moveDown(1.5);
    doc.fontSize(11).text(body, { align: 'left' });
    doc.end();
  });

  const ref = `recruitment-letter/${randomUUID()}`;
  const target = resolvePath(
    process.cwd(),
    process.env.STORAGE_LOCAL_PATH || 'var/storage',
    ref,
  );
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    encryptBlob(pdf, parseEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY)),
    { mode: 0o600 },
  );
  return ref;
}

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

/**
 * Market rate and a normal purchase lot per item, in the units `ITEMS` declares.
 *
 * Kept beside the item list rather than inside it because these drive the movement
 * data below, not the item master: a demo database wants a cement bag to cost what a
 * cement bag costs, so the stock valuation on screen is a number somebody can sanity
 * check against what they paid last week.
 */
const ITEM_TRADE: Record<string, { rate: number; lot: number }> = {
  'CEM-OPC53': { rate: 395, lot: 500 },
  'CEM-PPC': { rate: 358, lot: 400 },
  'AGG-MSAND': { rate: 1650, lot: 60 },
  'AGG-20MM': { rate: 1420, lot: 60 },
  'STL-TMT12': { rate: 62500, lot: 8 },
  'STL-TMT16': { rate: 61800, lot: 6 },
  'ELE-WIRE25': { rate: 32, lot: 2000 },
  'PLM-CPVC20': { rate: 145, lot: 600 },
  'FIN-PUTTY': { rate: 28, lot: 1500 },
  'SAF-HELMET': { rate: 260, lot: 80 },
};

/** What material gets issued for, so the Issues register reads like a site's. */
const ISSUE_PURPOSES = [
  'Block A — slab casting',
  'Block A — column shuttering',
  'Block B — brickwork',
  'Block B — internal plaster',
  'Basement — retaining wall',
  'Site office — electrical rough-in',
  'Tower 1 — plumbing riser',
  'Common area — finishing',
];

/**
 * Starting meter and a plausible day's work, per equipment category.
 *
 * A machine registered with a zero meter reads as a machine that has never run, and
 * every utilisation and service-due figure computed from it is meaningless. These
 * put each machine part-way through its life, which is where a real registry finds
 * them.
 */
const PLANT_DUTY: Record<
  string,
  {
    start: number;
    perDay: number;
    spread: number;
    hireRate: number;
    fuelPerUnit: number;
  }
> = {
  Earthmoving: {
    start: 4218,
    perDay: 7.5,
    spread: 3,
    hireRate: 950,
    fuelPerUnit: 5.4,
  },
  Transport: {
    start: 68420,
    perDay: 132,
    spread: 60,
    hireRate: 38,
    fuelPerUnit: 0.28,
  },
  Lifting: {
    start: 1147,
    perDay: 6.5,
    spread: 2.5,
    hireRate: 1450,
    fuelPerUnit: 0,
  },
  Concreting: {
    start: 3106,
    perDay: 5.5,
    spread: 3,
    hireRate: 2200,
    fuelPerUnit: 0,
  },
  Power: { start: 2451, perDay: 9, spread: 4, hireRate: 650, fuelPerUnit: 3.1 },
};

/** The service each category actually gets, and how often. */
const SERVICE_PLAN: Record<
  string,
  { type: string; intervalHours?: number; intervalKm?: number }
> = {
  Earthmoving: { type: 'Engine oil & filter change', intervalHours: 250 },
  Transport: { type: 'Full service & oil change', intervalKm: 10000 },
  Lifting: { type: 'Wire rope & brake inspection', intervalHours: 500 },
  Concreting: { type: 'Mixer drum & bearing service', intervalHours: 400 },
  Power: { type: 'DG set service & coolant top-up', intervalHours: 300 },
};

const SPARE_PARTS: {
  no: string;
  name: string;
  uom: string;
  reorder: number;
  rate: number;
  opening: number;
  cats: string[];
}[] = [
  {
    no: 'SP-ENGOIL-15W40',
    name: 'Engine Oil 15W-40 (20L)',
    uom: 'NOS',
    reorder: 6,
    rate: 4850,
    opening: 14,
    cats: ['Earthmoving', 'Transport', 'Power'],
  },
  {
    no: 'SP-OILFLT-JCB',
    name: 'Oil Filter — JCB 3DX',
    uom: 'NOS',
    reorder: 4,
    rate: 780,
    opening: 9,
    cats: ['Earthmoving'],
  },
  {
    no: 'SP-AIRFLT-TATA',
    name: 'Air Filter — Tata LPT',
    uom: 'NOS',
    reorder: 4,
    rate: 1150,
    opening: 7,
    cats: ['Transport'],
  },
  {
    no: 'SP-HYDHOSE-1IN',
    name: 'Hydraulic Hose 1 inch (per m)',
    uom: 'RMT',
    reorder: 10,
    rate: 640,
    opening: 24,
    cats: ['Earthmoving', 'Lifting'],
  },
  {
    no: 'SP-BRKPAD-LPT',
    name: 'Brake Pad Set — LPT 1613',
    uom: 'NOS',
    reorder: 2,
    rate: 3200,
    opening: 4,
    cats: ['Transport'],
  },
  {
    no: 'SP-VBELT-B72',
    name: 'V-Belt B72',
    uom: 'NOS',
    reorder: 6,
    rate: 420,
    opening: 12,
    cats: ['Concreting', 'Power'],
  },
  {
    no: 'SP-COOLANT-5L',
    name: 'Coolant Concentrate (5L)',
    uom: 'NOS',
    reorder: 5,
    rate: 1250,
    opening: 10,
    cats: ['Power', 'Earthmoving'],
  },
  {
    no: 'SP-WIREROPE-16',
    name: 'Wire Rope 16mm (per m)',
    uom: 'RMT',
    reorder: 20,
    rate: 385,
    opening: 60,
    cats: ['Lifting'],
  },
];

/**
 * Employee document types and joining-kit items.
 *
 * Every document type is seeded NON-mandatory on purpose. `assertMandatoryDocsComplete`
 * blocks attendance marking and punching for any employee missing a mandatory
 * document, so declaring one here without also uploading a file for all nineteen
 * employees would lock the whole demo out of attendance — and the file would have to
 * be fabricated, leaving a download that 404s. The rule is exercised by the code, not
 * by the fixture.
 */
const DOCUMENT_TYPES: {
  code: string;
  name: string;
  expiry?: boolean;
  number?: boolean;
}[] = [
  { code: 'AADHAAR', name: 'Aadhaar Card', number: true },
  { code: 'PAN', name: 'PAN Card', number: true },
  { code: 'BANK', name: 'Cancelled Cheque / Passbook' },
  { code: 'EDU', name: 'Educational Certificates' },
  { code: 'EXP', name: 'Previous Experience Letter' },
  { code: 'MED', name: 'Medical Fitness Certificate', expiry: true },
];

const KIT_ITEMS: { name: string; qty: number; recoverable: boolean }[] = [
  { name: 'Safety Helmet', qty: 1, recoverable: false },
  { name: 'Safety Shoes', qty: 1, recoverable: false },
  { name: 'Photo ID Card', qty: 1, recoverable: true },
  { name: 'Laptop', qty: 1, recoverable: true },
  { name: 'Company SIM', qty: 1, recoverable: true },
];

/** The canonical path a candidate walks; terminal stages branch off it. */
const HIRING_PATH = [
  'applied',
  'shortlisted',
  'interviewing',
  'selected',
  'offer_issued',
  'offer_accepted',
  'joined',
] as const;

const CAND_FIRST = [
  'Naveen',
  'Pooja',
  'Arjun',
  'Divya',
  'Manoj',
  'Shalini',
  'Farhan',
  'Ritika',
  'Karthik',
  'Neha',
  'Yashwant',
  'Ipsita',
  'Rahul',
  'Tanvi',
  'Sandeep',
  'Meera',
  'Gaurav',
  'Swati',
  'Imran',
  'Lakshmi',
];
const CAND_LAST = [
  'Ravindran',
  'Bhatt',
  'Sethi',
  'Krishnan',
  'Pillai',
  'Rao',
  'Qureshi',
  'Jain',
  'Subramanian',
  'Wagh',
  'Patil',
  'Mohanty',
  'Bansal',
  'Kulkarni',
  'Nambiar',
];
/** Distinct enough across sixty indices that no company repeats a name. */
const candidateName = (i: number) =>
  `${CAND_FIRST[i % CAND_FIRST.length]} ${
    CAND_LAST[(i * 7 + 3) % CAND_LAST.length]
  }`;

const CAND_EMPLOYERS = [
  'Sobha Ltd',
  'Puravankara',
  'Brigade Group',
  'Godrej Properties',
  'L&T Construction',
  'Prestige Group',
  'Shapoorji Pallonji',
  'Embassy Group',
  'Salarpuria Sattva',
  'Century Real Estate',
  'Mantri Developers',
  null,
];

/**
 * The pipeline as stage populations rather than a list of people.
 *
 * The funnel report divides each stage's *current* population by the one before it,
 * so a snapshot that does not taper reports conversions above 100% — which reads as a
 * broken report rather than as unusual data. Declaring the shape here makes the taper
 * explicit and checkable: 7 applied, 5 shortlisted, 4 interviewing, 3 selected, 2
 * offered, 2 accepted, 2 joined, with 3 rejections and a no-show off to the side.
 *
 * `via` is how far down `HIRING_PATH` a terminal candidate got before dropping out.
 * Without it a rejection carries no history and the funnel cannot say where in the
 * process people are being lost, which is the only question it exists to answer.
 */
const PIPELINE: { req: number; stage: string; via?: number; count: number }[] =
  [
    { req: 0, stage: 'applied', count: 3 },
    { req: 1, stage: 'applied', count: 2 },
    { req: 4, stage: 'applied', count: 2 },
    { req: 0, stage: 'shortlisted', count: 3 },
    { req: 1, stage: 'shortlisted', count: 2 },
    { req: 0, stage: 'interviewing', count: 2 },
    { req: 1, stage: 'interviewing', count: 2 },
    { req: 0, stage: 'selected', count: 2 },
    { req: 1, stage: 'selected', count: 1 },
    { req: 0, stage: 'offer_issued', count: 1 },
    { req: 1, stage: 'offer_issued', count: 1 },
    { req: 0, stage: 'offer_accepted', count: 1 },
    { req: 1, stage: 'offer_accepted', count: 1 },
    { req: 0, stage: 'joined', count: 1 },
    { req: 3, stage: 'joined', count: 1 },
    { req: 0, stage: 'rejected', via: 2, count: 2 },
    { req: 1, stage: 'rejected', via: 1, count: 1 },
    { req: 1, stage: 'no_show', via: 5, count: 1 },
  ];

const CAND_SOURCES = [
  'portal',
  'referral',
  'agency',
  'portal',
  'walk_in',
  'portal',
  'internal',
] as const;

const REJECTION_REASONS = [
  'Expectation well outside the band budgeted for the role.',
  'Depth on RCC detailing was not there for the level we are hiring at.',
  'Withdrew after the second round citing a counter-offer.',
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

  const totals = {
    employees: 0,
    punches: 0,
    workers: 0,
    assets: 0,
    purchases: 0,
    issues: 0,
    transfers: 0,
    payments: 0,
    indents: 0,
    logbook: 0,
    fuel: 0,
    maintenance: 0,
    serviceBills: 0,
    hireBills: 0,
    candidates: 0,
    interviews: 0,
    offers: 0,
    onboarding: 0,
    letters: 0,
    resignations: 0,
  };
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
    const vendors = [];
    for (const v of VENDORS) {
      vendors.push(
        await prisma.vendor.create({
          data: {
            companyId: company.id,
            code: `${spec.shortCode}-${v.code}`,
            name: v.name,
            type: v.type,
          },
        }),
      );
    }

    const itemCats = new Map<string, string>();
    for (const name of [...new Set(ITEMS.map((i) => i.cat))]) {
      const row = await prisma.itemCategory.create({
        data: { companyId: company.id, name },
      });
      itemCats.set(name, row.id);
    }
    const items = [];
    for (const it of ITEMS) {
      items.push(
        await prisma.item.create({
          data: {
            companyId: company.id,
            code: it.code,
            name: it.name,
            categoryId: itemCats.get(it.cat)!,
            unit: it.unit,
          },
        }),
      );
    }

    const eqCats = new Map<string, string>();
    for (const e of EQUIPMENT) {
      if (eqCats.has(e.cat)) continue;
      const row = await prisma.equipmentCategory.create({
        data: { companyId: company.id, name: e.cat, meterType: e.meter },
      });
      eqCats.set(e.cat, row.id);
    }
    /**
     * The sites that actually hold material and machines.
     *
     * Each company's list ends with its office, and an office is not a store: a head
     * office carrying sixty cubic metres of M-sand and a batching plant parked in
     * Koramangala is the sort of detail that tells anyone looking at the demo that
     * the data was generated rather than recorded. Small consumables still reach it
     * below — PPE and stationery genuinely do sit in a central store.
     */
    const siteIsOffice = (name: string) => /office/i.test(name);
    const storeSites = sites.filter((x) => !siteIsOffice(x.name));
    const officeSites = sites.filter((x) => siteIsOffice(x.name));

    const machines: {
      row: { id: string };
      spec: (typeof EQUIPMENT)[number];
      reading: number;
      lastDone: number;
    }[] = [];
    for (const [ei, e] of EQUIPMENT.entries()) {
      machines.push({
        row: await prisma.equipment.create({
          data: {
            companyId: company.id,
            code: `${spec.shortCode}-${e.code}`,
            name: e.name,
            categoryId: eqCats.get(e.cat)!,
            ownership: e.own,
            vendorId: null,
            powerSource: e.power,
            meterType: e.meter,
            // Spread across the sites rather than parked at the first: a registry
            // where every machine sits at one site makes the site filter useless.
            deployedSiteId: storeSites[ei % storeSites.length].id,
          },
        }),
        spec: e,
        reading: 0,
        lastDone: 0,
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

    // ── Inventory: purchases, receipts, bills, payments, issues, transfers ────
    //
    // Written as movements, not as a stock table with numbers typed into it. The
    // Stock screen values what is on hand at a weighted-average rate the API derives
    // by replaying the ledger, so a balance invented independently of the ledger
    // would disagree with the register the moment anyone opened it. Every balance row
    // written at the end of this block is the arithmetic result of the purchases,
    // issues and transfers above it.
    interface Bal {
      received: number;
      issued: number;
      transferIn: number;
      transferOut: number;
      war: number;
      qty: number;
    }
    const balances = new Map<string, Bal>();
    const bal = (itemId: string, siteId: string): Bal => {
      const key = `${itemId}|${siteId}`;
      let b = balances.get(key);
      if (!b) {
        b = {
          received: 0,
          issued: 0,
          transferIn: 0,
          transferOut: 0,
          war: 0,
          qty: 0,
        };
        balances.set(key, b);
      }
      return b;
    };
    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const materialVendors = vendors.filter((v) => v.type === 'material');
    const fuelVendor = vendors.find((v) => v.type === 'fuel')!;
    const hireVendor = vendors.find((v) => v.type === 'hire')!;
    const serviceVendor = vendors.find((v) => v.type === 'service')!;

    const openBills: {
      id: string;
      vendorId: string;
      total: number;
      paid: number;
    }[] = [];
    let grnSeq = 0;

    for (const [si, site] of sites.entries()) {
      const isOffice = siteIsOffice(site.name);
      for (const [ii, item] of items.entries()) {
        const trade = ITEM_TRADE[ITEMS[ii].code];
        // The bulk trades are bought again and again; the specialised ones land
        // once or twice and mostly at the larger site.
        const bulk = ['Cement & Binders', 'Aggregates', 'Steel'].includes(
          ITEMS[ii].cat,
        );
        // Structural material goes to the pour, never to the office.
        if (isOffice && bulk) continue;
        const rounds = isOffice ? 1 : bulk ? 3 : si === 0 ? 2 : 1;

        for (let r = 0; r < rounds; r++) {
          const when = daysAgo(82 - r * 26 - si * 2);
          const quantity = round3(trade.lot * (0.7 + rand() * 0.6));
          const rate = round2(trade.rate * (0.96 + rand() * 0.09));
          const amount = round2(quantity * rate);
          const vendor =
            ITEMS[ii].cat === 'Steel' ? materialVendors[1] : materialVendors[0];

          const purchase = await prisma.purchase.create({
            data: {
              companyId: company.id,
              siteId: site.id,
              itemId: item.id,
              vendorId: vendor.id,
              date: when,
              quantity: money(quantity),
              rate: money(rate),
              amount: money(amount),
              remarks: r === 0 ? 'Opening stock for the site' : null,
            },
          });

          grnSeq += 1;
          await prisma.goodsReceiptNote.create({
            data: {
              companyId: company.id,
              purchaseId: purchase.id,
              grnNumber: `${spec.shortCode}/GRN/26-27/${String(grnSeq).padStart(
                4,
                '0',
              )}`,
              siteId: site.id,
            },
          });

          const billDate = new Date(when);
          billDate.setUTCDate(billDate.getUTCDate() + 2);
          const bill = await prisma.purchaseBill.create({
            data: {
              companyId: company.id,
              purchaseId: purchase.id,
              vendorId: vendor.id,
              totalAmount: money(amount),
              billDate,
            },
          });
          openBills.push({
            id: bill.id,
            vendorId: vendor.id,
            total: amount,
            paid: 0,
          });

          await prisma.stockLedgerEntry.create({
            data: {
              companyId: company.id,
              itemId: item.id,
              siteId: site.id,
              type: 'purchase',
              quantity: money(quantity),
              rate: money(rate),
              referenceId: purchase.id,
              date: when,
            },
          });

          // The same running weighted average `StockService.recomputeWAR` derives
          // from the ledger: a purchase repositions the rate, nothing else does.
          const b = bal(item.id, site.id);
          const denominator = b.qty + quantity;
          b.war =
            denominator === 0
              ? rate
              : (b.qty * b.war + quantity * rate) / denominator;
          b.qty += quantity;
          b.received += quantity;
          totals.purchases++;
        }
      }
    }

    // Issues, drawn only against what the site actually holds — a register showing
    // more issued than was ever received is the one thing nobody would believe.
    let purposeIdx = 0;
    for (const [si, site] of sites.entries()) {
      for (const [ii, item] of items.entries()) {
        const b = bal(item.id, site.id);
        if (b.qty <= 0) continue;
        const draws = ITEMS[ii].cat === 'Safety' ? 1 : 2 + (si === 0 ? 1 : 0);

        for (let k = 0; k < draws; k++) {
          const available = b.qty;
          if (available <= 0) break;
          const wanted = round3(available * (0.18 + rand() * 0.22));
          if (wanted <= 0) continue;
          const when = daysAgo(64 - k * 19 - si);

          await prisma.issue.create({
            data: {
              companyId: company.id,
              siteId: site.id,
              itemId: item.id,
              date: when,
              quantity: money(wanted),
              issuedTo: ISSUE_PURPOSES[purposeIdx++ % ISSUE_PURPOSES.length],
              remarks: null,
            },
          });
          await prisma.stockLedgerEntry.create({
            data: {
              companyId: company.id,
              itemId: item.id,
              siteId: site.id,
              type: 'issue',
              quantity: money(wanted),
              referenceId: `seed-issue-${site.id}-${item.id}-${k}`,
              date: when,
            },
          });
          b.issued += wanted;
          b.qty -= wanted;
          totals.issues++;
        }
      }
    }

    // Transfers, only for items both sites already carry: a transfer moves material
    // at the destination's existing rate rather than repricing it, so sending an item
    // somewhere it has never been priced would land it valued at zero.
    // Between two construction sites where the company has them; otherwise back to
    // the central store, which is the only movement a single-site company really has.
    const [fromSite, toSite] =
      storeSites.length > 1
        ? [storeSites[0], storeSites[1]]
        : [storeSites[0], officeSites[0] ?? storeSites[0]];
    if (fromSite && toSite && fromSite.id !== toSite.id) {
      const transferable = items.filter(
        (item) =>
          bal(item.id, fromSite.id).qty > 5 && bal(item.id, toSite.id).qty > 0,
      );
      const statuses: ('received' | 'in_transit' | 'pending')[] = [
        'received',
        'received',
        'in_transit',
        'pending',
      ];
      for (const [ti, item] of transferable.slice(0, 4).entries()) {
        const from = bal(item.id, fromSite.id);
        const to = bal(item.id, toSite.id);
        const quantity = round3(Math.min(from.qty * 0.2, from.qty));
        if (quantity <= 0) continue;
        const when = daysAgo(22 - ti * 5);

        await prisma.stockTransfer.create({
          data: {
            companyId: company.id,
            fromSiteId: fromSite.id,
            toSiteId: toSite.id,
            itemId: item.id,
            date: when,
            quantity: money(quantity),
            status: statuses[ti],
            remarks: 'Surplus moved to the second site',
          },
        });
        // Both legs post on creation, whatever the status — the workflow status is
        // about who has acknowledged the material, not about where the stock is.
        for (const leg of [
          { siteId: fromSite.id, type: 'transfer_out' as const },
          { siteId: toSite.id, type: 'transfer_in' as const },
        ]) {
          await prisma.stockLedgerEntry.create({
            data: {
              companyId: company.id,
              itemId: item.id,
              siteId: leg.siteId,
              type: leg.type,
              quantity: money(quantity),
              referenceId: `seed-transfer-${item.id}-${ti}`,
              date: when,
            },
          });
        }
        from.transferOut += quantity;
        from.qty -= quantity;
        to.transferIn += quantity;
        to.qty += quantity;
        totals.transfers++;
      }
    }

    for (const [key, b] of balances) {
      const [itemId, siteId] = key.split('|');
      await prisma.stockBalance.create({
        data: {
          companyId: company.id,
          itemId,
          siteId,
          received: money(round3(b.received)),
          issued: money(round3(b.issued)),
          transferIn: money(round3(b.transferIn)),
          transferOut: money(round3(b.transferOut)),
          avgRate: money(Math.round(b.war * 1e6) / 1e6),
        },
      });
    }

    // Payments, allocated oldest bill first, leaving a realistic tail of unpaid and
    // part-paid bills rather than a ledger that is either all settled or all open.
    const modes: ('bank_transfer' | 'upi' | 'cheque')[] = [
      'bank_transfer',
      'bank_transfer',
      'upi',
      'cheque',
    ];
    for (const [vi, vendor] of materialVendors.entries()) {
      const theirs = openBills.filter((b) => b.vendorId === vendor.id);
      if (theirs.length === 0) continue;
      const outstanding = theirs.reduce((sum, b) => sum + b.total, 0);
      // Roughly three quarters settled: enough that the ageing report has both
      // cleared and overdue rows in it.
      let budget = round2(outstanding * (0.62 + vi * 0.14));

      for (let p = 0; p < 3 && budget > 0; p++) {
        const slice = round2(p === 2 ? budget : budget / (3 - p));
        if (slice <= 0) break;
        const when = daysAgo(46 - p * 13 - vi * 2);
        const payment = await prisma.payment.create({
          data: {
            companyId: company.id,
            vendorId: vendor.id,
            amount: money(slice),
            date: when,
            paymentMode: modes[(vi + p) % modes.length],
            referenceNumber: `${spec.shortCode}/PAY/${String(
              1200 + vi * 10 + p,
            )}`,
          },
        });

        let left = slice;
        let allocatedTotal = 0;
        for (const b of theirs) {
          if (left <= 0) break;
          const due = round2(b.total - b.paid);
          if (due <= 0) continue;
          const take = round2(Math.min(due, left));
          await prisma.paymentAllocation.create({
            data: {
              companyId: company.id,
              paymentId: payment.id,
              billId: b.id,
              allocatedAmount: money(take),
            },
          });
          b.paid = round2(b.paid + take);
          left = round2(left - take);
          allocatedTotal = round2(allocatedTotal + take);

          await prisma.purchaseBill.update({
            where: { id: b.id },
            data: {
              paidAmount: money(b.paid),
              paymentStatus:
                b.paid >= b.total
                  ? 'paid'
                  : b.paid > 0
                  ? 'part_paid'
                  : 'unpaid',
            },
          });
        }
        await prisma.payment.update({
          where: { id: payment.id },
          data: { allocatedAmount: money(allocatedTotal) },
        });
        budget = round2(budget - slice);
        totals.payments++;
      }
    }

    // Material indents, one in each state the approvals queue and the procurement
    // screen need something to show for.
    const indentPlan: {
      status:
        | 'submitted'
        | 'approved'
        | 'partially_fulfilled'
        | 'fulfilled'
        | 'rejected';
      days: number;
      justification: string;
      lines: {
        item: number;
        qty: number;
        approved?: number;
        done?: number;
        pending?: boolean;
      }[];
      reason?: string;
    }[] = [
      {
        status: 'submitted',
        days: 3,
        justification:
          'Slab casting for Block A starts next week; site stock is short.',
        lines: [
          { item: 0, qty: 320 },
          { item: 4, qty: 4 },
        ],
      },
      {
        status: 'approved',
        days: 12,
        justification: 'Brickwork and plaster on Block B, second floor.',
        lines: [
          { item: 1, qty: 260, approved: 220 },
          { item: 8, qty: 900, approved: 900, pending: true },
        ],
      },
      {
        status: 'partially_fulfilled',
        days: 26,
        justification:
          'Electrical rough-in for the site office and Tower 1 riser.',
        lines: [
          { item: 6, qty: 1400, approved: 1400, done: 900 },
          { item: 7, qty: 500, approved: 500, done: 500 },
        ],
      },
      {
        status: 'fulfilled',
        days: 44,
        justification: 'Safety gear replacement for the incoming crew.',
        lines: [{ item: 9, qty: 60, approved: 60, done: 60 }],
      },
      {
        status: 'rejected',
        days: 18,
        justification: 'Additional 20mm jelly requested ahead of schedule.',
        reason:
          'Sufficient stock already at site; re-raise closer to the pour date.',
        lines: [{ item: 3, qty: 90 }],
      },
    ];

    for (const [ix, plan] of indentPlan.entries()) {
      const decided = plan.status !== 'submitted';
      const indent = await prisma.materialIndent.create({
        data: {
          companyId: company.id,
          siteId: storeSites[ix % storeSites.length].id,
          projectId: projects[ix % projects.length]?.id ?? null,
          indentNumber: `${spec.shortCode}/IND/26-27/${String(101 + ix)}`,
          requiredByDate: daysAgo(plan.days - 10),
          justification: plan.justification,
          status: plan.status,
          requestedByUserId: employees[(ix + 2) % employees.length].userId,
          approvedByUserId: decided ? employees[0].userId : null,
          approvedAt: decided ? at(daysAgo(plan.days - 1), 11, 15) : null,
          decisionReason: plan.reason ?? null,
        },
      });
      for (const line of plan.lines) {
        await prisma.materialIndentLine.create({
          data: {
            companyId: company.id,
            indentId: indent.id,
            itemId: items[line.item].id,
            requestedQuantity: money(line.qty),
            approvedQuantity:
              line.approved != null ? money(line.approved) : null,
            fulfilledQuantity: money(line.done ?? 0),
            reductionReason:
              line.approved != null && line.approved < line.qty
                ? 'Trimmed to the quantity the pour actually needs'
                : null,
            procurementPending: line.pending ?? false,
          },
        });
      }
      totals.indents++;
    }

    // ── Plant: hire rates, logbook, fuel, servicing, spares and bills ────────
    //
    // The logbook is generated first and everything else is derived from it, because
    // that is the direction the real data flows: the meter reading decides when a
    // service falls due, the hours worked decide what a hire vendor may bill, and
    // fuel consumed only means anything next to the hours it was burned over. Seeding
    // them independently would produce five screens that each look plausible and
    // contradict each other.
    for (const [name, categoryId] of eqCats) {
      await prisma.hireRate.create({
        data: {
          companyId: company.id,
          categoryId,
          ratePerUnit: money(PLANT_DUTY[name].hireRate),
          effectiveFrom: daysAgo(180),
        },
      });
    }

    for (const [mi, m] of machines.entries()) {
      const duty = PLANT_DUTY[m.spec.cat];
      const plan = SERVICE_PLAN[m.spec.cat];
      let reading = duty.start;
      const logged: {
        date: Date;
        hours: number;
        fuel: number;
        closing: number;
      }[] = [];

      // Thirty days back, Sundays off — the same weekly off the sites keep.
      for (let back = 30; back >= 1; back--) {
        const day = daysAgo(back);
        if (day.getUTCDay() === 0) continue;
        // A machine is not on every job every day; the idle days are what make the
        // utilisation figure mean something.
        if (rand() < 0.12) continue;

        const worked =
          Math.round((duty.perDay + (rand() - 0.5) * duty.spread) * 100) / 100;
        if (worked <= 0) continue;
        const opening = reading;
        const closing = Math.round((opening + worked) * 1000) / 1000;
        const fuel =
          duty.fuelPerUnit > 0
            ? Math.round(
                worked * duty.fuelPerUnit * (0.92 + rand() * 0.18) * 100,
              ) / 100
            : null;

        await prisma.logbookEntry.create({
          data: {
            companyId: company.id,
            equipmentId: m.row.id,
            date: day,
            openingReading: money(opening),
            closingReading: money(closing),
            totalHours: money(worked),
            fuelConsumed: fuel != null ? money(fuel) : null,
            operatorId: employees[(mi + back) % employees.length].id,
            projectId: projects[mi % projects.length]?.id ?? null,
          },
        });
        reading = closing;
        logged.push({ date: day, hours: worked, fuel: fuel ?? 0, closing });
        totals.logbook++;
      }

      // The meter on the machine is the last reading anyone wrote down, and
      // utilisation is the share of available days it actually turned.
      const workingDays = 26;
      await prisma.equipment.update({
        where: { id: m.row.id },
        data: {
          currentReading: money(reading),
          utilizationPercent: money(
            Math.min(
              100,
              Math.round((logged.length / workingDays) * 1000) / 10,
            ),
          ),
        },
      });

      // Fuel is bought every few days, in a tankful, against the consumption the
      // logbook recorded in between — which is what makes a variance meaningful.
      if (duty.fuelPerUnit > 0) {
        for (let k = 3; k < logged.length; k += 4) {
          const window = logged.slice(k - 3, k + 1);
          const burned = window.reduce((sum, l) => sum + l.fuel, 0);
          // Most fills match the logbook; one machine in each company is off enough
          // to raise the variance flag the Fuel screen exists to surface.
          const drift = mi === 1 && k > 6 ? 1.24 : 0.97 + rand() * 0.08;
          const quantity = Math.round(burned * drift * 100) / 100;
          if (quantity <= 0) continue;
          const rate = Math.round((93.4 + rand() * 3.2) * 100) / 100;
          const variance =
            Math.round(((quantity - burned) / burned) * 10000) / 100;

          await prisma.fuelEntry.create({
            data: {
              companyId: company.id,
              equipmentId: m.row.id,
              date: window[window.length - 1].date,
              quantity: money(quantity),
              rate: money(rate),
              amount: money(Math.round(quantity * rate * 100) / 100),
              vendorId: fuelVendor.id,
              variancePercent: money(variance),
              varianceAlert: Math.abs(variance) > 10,
            },
          });
          totals.fuel++;
        }
      }

      // A service history that brackets the current reading: one done a while back,
      // the next falling due near where the meter now stands, so the maintenance
      // screen has something genuinely upcoming on it.
      const interval = plan.intervalHours ?? plan.intervalKm!;
      const lastDone =
        Math.round((reading - interval * (0.55 + rand() * 0.3)) * 1000) / 1000;
      await prisma.serviceSchedule.create({
        data: {
          companyId: company.id,
          equipmentId: m.row.id,
          serviceType: plan.type,
          intervalHours:
            plan.intervalHours != null ? money(plan.intervalHours) : null,
          intervalKm: plan.intervalKm != null ? money(plan.intervalKm) : null,
          lastDoneReading: money(lastDone),
          nextDueReading: money(
            Math.round((lastDone + interval) * 1000) / 1000,
          ),
        },
      });
      machines[mi].reading = reading;
      machines[mi].lastDone = lastDone;
    }

    // Spare parts, with a movement history that adds up to the stock on hand.
    const partRows = [];
    for (const p of SPARE_PARTS) {
      const compatible = p.cats
        .map((c) => eqCats.get(c))
        .filter((id): id is string => Boolean(id));
      partRows.push({
        spec: p,
        row: await prisma.sparePart.create({
          data: {
            companyId: company.id,
            partNumber: p.no,
            name: p.name,
            unitOfMeasure: p.uom,
            reorderLevel: money(p.reorder),
            compatibleCategoryIds: compatible,
            stockQuantity: money(0),
            avgRate: money(0),
          },
        }),
      });
    }

    // Maintenance: one breakdown still open, two closed jobs with real costs behind
    // them. The open one is what the Maintenance screen is for; the closed ones give
    // the service bills and spare consumption something to hang off.
    const jobPlan: {
      machine: number;
      type: 'breakdown' | 'scheduled';
      status: 'open' | 'closed';
      days: number;
      description: string;
      labour: number;
      parts: { part: number; qty: number }[];
    }[] = [
      {
        machine: 0,
        type: 'breakdown',
        status: 'open',
        days: 2,
        description:
          'Hydraulic hose burst on the loader arm; boom will not hold load.',
        labour: 3500,
        parts: [{ part: 3, qty: 4 }],
      },
      {
        machine: 1,
        type: 'scheduled',
        status: 'closed',
        days: 21,
        description:
          'Scheduled full service — oil, filters and brake inspection.',
        labour: 4800,
        parts: [
          { part: 0, qty: 2 },
          { part: 2, qty: 1 },
          { part: 4, qty: 1 },
        ],
      },
      {
        machine: 4,
        type: 'breakdown',
        status: 'closed',
        days: 34,
        description: 'DG set overheating under load; coolant circuit flushed.',
        labour: 2600,
        parts: [
          { part: 6, qty: 2 },
          { part: 5, qty: 1 },
        ],
      },
    ];

    // Opening receipts first, so nothing is ever consumed out of a part that has not
    // been bought — a negative spare balance is not a thing a store can have.
    const partState = partRows.map(() => ({ qty: 0, war: 0 }));
    for (const [pi, p] of partRows.entries()) {
      const rate = p.spec.rate;
      await prisma.sparePartMovement.create({
        data: {
          companyId: company.id,
          sparePartId: p.row.id,
          type: 'receipt',
          quantity: money(p.spec.opening),
          rate: money(rate),
          amount: money(Math.round(p.spec.opening * rate * 100) / 100),
          movementDate: daysAgo(70),
          vendorId: serviceVendor.id,
          billReference: `${spec.shortCode}/SP/${String(4400 + pi)}`,
          createdByUserId: employees[0].userId,
        },
      });
      partState[pi] = { qty: p.spec.opening, war: rate };
    }

    for (const [ji, job] of jobPlan.entries()) {
      const m = machines[job.machine];
      const closed = job.status === 'closed';
      const partsCost = job.parts.reduce(
        (sum, part) => sum + part.qty * partRows[part.part].spec.rate,
        0,
      );

      const created = await prisma.maintenanceJob.create({
        data: {
          companyId: company.id,
          equipmentId: m.row.id,
          type: job.type,
          description: job.description,
          openedAt: at(daysAgo(job.days), 9, 40),
          closedAt: closed ? at(daysAgo(job.days - 2), 17, 20) : null,
          closingReading: closed ? money(m.reading) : null,
          partsDescription: job.parts
            .map((part) => `${partRows[part.part].spec.name} × ${part.qty}`)
            .join(', '),
          labourCost: money(job.labour),
          partsCost: money(Math.round(partsCost * 100) / 100),
          totalCost: closed
            ? money(Math.round((job.labour + partsCost) * 100) / 100)
            : null,
          status: job.status,
        },
      });
      totals.maintenance++;

      for (const part of job.parts) {
        const state = partState[part.part];
        const take = Math.min(part.qty, state.qty);
        if (take <= 0) continue;
        await prisma.sparePartMovement.create({
          data: {
            companyId: company.id,
            sparePartId: partRows[part.part].row.id,
            type: 'consumption',
            quantity: money(take),
            rate: money(state.war),
            amount: money(Math.round(take * state.war * 100) / 100),
            movementDate: daysAgo(job.days),
            maintenanceJobId: created.id,
            createdByUserId: employees[0].userId,
          },
        });
        state.qty -= take;
      }

      // A closed job is a job somebody invoiced for.
      if (closed) {
        const gross = job.labour + partsCost;
        const tax = Math.round(gross * 0.18 * 100) / 100;
        const tds = Math.round(gross * 0.02 * 100) / 100;
        await prisma.serviceBill.create({
          data: {
            companyId: company.id,
            maintenanceJobId: created.id,
            vendorId: serviceVendor.id,
            billNumber: `${spec.shortCode}/SVC/26-27/${String(31 + ji)}`,
            billDate: daysAgo(job.days - 3),
            grossAmount: money(Math.round(gross * 100) / 100),
            taxAmount: money(tax),
            tdsPercent: money(2),
            tdsAmount: money(tds),
            netPayable: money(Math.round((gross + tax - tds) * 100) / 100),
            status: 'verified',
            verifiedByUserId: employees[0].userId,
            verifiedAt: at(daysAgo(job.days - 4), 15, 0),
            paymentStatus: ji === 1 ? 'paid' : 'unpaid',
            paidAmount:
              ji === 1
                ? money(Math.round((gross + tax - tds) * 100) / 100)
                : money(0),
            paidOn: ji === 1 ? daysAgo(job.days - 9) : null,
            paymentReference:
              ji === 1 ? `${spec.shortCode}/PAY/${String(1290 + ji)}` : null,
          },
        });
        totals.serviceBills++;
      }
    }

    for (const [pi, p] of partRows.entries()) {
      await prisma.sparePart.update({
        where: { id: p.row.id },
        data: {
          stockQuantity: money(partState[pi].qty),
          avgRate: money(partState[pi].war),
        },
      });
    }

    // Hire bills for the hired machines, billed against the logbook rather than
    // against the vendor's word — the variance column is the whole point of the
    // screen, so at least one bill has to disagree with the log.
    for (const m of machines.filter((x) => x.spec.own === 'hired')) {
      const rate = PLANT_DUTY[m.spec.cat].hireRate;
      for (const [bi, period] of [
        { from: 60, to: 31, status: 'paid' as const },
        { from: 30, to: 1, status: 'pending_verification' as const },
      ].entries()) {
        const logbookHours =
          Math.round(PLANT_DUTY[m.spec.cat].perDay * 25 * 100) / 100;
        // The vendor's claim is a little over what the log shows, which is exactly
        // the disagreement the verification step exists to catch.
        const billedHours =
          Math.round(logbookHours * (bi === 0 ? 1.0 : 1.06) * 100) / 100;
        const gross = Math.round(billedHours * rate * 100) / 100;
        const tds = Math.round(gross * 0.02 * 100) / 100;

        await prisma.hireBill.create({
          data: {
            companyId: company.id,
            equipmentId: m.row.id,
            vendorId: hireVendor.id,
            billedHours: money(billedHours),
            rate: money(rate),
            grossAmount: money(gross),
            billingPeriodFrom: daysAgo(period.from),
            billingPeriodTo: daysAgo(period.to),
            logbookHours: money(logbookHours),
            variance: money(
              Math.round((billedHours - logbookHours) * 100) / 100,
            ),
            tdsRate: money(2),
            tdsAmount: money(tds),
            netPayable: money(Math.round((gross - tds) * 100) / 100),
            status: period.status,
            verifiedByUserId:
              period.status === 'paid' ? employees[0].userId : null,
            verifiedAt:
              period.status === 'paid'
                ? at(daysAgo(period.to - 2), 12, 0)
                : null,
            paymentDate:
              period.status === 'paid' ? daysAgo(period.to - 6) : null,
            paymentReference:
              period.status === 'paid'
                ? `${spec.shortCode}/PAY/${String(1310 + bi)}`
                : null,
          },
        });
        totals.hireBills++;
      }
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
    // ── Recruitment: requisitions, pipeline, offers, onboarding, exits ───────
    const docTypes = [];
    for (const [di, dt] of DOCUMENT_TYPES.entries()) {
      docTypes.push(
        await prisma.documentType.create({
          data: {
            companyId: company.id,
            code: dt.code,
            name: dt.name,
            isMandatory: false,
            hasExpiry: dt.expiry ?? false,
            needsNumber: dt.number ?? false,
            sortOrder: di + 1,
          },
        }),
      );
    }

    const kitItems = [];
    for (const k of KIT_ITEMS) {
      kitItems.push(
        await prisma.kitItem.create({
          data: {
            companyId: company.id,
            name: k.name,
            defaultQuantity: k.qty,
            issuedByDefault: true,
            isRecoverableAtExit: k.recoverable,
          },
        }),
      );
    }

    // One active template per type. Generation refuses outright without one, so a
    // demo missing them has a Letters screen that can only produce an error.
    const templates = new Map<string, string>();
    for (const t of [
      {
        type: 'offer' as const,
        name: 'Standard Offer Letter',
        body:
          'Dear {{candidateName}},\n\n' +
          'We are pleased to offer you the position of {{designation}} in the {{department}} department at {{companyName}}.\n\n' +
          'Your annual cost to company will be {{offeredCtc}}. Your joining date is {{joiningDate}}. ' +
          'You will serve a probation of {{probationMonths}} months, after which your notice period will be {{noticePeriodDays}} days.\n\n' +
          'Please sign and return a copy of this letter to confirm your acceptance.\n\n' +
          'Issued on {{issueDate}}.',
      },
      {
        type: 'appointment' as const,
        name: 'Appointment Letter',
        body:
          'Dear {{employeeName}},\n\n' +
          'Further to your acceptance of our offer, we confirm your appointment as {{designation}} in the {{department}} department at {{companyName}} with effect from {{dateOfJoining}}.\n\n' +
          'Your employee code is {{employeeCode}} and you will report to {{reportingManager}}.\n\n' +
          'Issued on {{issueDate}}.',
      },
      {
        type: 'relieving' as const,
        name: 'Relieving Letter',
        body:
          'This is to certify that {{employeeName}} ({{employeeCode}}) was employed with {{companyName}} as {{designation}} from {{dateOfJoining}} to {{lastWorkingDay}}.\n\n' +
          'They have been relieved of their duties with effect from the close of business on {{lastWorkingDay}}. We wish them well.\n\n' +
          'Issued on {{issueDate}}.',
      },
    ]) {
      const row = await prisma.letterTemplate.create({
        data: {
          companyId: company.id,
          letterType: t.type,
          name: t.name,
          bodyTemplate: t.body,
          isActive: true,
        },
      });
      templates.set(t.type, row.id);
    }

    const reqPlan: {
      desig: string;
      dept: string;
      count: number;
      filled: number;
      type: 'permanent' | 'contract' | 'walk_in';
      status: 'open' | 'pending_approval' | 'closed' | 'rejected';
      min: number;
      max: number;
      days: number;
      justification: string;
      rejection?: string;
    }[] = [
      {
        desig: 'Site Engineer',
        dept: 'Engineering',
        count: 2,
        filled: 1,
        type: 'permanent',
        status: 'open',
        min: 600000,
        max: 900000,
        days: 58,
        justification:
          'Two additional engineers for the Phase II structural works.',
      },
      {
        desig: 'Accountant',
        dept: 'Accounts & Finance',
        count: 1,
        filled: 0,
        type: 'permanent',
        status: 'open',
        min: 500000,
        max: 750000,
        days: 41,
        justification: 'Site billing volume has outgrown the current desk.',
      },
      {
        desig: 'Store Keeper',
        dept: 'Stores & Procurement',
        count: 1,
        filled: 0,
        type: 'contract',
        status: 'pending_approval',
        min: 300000,
        max: 420000,
        days: 12,
        justification: 'Second store to be opened at the new site.',
      },
      {
        desig: 'Project Manager',
        dept: 'Projects',
        count: 1,
        filled: 1,
        type: 'permanent',
        status: 'closed',
        min: 1600000,
        max: 2200000,
        days: 96,
        justification:
          'Replacement for the outgoing manager on the residential project.',
      },
      {
        desig: 'Safety Officer',
        dept: 'Safety',
        count: 2,
        filled: 0,
        type: 'permanent',
        status: 'rejected',
        min: 450000,
        max: 620000,
        days: 34,
        justification: 'Two safety officers requested ahead of the audit.',
        rejection: 'One position approved for next quarter; re-raise then.',
      },
    ];

    const requisitions = [];
    for (const [ri, r] of reqPlan.entries()) {
      const decided =
        r.status === 'open' || r.status === 'closed' || r.status === 'rejected';
      requisitions.push(
        await prisma.requisition.create({
          data: {
            companyId: company.id,
            requisitionCode: `${spec.shortCode}/REQ/26-27/${String(11 + ri)}`,
            departmentId: depts.get(r.dept)!,
            designationId: desigs.get(r.desig)!,
            positionCount: r.count,
            filledPositions: r.filled,
            employmentType: r.type,
            projectId: projects[ri % projects.length]?.id ?? null,
            siteId: storeSites[ri % storeSites.length].id,
            targetJoiningDate: daysAgo(r.days - 45),
            budgetedCtcMin: money(r.min),
            budgetedCtcMax: money(r.max),
            justification: r.justification,
            status: r.status,
            approvedBy: decided ? employees[0].userId : null,
            approvedAt: decided ? at(daysAgo(r.days - 3), 10, 20) : null,
            rejectionReason: r.rejection ?? null,
            createdBy: employees[4 % employees.length].userId,
          },
        }),
      );
    }

    // Two joined candidates become two of the people already on the payroll: a hire
    // that produced nobody is not a hire, and inventing a separate employee for them
    // would leave the joining report disagreeing with the employee register.
    const hires = [
      employees[employees.length - 1],
      employees[employees.length - 2],
    ];
    let hireIdx = 0;
    const nameOffset = firstCompanyId === company.id ? 0 : 29;

    // The declared populations, flattened into people.
    const plan = PIPELINE.flatMap((entry) =>
      Array.from({ length: entry.count }, () => entry),
    );

    for (const [ci, c] of plan.entries()) {
      const terminal = c.stage === 'rejected' || c.stage === 'no_show';
      const reached = terminal
        ? c.via!
        : HIRING_PATH.indexOf(c.stage as (typeof HIRING_PATH)[number]);
      const fullName = candidateName(nameOffset + ci);
      const joined = c.stage === 'joined';
      const employee = joined ? hires[hireIdx++] : null;
      const band = reqPlan[c.req];
      // Asking somewhere between the band's floor and a little over its ceiling —
      // which is what makes the one candidate priced out of it worth noticing.
      const expected =
        Math.round((band.min * (0.95 + rand() * 0.45)) / 1000) * 1000;
      const currentCtc =
        Math.round((expected * (0.72 + rand() * 0.14)) / 1000) * 1000;
      const employer = CAND_EMPLOYERS[(ci * 5 + c.req) % CAND_EMPLOYERS.length];
      const source = CAND_SOURCES[ci % CAND_SOURCES.length];
      const reason = terminal
        ? c.stage === 'no_show'
          ? 'Did not report on the agreed joining date and stopped responding.'
          : REJECTION_REASONS[ci % REJECTION_REASONS.length]
        : undefined;
      // Later stages were entered longer ago, so the funnel has a time axis.
      const appliedDaysAgo = Math.max(12, 74 - reached * 8 - (ci % 5));

      const candidate = await prisma.candidate.create({
        data: {
          companyId: company.id,
          requisitionId: requisitions[c.req].id,
          fullName,
          phone: `9${Math.floor(700000000 + rand() * 299999999)}`,
          email: `${fullName
            .toLowerCase()
            .replace(/[^a-z]+/g, '.')}@example.com`,
          totalExperienceYears: money(Math.round((1.5 + rand() * 9) * 10) / 10),
          currentEmployer: employer,
          currentCtc: employer ? money(currentCtc) : null,
          expectedCtc: money(expected),
          source,
          referredByEmployeeId:
            source === 'referral' ? employees[ci % employees.length].id : null,
          stage: c.stage as never,
          employeeId: employee?.id ?? null,
          rejectionReason: c.stage === 'rejected' ? reason ?? null : null,
          noShowReason: c.stage === 'no_show' ? reason ?? null : null,
          createdBy: employees[4 % employees.length].userId,
        },
      });
      totals.candidates++;

      // Every step walked, so the funnel report can say where people were lost
      // rather than only where they now sit.
      let previous: string | null = null;
      for (let step = 0; step <= reached; step++) {
        await prisma.candidateStageHistory.create({
          data: {
            companyId: company.id,
            candidateId: candidate.id,
            fromStage: previous as never,
            toStage: HIRING_PATH[step] as never,
            actorId: employees[0].userId,
            occurredAt: at(
              daysAgo(Math.max(1, appliedDaysAgo - step * 5)),
              12,
              0,
            ),
          },
        });
        previous = HIRING_PATH[step];
      }
      if (terminal) {
        await prisma.candidateStageHistory.create({
          data: {
            companyId: company.id,
            candidateId: candidate.id,
            fromStage: previous as never,
            toStage: c.stage as never,
            actorId: employees[0].userId,
            occurredAt: at(
              daysAgo(Math.max(1, appliedDaysAgo - (reached + 1) * 5)),
              15,
              30,
            ),
            remarks: reason ?? null,
          },
        });
      }

      // Interviews from the interviewing stage onward. The round still in progress is
      // scheduled rather than fed a verdict — an interview with feedback attached that
      // has not happened yet is the sort of thing that makes a demo unbelievable.
      const interviewingIdx = HIRING_PATH.indexOf('interviewing');
      if (reached >= interviewingIdx) {
        const past = reached > interviewingIdx || terminal;
        const rounds: {
          type: 'technical' | 'hr' | 'managerial';
          mode: 'in_person' | 'video' | 'phone';
          done: boolean;
          outcome: 'recommend' | 'hold' | 'reject';
          score: number;
          comments: string;
        }[] = [
          {
            type: 'technical',
            mode: 'in_person',
            done: true,
            outcome: c.stage === 'rejected' ? 'reject' : 'recommend',
            score: c.stage === 'rejected' ? 4 : 8,
            comments:
              c.stage === 'rejected'
                ? 'Strong on paper but the depth on RCC detailing was not there.'
                : 'Solid on site execution and quantity take-off. Comfortable with the drawings.',
          },
          {
            type: 'managerial',
            mode: 'video',
            done: past,
            outcome: 'recommend',
            score: 7,
            comments: 'Communicates well with the site team; happy to proceed.',
          },
        ];

        for (const [ri2, round] of rounds.entries()) {
          if (!round.done && ri2 > 0 && terminal) continue;
          const when = at(
            daysAgo(Math.max(1, appliedDaysAgo - 12 - ri2 * 4)),
            11,
            0,
          );
          const interview = await prisma.interview.create({
            data: {
              companyId: company.id,
              candidateId: candidate.id,
              roundNumber: ri2 + 1,
              roundType: round.type,
              scheduledAt: when,
              mode: round.mode,
              location:
                round.mode === 'in_person'
                  ? `${spec.city} site office`
                  : 'Google Meet',
              status: round.done ? 'completed' : 'scheduled',
              createdBy: employees[0].userId,
            },
          });
          const panel = [employees[0], employees[1 % employees.length]];
          for (const member of panel) {
            await prisma.interviewInterviewer.create({
              data: {
                companyId: company.id,
                interviewId: interview.id,
                employeeId: member.id,
              },
            });
          }
          if (round.done) {
            await prisma.interviewFeedback.create({
              data: {
                companyId: company.id,
                interviewId: interview.id,
                interviewerEmployeeId: panel[0].id,
                outcome: round.outcome,
                score: round.score,
                comments: round.comments,
              },
            });
          }
          totals.interviews++;
        }
      }

      // An offer exists from the moment one is issued, and its letter with it.
      const offerIdx = HIRING_PATH.indexOf('offer_issued');
      if (reached >= offerIdx) {
        const req = reqPlan[c.req];
        const ctc = Math.round((req.min + req.max) / 2 / 1000) * 1000;
        const monthly = Math.round(ctc / 12);
        const basic = Math.round(monthly * 0.5);
        const joiningDate = daysAgo(joined ? 20 : -14);
        const accepted = reached >= HIRING_PATH.indexOf('offer_accepted');

        const letterRef = await writeLetterPdf(
          'OFFER LETTER',
          `Dear ${fullName},\n\nWe are pleased to offer you the position of ${
            req.desig
          } in the ${req.dept} department at ${
            spec.name
          }.\n\nYour annual cost to company will be Rs ${ctc.toLocaleString(
            'en-IN',
          )}. Your joining date is ${joiningDate
            .toISOString()
            .slice(
              0,
              10,
            )}. You will serve a probation of 6 months, after which your notice period will be 30 days.\n\nPlease sign and return a copy of this letter to confirm your acceptance.`,
        );
        const letter = await prisma.generatedLetter.create({
          data: {
            companyId: company.id,
            letterType: 'offer',
            candidateId: candidate.id,
            templateId: templates.get('offer')!,
            renderedRef: letterRef,
            issuedBy: employees[0].userId,
            issuedAt: at(daysAgo(Math.max(2, appliedDaysAgo - 30)), 16, 0),
          },
        });
        totals.letters++;

        await prisma.offer.create({
          data: {
            companyId: company.id,
            candidateId: candidate.id,
            designationId: desigs.get(req.desig)!,
            departmentId: depts.get(req.dept)!,
            offeredCtc: money(ctc),
            salaryBreakup: [
              { name: 'Basic', monthlyAmount: basic },
              { name: 'HRA', monthlyAmount: Math.round(basic * 0.4) },
              { name: 'Conveyance', monthlyAmount: 1600 },
              {
                name: 'Special Allowance',
                monthlyAmount: monthly - basic - Math.round(basic * 0.4) - 1600,
              },
            ],
            proposedJoiningDate: joiningDate,
            confirmedJoiningDate: joined ? joiningDate : null,
            probationMonths: 6,
            noticePeriodDays: 30,
            reportingManagerEmployeeId: employees[0].id,
            outsideBudget: false,
            status:
              c.stage === 'no_show'
                ? 'accepted'
                : accepted
                ? 'accepted'
                : 'issued',
            letterId: letter.id,
            acceptedOn:
              accepted || c.stage === 'no_show'
                ? daysAgo(Math.max(2, appliedDaysAgo - 34))
                : null,
          },
        });
        totals.offers++;
      }

      // Joining closes the loop: an appointment letter and a checklist that is part
      // worked through, which is what an onboarding screen is for.
      if (joined && employee) {
        const req = reqPlan[c.req];
        const appointmentRef = await writeLetterPdf(
          'APPOINTMENT LETTER',
          `Dear ${fullName},\n\nFurther to your acceptance of our offer, we confirm your appointment as ${
            req.desig
          } in the ${req.dept} department at ${
            spec.name
          } with effect from ${daysAgo(20)
            .toISOString()
            .slice(0, 10)}.\n\nYour employee code is ${
            employee.employeeCode
          } and you will report to the Project Manager.`,
        );
        await prisma.generatedLetter.create({
          data: {
            companyId: company.id,
            letterType: 'appointment',
            employeeId: employee.id,
            candidateId: candidate.id,
            templateId: templates.get('appointment')!,
            renderedRef: appointmentRef,
            issuedBy: employees[0].userId,
            issuedAt: at(daysAgo(19), 10, 0),
          },
        });
        totals.letters++;

        const checklist = await prisma.onboardingChecklist.create({
          data: {
            companyId: company.id,
            employeeId: employee.id,
            candidateId: candidate.id,
            openedAt: at(daysAgo(20), 9, 30),
          },
        });
        let itemNo = 0;
        for (const dt of docTypes) {
          itemNo++;
          const done = itemNo <= 4;
          await prisma.onboardingItem.create({
            data: {
              companyId: company.id,
              checklistId: checklist.id,
              itemType: 'document',
              documentTypeId: dt.id,
              label: dt.name,
              status: done ? 'completed' : 'pending',
              completedBy: done ? employees[0].userId : null,
              completedAt: done ? at(daysAgo(18), 14, 0) : null,
            },
          });
        }
        for (const [ki, k] of kitItems.entries()) {
          const done = ki < 3;
          await prisma.onboardingItem.create({
            data: {
              companyId: company.id,
              checklistId: checklist.id,
              itemType: 'kit',
              kitItemId: k.id,
              label: k.name,
              status: done ? 'completed' : 'pending',
              completedBy: done ? employees[0].userId : null,
              completedAt: done ? at(daysAgo(17), 11, 0) : null,
            },
          });
        }
        await prisma.onboardingItem.create({
          data: {
            companyId: company.id,
            checklistId: checklist.id,
            itemType: 'induction',
            label: 'Complete induction',
            status: 'completed',
            completedBy: employees[0].userId,
            completedAt: at(daysAgo(16), 15, 45),
          },
        });
        totals.onboarding++;
      }
    }

    // Exits, so the resignation register and the attrition report are not empty and
    // the two reports can be read against each other.
    for (const [xi, x] of [
      {
        emp: 3,
        days: 26,
        category: 'better_opportunity' as const,
        detail: 'Offered a lead role at a larger contractor in Hyderabad.',
        notice: 30,
        status: 'accepted' as const,
        waiver: 6,
      },
      {
        emp: 5,
        days: 9,
        category: 'relocation' as const,
        detail:
          'Family relocating to Coimbatore at the end of the school year.',
        notice: 60,
        status: 'submitted' as const,
      },
      {
        emp: 7,
        days: 47,
        category: 'personal' as const,
        detail:
          'Extended family commitment; later resolved and the notice was pulled back.',
        notice: 30,
        status: 'withdrawn' as const,
      },
    ].entries()) {
      const employee = employees[x.emp % employees.length];
      const expected = daysAgo(x.days - x.notice);
      await prisma.resignation.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          resignationDate: daysAgo(x.days),
          reasonCategory: x.category,
          reasonDetail: x.detail,
          noticePeriodDays: x.notice,
          expectedLastWorkingDay: expected,
          agreedLastWorkingDay:
            x.status === 'accepted'
              ? daysAgo(x.days - x.notice + (x.waiver ?? 0))
              : null,
          noticeWaiverDays: x.status === 'accepted' ? x.waiver ?? null : null,
          waiverReason:
            x.status === 'accepted'
              ? 'Handover completed early; balance of notice waived.'
              : null,
          status: x.status,
          withdrawReason:
            x.status === 'withdrawn'
              ? 'Personal situation resolved; employee asked to stay on.'
              : null,
          createdBy: employee.userId,
        },
      });
      totals.resignations++;
      void xi;
    }

    console.log(
      `    ${LABOUR_NAMES.length} labour workers, ${ASSETS.length} assets, ${ITEMS.length} items, ${EQUIPMENT.length} machines`,
    );
  }

  console.log(
    `\n  Totals: ${totals.employees} employees, ${totals.punches} punches, ${totals.workers} labour workers, ${totals.assets} assets`,
  );
  console.log(
    `  Inventory: ${totals.purchases} purchases, ${totals.issues} issues, ${totals.transfers} transfers, ${totals.payments} payments, ${totals.indents} indents`,
  );
  console.log(
    `  Plant: ${totals.logbook} logbook entries, ${totals.fuel} fuel entries, ${totals.maintenance} maintenance jobs, ${totals.serviceBills} service bills, ${totals.hireBills} hire bills`,
  );
  console.log(
    `  Recruitment: ${totals.candidates} candidates, ${totals.interviews} interviews, ${totals.offers} offers, ${totals.onboarding} onboarding checklists, ${totals.letters} letters, ${totals.resignations} resignations`,
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
