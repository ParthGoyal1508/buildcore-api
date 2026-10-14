/**
 * Ready examples for every HR document, on top of an existing demo database (2026-10-14).
 *
 * Local-only and **additive**: `seed-demo.ts` skips a company that already exists, so a
 * database seeded before the HR documents landed has no father's names, no permanent
 * addresses, no salary revision, no transfer, no exit and no processed payroll for last
 * month — and every HR letter's compose form pre-fills half blank. This script adds just
 * enough for each document to have one person whose record-backed fields all resolve:
 *
 * - every employee: `fatherName` and a permanent address, where missing;
 * - appointment: a new joiner with full salary heads, designation, site and manager;
 * - offer: a candidate at `offer_accepted` with an accepted offer on a project requisition;
 * - increment: an employee with a past `SalaryRevision`, its new heads on the employee;
 * - transfer: two `EmployeeLocationAssignment` rows at sites of different projects;
 * - relieving / experience / F&F: an accepted resignation, an exit last month, an
 *   earned-leave balance and a salary account (the F&F sheet prints its last four digits);
 * - termination: an exit with reason `termination`;
 * - payslip: last month's (empty, draft) payroll run filled and processed, with slips.
 *
 * Idempotent: every row it creates has a stable id (or a natural unique key) and is
 * created only if absent; fill-ins only touch null columns; the payroll run is left
 * alone once processed. Re-running is a no-op.
 *
 * Run: `npm run seed:hr-docs`.
 */
import { createHash } from 'crypto';

import { config as loadEnv } from 'dotenv';
import { expand } from 'dotenv-expand';
import { PrismaClient, Prisma } from '@prisma/client';

import {
  encryptBlob,
  parseEncryptionKey,
} from '../src/common/storage/blob-cipher';
import {
  computePayrollLine,
  round2,
} from '../src/payroll/engine/payroll-computation';

// `.env` builds DATABASE_URL out of other variables; plain `dotenv/config` leaves the
// `${…}` in place and the guard below could not read the host.
expand(loadEnv());

// ─── Guard (copied from seed-demo.ts) ─────────────────────────────────────────

function pinSingleConnection(): void {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set('connection_limit', '1');
  process.env.DATABASE_URL = url.toString();
}

/**
 * Refuses to write fabricated data anywhere it was not deliberately aimed — see the
 * same function in `seed-demo.ts`. Unlike there, the connection is pinned locally too:
 * the RLS bypass below is a session setting, and one connection is what makes it hold.
 */
function assertTarget(): { host: string; isLocal: boolean } {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^:/?]+)/)?.[1];
  if (!host) {
    throw new Error('DATABASE_URL is missing or unparseable.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-hr-docs.ts must never run with NODE_ENV=production.');
  }
  if (['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host)) {
    pinSingleConnection();
    return { host, isLocal: true };
  }
  if (process.env.SEED_DEMO_ALLOW_HOST === host) {
    pinSingleConnection();
    return { host, isLocal: false };
  }
  throw new Error(
    `seed-hr-docs.ts refuses a non-local DATABASE_URL (host: ${host}). It writes ` +
      'fabricated employees, salaries and exits. To aim it at this host on purpose, ' +
      `re-run with SEED_DEMO_ALLOW_HOST=${host}`,
  );
}

const TARGET = assertTarget();
const prisma = new PrismaClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const money = (n: number) => new Prisma.Decimal(round2(n));
const num = (v: Prisma.Decimal | null | undefined) => (v ? v.toNumber() : 0);

/** A stable, cuid-shaped id, so re-running finds the row it made last time. */
const sid = (key: string) =>
  'c' + createHash('sha256').update(`hr-docs:${key}`).digest('hex').slice(0, 24);

