/**
 * Labour completion module: everything a road-construction company's labour screens hold after a
 * couple of months of face-punch attendance (031/034).
 *
 * - Tidies the base seed's workforce so it can be priced and punched as the app expects:
 *   contractor labour gets its contractor, labour registered at the head office moves to a working
 *   camp, skilled hands get a rate override, and every worker who punches has a face template.
 * - Adds a dozen more workers per company (women among them, as on any Rajasthan road site), the
 *   labour-code counter, site rates per site and gender, supervisor-site assignments and gangs.
 * - Punches from 1 September to now, and the face-punch musters the app derives from them: the
 *   September musters match the approved September payment sheet (24 days for each worker on it),
 *   October carries the ordinary noise — absences, half days, a few corrected punches, and two
 *   missing punch-outs per company still waiting for the supervisor.
 * - A few refused punches, reference group photos per site, and advances in every state.
 *
 * October payment sheets are left for the app to generate (it owns the pricing, deduction and
 * denomination rules), which is also why no advance has been recovered yet.
 */
import {
  AdvanceStatus,
  EngagementType,
  LabourGender,
  LabourPunchRefusalReason,
  LabourPunchSource,
  LabourPunchType,
  MusterSource,
  MusterStatus,
  Prisma,
  WorkerStatus,
} from '@prisma/client';
import type { Sharp } from 'sharp';

import {
  deriveLabourDay,
  type LabourDayRules,
  musterLineFor,
} from '../../src/labour/attendance/labour-day.util';
import {
  at,
  type CompanyContext,
  d,
  type ModuleResult,
  money,
} from './support';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (input?: Buffer) => Sharp = require('sharp');

// ─── Reference data ───────────────────────────────────────────────────────────

/** Who runs which camp, by username and a fragment of the site name. First listed punches. */
const SUPERVISORS: Record<string, { username: string; sites: string[] }[]> = {
  PRPL: [
    { username: 'deepak.meena', sites: ['Tonk Bypass'] },
    { username: 'ramesh.gurjar', sites: ['Deva Khera'] },
    { username: 'mahendra.rathore', sites: ['Deoli–Uniyara', 'Tonk Bypass'] },
  ],
  TE: [
    { username: 'rohit.tiwari', sites: ['NH-148A'] },
    { username: 'sanjay.prajapat', sites: ['Mangalam', 'NH-30'] },
    { username: 'arvind.yadav', sites: ['NH-30'] },
  ],
};

/** Site daily rates (₹) before and after the 1 October revision, by region. */
function siteRates(siteName: string) {
  if (/Gurugram|NH-148A/.test(siteName)) {
    return { old: { male: 540, female: 510 }, cur: { male: 570, female: 540 } };
  }
  if (/Lucknow|Itaunja|NH-30/.test(siteName)) {
    return { old: { male: 430, female: 400 }, cur: { male: 450, female: 420 } };
  }
  return { old: { male: 470, female: 430 }, cur: { male: 500, female: 450 } };
}

/** Per-worker daily rate the office sets for skilled hands; helpers take the site rate. */
const SKILL_OVERRIDE: Record<string, number> = {
  Mason: 650,
  'Bar Bender': 600,
  Carpenter: 580,
  Electrician: 620,
  Painter: 520,
};

interface NewWorker {
  name: string;
  father: string;
  gender: LabourGender;
  skill: string;
  contractor?: boolean;
  /** Days before today the worker was registered. */
  registered: number;
  /** Left the site this many days ago. */
  leftDaysAgo?: number;
  leftReason?: string;
  /** Registered at the gate without face photos yet: no punches. */
  noFace?: boolean;
}

const NEW_WORKERS: Record<string, NewWorker[]> = {
  PRPL: [
    {
      name: 'Bhanwar Lal Gurjar',
      father: 'Ramdhan Gurjar',
      gender: 'male',
      skill: 'Mason',
      registered: 22,
    },
    {
      name: 'Kamla Devi Meena',
      father: 'Kalyan Meena',
      gender: 'female',
      skill: 'Helper',
      registered: 21,
    },
    {
      name: 'Shankar Lal Bairwa',
      father: 'Gopal Bairwa',
      gender: 'male',
      skill: 'Helper',
      registered: 21,
    },
    {
      name: 'Gita Devi Regar',
      father: 'Mangilal Regar',
      gender: 'female',
      skill: 'Helper',
      registered: 20,
    },
    {
      name: 'Mohan Lal Saini',
      father: 'Bhagirath Saini',
      gender: 'male',
      skill: 'Bar Bender',
      registered: 20,
      contractor: true,
    },
    {
      name: 'Sita Devi Bairwa',
      father: 'Prabhu Bairwa',
      gender: 'female',
      skill: 'Helper',
      registered: 19,
    },
    {
      name: 'Kailash Mali',
      father: 'Ratan Lal Mali',
      gender: 'male',
      skill: 'Helper',
      registered: 19,
      leftDaysAgo: 9,
      leftReason: 'Went back to the village for the bajra harvest',
    },
    {
      name: 'Laxmi Devi Gurjar',
      father: 'Hanuman Gurjar',
      gender: 'female',
      skill: 'Helper',
      registered: 15,
    },
    {
      name: 'Prabhu Lal Meena',
      father: 'Chhotu Ram Meena',
      gender: 'male',
      skill: 'Carpenter',
      registered: 15,
      contractor: true,
    },
    {
      name: 'Santosh Devi Saini',
      father: 'Ganpat Saini',
      gender: 'female',
      skill: 'Helper',
      registered: 13,
    },
    {
      name: 'Hemraj Bairwa',
      father: 'Nathu Lal Bairwa',
      gender: 'male',
      skill: 'Helper',
      registered: 8,
    },
    {
      name: 'Ramkesh Meena',
      father: 'Bhonri Lal Meena',
      gender: 'male',
      skill: 'Helper',
      registered: 0,
      noFace: true,
    },
  ],
  TE: [
    {
      name: 'Rajesh Jatav',
      father: 'Mahesh Jatav',
      gender: 'male',
      skill: 'Mason',
      registered: 22,
    },
    {
      name: 'Sunita Devi',
      father: 'Ram Prasad',
      gender: 'female',
      skill: 'Helper',
      registered: 21,
    },
    {
      name: 'Ram Kishan Pal',
      father: 'Shiv Charan Pal',
      gender: 'male',
      skill: 'Helper',
      registered: 21,
    },
    {
      name: 'Pinki Devi',
      father: 'Raghubir Singh',
      gender: 'female',
      skill: 'Helper',
      registered: 20,
    },
    {
      name: 'Om Prakash Kushwaha',
      father: 'Jagdish Kushwaha',
      gender: 'male',
      skill: 'Bar Bender',
      registered: 20,
      contractor: true,
    },
    {
      name: 'Rekha Devi',
      father: 'Satish Kumar',
      gender: 'female',
      skill: 'Helper',
      registered: 19,
    },
    {
      name: 'Suresh Pal',
      father: 'Babu Lal Pal',
      gender: 'male',
      skill: 'Helper',
      registered: 19,
      leftDaysAgo: 8,
      leftReason: 'Left for a brick kiln job near his village',
    },
    {
      name: 'Munni Devi Meena',
      father: 'Kishan Lal Meena',
      gender: 'female',
      skill: 'Helper',
      registered: 15,
    },
    {
      name: 'Raju Prajapati',
      father: 'Mool Chand Prajapati',
      gender: 'male',
      skill: 'Carpenter',
      registered: 15,
      contractor: true,
    },
    {
      name: 'Guddi Devi',
      father: 'Harpal Singh',
      gender: 'female',
      skill: 'Helper',
      registered: 13,
    },
    {
      name: 'Sonu Kashyap',
      father: 'Rajendra Kashyap',
      gender: 'male',
      skill: 'Helper',
      registered: 8,
    },
    {
      name: 'Vinod Nishad',
      father: 'Kallu Nishad',
      gender: 'male',
      skill: 'Helper',
      registered: 0,
      noFace: true,
    },
  ],
};

const GANG_KINDS = [
  'Earthwork',
  'GSB & WMM',
  'Culvert & Masonry',
  'Shoulder & Drain',
];
const OM_GANG_KINDS = ['Pothole Patching', 'Road Furniture & Drain'];

const PHOTO_NOTES = [
  'Morning toolbox talk before starting work',
  'Gang at the chainage before GSB spreading',
  'Safety briefing — helmets and reflective jackets',
  'Evening group photo after the day’s stretch',
  'Culvert work face, mate and helpers',
];

const ADVANCES = [
  {
    amount: 3000,
    reason: 'Medical treatment for his daughter',
    instalments: 3,
    status: 'disbursed' as const,
    raised: 16,
  },
  {
    amount: 10000,
    reason: 'Sister’s wedding in the village',
    instalments: 8,
    status: 'disbursed' as const,
    raised: 37,
  },
  {
    amount: 2000,
    reason: 'School fees for two children',
    instalments: 2,
    status: 'approved' as const,
    raised: 5,
  },
  {
    amount: 4500,
    reason: 'Roof repair after the monsoon',
    instalments: 3,
    status: 'pending' as const,
    raised: 2,
  },
  {
    amount: 1500,
    reason: 'Travel home for Dussehra',
    instalments: 1,
    status: 'pending' as const,
    raised: 1,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** `labour.advanceLimitMultiple`'s default: above 15 days' wages an advance needs approval. */
const ADVANCE_LIMIT_MULTIPLE = 15;
const iso = (day: Date) => day.toISOString().slice(0, 10);
const addDays = (day: Date, n: number) => new Date(day.getTime() + n * DAY_MS);
const addMin = (t: Date, n: number) => new Date(t.getTime() + n * 60_000);

/** Metres → degrees of latitude/longitude near the site, for jittering a fix. */
function offset(lat: number, lng: number, metres: number, bearing: number) {
  const dLat = (metres * Math.cos(bearing)) / 111_320;
  const dLng =
    (metres * Math.sin(bearing)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const R = 6_371_008.8;
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.sin(rad(b.lng - a.lng) / 2) ** 2 *
      Math.cos(rad(a.lat)) *
      Math.cos(rad(b.lat));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** A face descriptor as `BiometricsService.serializeDescriptor` stores it: 128 float32s. */
function faceTemplate(rand: () => number): Buffer {
  const v = new Float32Array(128);
  for (let i = 0; i < v.length; i++) v[i] = round((rand() - 0.5) * 0.4, 5);
  return Buffer.from(v.buffer);
}

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A small JPEG standing in for a supervisor's group photo: a road camp at a given hour. */
async function sitePhoto(
  caption: string,
  stamp: string,
  rand: () => number,
): Promise<Buffer> {
  const figures = Array.from({ length: 6 + Math.floor(rand() * 5) }, (_, i) => {
    const x = 150 + i * 55 + Math.floor(rand() * 20);
    const vest = rand() < 0.5 ? '#f97316' : '#facc15';
    return (
      `<circle cx="${x}" cy="318" r="11" fill="#7c4a2d"/>` +
      `<rect x="${
        x - 13
      }" y="330" width="26" height="46" rx="6" fill="${vest}"/>` +
      `<rect x="${x - 11}" y="376" width="9" height="34" fill="#334155"/>` +
      `<rect x="${x + 2}" y="376" width="9" height="34" fill="#334155"/>` +
      `<path d="M${x - 13} 312 a13 9 0 0 1 26 0 z" fill="#fde047"/>`
    );
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#9cc9ea"/><stop offset="1" stop-color="#e8d9b8"/></linearGradient></defs>
  <rect width="800" height="300" fill="url(#s)"/>
  <rect y="300" width="800" height="300" fill="#c8a97a"/>
  <polygon points="330,300 470,300 760,600 40,600" fill="#5b5b5b"/>
  <polygon points="396,300 404,300 412,600 388,600" fill="#e5e5e5"/>
  <rect x="560" y="250" width="140" height="70" fill="#d97706"/>
  <rect x="580" y="225" width="60" height="35" fill="#b45309"/>
  <circle cx="590" cy="325" r="16" fill="#1f2937"/><circle cx="670" cy="325" r="16" fill="#1f2937"/>
  ${figures}
  <rect y="540" width="800" height="60" fill="rgba(0,0,0,0.55)"/>
  <text x="20" y="566" font-family="Arial, sans-serif" font-size="20" fill="#fff">${escapeXml(
    caption,
  )}</text>
  <text x="20" y="590" font-family="Arial, sans-serif" font-size="15" fill="#e5e7eb">${escapeXml(
    stamp,
  )}</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 72 }).toBuffer();
}

// ─── Types for the punch plan ─────────────────────────────────────────────────

interface WorkerRow {
  id: string;
  labourCode: string;
  fullName: string;
  siteId: string;
  gender: LabourGender | null;
  skillCategoryId: string | null;
  status: WorkerStatus;
  lastWorkingDate: Date | null;
  createdAt: Date;
  faceEnrolmentId: string | null;
  engagementType: EngagementType;
  rateOverride: Prisma.Decimal | null;
}

interface SiteRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius: number;
  weeklyOffDay: number;
}

interface PlannedDay {
  worker: WorkerRow;
  site: SiteRow;
  date: Date;
  in: Date | null;
  out: Date | null;
}

interface PlannedCorrection {
  worker: WorkerRow;
  site: SiteRow;
  date: Date;
  type: LabourPunchType;
  oldAt: Date | null;
  newAt: Date;
  reason: string;
  byUserId: string;
  createdAt: Date;
}

// ─── Module ───────────────────────────────────────────────────────────────────

export async function seedLabour(ctx: CompanyContext): Promise<ModuleResult> {
  const { prisma, company, today, rng } = ctx;
  const companyId = company.id;
  const now = new Date();
  const result: ModuleResult = {};
  const bump = (key: string, n: number) => {
    if (n > 0) result[key] = (result[key] ?? 0) + n;
  };

  const companyRow = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      labourFullDayHours: true,
      labourHalfDayHours: true,
      labourStandardHours: true,
      punchBlockEnforced: true,
    },
  });
  const rules: LabourDayRules = {
    fullDayHours: Number(companyRow.labourFullDayHours),
    halfDayHours: Number(companyRow.labourHalfDayHours),
    standardHours: Number(companyRow.labourStandardHours),
  };

  const allSites = await prisma.site.findMany({
    where: { companyId },
    orderBy: { name: 'asc' },
  });
  const workSites: SiteRow[] = allSites
    .filter((s) => s.projectId && s.status === 'active')
    .map((s) => ({
      id: s.id,
      name: s.name,
      lat: Number(s.latitude),
      lng: Number(s.longitude),
      radius: s.geofenceRadiusMeters,
      weeklyOffDay: s.weeklyOffDay,
    }));
  if (workSites.length === 0) return result;
  const siteById = new Map(workSites.map((s) => [s.id, s]));

  // People: the director signs off, Site Incharges punch, the HR office corrects now and then.
  const users = await prisma.user.findMany({
    where: { companyId, status: 'active' },
    include: { userRoles: { include: { role: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const withRole = (name: string) =>
    users.filter((u) => u.userRoles.some((r) => r.role.name === name));
  const director = withRole('Super Admin')[0] ?? users[0];
  const office = withRole('Head Office')[0] ?? director;
  const incharges = withRole('Site Incharge');
  if (!director) return result;

  // Site → supervisors, from the named plan, then any unassigned camp to an incharge in turn.
  const assignments = new Map<string, string[]>(); // userId → siteIds
  for (const plan of SUPERVISORS[company.shortCode] ?? []) {
    const user = incharges.find((u) => u.username === plan.username);
    if (!user) continue;
    const ids = workSites
      .filter((s) => plan.sites.some((frag) => s.name.includes(frag)))
      .map((s) => s.id);
    if (ids.length) assignments.set(user.id, ids);
  }
  workSites.forEach((s, i) => {
    const covered = [...assignments.values()].some((ids) => ids.includes(s.id));
    if (covered || incharges.length === 0) return;
    const user = incharges[i % incharges.length];
    assignments.set(user.id, [...(assignments.get(user.id) ?? []), s.id]);
  });
  const primarySupervisor = new Map<string, string>();
  for (const s of workSites) {
    const candidates = [...assignments.entries()]
      .filter(([, ids]) => ids.includes(s.id))
      .sort((a, b) => a[1].length - b[1].length);
    primarySupervisor.set(s.id, candidates[0]?.[0] ?? director.id);
  }

  // ── Supervisor sites ──────────────────────────────────────────────────────
  if ((await prisma.supervisorSite.count({ where: { companyId } })) === 0) {
    const rows = [...assignments.entries()].flatMap(([userId, ids]) =>
      ids.map((siteId) => ({
        companyId,
        userId,
        siteId,
        createdBy: director.id,
        createdAt: at(d('2026-08-24'), 11, 15),
      })),
    );
    const { count } = await prisma.supervisorSite.createMany({
      data: rows,
      skipDuplicates: true,
    });
    bump('supervisorSites', count);
  }

  // ── Site wage rates: male and female per camp, revised on 1 October ───────
  if ((await prisma.siteWageRate.count({ where: { companyId } })) === 0) {
    const rows: Prisma.SiteWageRateCreateManyInput[] = [];
    for (const s of workSites) {
      const r = siteRates(s.name);
      for (const gender of ['male', 'female'] as const) {
        rows.push({
          companyId,
          siteId: s.id,
          gender,
          dailyRate: money(r.old[gender]),
          effectiveFrom: d('2026-04-01'),
          effectiveTo: d('2026-09-30'),
          createdBy: director.id,
          createdAt: at(d('2026-03-27'), 12, 30),
        });
        rows.push({
          companyId,
          siteId: s.id,
          gender,
          dailyRate: money(r.cur[gender]),
          effectiveFrom: d('2026-10-01'),
          effectiveTo: null,
          createdBy: director.id,
          createdAt: at(d('2026-09-26'), 16, 5),
        });
      }
    }
    bump(
      'siteWageRates',
      (await prisma.siteWageRate.createMany({ data: rows })).count,
    );
  }

  // ── Workforce tidy-up ─────────────────────────────────────────────────────
  const skills = await prisma.skillCategory.findMany({ where: { companyId } });
  const skillId = new Map(skills.map((s) => [s.name, s.id]));
  const skillName = new Map(skills.map((s) => [s.id, s.name]));
  const contractor = await prisma.vendor.findFirst({
    where: { companyId, type: 'labour_contractor' },
    orderBy: { createdAt: 'asc' },
  });

  let fixed = 0;
  const existing = await prisma.labourWorker.findMany({
    where: { companyId, deletedAt: null },
    orderBy: { labourCode: 'asc' },
  });
  for (const [i, w] of existing.entries()) {
    const data: Prisma.LabourWorkerUpdateInput = {};
    // Contractor labour must name its contractor (013 FR-008); the base seed left it blank.
    if (w.engagementType === 'contractor' && !w.contractorId && contractor) {
      data.contractorId = contractor.id;
    }
    // Labour does not work at the head office: move it to a camp, round the camps.
    if (!siteById.has(w.siteId)) {
      data.siteId = workSites[i % workSites.length].id;
    }
    const override = w.skillCategoryId
      ? SKILL_OVERRIDE[skillName.get(w.skillCategoryId) ?? '']
      : undefined;
    if (override && w.rateOverride === null)
      data.rateOverride = money(override);
    // Registered when the season began, not the day the database was built (base-seed rows).
    if (!w.createdBy && w.createdAt > d('2026-08-31')) {
      data.createdAt = at(addDays(d('2026-04-06'), (i % 9) * 7), 10, 0);
    }
    if (Object.keys(data).length) {
      await prisma.labourWorker.update({ where: { id: w.id }, data });
      fixed++;
    }
  }
  bump('workersTidied', fixed);

  // ── More workers for the post-monsoon push ────────────────────────────────
  const prefix =
    existing[0]?.labourCode.replace(/\d+$/, '') ?? `${company.shortCode}-W`;
  const highest = Math.max(
    2000,
    ...existing.map((w) => Number(w.labourCode.replace(/\D/g, '')) || 0),
  );
  const known = new Set(existing.map((w) => w.fullName));
  let next = highest;
  let added = 0;
  for (const [i, spec] of (
    NEW_WORKERS[company.shortCode] ?? NEW_WORKERS.PRPL
  ).entries()) {
    if (known.has(spec.name)) continue;
    next++;
    const site = workSites[(i + 1) % workSites.length];
    const registered = new Date(
      at(addDays(today, -spec.registered), 9, 0).getTime() +
        (i % 5) * 1_380_000,
    );
    const left =
      spec.leftDaysAgo !== undefined ? addDays(today, -spec.leftDaysAgo) : null;
    await prisma.labourWorker.create({
      data: {
        companyId,
        labourCode: `${prefix}${next}`,
        fullName: spec.name,
        fatherName: spec.father,
        phone: `${rng.pick(['6', '7', '8', '9'])}${String(
          rng.int(100000000, 999999999),
        )}`,
        gender: spec.gender,
        dateOfBirth: d(
          `${rng.int(1978, 2004)}-${String(rng.int(1, 12)).padStart(
            2,
            '0',
          )}-${String(rng.int(1, 28)).padStart(2, '0')}`,
        ),
        aadhaarNumber: spec.noFace
          ? null
          : `${rng.int(2, 9)}${String(rng.int(0, 99999999999)).padStart(
              11,
              '0',
            )}`,
        bankAccount:
          i % 3 === 0
            ? null
            : `${rng.int(30, 39)}${rng.int(10000000, 99999999)}${rng.int(
                100,
                999,
              )}`,
        skillCategoryId: skillId.get(spec.skill) ?? null,
        engagementType: spec.contractor && contractor ? 'contractor' : 'direct',
        contractorId: spec.contractor && contractor ? contractor.id : null,
        siteId: site.id,
        rateOverride: SKILL_OVERRIDE[spec.skill]
          ? money(SKILL_OVERRIDE[spec.skill])
          : null,
        status: left ? 'inactive' : 'active',
        lastWorkingDate: left ? addDays(left, -1) : null,
        deactivationReason: left ? spec.leftReason : null,
        createdAt: registered,
        createdBy: primarySupervisor.get(site.id) ?? director.id,
      },
    });
    added++;
  }
  bump('workersAdded', added);

  // The counter the app issues the next code from, past every code already issued (031).
  const allWorkers: WorkerRow[] = await prisma.labourWorker.findMany({
    where: { companyId, deletedAt: null },
    orderBy: { labourCode: 'asc' },
  });
  const maxCode = Math.max(
    0,
    ...allWorkers.map((w) => Number(w.labourCode.replace(/\D/g, '')) || 0),
  );
  const seq = await prisma.labourCodeSequence.findUnique({
    where: { companyId },
  });
  if (!seq || seq.lastNumber < maxCode) {
    await prisma.labourCodeSequence.upsert({
      where: { companyId },
      create: { companyId, lastNumber: maxCode },
      update: { lastNumber: maxCode },
    });
    bump('labourCodeSequence', 1);
  }

  // Face templates: every worker who punches was enrolled with 3–5 photos at registration.
  const newNames = new Set(
    (NEW_WORKERS[company.shortCode] ?? [])
      .filter((s) => s.noFace)
      .map((s) => s.name),
  );
  let faces = 0;
  for (const w of allWorkers) {
    if (w.faceEnrolmentId || newNames.has(w.fullName)) continue;
    const ref = await ctx.writeBlob('labour-face', faceTemplate(rng.rand));
    await prisma.labourWorker.update({
      where: { id: w.id },
      data: { faceEnrolmentId: ref },
    });
    w.faceEnrolmentId = ref;
    faces++;
  }
  bump('faceTemplates', faces);

  // ── Gangs under a mate ───────────────────────────────────────────────────
  if ((await prisma.labourGang.count({ where: { companyId } })) === 0) {
    let gangs = 0;
    let members = 0;
    for (const s of workSites) {
      const here = allWorkers.filter(
        (w) => w.siteId === s.id && w.status === 'active' && w.faceEnrolmentId,
      );
      const kinds = /O&M/.test(s.name) ? OM_GANG_KINDS : GANG_KINDS;
      const skilledFirst = [...here].sort((a, b) => {
        const rank = (w: WorkerRow) =>
          w.gender === 'male' &&
          skillName.get(w.skillCategoryId ?? '') === 'Mason'
            ? 0
            : w.gender === 'male'
            ? 1
            : 2;
        return rank(a) - rank(b) || a.labourCode.localeCompare(b.labourCode);
      });
      const groups: WorkerRow[][] = [];
      if (skilledFirst.length >= 7) {
        const half = Math.ceil(skilledFirst.length / 2);
        const leaders = skilledFirst.slice(0, 2);
        const rest = skilledFirst.slice(2);
        groups.push(
          [leaders[0], ...rest.filter((_, i) => i % 2 === 0)].slice(0, half),
        );
        groups.push([leaders[1], ...rest.filter((_, i) => i % 2 === 1)]);
      } else if (skilledFirst.length >= 3) {
        groups.push(
          skilledFirst.slice(0, Math.max(3, skilledFirst.length - 1)),
        );
      }
      for (const [gi, group] of groups.entries()) {
        const leader = group[0];
        await prisma.labourGang.create({
          data: {
            companyId,
            name: `${kinds[gi % kinds.length]} — ${
              leader.fullName.split(' ')[0]
            } Mate`,
            gangLeaderWorkerId: leader.id,
            siteId: s.id,
            createdBy: primarySupervisor.get(s.id) ?? director.id,
            createdAt: at(addDays(today, -18 + gi), 10, 20),
            members: {
              create: group.map((w) => ({
                companyId,
                workerId: w.id,
                isActive: true,
                createdAt: at(addDays(today, -18 + gi), 10, 20),
              })),
            },
          },
        });
        gangs++;
        members += group.length;
      }
    }
    bump('gangs', gangs);
    bump('gangMembers', members);
  }

  // ── Punches, corrections and the musters derived from them ───────────────
  const punchCount = await prisma.labourPunch.count({ where: { companyId } });
  const sheetWorkers = new Set<string>();
  const septSheet = await prisma.labourPaymentSheet.findFirst({
    where: {
      companyId,
      deletedAt: null,
      periodFrom: d('2026-09-01'),
      periodTo: d('2026-09-30'),
    },
    include: { lines: { select: { workerId: true, daysWorked: true } } },
  });
  for (const l of septSheet?.lines ?? []) sheetWorkers.add(l.workerId);
  const septDays = Math.round(Number(septSheet?.lines[0]?.daysWorked ?? 24));

  if (punchCount === 0) {
    const start = d('2026-09-01');
    const plan: PlannedDay[] = [];
    const holidays = new Set(['2026-10-02']); // Gandhi Jayanti
    const septWorking: Date[] = [];
    for (let t = start; t <= d('2026-09-30'); t = addDays(t, 1)) {
      if (t.getUTCDay() !== 0) septWorking.push(t);
    }

    for (const w of allWorkers) {
      if (!w.faceEnrolmentId) continue;
      const site = siteById.get(w.siteId);
      if (!site) continue;
      // Workers on the September sheet worked exactly the days it pays; a pre-031 project sheet
      // covers every site, so nobody else was on site in September.
      const onSept = sheetWorkers.has(w.id);
      const septOff = new Set<string>();
      if (onSept) {
        const pool = [...septWorking];
        while (septOff.size < Math.max(0, pool.length - septDays)) {
          septOff.add(iso(pool[rng.int(0, pool.length - 1)]));
        }
      }
      const firstDay = onSept
        ? start
        : (() => {
            const reg = new Date(
              Date.UTC(
                w.createdAt.getUTCFullYear(),
                w.createdAt.getUTCMonth(),
                w.createdAt.getUTCDate(),
              ),
            );
            return reg < d('2026-10-01') ? d('2026-10-01') : reg;
          })();
      for (let day = firstDay; day <= today; day = addDays(day, 1)) {
        const key = iso(day);
        if (w.lastWorkingDate && day > w.lastWorkingDate) break;
        const sept = key < '2026-10-01';
        if (sept && !onSept) continue;
        const weeklyOff = day.getUTCDay() === site.weeklyOffDay;
        if (holidays.has(key)) continue;
        // One Sunday in October the first camp worked a half shift to finish a stretch before rain.
        const sundayPush =
          weeklyOff &&
          !sept &&
          key === iso(addDays(today, -15)) &&
          site.id === workSites[0].id &&
          rng.rand() < 0.6;
        if (weeklyOff && !sundayPush) continue;
        if (sept && septOff.has(key)) continue;

        const inAt = sundayPush
          ? at(day, 8, rng.int(0, 25))
          : at(day, 7, 30 + rng.int(0, 50));
        let kind: 'full' | 'half' | 'short' | 'absent' = 'full';
        if (sundayPush) kind = 'half';
        else if (!sept) {
          const r = rng.rand();
          kind =
            r < 0.06
              ? 'absent'
              : r < 0.1
              ? 'half'
              : r < 0.112
              ? 'short'
              : 'full';
        }
        if (kind === 'absent') continue;
        let outAt: Date;
        if (kind === 'full') {
          // September's sheet paid no overtime, so its days end on the shift; October has the
          // odd long day finishing a stretch.
          const long = !sept && rng.rand() < 0.12;
          outAt = addMin(
            inAt,
            long
              ? rng.int(565, 610)
              : sept
              ? rng.int(480, 484)
              : rng.int(481, 510),
          );
        } else if (kind === 'half') {
          outAt = addMin(inAt, rng.int(255, 330));
        } else {
          outAt = addMin(inAt, rng.int(120, 200));
        }
        plan.push({
          worker: w,
          site,
          date: day,
          in: inAt <= now ? inAt : null,
          out: outAt <= now ? outAt : null,
        });
      }
    }

    // October noise: corrected punches, and two missing punch-outs still open.
    const corrections: PlannedCorrection[] = [];
    const facePunchAt = new Map<string, Date>(); // original face time of a re-timed punch
    const sourceOf = new Map<string, LabourPunchSource>();
    const keyOf = (p: PlannedDay, t: LabourPunchType) =>
      `${p.worker.id}|${iso(p.date)}|${t}`;
    const octFull = (from: number, to: number) =>
      plan.filter((p) => {
        const age = Math.round((today.getTime() - p.date.getTime()) / DAY_MS);
        return (
          iso(p.date) >= '2026-10-01' &&
          age >= from &&
          age <= to &&
          p.in &&
          p.out &&
          p.out.getTime() - p.in.getTime() >= rules.fullDayHours * 3_600_000
        );
      });
    const used = new Set<PlannedDay>();
    const take = (pool: PlannedDay[]) => {
      const free = pool.filter((p) => !used.has(p));
      if (!free.length) return null;
      const p = free[rng.int(0, free.length - 1)];
      used.add(p);
      return p;
    };
    const nextMorning = (p: PlannedDay) =>
      at(addDays(p.date, p.date.getUTCDay() === 6 ? 2 : 1), 9, rng.int(5, 50));
    const supervisorOf = (p: PlannedDay) =>
      primarySupervisor.get(p.site.id) ?? director.id;

    // Phone battery died at the end of the day: punch-out added next morning.
    for (const reason of [
      'Supervisor’s phone battery died before the evening punch-out; worked till close',
      'Network down at the camp in the evening; punch-out could not be taken',
    ]) {
      const p = take(octFull(5, 16));
      if (!p) continue;
      sourceOf.set(keyOf(p, LabourPunchType.out), LabourPunchSource.correction);
      corrections.push({
        worker: p.worker,
        site: p.site,
        date: p.date,
        type: LabourPunchType.out,
        oldAt: null,
        newAt: p.out,
        reason,
        byUserId: supervisorOf(p),
        createdAt: nextMorning(p),
      });
    }
    // Arrived while the supervisor was at the other chainage: punch-in added by the HR office.
    {
      const p = take(octFull(4, 12));
      if (p) {
        p.in = at(p.date, 7, 45);
        if (p.out < addMin(p.in, 490)) p.out = addMin(p.in, 490);
        sourceOf.set(
          keyOf(p, LabourPunchType.in),
          LabourPunchSource.correction,
        );
        corrections.push({
          worker: p.worker,
          site: p.site,
          date: p.date,
          type: LabourPunchType.in,
          oldAt: null,
          newAt: p.in,
          reason:
            'Reached the culvert site directly at 7:45; the supervisor was at the far end of the stretch and confirmed it by phone',
          byUserId: office.id,
          createdAt: nextMorning(p),
        });
      }
    }
    // Punched out by mistake at lunch instead of another worker: time corrected the same evening.
    {
      const p = take(octFull(3, 14));
      if (p) {
        const wrong = at(p.date, 12, rng.int(55, 59));
        facePunchAt.set(keyOf(p, LabourPunchType.out), wrong);
        corrections.push({
          worker: p.worker,
          site: p.site,
          date: p.date,
          type: LabourPunchType.out,
          oldAt: wrong,
          newAt: p.out,
          reason:
            'Punched out by mistake at lunch in place of another labour; actually left at day end',
          byUserId: supervisorOf(p),
          createdAt: addMin(p.out, rng.int(10, 40)),
        });
      }
    }
    // Still open: punch-out missing, waiting for the supervisor to correct it.
    for (const range of [
      [2, 4],
      [1, 2],
    ]) {
      const p = take(octFull(range[0], range[1]));
      if (p) p.out = null;
    }

    // Write the punches.
    const punchRows: Prisma.LabourPunchCreateManyInput[] = [];
    const outsideFence = new Set<PlannedDay>(
      plan
        .filter((p) => iso(p.date) >= '2026-10-01' && !used.has(p))
        .filter(() => rng.rand() < 0.004),
    );
    const correctedAt = new Map(
      corrections.map((c) => [
        `${c.worker.id}|${iso(c.date)}|${c.type}`,
        c.createdAt,
      ]),
    );
    const correctedBy = new Map(
      corrections.map((c) => [
        `${c.worker.id}|${iso(c.date)}|${c.type}`,
        c.byUserId,
      ]),
    );
    const fenceFlags = new Map<string, boolean>();
    for (const p of plan) {
      for (const type of [LabourPunchType.in, LabourPunchType.out]) {
        const t = type === LabourPunchType.in ? p.in : p.out;
        if (!t) continue;
        const key = keyOf(p, type);
        const source = sourceOf.get(key) ?? LabourPunchSource.face;
        const base = {
          companyId,
          workerId: p.worker.id,
          siteId: p.site.id,
          punchDate: p.date,
          type,
          punchedAt: t,
          createdAt: facePunchAt.get(key) ?? t,
          correctedAt: correctedAt.get(key) ?? null,
        };
        if (source === LabourPunchSource.correction) {
          punchRows.push({
            ...base,
            createdAt: correctedAt.get(key) ?? t,
            supervisorId: correctedBy.get(key) ?? supervisorOf(p),
            source,
          });
          continue;
        }
        const far = outsideFence.has(p) && type === LabourPunchType.in;
        const accuracy = rng.int(4, 22);
        const fix = offset(
          p.site.lat,
          p.site.lng,
          far
            ? p.site.radius + rng.int(120, 320)
            : rng.int(15, Math.min(380, p.site.radius - 60)),
          rng.rand() * 2 * Math.PI,
        );
        const distance = haversine(fix, { lat: p.site.lat, lng: p.site.lng });
        const violation = distance > p.site.radius + accuracy;
        if (violation) fenceFlags.set(`${p.site.id}|${iso(p.date)}`, true);
        punchRows.push({
          ...base,
          supervisorId: supervisorOf(p),
          source,
          faceMatchDistance: money(round(0.24 + rng.rand() * 0.2, 4)),
          latitude: new Prisma.Decimal(fix.lat.toFixed(7)),
          longitude: new Prisma.Decimal(fix.lng.toFixed(7)),
          accuracyMetres: money(accuracy),
          geofenceDistanceMetres: money(round(distance, 2)),
          geofenceViolation: violation,
        });
      }
    }
    for (let i = 0; i < punchRows.length; i += 1000) {
      await prisma.labourPunch.createMany({
        data: punchRows.slice(i, i + 1000),
      });
    }
    bump('punches', punchRows.length);

    if (corrections.length) {
      await prisma.labourPunchCorrection.createMany({
        data: corrections.map((c) => ({
          companyId,
          workerId: c.worker.id,
          siteId: c.site.id,
          punchDate: c.date,
          type: c.type,
          oldPunchedAt: c.oldAt,
          newPunchedAt: c.newAt,
          reason: c.reason,
          correctedById: c.byUserId,
          createdAt: c.createdAt,
        })),
      });
      bump('punchCorrections', corrections.length);
    }

    // One approved face-punch roll per site and day, its lines counted as `LabourDayService`
    // counts them: full, half or short (marked absent) once both punches are in order.
    const bySiteDay = new Map<string, PlannedDay[]>();
    for (const p of plan) {
      if (!p.in && !p.out) continue;
      const key = `${p.site.id}|${iso(p.date)}`;
      bySiteDay.set(key, [...(bySiteDay.get(key) ?? []), p]);
    }
    const firstFix = new Map<string, Prisma.LabourPunchCreateManyInput>();
    for (const r of punchRows) {
      if (r.source !== LabourPunchSource.face) continue;
      const key = `${r.siteId}|${iso(r.punchDate as Date)}`;
      const cur = firstFix.get(key);
      if (!cur || (r.punchedAt as Date) < (cur.punchedAt as Date)) {
        firstFix.set(key, r);
      }
    }
    const faceScore = new Map(
      punchRows
        .filter((r) => r.type === LabourPunchType.in && r.faceMatchDistance)
        .map((r) => [
          `${r.workerId}|${iso(r.punchDate as Date)}`,
          r.faceMatchDistance,
        ]),
    );
    let rolls = 0;
    const lineRows: Prisma.MusterLineCreateManyInput[] = [];
    for (const [key, days] of bySiteDay) {
      const [siteId, date] = key.split('|');
      const site = siteById.get(siteId);
      const fix = firstFix.get(key);
      const capturedAt =
        (fix?.punchedAt as Date) ??
        days[0].in ??
        days[0].out ??
        at(d(date), 8, 0);
      const roll = await prisma.musterRoll.create({
        data: {
          companyId,
          siteId,
          date: d(date),
          supervisorId:
            (fix?.supervisorId as string) ?? primarySupervisor.get(siteId),
          latitude:
            (fix?.latitude as Prisma.Decimal) ?? new Prisma.Decimal(site.lat),
          longitude:
            (fix?.longitude as Prisma.Decimal) ?? new Prisma.Decimal(site.lng),
          accuracyMetres: (fix?.accuracyMetres as Prisma.Decimal) ?? money(0),
          geofenceViolation: fenceFlags.get(key) ?? false,
          source: MusterSource.face_punch,
          capturedAt,
          receivedAt: capturedAt,
          status: MusterStatus.approved,
          approvedAt: capturedAt,
          createdBy:
            (fix?.supervisorId as string) ?? primarySupervisor.get(siteId),
          createdAt: capturedAt,
        },
      });
      rolls++;
      for (const p of days) {
        const day = deriveLabourDay(p.in, p.out, date < iso(today), rules);
        const line = musterLineFor(day);
        if (!line) continue;
        lineRows.push({
          companyId,
          musterId: roll.id,
          workerId: p.worker.id,
          attendanceType: line.attendanceType,
          overtimeHours:
            line.overtimeHours !== null ? money(line.overtimeHours) : null,
          photoRef: null,
          faceMatchScore:
            (faceScore.get(`${p.worker.id}|${date}`) as Prisma.Decimal) ?? null,
          skillCategoryIdOnDay: p.worker.skillCategoryId,
          createdAt: p.out ?? capturedAt,
        });
      }
    }
    for (let i = 0; i < lineRows.length; i += 1000) {
      await prisma.musterLine.createMany({ data: lineRows.slice(i, i + 1000) });
    }
    bump('musterRolls', rolls);
    bump('musterLines', lineRows.length);
  }

  // ── Refused punches: a face that did not match in poor light, and so on ──
  if ((await prisma.labourPunchRefusal.count({ where: { companyId } })) === 0) {
    const reasons: LabourPunchRefusalReason[] = companyRow.punchBlockEnforced
      ? [
          'face_mismatch',
          'no_face_detected',
          'outside_geofence',
          'face_mismatch',
        ]
      : [
          'face_mismatch',
          'no_face_detected',
          'face_mismatch',
          'no_face_detected',
        ];
    const active = allWorkers.filter(
      (w) => w.status === 'active' && w.faceEnrolmentId,
    );
    const rows: Prisma.LabourPunchRefusalCreateManyInput[] = [];
    for (const [i, reason] of reasons.entries()) {
      const w = active[(i * 5 + 3) % active.length];
      const site = siteById.get(w.siteId);
      if (!site) continue;
      // On a day the worker did punch, a minute or two before the accepted punch-in.
      const punch = await prisma.labourPunch.findFirst({
        where: {
          workerId: w.id,
          type: 'in',
          source: 'face',
          punchDate: { gte: new Date(today.getTime() - 6 * DAY_MS), lt: today },
        },
        orderBy: { punchDate: 'desc' },
      });
      const when = punch
        ? addMin(punch.punchedAt, -rng.int(1, 4))
        : at(addDays(today, -i - 1), 7, 41);
      const far = reason === 'outside_geofence';
      const fix = offset(
        site.lat,
        site.lng,
        far ? site.radius + rng.int(250, 900) : rng.int(20, 300),
        rng.rand() * 2 * Math.PI,
      );
      rows.push({
        companyId,
        workerId: w.id,
        siteId: site.id,
        type: 'in',
        reason,
        supervisorId: primarySupervisor.get(site.id) ?? director.id,
        latitude: new Prisma.Decimal(fix.lat.toFixed(7)),
        longitude: new Prisma.Decimal(fix.lng.toFixed(7)),
        accuracyMetres: money(rng.int(5, 25)),
        distanceMetres: money(
          round(haversine(fix, { lat: site.lat, lng: site.lng }), 2),
        ),
        faceMatchDistance:
          reason === 'face_mismatch'
            ? money(round(0.62 + rng.rand() * 0.15, 4))
            : null,
        createdAt: when,
      });
    }
    bump(
      'punchRefusals',
      (await prisma.labourPunchRefusal.createMany({ data: rows })).count,
    );
  }

  // ── Group photos the supervisors keep for reference (not attendance) ─────
  if ((await prisma.labourSitePhoto.count({ where: { companyId } })) === 0) {
    let photos = 0;
    for (const s of workSites) {
      for (const ago of [12, 8, 5, 2]) {
        const day = addDays(
          today,
          -ago - (s.weeklyOffDay === addDays(today, -ago).getUTCDay() ? 1 : 0),
        );
        const when = at(day, 8, rng.int(5, 40));
        const note = PHOTO_NOTES[(ago + s.name.length) % PHOTO_NOTES.length];
        const wall = new Date(when.getTime() + 330 * 60_000);
        const hhmm = wall.toISOString().slice(11, 16);
        const image = await sitePhoto(
          s.name,
          `${iso(day)} ${hhmm} IST · ${note}`,
          rng.rand,
        );
        const fix = offset(
          s.lat,
          s.lng,
          rng.int(20, 250),
          rng.rand() * 2 * Math.PI,
        );
        await prisma.labourSitePhoto.create({
          data: {
            companyId,
            siteId: s.id,
            photoDate: day,
            photoRef: await ctx.writeBlob('labour-site-photo', image),
            note,
            latitude: new Prisma.Decimal(fix.lat.toFixed(7)),
            longitude: new Prisma.Decimal(fix.lng.toFixed(7)),
            takenById: primarySupervisor.get(s.id) ?? director.id,
            createdAt: when,
          },
        });
        photos++;
      }
    }
    bump('sitePhotos', photos);
  }

  // ── Advances against future wages ────────────────────────────────────────
  if ((await prisma.labourAdvance.count({ where: { companyId } })) === 0) {
    const candidates = allWorkers.filter(
      (w) =>
        w.status === 'active' &&
        w.faceEnrolmentId &&
        w.engagementType === 'direct',
    );
    const rateOf = (w: WorkerRow) =>
      w.rateOverride
        ? Number(w.rateOverride)
        : siteRates(siteById.get(w.siteId)?.name ?? '').cur[w.gender ?? 'male'];
    let count = 0;
    for (const [i, a] of ADVANCES.entries()) {
      const w = candidates[(i * 4 + 1) % candidates.length];
      if (!w) continue;
      const raisedOn = addDays(today, -a.raised);
      const raisedAt = at(raisedOn, 17, rng.int(10, 50));
      // Recovery from the first weekly period (Monday) after it is paid out.
      const monday = addDays(raisedOn, (8 - raisedOn.getUTCDay()) % 7 || 7);
      const disbursed = a.status === 'disbursed';
      const approved = a.status !== 'pending';
      await prisma.labourAdvance.create({
        data: {
          companyId,
          workerId: w.id,
          amount: money(a.amount),
          reason: a.reason,
          recoveryInstalments: a.instalments,
          instalmentAmount: money(
            Math.round((a.amount / a.instalments) * 100) / 100,
          ),
          recoveryStartPeriod:
            monday < d('2026-10-05') ? d('2026-10-05') : monday,
          outstandingBalance: money(disbursed ? a.amount : 0),
          exceedsLimit: a.amount > rateOf(w) * ADVANCE_LIMIT_MULTIPLE,
          status: a.status as AdvanceStatus,
          approvedBy: approved ? director.id : null,
          approvedAt: approved
            ? addMin(raisedAt, 60 * 15 + rng.int(0, 90))
            : null,
          disbursedOn: disbursed ? addDays(raisedOn, 1) : null,
          createdBy: primarySupervisor.get(w.siteId) ?? office.id,
          createdAt: raisedAt,
        },
      });
      count++;
    }
    bump('advances', count);
  }

  return result;
}