/** Last month, as payroll names a period, and its last day. */
function lastMonth(): { period: string; end: Date; days: number } {
  const now = new Date(Date.now() + 330 * 60_000); // IST, as the app's calendar
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based → last month is m-1
  const end = new Date(Date.UTC(y, m, 0));
  const period = `${end.getUTCFullYear()}-${String(
    end.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  return { period, end, days: end.getUTCDate() };
}
const iso = (t: Date) => t.toISOString().slice(0, 10);
const addDays = (t: Date, n: number) => new Date(t.getTime() + n * 86_400_000);

/** Fathers' first names; the surname is the employee's own. */
const FATHER_FIRST = [
  'Ramesh', 'Suresh', 'Prakash', 'Venkatesh', 'Gopal', 'Mahesh', 'Shankar',
  'Srinivas', 'Narayan', 'Ashok', 'Dinesh', 'Vijay', 'Anil', 'Mohan', 'Vishwanath',
  'Raghunath', 'Krishna', 'Dattatray', 'Vasant', 'Balaji',
];

/** Where "father's first name + own surname" would read wrong. */
const FATHER_OVERRIDES: Record<string, string> = {
  'PRPL-0005': 'Mohammed Yusuf',
};

const STREETS = [
  'Ganesh Nagar, 2nd Cross', 'Shanti Colony, Main Road', 'Vidya Nagar, 4th Lane',
  'Gandhi Chowk, Ward 7', 'Station Road, Near Bus Stand', 'Laxmi Layout, 1st Main',
  'Saraswati Nagar, 3rd Cross', 'Old Market Road', 'Ram Mandir Road',
  'Teachers Colony, 5th Lane',
];

interface Home {
  city: string;
  state: string;
  pinBase: number;
}
const HOMES: Record<string, Home[]> = {
  PRPL: [
    { city: 'Mysuru', state: 'Karnataka', pinBase: 570001 },
    { city: 'Hubballi', state: 'Karnataka', pinBase: 580020 },
    { city: 'Davanagere', state: 'Karnataka', pinBase: 577001 },
    { city: 'Mangaluru', state: 'Karnataka', pinBase: 575001 },
    { city: 'Tumakuru', state: 'Karnataka', pinBase: 572101 },
  ],
  SBPL: [
    { city: 'Satara', state: 'Maharashtra', pinBase: 415001 },
    { city: 'Kolhapur', state: 'Maharashtra', pinBase: 416001 },
    { city: 'Ahmednagar', state: 'Maharashtra', pinBase: 414001 },
    { city: 'Solapur', state: 'Maharashtra', pinBase: 413001 },
    { city: 'Nashik', state: 'Maharashtra', pinBase: 422001 },
  ],
};

function addressFor(shortCode: string, i: number) {
  const homes = HOMES[shortCode] ?? HOMES.PRPL;
  const home = homes[i % homes.length];
  return {
    permanentAddress: `${10 + ((i * 37) % 180)}, ${STREETS[i % STREETS.length]}`,
    permanentCity: home.city,
    permanentState: home.state,
    permanentPinCode: String(home.pinBase + (i % 9)),
  };
}

// ─── The people, per company ──────────────────────────────────────────────────

interface Heads {
  basic: number;
  hra: number;
  conveyance: number;
  siteAllowance: number;
  specialAllowance: number;
}

interface PersonSpec {
  role: 'appointment' | 'increment' | 'transfer' | 'resignation' | 'termination';
  code: string; // suffix after `${shortCode}-`
  firstName: string;
  lastName: string;
  fatherFirst: string;
  gender: 'male' | 'female';
  designation: string;
  department: string;
  site: number; // index into the company's project sites, ordered by name
  doj: string;
  heads: Heads;
  mobile: string;
}

interface CompanySpec {
  shortCode: string;
  domain: string;
  people: PersonSpec[];
  candidate: {
    fullName: string;
    fatherName: string;
    address: string;
    phone: string;
    email: string;
    designation: string;
    department: string;
    annualCtc: number;
  };
}

const SPECS: CompanySpec[] = [
  {
    shortCode: 'PRPL',
    domain: 'parthrealcon.com',
    people: [
      {
        role: 'appointment', code: '0901', firstName: 'Arjun', lastName: 'Venkatesh',
        fatherFirst: 'Srinivasa', gender: 'male', designation: 'Senior Engineer',
        department: 'Engineering', site: 0, doj: '2026-10-05', mobile: '9845090101',
        heads: { basic: 42000, hra: 16800, conveyance: 1600, siteAllowance: 3000, specialAllowance: 14600 },
      },
      {
        role: 'increment', code: '0902', firstName: 'Bhavana', lastName: 'Narayanan',
        fatherFirst: 'Sridhar', gender: 'female', designation: 'Quantity Surveyor',
        department: 'Engineering', site: 1, doj: '2023-04-03', mobile: '9845090102',
        heads: { basic: 34000, hra: 13600, conveyance: 1600, siteAllowance: 2500, specialAllowance: 15300 },
      },
      {
        role: 'transfer', code: '0903', firstName: 'Harish', lastName: 'Acharya',
        fatherFirst: 'Raghavendra', gender: 'male', designation: 'Site Supervisor',
        department: 'Projects', site: 1, doj: '2022-08-16', mobile: '9845090103',
        heads: { basic: 26000, hra: 10400, conveyance: 1600, siteAllowance: 2500, specialAllowance: 11500 },
      },
      {
        role: 'resignation', code: '0904', firstName: 'Divya', lastName: 'Hegde',
        fatherFirst: 'Ganapati', gender: 'female', designation: 'Accountant',
        department: 'Accounts & Finance', site: 2, doj: '2022-07-11', mobile: '9845090104',
        heads: { basic: 32000, hra: 12800, conveyance: 1600, siteAllowance: 2500, specialAllowance: 14100 },
      },
      {
        role: 'termination', code: '0905', firstName: 'Naveen', lastName: 'Shenoy',
        fatherFirst: 'Umesh', gender: 'male', designation: 'Store Keeper',
        department: 'Stores & Procurement', site: 0, doj: '2024-03-04', mobile: '9845090105',
        heads: { basic: 21000, hra: 8400, conveyance: 1600, siteAllowance: 2500, specialAllowance: 8500 },
      },
    ],
    candidate: {
      fullName: 'Rohan Kamath', fatherName: 'Sudhakar Kamath',
      address: '48, Kadri Hills Road, Mangaluru, Karnataka - 575004',
      phone: '9845090110', email: 'rohan.kamath@example.com',
      designation: 'Site Engineer', department: 'Engineering', annualCtc: 540000,
    },
  },
  {
    shortCode: 'SBPL',
    domain: 'shreejibuildtech.in',
    people: [
      {
        role: 'appointment', code: '0901', firstName: 'Aniket', lastName: 'Deshmukh',
        fatherFirst: 'Prabhakar', gender: 'male', designation: 'Senior Engineer',
        department: 'Engineering', site: 0, doj: '2026-10-05', mobile: '9822090101',
        heads: { basic: 40000, hra: 16000, conveyance: 1600, siteAllowance: 3000, specialAllowance: 13400 },
      },
      {
        role: 'increment', code: '0902', firstName: 'Prajakta', lastName: 'Shinde',
        fatherFirst: 'Dilip', gender: 'female', designation: 'Quantity Surveyor',
        department: 'Engineering', site: 1, doj: '2023-02-13', mobile: '9822090102',
        heads: { basic: 33000, hra: 13200, conveyance: 1600, siteAllowance: 2500, specialAllowance: 14700 },
      },
      {
        role: 'transfer', code: '0903', firstName: 'Omkar', lastName: 'Patwardhan',
        fatherFirst: 'Madhukar', gender: 'male', designation: 'Site Supervisor',
        department: 'Projects', site: 0, doj: '2022-11-07', mobile: '9822090103',
        heads: { basic: 25000, hra: 10000, conveyance: 1600, siteAllowance: 2500, specialAllowance: 10900 },
      },
      {
        role: 'resignation', code: '0904', firstName: 'Snehal', lastName: 'Gokhale',
        fatherFirst: 'Shrikant', gender: 'female', designation: 'Accountant',
        department: 'Accounts & Finance', site: 1, doj: '2021-06-21', mobile: '9822090104',
        heads: { basic: 31000, hra: 12400, conveyance: 1600, siteAllowance: 2500, specialAllowance: 13500 },
      },
      {
        role: 'termination', code: '0905', firstName: 'Tushar', lastName: 'Mane',
        fatherFirst: 'Bhimrao', gender: 'male', designation: 'Store Keeper',
        department: 'Stores & Procurement', site: 0, doj: '2024-01-15', mobile: '9822090105',
        heads: { basic: 20000, hra: 8000, conveyance: 1600, siteAllowance: 2500, specialAllowance: 8100 },
      },
    ],
    candidate: {
      fullName: 'Kunal Thakur', fatherName: 'Rajendra Thakur',
      address: '12, Shivaji Peth, Kolhapur, Maharashtra - 416012',
      phone: '9822090110', email: 'kunal.thakur@example.com',
      designation: 'Site Engineer', department: 'Engineering', annualCtc: 510000,
    },
  },
];

/** What a person earned before their increment — about 9% less, rounded. */
const previousOf = (h: Heads): Heads => ({
  basic: Math.round((h.basic * 0.91) / 100) * 100,
  hra: Math.round((h.hra * 0.91) / 100) * 100,
  conveyance: h.conveyance,
  siteAllowance: h.siteAllowance,
  specialAllowance: Math.round((h.specialAllowance * 0.91) / 100) * 100,
});

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Seeding HR document examples into ${TARGET.host}…\n`);
  // The same RLS bypass `withRlsContext()` sets for system writes; session-wide, and the
  // connection is pinned to one (see `assertTarget`).
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const admin = await prisma.user.findFirst({
    where: { email: 'admin@buildcore.dev' },
    select: { id: true },
  });
  if (!admin) throw new Error('admin@buildcore.dev not found — run seed-demo first.');

  // Lazy: `config.ts` reads process.env when it is evaluated, after `expand` above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const statutory = require('../src/common/configs/config').default().hrPayroll
    .statutory;
  const key = parseEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY);
  const encryptPii = (plain: string) =>
    encryptBlob(Buffer.from(plain, 'utf8'), key).toString('base64');

  const month = lastMonth();
  const today = d(iso(new Date(Date.now() + 330 * 60_000)));

  for (const spec of SPECS) {
    const company = await prisma.company.findFirst({
      where: { shortCode: spec.shortCode },
    });
    if (!company) {
      console.log(`  ${spec.shortCode}: not in this database, skipped.`);
      continue;
    }
    const companyId = company.id;
    const sc = spec.shortCode;
    const k = (s: string) => sid(`${sc}:${s}`);

    const [designations, departments, sites, shift, signatory] =
      await Promise.all([
        prisma.designation.findMany({ where: { companyId } }),
        prisma.department.findMany({ where: { companyId } }),
        prisma.site.findMany({
          where: { companyId, projectId: { not: null } },
          orderBy: { name: 'asc' },
        }),
        prisma.shift.findFirst({
          where: { companyId, name: { startsWith: 'General' } },
        }),
        prisma.signatory.findFirst({ where: { companyId, isActive: true } }),
      ]);
    const desig = (name: string) => {
      const row = designations.find((r) => r.name === name);
      if (!row) throw new Error(`${sc}: no designation "${name}"`);
      return row.id;
    };
    const dept = (name: string) => {
      const row = departments.find((r) => r.name === name);
      if (!row) throw new Error(`${sc}: no department "${name}"`);
      return row.id;
    };
    // Sites whose projects differ, so a transfer moves between projects.
    // Test fixtures left by e2e runs ("TEST SITE", "E2E…") are not somewhere to post anyone.
    const realSites = sites.filter((s) => !/test|e2e/i.test(s.name));
    const projectSites = realSites.filter(
      (s, i) => realSites.findIndex((t) => t.projectId === s.projectId) === i,
    );
    if (projectSites.length < 2 || !shift) {
      throw new Error(`${sc}: needs two project sites and a General shift.`);
    }
    const siteAt = (i: number) => projectSites[i % projectSites.length];

    const manager = await prisma.employee.findFirst({
      where: { companyId, employeeCode: `${sc}-0001` },
    });
    if (!manager) throw new Error(`${sc}: ${sc}-0001 not found.`);

    // ── Employees: the documents' people ──────────────────────────────────────
    const made: Record<PersonSpec['role'], { id: string; code: string; name: string }> =
      {} as never;
    for (const [i, p] of spec.people.entries()) {
      const employeeCode = `${sc}-${p.code}`;
      const heads =
        p.role === 'increment' ? previousOf(p.heads) : p.heads;
      const employee = await prisma.employee.upsert({
        where: { companyId_employeeCode: { companyId, employeeCode } },
        update: {},
        create: {
          id: k(`employee:${p.code}`),
          companyId,
          siteId: siteAt(p.site).id,
          shiftId: shift.id,
          employeeCode,
          firstName: p.firstName,
          lastName: p.lastName,
          fatherName: `${p.fatherFirst} ${p.lastName}`,
          gender: p.gender,
          dob: d(`${1986 + i * 2}-0${1 + i}-1${i}`),
          maritalStatus: i % 2 ? 'married' : 'single',
          departmentId: dept(p.department),
          designationId: desig(p.designation),
          employmentType: 'full_time',
          dateOfJoining: d(p.doj),
          probationEndDate: addDays(d(p.doj), 182),
          reportingToEmployeeId: manager.id,
          hoursPerDay: money(8),
          calculationMode: 'monthly',
          paymentMode: 'bank',
          pfApplicable: true,
          uan: `10${sc === 'PRPL' ? '77' : '88'}0090${p.code}`,
          pfNumber: `${sc === 'PRPL' ? 'KN/BNG' : 'MH/PUN'}/0012345/000/${p.code}`,
          basic: money(heads.basic),
          hra: money(heads.hra),
          conveyanceAllowance: money(heads.conveyance),
          siteAllowance: money(heads.siteAllowance),
          specialAllowance: money(heads.specialAllowance),
          bankName: sc === 'PRPL' ? 'HDFC Bank' : 'Bank of Maharashtra',
          bankBranch: sc === 'PRPL' ? 'Koramangala' : 'Baner',
          ifscCode: sc === 'PRPL' ? 'HDFC0000053' : 'MAHB0001234',
          bankAccountNumberEncrypted: encryptPii(`5010023456${p.code}`),
          bankAccountHolderName: `${p.firstName} ${p.lastName}`.toUpperCase(),
          mobile: p.mobile,
          email: `${p.firstName}.${p.lastName}@${spec.domain}`.toLowerCase(),
          presentAddress:
            sc === 'PRPL'
              ? `${20 + i}, 6th Main, HSR Layout Sector ${i + 1}`
              : `Flat ${101 + i}, Sai Residency, Aundh`,
          presentCity: sc === 'PRPL' ? 'Bengaluru' : 'Pune',
          presentState: sc === 'PRPL' ? 'Karnataka' : 'Maharashtra',
          presentPinCode: sc === 'PRPL' ? '560102' : '411007',
          ...addressFor(sc, 20 + i),
          emergencyContactName: `${p.fatherFirst} ${p.lastName}`,
          emergencyContactRelation: 'Father',
          emergencyContactPhone: `9${p.mobile.slice(1, 7)}9${p.code.slice(1)}`,
          offerLetterIssued: true,
          appointmentLetterIssued: p.role !== 'appointment',
        },
      });
      made[p.role] = {
        id: employee.id,
        code: employeeCode,
        name: `${p.firstName} ${p.lastName}`,
      };

      // Earned leave, which the F&F encashes; the others get a balance so their leave
      // screens are not empty.
      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveType_financialYear: {
            employeeId: employee.id,
            leaveType: 'earned',
            financialYear: '2026-2027',
          },
        },
        update: {},
        create: {
          employeeId: employee.id,
          leaveType: 'earned',
          financialYear: '2026-2027',
          opening: money(p.role === 'resignation' ? 10 : 6),
          accrued: money(6),
          used: money(p.role === 'resignation' ? 3 : 1),
        },
      });

      if (p.role === 'increment') {
        const prev = previousOf(p.heads);
        const effectiveFrom = d(`${month.period}-01`);
        const exists = await prisma.salaryRevision.findUnique({
          where: { id: k('revision') },
        });
        if (!exists) {
          // As `SalaryRevisionsService.create` does: the revision records both sets of
          // heads and the new ones are written onto the employee in the same breath.
          await prisma.$transaction([
            prisma.salaryRevision.create({
              data: {
                id: k('revision'),
                companyId,
                employeeId: employee.id,
                effectiveFrom,
                previousBasic: money(prev.basic),
                previousHra: money(prev.hra),
                previousConveyance: money(prev.conveyance),
                previousSiteAllowance: money(prev.siteAllowance),
                previousSpecialAllowance: money(prev.specialAllowance),
                basic: money(p.heads.basic),
                hra: money(p.heads.hra),
                conveyance: money(p.heads.conveyance),
                siteAllowance: money(p.heads.siteAllowance),
                specialAllowance: money(p.heads.specialAllowance),
                remarks: 'Annual increment — performance rating "Exceeds expectations"',
                createdByUserId: admin.id,
              },
            }),
            prisma.employee.update({
              where: { id: employee.id },
              data: {
                basic: money(p.heads.basic),
                hra: money(p.heads.hra),
                conveyanceAllowance: money(p.heads.conveyance),
                siteAllowance: money(p.heads.siteAllowance),
                specialAllowance: money(p.heads.specialAllowance),
              },
            }),
          ]);
        }
      }

      if (p.role === 'transfer') {
        const from = siteAt(p.site);
        const to = siteAt(p.site + 1);
        const rows = [
          { key: 'assign:from', siteId: from.id, at: p.doj, reason: 'Posted on joining' },
          {
            key: 'assign:to',
            siteId: to.id,
            at: iso(addDays(today, -7)),
            reason: 'Transferred to strengthen the site supervision team',
          },
        ];
        for (const r of rows) {
          await prisma.employeeLocationAssignment.upsert({
            where: { id: k(r.key) },
            update: {},
            create: {
              id: k(r.key),
              companyId,
              employeeId: employee.id,
              siteId: r.siteId,
              isMobile: false,
              effectiveFrom: d(r.at),
              assignedByUserId: admin.id,
              reason: r.reason,
            },
          });
        }
      }

      if (p.role === 'resignation') {
        // Resigned a month before the end of last month, relieved on its last day.
        const lwd = month.end;
        const resigned = addDays(lwd, -30);
        await prisma.resignation.upsert({
          where: { id: k('resignation') },
          update: {},
          create: {
            id: k('resignation'),
            companyId,
            employeeId: employee.id,
            resignationDate: resigned,
            reasonCategory: 'better_opportunity',
            reasonDetail: 'Moving closer to family; has an offer in the home town.',
            noticePeriodDays: 30,
            expectedLastWorkingDay: lwd,
            agreedLastWorkingDay: lwd,
            status: 'accepted',
            createdBy: admin.id,
          },
        });
        await prisma.exitRecord.upsert({
          where: { id: k('exit:resignation') },
          update: {},
          create: {
            id: k('exit:resignation'),
            employeeId: employee.id,
            lastWorkingDay: lwd,
            reason: 'resignation',
            remarks: 'Resignation accepted; notice served in full.',
            initiatedByUserId: admin.id,
          },
        });
      }

      if (p.role === 'termination') {
        await prisma.exitRecord.upsert({
          where: { id: k('exit:termination') },
          update: {},
          create: {
            id: k('exit:termination'),
            employeeId: employee.id,
            lastWorkingDay: addDays(today, -4),
            reason: 'termination',
            remarks: 'Repeated unauthorised absence after two written warnings.',
            initiatedByUserId: admin.id,
          },
        });
      }
    }

    // ── Every employee: father's name and permanent address where missing ─────
    const everyone = await prisma.employee.findMany({
      where: { companyId },
      orderBy: { employeeCode: 'asc' },
    });
    let filled = 0;
    for (const [i, e] of everyone.entries()) {
      const data: Prisma.EmployeeUpdateInput = {};
      if (!e.fatherName) {
        data.fatherName =
          FATHER_OVERRIDES[e.employeeCode] ??
          `${FATHER_FIRST[(i * 7) % FATHER_FIRST.length]} ${
            e.lastName ?? ''
          }`.trim();
      }
      if (!e.permanentAddress) Object.assign(data, addressFor(sc, i));
      if (Object.keys(data).length) {
        await prisma.employee.update({ where: { id: e.id }, data });
        filled++;
      }
    }

    // ── Offer: a candidate with an accepted offer ────────────────────────────
    const requisition = await prisma.requisition.findFirst({
      where: {
        companyId,
        status: 'open',
        projectId: { not: null },
        siteId: { not: null },
        deletedAt: null,
      },
      orderBy: { requisitionCode: 'asc' },
    });
    if (!requisition) throw new Error(`${sc}: no open requisition on a project.`);
    const c = spec.candidate;
    const candidate = await prisma.candidate.upsert({
      where: { id: k('candidate') },
      update: {},
      create: {
        id: k('candidate'),
        companyId,
        requisitionId: requisition.id,
        fullName: c.fullName,
        fatherName: c.fatherName,
        address: c.address,
        phone: c.phone,
        email: c.email,
        totalExperienceYears: money(4.5),
        currentEmployer: 'Sobha Constructions',
        currentCtc: money(c.annualCtc * 0.82),
        expectedCtc: money(c.annualCtc),
        source: 'portal',
        stage: 'offer_accepted',
        createdBy: admin.id,
      },
    });
    for (const [step, toStage] of (
      [
        'applied', 'shortlisted', 'interviewing', 'selected', 'offer_issued', 'offer_accepted',
      ] as const
    ).entries()) {
      await prisma.candidateStageHistory.upsert({
        where: { id: k(`stage:${toStage}`) },
        update: {},
        create: {
          id: k(`stage:${toStage}`),
          companyId,
          candidateId: candidate.id,
          fromStage: step === 0 ? null : (
            ['applied', 'shortlisted', 'interviewing', 'selected', 'offer_issued'] as const
          )[step - 1],
          toStage,
          occurredAt: addDays(today, -30 + step * 5),
          actorId: admin.id,
        },
      });
    }
    const monthly = c.annualCtc / 12;
    const basic = Math.round(monthly * 0.45);
    await prisma.offer.upsert({
      where: { id: k('offer') },
      update: {},
      create: {
        id: k('offer'),
        companyId,
        candidateId: candidate.id,
        designationId: desig(c.designation),
        departmentId: dept(c.department),
        offeredCtc: money(c.annualCtc),
        salaryBreakup: [
          { name: 'Basic', monthlyAmount: basic },
          { name: 'HRA', monthlyAmount: Math.round(basic * 0.4) },
          { name: 'Conveyance', monthlyAmount: 1600 },
          {
            name: 'Special Allowance',
            monthlyAmount: monthly - basic - Math.round(basic * 0.4) - 1600,
          },
        ],
        proposedJoiningDate: addDays(today, 19),
        probationMonths: 6,
        noticePeriodDays: 30,
        reportingManagerEmployeeId: manager.id,
        status: 'accepted',
        acceptedOn: addDays(today, -3),
        createdBy: admin.id,
      },
    });

    // ── Payslip: last month's run, processed with slips ──────────────────────
    const payslip = await processLastMonth(companyId, month, statutory, company);

    console.log(`  ${sc} (${company.name})`);
    for (const [role, e] of Object.entries(made)) {
      console.log(`    ${role.padEnd(12)} ${e.code}  ${e.name.padEnd(20)} ${e.id}`);
    }
    console.log(`    offer        candidate     ${c.fullName.padEnd(20)} ${candidate.id}`);
    console.log(`    filled father's name / permanent address on ${filled} employee(s)`);
    console.log(`    payslip      ${payslip}`);
    console.log(
      `    signatory    ${
        signatory ? `${signatory.name} (${signatory.id})` : 'NONE ACTIVE'
      }\n`,
    );
  }
}

/**
 * Fills and processes last month's payroll run, the way the engine would.
 *
 * Uses the run that already exists for the period when there is one — `getSlip` reads
 * "the" run for a company and period, so a second one would make the payslip depend on
 * which row Postgres returned first. A run already processed is left exactly as it is.
 * A full month is paid to everybody active who had joined by its end and was not leaving
 * in it (the leaver's month is the F&F's to pay).
 */
async function processLastMonth(
  companyId: string,
  month: { period: string; end: Date; days: number },
  statutory: Parameters<typeof computePayrollLine>[3],
  company: {
    pfEmployerRate: Prisma.Decimal;
    esicEmployerRate: Prisma.Decimal;
    gratuityRate: Prisma.Decimal;
    bonusRate: Prisma.Decimal;
    otMultiplier: Prisma.Decimal;
  },
): Promise<string> {
  let run = await prisma.payrollRun.findFirst({
    where: { companyId, period: month.period, isFnf: false },
    include: { _count: { select: { lineItems: true } } },
  });
  if (run && run.status !== 'draft') {
    return `${month.period} run ${run.id} already ${run.status}; left as is`;
  }
  if (run && run._count.lineItems > 0) {
    return `${month.period} run ${run.id} is a draft with lines; left for HR to process`;
  }
  if (!run) {
    run = await prisma.payrollRun.create({
      data: { id: sid(`${companyId}:run:${month.period}`), companyId, period: month.period },
      include: { _count: { select: { lineItems: true } } },
    });
  }

  const employees = await prisma.employee.findMany({
    where: {
      companyId,
      isActive: true,
      dateOfJoining: { lte: month.end },
      exitRecords: { none: { lastWorkingDay: { lte: month.end } } },
    },
  });
  const rates = {
    pfEmployerRatePercent: company.pfEmployerRate.toNumber(),
    esicEmployerRatePercent: company.esicEmployerRate.toNumber(),
    gratuityRatePercent: company.gratuityRate.toNumber(),
    bonusRatePercent: company.bonusRate.toNumber(),
    otMultiplier: company.otMultiplier.toNumber(),
  };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const e of employees) {
      const f = computePayrollLine(
        {
          employeeId: e.id,
          projectId: null,
          basic: num(e.basic),
          hra: num(e.hra),
          conveyanceAllowance: num(e.conveyanceAllowance),
          siteAllowance: num(e.siteAllowance),
          specialAllowance: num(e.specialAllowance),
          pfApplicable: e.pfApplicable,
          pfUpperLimit: e.pfUpperLimit,
          esicApplicable: e.esicApplicable,
          esicUpperLimit: e.esicUpperLimit,
          hoursPerDay: num(e.hoursPerDay) || 8,
          loanEmiDeduction: 0,
          tds: 0,
        },
        { monthDays: month.days, payableDays: month.days, lopDays: 0, otHours: 0 },
        rates,
        statutory,
      );
      await tx.payrollLineItem.create({
        data: {
          payrollRunId: run!.id,
          employeeId: e.id,
          monthDays: f.monthDays,
          payableDays: f.payableDays,
          lopDays: f.lopDays,
          otHours: f.otHours,
          otWages: f.otWages,
          basic: f.basic,
          hra: f.hra,
          conveyanceAllowance: f.conveyanceAllowance,
          siteAllowance: f.siteAllowance,
          specialAllowance: f.specialAllowance,
          employeePf: f.employeePf,
          employeeEsic: f.employeeEsic,
          professionalTax: f.professionalTax,
          tds: f.tds,
          loanEmiDeduction: f.loanEmiDeduction,
          netPay: f.netPay,
          employerPf: f.employerPf,
          employerEps: f.employerEps,
          employerEdli: f.employerEdli,
          adminCharges: f.adminCharges,
          employerEsic: f.employerEsic,
          gratuity: f.gratuity,
          bonus: f.bonus,
        },
      });
      // As `PayrollEngineService.materialiseSalarySlips` writes it at Processed.
      const slip = {
        monthDays: f.monthDays,
        payableDays: f.payableDays,
        lopDays: f.lopDays,
        otHours: f.otHours,
        earningBasic: f.basic,
        earningHra: f.hra,
        earningConveyance: f.conveyanceAllowance,
        earningSiteAllowance: f.siteAllowance,
        earningSpecialAllowance: f.specialAllowance,
        earningOt: f.otWages,
        fullEarningBasic: e.basic,
        fullEarningHra: e.hra,
        fullEarningConveyance: e.conveyanceAllowance,
        fullEarningSiteAllowance: e.siteAllowance,
        fullEarningSpecialAllowance: e.specialAllowance,
        deductionPf: f.employeePf,
        deductionEsic: f.employeeEsic,
        deductionPt: f.professionalTax,
        deductionTds: f.tds,
        deductionLoanEmi: f.loanEmiDeduction,
        deductionAdvanceRecovery: 0,
        deductionFuelRecovery: 0,
        employerPf: f.employerPf,
        employerEps: f.employerEps,
        employerEdli: f.employerEdli,
        employerAdminCharges: f.adminCharges,
        employerGratuity: f.gratuity,
        employerBonus: f.bonus,
        netPay: f.netPay,
      };
      await tx.salarySlip.upsert({
        where: { employeeId_period: { employeeId: e.id, period: month.period } },
        create: { employeeId: e.id, period: month.period, ...slip },
        update: slip,
      });
    }
    await tx.payrollRun.update({
      where: { id: run!.id },
      data: {
        status: 'processed',
        generatedAt: run!.generatedAt ?? now,
        processedAt: now,
      },
    });
  });
  return `${month.period} run ${run.id} processed with ${employees.length} slip(s)`;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
