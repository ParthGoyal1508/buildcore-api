/**
 * Projects completion: the site's daily work, the bills built from it, and the money around them.
 *
 * What the base seed leaves empty and this fills, per company:
 * - A BOQ for every project that has none (the base seed priced only the first project), sized to
 *   the contract value so the BOQ total and the contract agree.
 * - Daily work reports for every project with a live site, measured against the BOQ with real
 *   dimensions, numbered as `DwrService` numbers them, approved the way the approval moves
 *   `doneQty` — so the reconciliation screen reads zero drift and every bill quantity is covered by
 *   approved measurement before its billing date.
 * - Two subcontractors and three more work orders, coded from the WORK_ORDER series.
 * - Bill packages to the client and to subcontractors, driven through the app's own
 *   `BillPackageService` (compose → claim → adjust → issue → certify) and `DebitNoteService`, so
 *   every frozen figure is the one the app computes; only the timestamps are moved back afterwards.
 * - Payments against certified subcontractor bills, signed copies, client receipts (`Revenue`),
 *   project budgets, and scanned copies on the bank guarantees.
 *
 * `StagedProjectDocument` is deliberately left empty: a row there is an upload waiting for a
 * project that has not been created yet, which is a transient state of the create-project form
 * and never where a settled company's data rests.
 */
import { randomUUID } from 'crypto';

import {
  BillDeductionSection,
  BillDirection,
  BillPackageStatus,
  BillTaxBasis,
  CodeSeriesType,
  DwrStatus,
  DwrWeather,
  PaymentInstrument,
  Prisma,
  ProjectBudgetCategory,
  SignedCopySubject,
  WorkOrderStatus,
} from '@prisma/client';
import type { PrismaService } from 'nestjs-prisma';

import { CompaniesService } from '../../src/settings/companies/companies.service';
import { CodeSeriesService } from '../../src/settings/code-series/code-series.service';
import { VendorIdentitySource } from '../../src/partners/vendors/vendor-identity.source';
import { ProjectSourcesRegistry } from '../../src/projects/portfolio/project-sources.registry';
import { DwrPeriodFiguresService } from '../../src/projects/dwr/dwr-period-figures.service';
import { computeMeasuredQty } from '../../src/projects/dwr/dwr-quantity';
import { BillPackageService } from '../../src/projects/billing/package/bill-package.service';
import type { BillPackageView } from '../../src/projects/billing/package/bill-package.service';
import { DebitNoteService } from '../../src/projects/billing/package/debit-note.service';
import { money as round2 } from '../../src/projects/billing/bill-totals';

import { at, d } from './support';
import type { CompanyContext, ModuleResult, Rng } from './support';

const dec = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);
const iso = (t: Date) => t.toISOString().slice(0, 10);
const addDays = (t: Date, n: number) => {
  const c = new Date(t);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
};
const inr = (n: number | Prisma.Decimal) =>
  Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ─── Reference data ────────────────────────────────────────────────────────────

interface BoqLine {
  boqNo: string;
  taskName: string;
  unit: string;
  scopeQty: number;
  rate: number;
}
interface BoqGroup {
  boqNo: string;
  name: string;
  items: BoqLine[];
}

/** BOQs for the projects the base seed left unpriced. Rates are Rajasthan BSR-like, not round. */
const BOQS: Record<string, BoqGroup[]> = {
  'PRPL-2502': [
    {
      boqNo: '1',
      name: 'Site clearance and earthwork',
      items: [
        {
          boqNo: '1.1',
          taskName:
            'Clearing and grubbing road land including uprooting of shrubs and disposal (MoRTH 201)',
          unit: 'Ha',
          scopeQty: 22.4,
          rate: 38540,
        },
        {
          boqNo: '1.2',
          taskName:
            'Excavation in soil for widening, including loading and disposal within 1 km lead (MoRTH 301)',
          unit: 'Cum',
          scopeQty: 62000,
          rate: 168.4,
        },
        {
          boqNo: '1.3',
          taskName:
            'Construction of embankment with borrow material, compacted to 97% MDD (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 84000,
          rate: 312.75,
        },
        {
          boqNo: '1.4',
          taskName:
            'Construction of subgrade 500 mm thick, CBR not less than 8, compacted to 97% MDD (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 46200,
          rate: 398.6,
        },
      ],
    },
    {
      boqNo: '2',
      name: 'Granular sub-base and base',
      items: [
        {
          boqNo: '2.1',
          taskName:
            'Granular Sub-Base Grade-III, 200 mm, laid and compacted (MoRTH 401)',
          unit: 'Cum',
          scopeQty: 26880,
          rate: 1684.2,
        },
        {
          boqNo: '2.2',
          taskName:
            'Wet Mix Macadam, 250 mm in two layers, by paver (MoRTH 406)',
          unit: 'Cum',
          scopeQty: 33600,
          rate: 2248.9,
        },
      ],
    },
    {
      boqNo: '3',
      name: 'Bituminous courses',
      items: [
        {
          boqNo: '3.1',
          taskName:
            'Prime coat with SS-1 emulsion @ 0.70 kg/sqm on WMM (MoRTH 502)',
          unit: 'Sqm',
          scopeQty: 196000,
          rate: 38.65,
        },
        {
          boqNo: '3.2',
          taskName: 'Tack coat with RS-1 emulsion @ 0.25 kg/sqm (MoRTH 503)',
          unit: 'Sqm',
          scopeQty: 392000,
          rate: 17.2,
        },
        {
          boqNo: '3.3',
          taskName:
            'Dense Bituminous Macadam Grade-II, 60 mm, with VG-30 (MoRTH 507)',
          unit: 'Cum',
          scopeQty: 11760,
          rate: 9086.4,
        },
        {
          boqNo: '3.4',
          taskName:
            'Bituminous Concrete Grade-II, 40 mm, with VG-40 (MoRTH 509)',
          unit: 'Cum',
          scopeQty: 7840,
          rate: 10132.8,
        },
      ],
    },
    {
      boqNo: '4',
      name: 'Cross drainage and road furniture',
      items: [
        {
          boqNo: '4.1',
          taskName:
            'RCC NP4 pipe culvert, 1200 mm dia, including bedding and headwalls',
          unit: 'Rmt',
          scopeQty: 420,
          rate: 6052.3,
        },
        {
          boqNo: '4.2',
          taskName:
            'Retro-reflective cautionary and mandatory signboards, 900 mm, on MS post',
          unit: 'Each',
          scopeQty: 180,
          rate: 6840,
        },
        {
          boqNo: '4.3',
          taskName:
            'Reinforced cement concrete kilometre stones, painted and lettered',
          unit: 'Each',
          scopeQty: 29,
          rate: 2455.5,
        },
      ],
    },
  ],
  'PRPL-2503': [
    {
      boqNo: '1',
      name: 'Site clearance and earthwork',
      items: [
        {
          boqNo: '1.1',
          taskName:
            'Clearing and grubbing road land including disposal (MoRTH 201)',
          unit: 'Ha',
          scopeQty: 14.4,
          rate: 36820,
        },
        {
          boqNo: '1.2',
          taskName:
            'Dismantling of existing masonry culverts and disposal (MoRTH 202)',
          unit: 'Cum',
          scopeQty: 1240,
          rate: 382.5,
        },
        {
          boqNo: '1.3',
          taskName:
            'Excavation in soil for widening, including disposal within 1 km lead (MoRTH 301)',
          unit: 'Cum',
          scopeQty: 28500,
          rate: 168.4,
        },
        {
          boqNo: '1.4',
          taskName:
            'Construction of embankment with borrow material, compacted to 97% MDD (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 41000,
          rate: 312.75,
        },
        {
          boqNo: '1.5',
          taskName:
            'Construction of subgrade 500 mm thick, CBR not less than 8 (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 21600,
          rate: 398.6,
        },
      ],
    },
    {
      boqNo: '2',
      name: 'Granular sub-base and base',
      items: [
        {
          boqNo: '2.1',
          taskName: 'Granular Sub-Base Grade-III, 200 mm (MoRTH 401)',
          unit: 'Cum',
          scopeQty: 12100,
          rate: 1684.2,
        },
        {
          boqNo: '2.2',
          taskName: 'Wet Mix Macadam, 250 mm in two layers (MoRTH 406)',
          unit: 'Cum',
          scopeQty: 14400,
          rate: 2248.9,
        },
      ],
    },
    {
      boqNo: '3',
      name: 'Bituminous courses',
      items: [
        {
          boqNo: '3.1',
          taskName: 'Prime coat with SS-1 emulsion @ 0.70 kg/sqm (MoRTH 502)',
          unit: 'Sqm',
          scopeQty: 86400,
          rate: 38.65,
        },
        {
          boqNo: '3.2',
          taskName: 'Tack coat with RS-1 emulsion @ 0.25 kg/sqm (MoRTH 503)',
          unit: 'Sqm',
          scopeQty: 172800,
          rate: 17.2,
        },
        {
          boqNo: '3.3',
          taskName:
            'Dense Bituminous Macadam Grade-I, 50 mm, with VG-30 (MoRTH 507)',
          unit: 'Cum',
          scopeQty: 4320,
          rate: 9086.4,
        },
        {
          boqNo: '3.4',
          taskName:
            'Bituminous Concrete Grade-II, 30 mm, with VG-40 (MoRTH 509)',
          unit: 'Cum',
          scopeQty: 2590,
          rate: 10132.8,
        },
      ],
    },
    {
      boqNo: '4',
      name: 'Cross drainage and road furniture',
      items: [
        {
          boqNo: '4.1',
          taskName: 'RCC box culvert 2.0 m × 2.0 m, single cell, M30, complete',
          unit: 'Rmt',
          scopeQty: 96,
          rate: 48520,
        },
        {
          boqNo: '4.2',
          taskName: 'Retro-reflective signboards, 900 mm, on MS post',
          unit: 'Each',
          scopeQty: 64,
          rate: 6840,
        },
      ],
    },
  ],
  'TE-2502': [
    {
      boqNo: '1',
      name: 'Routine maintenance of carriageway and drains',
      items: [
        {
          boqNo: '1.1',
          taskName:
            'Pothole repair with 20 mm premix carpet including cutting, tack coat and compaction',
          unit: 'Sqm',
          scopeQty: 12800,
          rate: 685.4,
        },
        {
          boqNo: '1.2',
          taskName:
            'Sealing of cracks with bitumen emulsion and sand, including cleaning',
          unit: 'Rmt',
          scopeQty: 38000,
          rate: 64.8,
        },
        {
          boqNo: '1.3',
          taskName: 'Dressing of earthen shoulders and edge repair, both sides',
          unit: 'Km',
          scopeQty: 264,
          rate: 18450,
        },
        {
          boqNo: '1.4',
          taskName:
            'Cleaning of side drains, chutes and culvert barrels, with disposal',
          unit: 'Rmt',
          scopeQty: 96000,
          rate: 42.6,
        },
        {
          boqNo: '1.5',
          taskName: 'Cutting of grass and vegetation on verges and median',
          unit: 'Sqm',
          scopeQty: 520000,
          rate: 6.85,
        },
      ],
    },
    {
      boqNo: '2',
      name: 'Road furniture and safety',
      items: [
        {
          boqNo: '2.1',
          taskName:
            'Repainting of road markings with hot-applied thermoplastic, 2.5 mm',
          unit: 'Sqm',
          scopeQty: 18600,
          rate: 512.3,
        },
        {
          boqNo: '2.2',
          taskName:
            'Replacement of damaged W-beam metal crash barrier, including posts',
          unit: 'Rmt',
          scopeQty: 420,
          rate: 4862.5,
        },
        {
          boqNo: '2.3',
          taskName:
            'Painting of kerbs and parapets with two coats of road marking paint',
          unit: 'Sqm',
          scopeQty: 26000,
          rate: 38.4,
        },
        {
          boqNo: '2.4',
          taskName:
            'Replacement of damaged raised pavement markers (road studs)',
          unit: 'Each',
          scopeQty: 3800,
          rate: 365,
        },
      ],
    },
    {
      boqNo: '3',
      name: 'Periodic renewal',
      items: [
        {
          boqNo: '3.1',
          taskName:
            'Bituminous Concrete 30 mm overlay with VG-40, by paver (MoRTH 509)',
          unit: 'Cum',
          scopeQty: 6600,
          rate: 10482.6,
        },
        {
          boqNo: '3.2',
          taskName: 'Tack coat with RS-1 emulsion @ 0.25 kg/sqm (MoRTH 503)',
          unit: 'Sqm',
          scopeQty: 132000,
          rate: 17.2,
        },
      ],
    },
  ],
  'TE-2503': [
    {
      boqNo: '1',
      name: 'Earthwork',
      items: [
        {
          boqNo: '1.1',
          taskName:
            'Excavation in hard soil for road formation, including disposal within plant premises',
          unit: 'Cum',
          scopeQty: 9600,
          rate: 182.4,
        },
        {
          boqNo: '1.2',
          taskName:
            'Filling with selected murrum in layers, compacted to 97% MDD',
          unit: 'Cum',
          scopeQty: 7800,
          rate: 386.5,
        },
      ],
    },
    {
      boqNo: '2',
      name: 'Rigid pavement',
      items: [
        {
          boqNo: '2.1',
          taskName: 'Granular Sub-Base Grade-II, 200 mm (MoRTH 401)',
          unit: 'Cum',
          scopeQty: 3450,
          rate: 1712.8,
        },
        {
          boqNo: '2.2',
          taskName: 'Dry Lean Concrete M10, 100 mm, by paver (IRC:SP:49)',
          unit: 'Cum',
          scopeQty: 1920,
          rate: 4265.4,
        },
        {
          boqNo: '2.3',
          taskName:
            'Pavement Quality Concrete M40, 280 mm, with dowels and tie bars (MoRTH 602)',
          unit: 'Cum',
          scopeQty: 4200,
          rate: 7842.6,
        },
      ],
    },
    {
      boqNo: '3',
      name: 'Drainage and kerbs',
      items: [
        {
          boqNo: '3.1',
          taskName:
            'RCC covered drain 600 × 600 mm, M25, with precast cover slabs',
          unit: 'Rmt',
          scopeQty: 2400,
          rate: 4652.8,
        },
        {
          boqNo: '3.2',
          taskName: 'Precast M30 kerb stone 300 × 450 mm, laid on M15 bed',
          unit: 'Rmt',
          scopeQty: 4800,
          rate: 685.25,
        },
      ],
    },
    {
      boqNo: '4',
      name: 'Road markings',
      items: [
        {
          boqNo: '4.1',
          taskName: 'Hot-applied thermoplastic road marking, 2.5 mm',
          unit: 'Sqm',
          scopeQty: 1800,
          rate: 512.3,
        },
      ],
    },
  ],
};

/** How a day's quantity of an item is measured, so the six factors multiply to it. */
type Kind =
  | { k: 'cum'; B: number; D: number }
  | { k: 'sqm'; B: number }
  | { k: 'rmt'; unit: number }
  | { k: 'kg'; bar: number; w: number }
  | { k: 'direct'; places: number };

interface Activity {
  boqNo: string;
  from: string;
  to: string;
  total: number;
  kind: Kind;
  section: string;
  layer?: string;
  /** A fixed structure location (km); otherwise the work front advances along the road. */
  at?: number;
  equipment?: RegExp;
}

const EARTH = /JCB|Excavator|Backhoe|Loader|Dozer|Grader/i;
const HAUL = /Tipper|Dumper/i;
const CONCRETE = /Batching|Transit|Mixer/i;
const LIFT = /Crane|Hydra/i;

interface DwrPlan {
  /** Chainage in km. */
  road: [number, number];
  workers: [number, number];
  machinery: [number, number];
  activities: Activity[];
  /** Words for the narrative. */
  place: string;
}

const PLAN_2501 = (culvertAt: number): Activity[] => [
  {
    boqNo: '1.3',
    from: '2026-07-06',
    to: '2026-07-25',
    total: 2.6,
    kind: { k: 'direct', places: 3 },
    section: 'Road land, both sides',
    equipment: EARTH,
  },
  {
    boqNo: '1.1',
    from: '2026-07-08',
    to: '2026-10-17',
    total: 7400,
    kind: { k: 'cum', B: 12.5, D: 0.3 },
    section: 'Main carriageway',
    layer: 'Cutting',
    equipment: EARTH,
  },
  {
    boqNo: '1.2',
    from: '2026-07-15',
    to: '2026-10-18',
    total: 4600,
    kind: { k: 'cum', B: 14, D: 0.25 },
    section: 'Main carriageway',
    layer: 'Embankment',
    equipment: HAUL,
  },
  {
    boqNo: '2.1',
    from: '2026-07-22',
    to: '2026-09-30',
    total: 1050,
    kind: { k: 'cum', B: 11, D: 0.2 },
    section: 'Main carriageway',
    layer: 'GSB',
  },
  {
    boqNo: '2.2',
    from: '2026-08-10',
    to: '2026-10-18',
    total: 1350,
    kind: { k: 'cum', B: 10.5, D: 0.125 },
    section: 'Main carriageway',
    layer: 'WMM',
  },
  {
    boqNo: '2.3',
    from: '2026-07-13',
    to: '2026-09-26',
    total: 36000,
    kind: { k: 'kg', bar: 12, w: 2.47 },
    section: 'Box culvert',
    at: culvertAt,
    equipment: LIFT,
  },
  {
    boqNo: '2.4',
    from: '2026-07-20',
    to: '2026-09-30',
    total: 1480,
    kind: { k: 'sqm', B: 2.5 },
    section: 'Box culvert',
    at: culvertAt,
  },
  {
    boqNo: '3.1',
    from: '2026-09-03',
    to: '2026-10-18',
    total: 820,
    kind: { k: 'cum', B: 9.5, D: 0.05 },
    section: 'Main carriageway',
    layer: 'DBM',
  },
  {
    boqNo: '3.2',
    from: '2026-10-06',
    to: '2026-10-18',
    total: 140,
    kind: { k: 'cum', B: 9.5, D: 0.04 },
    section: 'Main carriageway',
    layer: 'BC',
  },
  {
    boqNo: '4.1',
    from: '2026-08-04',
    to: '2026-09-04',
    total: 180,
    kind: { k: 'rmt', unit: 2.5 },
    section: 'Pipe culvert (VO-07)',
    at: culvertAt + 2.35,
    equipment: LIFT,
  },
  {
    boqNo: '4.2',
    from: '2026-08-18',
    to: '2026-08-29',
    total: 32,
    kind: { k: 'cum', B: 6, D: 0.15 },
    section: 'Culvert raft (VO-12)',
    at: culvertAt,
    equipment: CONCRETE,
  },
];

const PLANS: Record<string, DwrPlan> = {
  'PRPL-2501': {
    road: [312, 326.4],
    workers: [45, 85],
    machinery: [8, 14],
    place: 'Tonk Bypass',
    activities: PLAN_2501(318.45),
  },
  'TE-2501': {
    road: [0, 19.5],
    workers: [30, 60],
    machinery: [6, 11],
    place: 'NH-148A',
    activities: PLAN_2501(7.82),
  },
  'PRPL-2502': {
    road: [0, 28],
    workers: [35, 70],
    machinery: [6, 12],
    place: 'SH-37A',
    activities: [
      {
        boqNo: '1.1',
        from: '2026-08-21',
        to: '2026-09-10',
        total: 3.2,
        kind: { k: 'direct', places: 3 },
        section: 'Widening strip, both sides',
        equipment: EARTH,
      },
      {
        boqNo: '1.2',
        from: '2026-08-21',
        to: '2026-10-18',
        total: 9800,
        kind: { k: 'cum', B: 3.5, D: 0.45 },
        section: 'Widening strip',
        layer: 'Cutting',
        equipment: EARTH,
      },
      {
        boqNo: '1.3',
        from: '2026-08-25',
        to: '2026-10-18',
        total: 14500,
        kind: { k: 'cum', B: 4, D: 0.3 },
        section: 'Widening strip',
        layer: 'Embankment',
        equipment: HAUL,
      },
      {
        boqNo: '1.4',
        from: '2026-09-05',
        to: '2026-10-18',
        total: 6200,
        kind: { k: 'cum', B: 4.5, D: 0.25 },
        section: 'Widening strip',
        layer: 'Subgrade',
      },
      {
        boqNo: '2.1',
        from: '2026-09-15',
        to: '2026-10-18',
        total: 2900,
        kind: { k: 'cum', B: 10, D: 0.2 },
        section: 'Full carriageway',
        layer: 'GSB',
      },
      {
        boqNo: '2.2',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 1450,
        kind: { k: 'cum', B: 10, D: 0.125 },
        section: 'Full carriageway',
        layer: 'WMM',
      },
      {
        boqNo: '4.1',
        from: '2026-08-28',
        to: '2026-09-25',
        total: 95,
        kind: { k: 'rmt', unit: 2.5 },
        section: 'Pipe culvert',
        at: 11.62,
        equipment: LIFT,
      },
    ],
  },
  'PRPL-2503': {
    road: [0, 9.6],
    workers: [12, 24],
    machinery: [2, 5],
    place: 'MDR-419',
    activities: [
      {
        boqNo: '1.1',
        from: '2026-10-05',
        to: '2026-10-18',
        total: 4.2,
        kind: { k: 'direct', places: 3 },
        section: 'Road land, both sides',
        equipment: EARTH,
      },
      {
        boqNo: '1.3',
        from: '2026-10-12',
        to: '2026-10-18',
        total: 1650,
        kind: { k: 'cum', B: 3, D: 0.4 },
        section: 'Widening strip',
        layer: 'Cutting',
        equipment: EARTH,
      },
    ],
  },
  'TE-2502': {
    road: [413.2, 479.4],
    workers: [18, 38],
    machinery: [3, 7],
    place: 'NH-30',
    activities: [
      {
        boqNo: '1.1',
        from: '2026-08-21',
        to: '2026-10-18',
        total: 2650,
        kind: { k: 'sqm', B: 1.5 },
        section: 'Main carriageway',
        layer: 'Patch repair',
      },
      {
        boqNo: '1.2',
        from: '2026-09-01',
        to: '2026-10-18',
        total: 24500,
        kind: { k: 'direct', places: 0 },
        section: 'Main carriageway',
      },
      {
        boqNo: '1.3',
        from: '2026-08-25',
        to: '2026-10-10',
        total: 62,
        kind: { k: 'direct', places: 1 },
        section: 'Shoulders',
        equipment: EARTH,
      },
      {
        boqNo: '1.4',
        from: '2026-08-21',
        to: '2026-09-30',
        total: 41000,
        kind: { k: 'direct', places: 0 },
        section: 'Side drains',
      },
      {
        boqNo: '1.5',
        from: '2026-08-21',
        to: '2026-10-18',
        total: 145000,
        kind: { k: 'sqm', B: 3 },
        section: 'Verges and median',
      },
      {
        boqNo: '2.1',
        from: '2026-10-03',
        to: '2026-10-18',
        total: 2100,
        kind: { k: 'sqm', B: 0.15 },
        section: 'Main carriageway',
        layer: 'Edge and centre lines',
      },
      {
        boqNo: '2.2',
        from: '2026-09-08',
        to: '2026-09-26',
        total: 96,
        kind: { k: 'rmt', unit: 4 },
        section: 'Approach to ROB',
        equipment: LIFT,
      },
      {
        boqNo: '2.4',
        from: '2026-10-06',
        to: '2026-10-18',
        total: 640,
        kind: { k: 'direct', places: 0 },
        section: 'Main carriageway',
      },
      {
        boqNo: '3.1',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 410,
        kind: { k: 'cum', B: 7, D: 0.03 },
        section: 'Main carriageway',
        layer: 'BC overlay',
      },
      {
        boqNo: '3.2',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 13600,
        kind: { k: 'sqm', B: 7 },
        section: 'Main carriageway',
        layer: 'Tack coat',
      },
    ],
  },
  'TE-2503': {
    road: [0, 4.8],
    workers: [25, 50],
    machinery: [4, 8],
    place: 'Morak works',
    activities: [
      {
        boqNo: '1.1',
        from: '2026-08-21',
        to: '2026-10-05',
        total: 4850,
        kind: { k: 'cum', B: 7.5, D: 0.4 },
        section: 'Road R-2 (packing plant to wagon loading)',
        layer: 'Formation',
        equipment: EARTH,
      },
      {
        boqNo: '1.2',
        from: '2026-08-28',
        to: '2026-10-18',
        total: 4100,
        kind: { k: 'cum', B: 7.5, D: 0.3 },
        section: 'Road R-2 (packing plant to wagon loading)',
        layer: 'Murrum filling',
        equipment: HAUL,
      },
      {
        boqNo: '2.1',
        from: '2026-09-10',
        to: '2026-10-18',
        total: 1420,
        kind: { k: 'cum', B: 7.5, D: 0.2 },
        section: 'Road R-2 (packing plant to wagon loading)',
        layer: 'GSB',
      },
      {
        boqNo: '2.2',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 260,
        kind: { k: 'cum', B: 7, D: 0.1 },
        section: 'Road R-2 (packing plant to wagon loading)',
        layer: 'DLC',
        equipment: CONCRETE,
      },
      {
        boqNo: '3.1',
        from: '2026-08-21',
        to: '2026-10-18',
        total: 980,
        kind: { k: 'direct', places: 1 },
        section: 'Drain along Road R-4 (clinker yard)',
        equipment: CONCRETE,
      },
      {
        boqNo: '3.2',
        from: '2026-09-20',
        to: '2026-10-18',
        total: 1250,
        kind: { k: 'direct', places: 1 },
        section: 'Road R-2 kerb, both sides',
        equipment: LIFT,
      },
    ],
  },
};

/**
 * The rest of the two flagship schedules. The base seed priced twelve lines (about ₹5.3 crore)
 * against contracts of ₹112.4 crore and ₹20.4 crore; these groups bring each BOQ to its contract
 * value at the quoted premium, as new lines beside the old ones so no existing bill moves.
 */
const BOQ_TOPUPS: Record<string, BoqGroup[]> = {
  'PRPL-2501': [
    {
      boqNo: '5',
      name: 'Four-lane main carriageway, Km 312.000 to Km 326.400',
      items: [
        {
          boqNo: '5.1',
          taskName:
            'Excavation for roadway in ordinary soil, main carriageway, including disposal (MoRTH 301)',
          unit: 'Cum',
          scopeQty: 168000,
          rate: 182.4,
        },
        {
          boqNo: '5.2',
          taskName:
            'Embankment with approved borrow material, compacted to 95% MDD, all leads and lifts (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 412000,
          rate: 248.65,
        },
        {
          boqNo: '5.3',
          taskName:
            'Subgrade 500 mm, CBR not less than 8, compacted to 97% MDD (MoRTH 305)',
          unit: 'Cum',
          scopeQty: 118000,
          rate: 398.6,
        },
        {
          boqNo: '5.4',
          taskName:
            'Granular Sub-Base Grade-I, 200 mm, by motor grader (MoRTH 401)',
          unit: 'Cum',
          scopeQty: 52000,
          rate: 1712.8,
        },
        {
          boqNo: '5.5',
          taskName:
            'Wet Mix Macadam, 250 mm in two layers, by paver (MoRTH 406)',
          unit: 'Cum',
          scopeQty: 64500,
          rate: 2284.55,
        },
        {
          boqNo: '5.6',
          taskName: 'Prime coat with SS-1 emulsion @ 0.70 kg/sqm (MoRTH 502)',
          unit: 'Sqm',
          scopeQty: 258000,
          rate: 38.65,
        },
        {
          boqNo: '5.7',
          taskName: 'Tack coat with RS-1 emulsion @ 0.25 kg/sqm (MoRTH 503)',
          unit: 'Sqm',
          scopeQty: 516000,
          rate: 17.2,
        },
        {
          boqNo: '5.8',
          taskName:
            'Dense Bituminous Macadam Grade-II, 100 mm in two layers, with VG-30 (MoRTH 507)',
          unit: 'Cum',
          scopeQty: 22000,
          rate: 9142.25,
        },
        {
          boqNo: '5.9',
          taskName:
            'Bituminous Concrete Grade-II, 40 mm, with VG-40 (MoRTH 509)',
          unit: 'Cum',
          scopeQty: 10320,
          rate: 10214.6,
        },
      ],
    },
    {
      boqNo: '6',
      name: 'Structures and drainage',
      items: [
        {
          boqNo: '6.1',
          taskName:
            'RCC M30 in box culverts, walls and slabs, including formwork (MoRTH 1700)',
          unit: 'Cum',
          scopeQty: 4850,
          rate: 9860,
        },
        {
          boqNo: '6.2',
          taskName:
            'RCC M35 superstructure, minor bridge at Ch. 320+150, including staging (MoRTH 1700)',
          unit: 'Cum',
          scopeQty: 2400,
          rate: 12450,
        },
        {
          boqNo: '6.3',
          taskName:
            'HYSD reinforcement Fe500D in structures, cut, bent and placed (MoRTH 1600)',
          unit: 'MT',
          scopeQty: 1000,
          rate: 72350,
        },
        {
          boqNo: '6.4',
          taskName:
            'RCC lined drain 1.0 m × 0.8 m, M25, with covers at junctions',
          unit: 'Rmt',
          scopeQty: 18600,
          rate: 3480,
        },
      ],
    },
    {
      boqNo: '7',
      name: 'Road furniture, safety and lighting',
      items: [
        {
          boqNo: '7.1',
          taskName:
            'W-beam metal crash barrier with posts and reflectors (MoRTH 810)',
          unit: 'Rmt',
          scopeQty: 9800,
          rate: 4862.5,
        },
        {
          boqNo: '7.2',
          taskName:
            'Hot-applied thermoplastic road marking, 2.5 mm, four-lane carriageway (MoRTH 803)',
          unit: 'Sqm',
          scopeQty: 21500,
          rate: 512.3,
        },
        {
          boqNo: '7.3',
          taskName:
            'Overhead cantilever gantry sign, retro-reflective, complete with foundation',
          unit: 'Each',
          scopeQty: 24,
          rate: 485000,
        },
        {
          boqNo: '7.4',
          taskName:
            'Retro-reflective cautionary and mandatory signboards, 900 mm (MoRTH 801)',
          unit: 'Each',
          scopeQty: 620,
          rate: 6840,
        },
        {
          boqNo: '7.5',
          taskName:
            'Highway lighting, 12 m octagonal pole with twin LED luminaires and cabling',
          unit: 'Each',
          scopeQty: 280,
          rate: 68400,
        },
      ],
    },
  ],
  'TE-2501': [
    {
      boqNo: '5',
      name: 'Routine maintenance, full length',
      items: [
        {
          boqNo: '5.1',
          taskName:
            'Pothole repair with 20 mm premix carpet including cutting, tack coat and compaction',
          unit: 'Sqm',
          scopeQty: 24000,
          rate: 685.4,
        },
        {
          boqNo: '5.2',
          taskName:
            'Sealing of cracks with bitumen emulsion and sand, including cleaning',
          unit: 'Rmt',
          scopeQty: 90000,
          rate: 64.8,
        },
        {
          boqNo: '5.3',
          taskName:
            'Cleaning of side drains, chutes and culvert barrels, with disposal',
          unit: 'Rmt',
          scopeQty: 210000,
          rate: 42.6,
        },
        {
          boqNo: '5.4',
          taskName: 'Cutting of grass and vegetation on verges and median',
          unit: 'Sqm',
          scopeQty: 1100000,
          rate: 6.85,
        },
        {
          boqNo: '5.5',
          taskName:
            'Upkeep of median and avenue plantation, watering and horticulture',
          unit: 'Km-month',
          scopeQty: 702,
          rate: 18400,
        },
        {
          boqNo: '5.6',
          taskName:
            'Mechanical sweeping and cleaning of carriageway and service roads',
          unit: 'Km-month',
          scopeQty: 702,
          rate: 9850,
        },
      ],
    },
    {
      boqNo: '6',
      name: 'Periodic renewal and safety',
      items: [
        {
          boqNo: '6.1',
          taskName:
            'Bituminous Concrete 40 mm overlay with VG-40, by paver (MoRTH 509)',
          unit: 'Cum',
          scopeQty: 5200,
          rate: 10482.6,
        },
        {
          boqNo: '6.2',
          taskName: 'Tack coat with RS-1 emulsion @ 0.25 kg/sqm (MoRTH 503)',
          unit: 'Sqm',
          scopeQty: 130000,
          rate: 17.2,
        },
        {
          boqNo: '6.3',
          taskName:
            'Milling of existing bituminous surface, 50 mm, with disposal',
          unit: 'Sqm',
          scopeQty: 98000,
          rate: 118.5,
        },
        {
          boqNo: '6.4',
          taskName:
            'Repainting of road markings with hot-applied thermoplastic, 2.5 mm',
          unit: 'Sqm',
          scopeQty: 16800,
          rate: 512.3,
        },
        {
          boqNo: '6.5',
          taskName:
            'Replacement of damaged W-beam metal crash barrier, including posts',
          unit: 'Rmt',
          scopeQty: 1850,
          rate: 4862.5,
        },
        {
          boqNo: '6.6',
          taskName:
            'Replacement of damaged raised pavement markers (road studs)',
          unit: 'Each',
          scopeQty: 7600,
          rate: 365,
        },
      ],
    },
  ],
};

/** Work on the top-up lines, appended to the same days' reports. */
const EXTENSIONS: Record<
  string,
  { road: [number, number]; activities: Activity[] }
> = {
  'PRPL-2501': {
    road: [312, 326.4],
    activities: [
      {
        boqNo: '5.1',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 45760,
        kind: { k: 'cum', B: 25, D: 0.3 },
        section: 'Four-lane main carriageway',
        layer: 'Cutting',
        equipment: EARTH,
      },
      {
        boqNo: '5.2',
        from: '2026-07-10',
        to: '2026-10-18',
        total: 103840,
        kind: { k: 'cum', B: 28, D: 0.25 },
        section: 'Four-lane main carriageway',
        layer: 'Embankment',
        equipment: HAUL,
      },
      {
        boqNo: '5.3',
        from: '2026-08-01',
        to: '2026-10-18',
        total: 24640,
        kind: { k: 'cum', B: 26, D: 0.25 },
        section: 'Four-lane main carriageway',
        layer: 'Subgrade',
      },
      {
        boqNo: '5.4',
        from: '2026-08-20',
        to: '2026-10-18',
        total: 8624,
        kind: { k: 'cum', B: 24, D: 0.2 },
        section: 'Four-lane main carriageway',
        layer: 'GSB',
      },
      {
        boqNo: '5.5',
        from: '2026-09-10',
        to: '2026-10-18',
        total: 4928,
        kind: { k: 'cum', B: 23, D: 0.125 },
        section: 'Four-lane main carriageway',
        layer: 'WMM',
      },
      {
        boqNo: '5.6',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 15840,
        kind: { k: 'sqm', B: 23 },
        section: 'Four-lane main carriageway',
        layer: 'Prime coat',
      },
      {
        boqNo: '6.1',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 1276,
        kind: { k: 'direct', places: 2 },
        section: 'Box culverts (various)',
        at: 316.92,
        equipment: CONCRETE,
      },
      {
        boqNo: '6.2',
        from: '2026-08-01',
        to: '2026-10-18',
        total: 458,
        kind: { k: 'direct', places: 2 },
        section: 'Minor bridge',
        at: 320.15,
        equipment: CONCRETE,
      },
      {
        boqNo: '6.3',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 273,
        kind: { k: 'direct', places: 3 },
        section: 'Structures',
        at: 320.15,
        equipment: LIFT,
      },
      {
        boqNo: '6.4',
        from: '2026-08-10',
        to: '2026-10-18',
        total: 2992,
        kind: { k: 'direct', places: 1 },
        section: 'Lined drain',
        equipment: CONCRETE,
      },
      {
        boqNo: '7.1',
        from: '2026-10-05',
        to: '2026-10-18',
        total: 528,
        kind: { k: 'rmt', unit: 4 },
        section: 'Median and approaches',
        equipment: LIFT,
      },
    ],
  },
  'TE-2501': {
    road: [0, 19.5],
    activities: [
      {
        boqNo: '5.1',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 5400,
        kind: { k: 'sqm', B: 1.5 },
        section: 'Main carriageway',
        layer: 'Patch repair',
      },
      {
        boqNo: '5.2',
        from: '2026-07-15',
        to: '2026-10-18',
        total: 19500,
        kind: { k: 'direct', places: 0 },
        section: 'Main carriageway',
      },
      {
        boqNo: '5.3',
        from: '2026-07-06',
        to: '2026-09-30',
        total: 58500,
        kind: { k: 'direct', places: 0 },
        section: 'Side drains',
      },
      {
        boqNo: '5.4',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 285000,
        kind: { k: 'sqm', B: 3 },
        section: 'Verges and median',
      },
      {
        boqNo: '5.5',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 51,
        kind: { k: 'direct', places: 2 },
        section: 'Median plantation',
      },
      {
        boqNo: '5.6',
        from: '2026-07-06',
        to: '2026-10-18',
        total: 51,
        kind: { k: 'direct', places: 2 },
        section: 'Carriageway and service roads',
      },
      {
        boqNo: '6.3',
        from: '2026-09-01',
        to: '2026-10-18',
        total: 19500,
        kind: { k: 'sqm', B: 7 },
        section: 'Main carriageway',
        layer: 'Milling',
      },
      {
        boqNo: '6.1',
        from: '2026-09-05',
        to: '2026-10-18',
        total: 975,
        kind: { k: 'cum', B: 7, D: 0.04 },
        section: 'Main carriageway',
        layer: 'BC overlay',
      },
      {
        boqNo: '6.2',
        from: '2026-09-05',
        to: '2026-10-18',
        total: 24000,
        kind: { k: 'sqm', B: 7 },
        section: 'Main carriageway',
        layer: 'Tack coat',
      },
      {
        boqNo: '6.4',
        from: '2026-10-01',
        to: '2026-10-18',
        total: 1800,
        kind: { k: 'sqm', B: 0.15 },
        section: 'Main carriageway',
        layer: 'Edge and centre lines',
      },
      {
        boqNo: '6.5',
        from: '2026-08-10',
        to: '2026-09-15',
        total: 195,
        kind: { k: 'rmt', unit: 4 },
        section: 'Approach to flyover',
        equipment: LIFT,
      },
    ],
  },
};

/** Client statutory details the base seed left blank — needed on every bill header. */
const CLIENT_IDS: Record<
  string,
  { gstin: string; pan: string; state: string }
> = {
  'National Highways Authority of India — PIU Tonk': {
    gstin: '08AAAGN4721K1ZS',
    pan: 'AAAGN4721K',
    state: '08',
  },
  'National Highways Authority of India — PIU Delhi': {
    gstin: '07AAAGN4721K1ZU',
    pan: 'AAAGN4721K',
    state: '07',
  },
  'National Highways Authority of India — PIU Lucknow': {
    gstin: '09AAAGN4721K1ZQ',
    pan: 'AAAGN4721K',
    state: '09',
  },
  'Public Works Department, Rajasthan — Division Tonk': {
    gstin: '08AAAGP3384F1ZQ',
    pan: 'AAAGP3384F',
    state: '08',
  },
  'Mangalam Cement Ltd': {
    gstin: '08AABCM6215P1ZK',
    pan: 'AABCM6215P',
    state: '08',
  },
};

/** CGST + SGST where the client is registered in Rajasthan, as the company is; IGST otherwise. */
const INTRA_STATE: Record<string, boolean> = {
  'PRPL-2501': true,
  'PRPL-2502': true,
  'PRPL-2503': true,
  'TE-2501': false,
  'TE-2502': false,
  'TE-2503': true,
};

const ORDER_NUMBERS: Record<string, string> = {
  'PRPL-2501': 'NHAI/PIU-TNK/NH-52/4L/2025/1147',
  'PRPL-2502': 'PWD/TNK/SH-37A/W&S/2025-26/318',
  'PRPL-2503': 'PWD/TNK/MDR-419/2026-27/072',
  'TE-2501': 'NHAI/PIU-DEL/O&M/NH-148A/2026/226',
  'TE-2502': 'NHAI/PIU-LKO/STOM/NH-30/2026/091',
  'TE-2503': 'MCL/MRK/CIV/PO/2026/4418',
};

interface VendorDef {
  name: string;
  gstin: string;
  pan: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
}

interface AwardDef {
  boqNo: string | null;
  description: string;
  unit: string;
  awardedQty: number;
  rate: number;
}

interface WorkOrderDef {
  key: string;
  project: string;
  vendor: string;
  workDetail: string;
  terms: string;
  requirements: string;
  status: WorkOrderStatus;
  awardedOn: string;
  materialShare?: number;
  lines: AwardDef[];
}

const TERMS_STD =
  'Measurement jointly with the site engineer; running bills monthly on the 21st–20th cycle. ' +
  'Payment within 21 days of certification by NEFT. 5% retention, released on completion of the ' +
  'defects period. TDS under section 194C. Diesel issued from the company pump is recovered at ' +
  'cost from the next bill.';

const VENDORS: Record<string, VendorDef[]> = {
  PRPL: [
    {
      name: 'Bairwa Earthmovers',
      gstin: '08AAPFB6620E1ZR',
      pan: 'AAPFB6620E',
      address: 'NH-52 Bypass Road, near Krishi Upaj Mandi',
      city: 'Tonk',
      state: 'Rajasthan',
      pinCode: '304001',
    },
    {
      name: 'Shree Shyam Infra Projects',
      gstin: '08ABHFS7731K1Z4',
      pan: 'ABHFS7731K',
      address: 'Plot 14, RIICO Industrial Area, Tonk Road',
      city: 'Tonk',
      state: 'Rajasthan',
      pinCode: '304001',
    },
    {
      name: 'Rajputana Road Pavers',
      gstin: '08AAKFR2290D1ZP',
      pan: 'AAKFR2290D',
      address: 'B-27, Sitapura Industrial Area',
      city: 'Jaipur',
      state: 'Rajasthan',
      pinCode: '302022',
    },
  ],
  TE: [
    {
      name: 'NCR Highway Maintenance Services',
      gstin: '06AAKFN3307G1ZD',
      pan: 'AAKFN3307G',
      address: 'Plot 88, Sector 37, Pace City-II',
      city: 'Gurugram',
      state: 'Haryana',
      pinCode: '122001',
    },
    {
      name: 'Hadoti Constructions',
      gstin: '08AAHFH5562Q1ZB',
      pan: 'AAHFH5562Q',
      address: '12, Indraprastha Industrial Area',
      city: 'Kota',
      state: 'Rajasthan',
      pinCode: '324005',
    },
    {
      name: 'Awadh Infra Services',
      gstin: '09ABFFA8814N1Z2',
      pan: 'ABFFA8814N',
      address: '3/118, Vibhuti Khand, Gomti Nagar',
      city: 'Lucknow',
      state: 'Uttar Pradesh',
      pinCode: '226010',
    },
  ],
};

const WORK_ORDERS: Record<string, WorkOrderDef[]> = {
  PRPL: [
    {
      key: 'earthwork-2501',
      project: 'PRPL-2501',
      vendor: 'Bairwa Earthmovers',
      workDetail:
        'Earthwork, embankment and subgrade for the four-lane main carriageway, Km 312 to Km 326.4',
      terms: TERMS_STD,
      requirements:
        'Minimum 4 excavators, 24 tippers, 2 motor graders and 4 vibratory rollers from the award date.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-07-01',
      lines: [
        {
          boqNo: '5.1',
          description: 'Excavation for roadway, machinery, labour and disposal',
          unit: 'Cum',
          awardedQty: 168000,
          rate: 118,
        },
        {
          boqNo: '5.2',
          description: 'Embankment with borrow material, compaction included',
          unit: 'Cum',
          awardedQty: 412000,
          rate: 172,
        },
        {
          boqNo: '5.3',
          description: 'Subgrade 500 mm, laying and compaction',
          unit: 'Cum',
          awardedQty: 118000,
          rate: 236,
        },
      ],
    },
    {
      key: 'earthwork-2502',
      project: 'PRPL-2502',
      vendor: 'Shree Shyam Infra Projects',
      workDetail:
        'Earthwork, subgrade and GSB for widening, Km 0 to Km 14, both sides',
      terms: TERMS_STD,
      requirements:
        'Minimum 2 excavators, 8 tippers, 1 motor grader and 2 vibratory rollers on site from the award date.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-08-12',
      materialShare: 0.18,
      lines: [
        {
          boqNo: '1.2',
          description:
            'Excavation for widening, machinery, labour and disposal',
          unit: 'Cum',
          awardedQty: 62000,
          rate: 112,
        },
        {
          boqNo: '1.3',
          description: 'Embankment with borrow material, compaction included',
          unit: 'Cum',
          awardedQty: 84000,
          rate: 205,
        },
        {
          boqNo: '1.4',
          description: 'Subgrade 500 mm, laying and compaction',
          unit: 'Cum',
          awardedQty: 46200,
          rate: 248,
        },
        {
          boqNo: '2.1',
          description: 'GSB Grade-III supply, laying and compaction',
          unit: 'Cum',
          awardedQty: 26880,
          rate: 1165,
        },
      ],
    },
    {
      key: 'bituminous-2501',
      project: 'PRPL-2501',
      vendor: 'Rajputana Road Pavers',
      workDetail:
        'Laying of DBM and BC with sensor paver, rollers and crew — mix supplied by the company',
      terms: TERMS_STD,
      requirements:
        'Sensor paver, two tandem rollers and one PTR with operators; laying gang of 18.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-08-28',
      lines: [
        {
          boqNo: '3.1',
          description: 'DBM laying and compaction, labour and plant',
          unit: 'Cum',
          awardedQty: 1680,
          rate: 785,
        },
        {
          boqNo: '3.2',
          description: 'BC laying and compaction, labour and plant',
          unit: 'Cum',
          awardedQty: 1240.8,
          rate: 845,
        },
      ],
    },
    {
      key: 'clearing-2503',
      project: 'PRPL-2503',
      vendor: 'Ashok Labour Contractors',
      workDetail:
        'Clearing, grubbing and excavation for widening, Km 0 to Km 9.6',
      terms: TERMS_STD,
      requirements: 'Labour gang of 20 with one backhoe loader.',
      status: WorkOrderStatus.draft,
      awardedOn: '2026-10-14',
      lines: [
        {
          boqNo: '1.1',
          description: 'Clearing and grubbing, labour and disposal',
          unit: 'Ha',
          awardedQty: 14.4,
          rate: 26500,
        },
        {
          boqNo: '1.3',
          description: 'Excavation for widening, labour and machinery',
          unit: 'Cum',
          awardedQty: 28500,
          rate: 118,
        },
      ],
    },
  ],
  TE: [
    {
      key: 'routine-2501',
      project: 'TE-2501',
      vendor: 'NCR Highway Maintenance Services',
      workDetail:
        'Routine maintenance — pothole repair, crack sealing, drain cleaning and vegetation control, full length',
      terms: TERMS_STD,
      requirements:
        'Three gangs of 12 with a mini hot-mix unit, a mechanical sweeper and two tractor-trolleys.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-07-02',
      lines: [
        {
          boqNo: '5.1',
          description: 'Pothole patching with premix, labour and equipment',
          unit: 'Sqm',
          awardedQty: 24000,
          rate: 470,
        },
        {
          boqNo: '5.2',
          description: 'Crack sealing, labour and emulsion sprayer',
          unit: 'Rmt',
          awardedQty: 90000,
          rate: 44,
        },
        {
          boqNo: '5.3',
          description: 'Drain and culvert cleaning with disposal',
          unit: 'Rmt',
          awardedQty: 210000,
          rate: 28.5,
        },
        {
          boqNo: '5.4',
          description: 'Grass and vegetation cutting',
          unit: 'Sqm',
          awardedQty: 1100000,
          rate: 4.6,
        },
      ],
    },
    {
      key: 'drains-2503',
      project: 'TE-2503',
      vendor: 'Hadoti Constructions',
      workDetail:
        'RCC covered drains and precast kerb laying along plant internal roads',
      terms: TERMS_STD,
      requirements:
        'Shuttering for 60 m of drain a day; kerb laying gang of 12.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-08-14',
      lines: [
        {
          boqNo: '3.1',
          description: 'RCC drain 600 × 600, labour, shuttering and curing',
          unit: 'Rmt',
          awardedQty: 2400,
          rate: 3180,
        },
        {
          boqNo: '3.2',
          description: 'Precast kerb laying on M15 bed, labour',
          unit: 'Rmt',
          awardedQty: 4800,
          rate: 465,
        },
      ],
    },
    {
      key: 'routine-2502',
      project: 'TE-2502',
      vendor: 'Awadh Infra Services',
      workDetail:
        'Routine maintenance gang — pothole patching, crack sealing, drain cleaning and vegetation, Km 413 to Km 479',
      terms: TERMS_STD,
      requirements:
        'Two gangs of 14 with a mini hot-mix unit and a tractor-trolley; working hours 07:00–17:00.',
      status: WorkOrderStatus.active,
      awardedOn: '2026-08-16',
      lines: [
        {
          boqNo: '1.1',
          description: 'Pothole patching with premix, labour and equipment',
          unit: 'Sqm',
          awardedQty: 12800,
          rate: 470,
        },
        {
          boqNo: '1.2',
          description: 'Crack sealing, labour and emulsion sprayer',
          unit: 'Rmt',
          awardedQty: 38000,
          rate: 44,
        },
        {
          boqNo: '1.4',
          description: 'Drain and culvert cleaning with disposal',
          unit: 'Rmt',
          awardedQty: 96000,
          rate: 28.5,
        },
        {
          boqNo: '1.5',
          description: 'Grass and vegetation cutting',
          unit: 'Sqm',
          awardedQty: 520000,
          rate: 4.6,
        },
      ],
    },
    {
      key: 'plantation-2501',
      project: 'TE-2501',
      vendor: 'Ashok Labour Contractors',
      workDetail:
        'Watering and upkeep of median and avenue plantation, full length',
      terms: TERMS_STD,
      requirements: 'One water tanker with a gang of 8, daily.',
      status: WorkOrderStatus.draft,
      awardedOn: '2026-10-13',
      lines: [
        {
          boqNo: null,
          description: 'Watering and upkeep of median plantation',
          unit: 'Km-month',
          awardedQty: 234,
          rate: 3850,
        },
        {
          boqNo: null,
          description: 'Replacement of dead saplings, including supply',
          unit: 'Each',
          awardedQty: 600,
          rate: 185,
        },
      ],
    },
  ],
};

interface DebitNoteDef {
  key: string;
  workOrder: string;
  noteDate: string;
  natureOfWork: string;
  lines: {
    description: string;
    unit: string;
    quantity: string;
    rate: string;
  }[];
}

const DEBIT_NOTES: Record<string, DebitNoteDef[]> = {
  PRPL: [
    {
      key: 'dn-gsb-rework',
      workOrder: 'earthwork-2502',
      noteDate: '2026-09-18',
      natureOfWork: 'Rectification of rejected subgrade done departmentally',
      lines: [
        {
          description:
            'Re-compaction of subgrade rejected in FDD test, Km 6+200 to 6+450 LHS',
          unit: 'Cum',
          quantity: '450',
          rate: '96.50',
        },
        {
          description: 'Motor grader hire for re-profiling',
          unit: 'Hour',
          quantity: '14',
          rate: '1850.00',
        },
      ],
    },
    {
      key: 'dn-paver-idle',
      workOrder: 'bituminous-2501',
      noteDate: '2026-10-12',
      natureOfWork: 'Wastage of DBM mix beyond permissible limit',
      lines: [
        {
          description: 'DBM mix rejected at paver for temperature, Ch. 314+600',
          unit: 'MT',
          quantity: '18.4',
          rate: '4620.00',
        },
      ],
    },
  ],
  TE: [
    {
      key: 'dn-drain-shutter',
      workOrder: 'drains-2503',
      noteDate: '2026-09-17',
      natureOfWork: 'Company shuttering plates damaged',
      lines: [
        {
          description: 'MS shuttering plates 900 × 600 damaged beyond repair',
          unit: 'Each',
          quantity: '22',
          rate: '1480.00',
        },
        {
          description: 'Hydra crane hire for drain cover placement',
          unit: 'Hour',
          quantity: '9',
          rate: '1350.00',
        },
      ],
    },
    {
      key: 'dn-routine-premix',
      workOrder: 'routine-2502',
      noteDate: '2026-10-14',
      natureOfWork: 'Premix issued from company stock',
      lines: [
        {
          description: 'Premix carpet material issued from Itaunja camp',
          unit: 'MT',
          quantity: '12.6',
          rate: '5240.00',
        },
      ],
    },
  ],
};

interface PackageDef {
  project: string;
  direction: BillDirection;
  workOrder?: string;
  from: string;
  to: string;
  target: 'draft' | 'issued' | 'certified';
  issuedOn?: string;
  certifiedOn?: string;
  /** Lines whose claim is cut below the approved measurement, with the reason the sheet prints. */
  claimCuts?: { boqNo: string; factor: number; reason: string }[];
  /** Claims on award lines with no BOQ line to measure (claimed by hand). */
  manualClaims?: { description: string; qty: number }[];
  adjustments?: Record<string, string>;
  deductionLines?: {
    section: BillDeductionSection;
    label: string;
    amount: string;
  }[];
  debitNote?: string;
  /** Client certification: lines passed short of what was billed. */
  certifyCuts?: { boqNo: string; factor: number }[];
  certifyRemarks?: string;
  externalBillNo?: string;
  /** Subcontractor bill: paid in full on this date, or this share of it. */
  paidOn?: string;
  paidShare?: number;
}

const PACKAGES: Record<string, PackageDef[]> = {
  PRPL: [
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_client,
      from: '2026-07-06',
      to: '2026-09-30',
      target: 'certified',
      issuedOn: '2026-10-02',
      certifiedOn: '2026-10-06',
      certifyCuts: [{ boqNo: '5.2', factor: 0.97 }],
      certifyRemarks:
        'Embankment passed at 97% pending density retest between Km 321 and Km 322.',
      externalBillNo: 'NHAI/PIU-TNK/IPC-04',
    },
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_client,
      from: '2026-10-01',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      externalBillNo: 'NHAI/PIU-TNK/IPC-05',
    },
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'earthwork-2501',
      from: '2026-07-06',
      to: '2026-09-30',
      target: 'certified',
      issuedOn: '2026-10-03',
      certifiedOn: '2026-10-07',
      claimCuts: [
        {
          boqNo: '5.1',
          factor: 0.88,
          reason:
            'Cutting at Km 319+800 to 320+400 done departmentally; excluded.',
        },
      ],
      adjustments: { recoveryDiesel: '842600.00' },
      paidOn: '2026-10-14',
    },
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'earthwork-2501',
      from: '2026-10-01',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      adjustments: { recoveryDiesel: '391800.00' },
    },
    {
      project: 'PRPL-2502',
      direction: BillDirection.to_client,
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-23',
      certifiedOn: '2026-10-08',
      certifyCuts: [{ boqNo: '1.3', factor: 0.97 }],
      certifyRemarks:
        'Embankment passed short pending FDD retest at Km 9+300 to 9+800.',
      externalBillNo: 'PWD/TNK/RA-1/2026-27',
    },
    {
      project: 'PRPL-2502',
      direction: BillDirection.to_client,
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
    },
    {
      project: 'PRPL-2502',
      direction: BillDirection.to_subcontractor,
      workOrder: 'earthwork-2502',
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-24',
      certifiedOn: '2026-09-30',
      claimCuts: [
        {
          boqNo: '1.2',
          factor: 0.9,
          reason:
            'Excavation at Km 3+100 to 3+600 done departmentally with the company backhoe; excluded.',
        },
      ],
      adjustments: {
        recoveryDiesel: '186450.00',
        mobilizationAdvanceTotal: '500000.00',
        mobilizationAdvance: '250000.00',
      },
      deductionLines: [
        {
          section: BillDeductionSection.recovery,
          label: 'Camp electricity and water',
          amount: '6500.00',
        },
      ],
      debitNote: 'dn-gsb-rework',
      paidOn: '2026-10-09',
    },
    {
      project: 'PRPL-2502',
      direction: BillDirection.to_subcontractor,
      workOrder: 'earthwork-2502',
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      claimCuts: [
        {
          boqNo: '1.2',
          factor: 0.92,
          reason:
            'Departmental excavation at the Km 14 camp approach excluded.',
        },
      ],
      adjustments: {
        recoveryDiesel: '212800.00',
        mobilizationAdvanceTotal: '500000.00',
        mobilizationAdvance: '250000.00',
      },
      deductionLines: [
        {
          section: BillDeductionSection.recovery,
          label: 'Camp electricity and water',
          amount: '6500.00',
        },
      ],
    },
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'bituminous-2501',
      from: '2026-09-01',
      to: '2026-09-30',
      target: 'certified',
      issuedOn: '2026-10-03',
      certifiedOn: '2026-10-07',
      adjustments: { recoveryDiesel: '48600.00' },
      paidOn: '2026-10-14',
      paidShare: 0.6,
    },
    {
      project: 'PRPL-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'bituminous-2501',
      from: '2026-10-01',
      to: '2026-10-15',
      target: 'draft',
      adjustments: { recoveryDiesel: '31250.00' },
      debitNote: 'dn-paver-idle',
    },
  ],
  TE: [
    {
      project: 'TE-2501',
      direction: BillDirection.to_client,
      from: '2026-07-06',
      to: '2026-09-30',
      target: 'certified',
      issuedOn: '2026-10-02',
      certifiedOn: '2026-10-06',
      certifyCuts: [{ boqNo: '5.4', factor: 0.95 }],
      certifyRemarks:
        'Vegetation clearing passed at 95% after joint inspection.',
      externalBillNo: 'NHAI/PIU-DEL/O&M/IPC-04',
    },
    {
      project: 'TE-2501',
      direction: BillDirection.to_client,
      from: '2026-10-01',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      externalBillNo: 'NHAI/PIU-DEL/O&M/IPC-05',
    },
    {
      project: 'TE-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'routine-2501',
      from: '2026-07-06',
      to: '2026-09-30',
      target: 'certified',
      issuedOn: '2026-10-03',
      certifiedOn: '2026-10-07',
      paidOn: '2026-10-13',
    },
    {
      project: 'TE-2501',
      direction: BillDirection.to_subcontractor,
      workOrder: 'routine-2501',
      from: '2026-10-01',
      to: '2026-10-15',
      target: 'draft',
    },
    {
      project: 'TE-2502',
      direction: BillDirection.to_client,
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-24',
      certifiedOn: '2026-10-09',
      certifyCuts: [{ boqNo: '1.5', factor: 0.95 }],
      certifyRemarks:
        'Vegetation clearing passed at 95% after joint inspection with the IE.',
      externalBillNo: 'NHAI/PIU-LKO/STOM/IPC-01',
    },
    {
      project: 'TE-2502',
      direction: BillDirection.to_client,
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
    },
    {
      project: 'TE-2503',
      direction: BillDirection.to_client,
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-22',
      certifiedOn: '2026-10-03',
      certifyRemarks: 'Certified in full.',
      externalBillNo: 'MCL/CIV/RA-01',
    },
    {
      project: 'TE-2503',
      direction: BillDirection.to_client,
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      externalBillNo: 'MCL/CIV/RA-02',
    },
    {
      project: 'TE-2503',
      direction: BillDirection.to_subcontractor,
      workOrder: 'drains-2503',
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-23',
      certifiedOn: '2026-09-29',
      adjustments: { mechanicalDebit: '18400.00' },
      deductionLines: [
        {
          section: BillDeductionSection.recovery,
          label: 'Cement issued in excess of theoretical consumption',
          amount: '14250.00',
        },
      ],
      debitNote: 'dn-drain-shutter',
      paidOn: '2026-10-08',
    },
    {
      project: 'TE-2503',
      direction: BillDirection.to_subcontractor,
      workOrder: 'drains-2503',
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'issued',
      issuedOn: '2026-10-17',
      adjustments: { mechanicalDebit: '9600.00' },
    },
    {
      project: 'TE-2502',
      direction: BillDirection.to_subcontractor,
      workOrder: 'routine-2502',
      from: '2026-08-21',
      to: '2026-09-20',
      target: 'certified',
      issuedOn: '2026-09-25',
      certifiedOn: '2026-10-01',
      claimCuts: [
        {
          boqNo: '1.5',
          factor: 0.85,
          reason:
            'Median grass cutting from Km 452 to Km 460 done by the departmental gang.',
        },
      ],
      paidOn: '2026-10-10',
    },
    {
      project: 'TE-2502',
      direction: BillDirection.to_subcontractor,
      workOrder: 'routine-2502',
      from: '2026-09-21',
      to: '2026-10-15',
      target: 'draft',
    },
  ],
};

/** Share of the contract value budgeted per head; the remainder is the margin the bid carried. */
const BUDGET_SHARES: Record<ProjectBudgetCategory, number> = {
  labour: 0.11,
  materials: 0.39,
  machinery: 0.13,
  fuel: 0.08,
  subcontractors: 0.15,
  overheads: 0.05,
};

// ─── Context assembled once per company ────────────────────────────────────────

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  contractValue: Prisma.Decimal;
  startDate: Date;
  clientId: string;
  client: { name: string; contactPerson: string | null };
  sites: { id: string; name: string; status: string }[];
}

interface People {
  /** Per project: supervisor employee, report author (user), engineer name. */
  forProject: Map<
    string,
    {
      supervisorEmployeeId: string | null;
      pmEmployeeId: string | null;
      submitterUserId: string | null;
    }
  >;
  approverUserId: string | null;
  accountsUserId: string | null;
}

async function loadPeople(
  ctx: CompanyContext,
  projects: ProjectRow[],
): Promise<People> {
  const { prisma, company } = ctx;
  const [employees, designations, roles] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId: company.id, isActive: true },
      select: { id: true, userId: true, siteId: true, designationId: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.designation.findMany({
      where: { companyId: company.id },
      select: { id: true, name: true },
    }),
    prisma.userRole.findMany({
      where: { user: { companyId: company.id, status: 'active' } },
      select: { userId: true, role: { select: { name: true } } },
    }),
  ]);
  const desig = new Map(designations.map((x) => [x.id, x.name]));
  const roleOf = new Map(roles.map((r) => [r.userId, r.role.name]));
  const rank = (name: string | undefined) => {
    const order = [
      'Site Supervisor',
      'Site Engineer',
      'Senior Engineer',
      'Surveyor',
      'Project Manager',
      'Quantity Surveyor',
    ];
    const i = order.indexOf(name ?? '');
    return i < 0 ? 99 : i;
  };
  const approverUserId =
    roles.find((r) => r.role.name === 'Super Admin')?.userId ?? null;
  const accountsUserId =
    employees.find(
      (e) => e.userId && desig.get(e.designationId ?? '') === 'Accountant',
    )?.userId ??
    roles.find((r) => r.role.name === 'Head Office')?.userId ??
    approverUserId;
  const siteInchargeUsers = roles
    .filter((r) => r.role.name === 'Site Incharge')
    .map((r) => r.userId);

  const forProject = new Map<
    string,
    {
      supervisorEmployeeId: string | null;
      pmEmployeeId: string | null;
      submitterUserId: string | null;
    }
  >();
  for (const project of projects) {
    const siteIds = new Set(project.sites.map((s) => s.id));
    const here = employees
      .filter((e) => e.siteId && siteIds.has(e.siteId))
      .map((e) => ({ ...e, d: desig.get(e.designationId ?? '') }));
    const engineers = [...here]
      .filter((e) => rank(e.d) < 99)
      .sort((a, b) => rank(a.d) - rank(b.d));
    const pm =
      here.find((e) => e.d === 'Project Manager') ??
      here.find((e) => e.d === 'Senior Engineer') ??
      null;
    // The author is somebody on site with a login and not the approver; failing that, a site
    // incharge from anywhere in the company.
    const author =
      engineers.find((e) => e.userId && e.userId !== approverUserId) ??
      here.find(
        (e) =>
          e.userId &&
          e.userId !== approverUserId &&
          roleOf.get(e.userId) === 'Site Incharge',
      ) ??
      null;
    forProject.set(project.id, {
      supervisorEmployeeId: engineers[0]?.id ?? author?.id ?? null,
      pmEmployeeId: pm?.id ?? null,
      submitterUserId:
        author?.userId ??
        siteInchargeUsers.find((u) => u !== approverUserId) ??
        null,
    });
  }
  return { forProject, approverUserId, accountsUserId };
}

// ─── Module ────────────────────────────────────────────────────────────────────

export async function seedProjects(ctx: CompanyContext): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const result: ModuleResult = {};
  const bump = (key: string, n = 1) => {
    if (n) result[key] = (result[key] ?? 0) + n;
  };

  const projects: ProjectRow[] = await prisma.project.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      contractValue: true,
      startDate: true,
      clientId: true,
      client: { select: { name: true, contactPerson: true } },
      sites: { select: { id: true, name: true, status: true } },
    },
    orderBy: { code: 'asc' },
  });
  if (projects.length === 0) return result;
  const byCode = new Map(projects.map((p) => [p.code, p]));
  const people = await loadPeople(ctx, projects);

  await completeProjectRecords(ctx, projects, people, bump);
  for (const project of projects) {
    bump('BOQ lines', await seedBoq(ctx, project));
    bump('BOQ lines', await topUpBoq(ctx, project));
  }
  const workOrders = await seedWorkOrders(ctx, byCode, bump);
  for (const project of projects) {
    await seedDwrs(ctx, project, people, bump);
    await extendDwrs(ctx, project, bump);
  }
  await normaliseSheetBills(ctx, projects, bump);
  await seedPackages(ctx, byCode, workOrders, people, bump);
  await seedLegacyPayments(ctx, people, bump);
  await seedRevenue(ctx, projects, bump);
  await seedBudgets(ctx, projects, bump);
  await seedBankGuaranteeScans(ctx, people, bump);
  return result;
}

// ─── Project records ───────────────────────────────────────────────────────────

async function completeProjectRecords(
  ctx: CompanyContext,
  projects: ProjectRow[],
  people: People,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma } = ctx;
  for (const project of projects) {
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: {
        clientRetentionFraction: true,
        projectManagerEmployeeId: true,
        orderNumber: true,
        siteStartDate: true,
        cgstApplicable: true,
        _count: { select: { billPackages: true } },
      },
    });
    const data: Prisma.ProjectUpdateInput = {};
    // 5%: what every bill the base seed raised already withholds. Without it the app refuses to
    // compose a bill to the client at all.
    if (row.clientRetentionFraction === null)
      data.clientRetentionFraction = dec('0.05');
    if (
      row._count.billPackages === 0 &&
      project.code in INTRA_STATE &&
      row.cgstApplicable !== INTRA_STATE[project.code]
    )
      data.cgstApplicable = INTRA_STATE[project.code];
    const pm = people.forProject.get(project.id)?.pmEmployeeId;
    if (!row.projectManagerEmployeeId && pm) data.projectManagerEmployeeId = pm;
    if (!row.orderNumber && ORDER_NUMBERS[project.code])
      data.orderNumber = ORDER_NUMBERS[project.code];
    if (!row.siteStartDate) data.siteStartDate = addDays(project.startDate, 18);
    if (Object.keys(data).length > 0) {
      await prisma.project.update({ where: { id: project.id }, data });
      bump('project records completed');
    }

    const ids = CLIENT_IDS[project.client.name];
    if (ids) {
      const updated = await prisma.client.updateMany({
        where: { id: project.clientId, gstin: null },
        data: ids,
      });
      bump('client GSTINs', updated.count);
    }
  }
}

// ─── BOQ ───────────────────────────────────────────────────────────────────────

async function seedBoq(
  ctx: CompanyContext,
  project: ProjectRow,
): Promise<number> {
  const schedule = BOQS[project.code];
  if (!schedule) return 0;
  const { prisma, company } = ctx;
  const existing = await prisma.bOQTaskGroup.count({
    where: { projectId: project.id },
  });
  if (existing > 0) return 0;
  let lines = 0;
  for (const group of schedule) {
    const row = await prisma.bOQTaskGroup.create({
      data: {
        companyId: company.id,
        projectId: project.id,
        boqNo: group.boqNo,
        name: group.name,
        scopeQty: dec(0),
      },
    });
    await prisma.bOQTaskItem.createMany({
      data: group.items.map((item) => ({
        companyId: company.id,
        groupId: row.id,
        boqNo: item.boqNo,
        taskName: item.taskName,
        unit: item.unit,
        scopeQty: dec(item.scopeQty),
        rate: dec(item.rate),
      })),
    });
    lines += group.items.length;
  }
  return lines;
}

async function boqLinesOf(ctx: CompanyContext, projectId: string) {
  return ctx.prisma.bOQTaskItem.findMany({
    where: { group: { projectId }, isEstimate: false, nonBoq: false },
    select: {
      id: true,
      boqNo: true,
      taskName: true,
      unit: true,
      scopeQty: true,
      doneQty: true,
      rate: true,
    },
  });
}

// ─── Vendors and work orders ───────────────────────────────────────────────────

async function seedWorkOrders(
  ctx: CompanyContext,
  byCode: Map<string, ProjectRow>,
  bump: (key: string, n?: number) => void,
): Promise<Map<string, { id: string; partnerId: string | null }>> {
  const { prisma, company } = ctx;
  const out = new Map<string, { id: string; partnerId: string | null }>();
  const codes = new CodeSeriesService();
  const isTaken = async (candidate: string) =>
    !!(await prisma.workOrder.findFirst({
      where: { companyId: company.id, code: candidate },
      select: { id: true },
    }));

  // The base seed's awards carry no code; give them the first numbers of the series, oldest first.
  const uncoded = await prisma.workOrder.findMany({
    where: { companyId: company.id, code: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const order of uncoded) {
    const code = await codes.next(
      prisma as unknown as Prisma.TransactionClient,
      company.id,
      CodeSeriesType.WORK_ORDER,
      'WO',
      isTaken,
    );
    await prisma.workOrder.update({ where: { id: order.id }, data: { code } });
    bump('work order codes');
  }

  for (const def of WORK_ORDERS[company.shortCode] ?? []) {
    const project = byCode.get(def.project);
    if (!project) continue;
    const partnerId = await findOrCreateVendor(ctx, def.vendor, bump);
    const found = await prisma.workOrder.findFirst({
      where: { projectId: project.id, workDetail: def.workDetail },
      select: { id: true, partnerId: true },
    });
    if (found) {
      out.set(def.key, found);
      continue;
    }
    const boq = await boqLinesOf(ctx, project.id);
    const boqByNo = new Map(boq.map((b) => [b.boqNo, b.id]));
    const total = round2(
      def.lines.reduce((s, l) => s + l.awardedQty * l.rate, 0),
    );
    const material = round2(total * (def.materialShare ?? 0));
    const code = await codes.next(
      prisma as unknown as Prisma.TransactionClient,
      company.id,
      CodeSeriesType.WORK_ORDER,
      'WO',
      isTaken,
    );
    const awardedAt = at(d(def.awardedOn), 15, 20);
    const created = await prisma.workOrder.create({
      data: {
        companyId: company.id,
        projectId: project.id,
        code,
        partnerId,
        workDetail: def.workDetail,
        terms: def.terms,
        requirements: def.requirements,
        labourAmount: dec(round2(total - material)),
        materialAmount: dec(material),
        retentionPercent: dec('0.05'),
        status: def.status,
        createdAt: awardedAt,
        awardLines: {
          create: def.lines.map((line) => ({
            companyId: company.id,
            boqTaskItemId: line.boqNo ? boqByNo.get(line.boqNo) ?? null : null,
            description: line.description,
            unit: line.unit,
            awardedQty: dec(line.awardedQty),
            rate: dec(line.rate),
            createdAt: awardedAt,
          })),
        },
      },
      select: { id: true, partnerId: true },
    });
    out.set(def.key, created);
    bump('work orders');
  }
  return out;
}

async function findOrCreateVendor(
  ctx: CompanyContext,
  name: string,
  bump: (key: string, n?: number) => void,
): Promise<string | null> {
  const { prisma, company } = ctx;
  const existing = await prisma.vendor.findFirst({
    where: { companyId: company.id, name },
    select: { id: true },
  });
  if (existing) return existing.id;
  const def = VENDORS[company.shortCode]?.find((v) => v.name === name);
  if (!def) return null;
  // Next free number in the company's own vendor coding, whatever other modules already took.
  const prefix = `${company.shortCode}-V-`;
  const codes = await prisma.vendor.findMany({
    where: { companyId: company.id, code: { startsWith: prefix } },
    select: { code: true },
  });
  const highest = codes.reduce((max, row) => {
    const n = Number(row.code.slice(prefix.length));
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 1000);
  const created = await prisma.vendor.create({
    data: {
      companyId: company.id,
      code: `${prefix}${highest + 1}`,
      name: def.name,
      type: 'subcontractor',
      gstin: def.gstin,
      pan: def.pan,
      tdsSection: '194C',
      tdsRate: dec('2.00'),
      address: def.address,
      city: def.city,
      state: def.state,
      pinCode: def.pinCode,
    },
    select: { id: true },
  });
  bump('subcontractor vendors');
  return created.id;
}

// ─── Daily work reports ────────────────────────────────────────────────────────

interface DayWeather {
  weather: DwrWeather;
  /** 0 = washed out (no report), 0.5 = rain interrupted, 1 = full day. */
  factor: number;
}

function weatherFor(day: Date, rng: Rng): DayWeather {
  const month = day.getUTCMonth() + 1;
  const roll = rng.rand();
  if (month === 7 || month === 8) {
    if (roll < 0.1) return { weather: DwrWeather.rainy, factor: 0 };
    if (roll < 0.3) return { weather: DwrWeather.rainy, factor: 0.5 };
    if (roll < 0.5) return { weather: DwrWeather.overcast, factor: 1 };
  } else if (month === 9) {
    if (roll < 0.04) return { weather: DwrWeather.rainy, factor: 0 };
    if (roll < 0.15) return { weather: DwrWeather.rainy, factor: 0.5 };
    if (roll < 0.3) return { weather: DwrWeather.overcast, factor: 1 };
  } else if (roll < 0.06) {
    return { weather: DwrWeather.overcast, factor: 1 };
  }
  return { weather: DwrWeather.clear, factor: 1 };
}

interface MeasuredLine {
  boqItemId: string;
  boqNo: string;
  qty: Prisma.Decimal;
  factors: {
    nos1?: number;
    length?: number;
    breadth?: number;
    depth?: number;
    density?: number;
  };
  /** Metres of road the line covers, where it is a stretch. */
  stretch: number | null;
}

/** Turns a target quantity into the dimensions a measurement book would carry. */
function measure(
  kind: Kind,
  target: number,
): { factors: MeasuredLine['factors']; stretch: number | null } | null {
  switch (kind.k) {
    case 'cum': {
      const L = Math.round(target / (kind.B * kind.D));
      return L < 1
        ? null
        : {
            factors: { length: L, breadth: kind.B, depth: kind.D },
            stretch: L,
          };
    }
    case 'sqm': {
      const L = Math.round(target / kind.B);
      return L < 1
        ? null
        : { factors: { length: L, breadth: kind.B }, stretch: L };
    }
    case 'rmt': {
      const n = Math.round(target / kind.unit);
      return n < 1
        ? null
        : { factors: { nos1: n, length: kind.unit }, stretch: null };
    }
    case 'kg': {
      const n = Math.round(target / (kind.bar * kind.w));
      return n < 1
        ? null
        : {
            factors: { nos1: n, length: kind.bar, density: kind.w },
            stretch: null,
          };
    }
    case 'direct': {
      const f = 10 ** kind.places;
      const v = Math.round(target * f) / f;
      return v <= 0 ? null : { factors: { length: v }, stretch: null };
    }
  }
}

async function seedDwrs(
  ctx: CompanyContext,
  project: ProjectRow,
  people: People,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const plan = PLANS[project.code];
  if (!plan) return;
  if (!project.sites.some((s) => s.status === 'active')) return;
  const { prisma, company, rng, today } = ctx;
  const existing = await prisma.dailyWorkReport.count({
    where: { projectId: project.id },
  });
  if (existing > 0) return;

  const boq = await boqLinesOf(ctx, project.id);
  const boqByNo = new Map(boq.map((b) => [b.boqNo, b]));
  const who = people.forProject.get(project.id);
  const submitter = who?.submitterUserId ?? null;
  const approver = people.approverUserId;
  const engineer = project.client.contactPerson ?? null;
  const equipment = await prisma.equipment.findMany({
    where: {
      companyId: company.id,
      deployedSiteId: { in: project.sites.map((s) => s.id) },
    },
    select: { id: true, name: true },
  });

  // Calendar: every working day from the earliest activity to today.
  const starts = plan.activities.map((a) => d(a.from).getTime());
  const first = new Date(Math.min(...starts));
  const days: { day: Date; weather: DayWeather }[] = [];
  for (let t = first; t <= today; t = addDays(t, 1)) {
    if (t.getUTCDay() === 0) continue; // the sites' weekly off
    days.push({ day: t, weather: weatherFor(t, rng) });
  }

  const linesByDay = distribute(
    plan.activities,
    days.filter((x) => x.weather.factor > 0),
    boqByNo,
    rng,
    today,
  );
  const front: Fronts = new Map();

  const reportDays = days.filter((x) => linesByDay.has(iso(x.day)));
  if (reportDays.length === 0) return;
  const returnedDay =
    reportDays.length > 4 ? reportDays[reportDays.length - 4] : null;

  const reports: Prisma.DailyWorkReportCreateManyInput[] = [];
  const tasks: Prisma.DWRTaskCreateManyInput[] = [];
  const approvedByItem = new Map<string, Prisma.Decimal>();
  const attachments: {
    dwrId: string;
    dpr: string;
    day: Date;
    at: Date;
    lines: string[];
  }[] = [];
  let seq = 0;

  for (const { day, weather } of reportDays) {
    seq += 1;
    const id = randomUUID();
    const dprNumber = `${project.code}-DPR-${String(seq).padStart(4, '0')}`;
    const ageDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    const status: DwrStatus =
      ageDays <= 1
        ? DwrStatus.draft
        : returnedDay && day.getTime() === returnedDay.day.getTime()
        ? DwrStatus.returned
        : DwrStatus.approved;
    const lines = linesByDay.get(iso(day)) ?? [];
    const narrative: string[] = [];
    let rfi = '';

    for (const line of lines) {
      const activity = plan.activities.find((a) => a.boqNo === line.boqNo);
      if (!activity) continue;
      const built = lineToTask(line, activity, {
        dwrId: id,
        road: plan.road,
        front,
        equipment,
        engineer,
        rng,
        unit: boqByNo.get(line.boqNo)?.unit ?? '',
      });
      tasks.push(built.task);
      narrative.push(built.text);
      if (status === DwrStatus.approved) {
        approvedByItem.set(
          line.boqItemId,
          (approvedByItem.get(line.boqItemId) ?? dec(0)).plus(line.qty),
        );
      }
      if (!rfi && activity.layer) {
        rfi = `RFI/${project.code.split('-')[1]}/${String(100 + seq).padStart(
          4,
          '0',
        )}`;
      }
    }

    const [wMin, wMax] = plan.workers;
    const [mMin, mMax] = plan.machinery;
    const factor = weather.factor < 1 ? 0.7 : 1;
    const submittedAt = at(day, 19, rng.int(5, 55));
    const reviewedAt = at(addDays(day, 1), rng.int(9, 12), rng.int(0, 59));
    const weatherNote =
      weather.factor < 1
        ? ' Work interrupted by rain in the afternoon.'
        : weather.weather === DwrWeather.overcast
        ? ' Overcast, no loss of working hours.'
        : '';
    const firstSection =
      plan.activities.find((a) => a.boqNo === lines[0].boqNo)?.section ??
      plan.place;
    reports.push({
      id,
      companyId: company.id,
      projectId: project.id,
      workDate: day,
      dprNumber,
      supervisorEmployeeId: who?.supervisorEmployeeId ?? null,
      weather: weather.weather,
      status,
      workerCount: Math.round(rng.int(wMin, wMax) * factor),
      machineryCount: Math.max(1, Math.round(rng.int(mMin, mMax) * factor)),
      progress: 0,
      location: `${plan.place} — ${firstSection}`,
      description: narrative.join(' ') + weatherNote,
      contractFor: 'self',
      rfiNo: rfi || null,
      layer:
        plan.activities.find((a) => a.boqNo === lines[0].boqNo)?.layer ?? null,
      createdByUserId: submitter,
      submittedByUserId: status === DwrStatus.draft ? null : submitter,
      submittedAt: status === DwrStatus.draft ? null : submittedAt,
      approvedByUserId: status === DwrStatus.approved ? approver : null,
      approvedAt: status === DwrStatus.approved ? reviewedAt : null,
      returnedAt: status === DwrStatus.returned ? reviewedAt : null,
      returnedByUserId: status === DwrStatus.returned ? approver : null,
      returnReason:
        status === DwrStatus.returned
          ? 'Layer thickness on the GSB line does not match the level sheet — recheck the depth and resubmit.'
          : null,
      fileRefs: [],
      createdAt: at(day, 18, rng.int(0, 50)),
      updatedAt: status === DwrStatus.approved ? reviewedAt : submittedAt,
    });
    if (status !== DwrStatus.draft && seq % 6 === 0) {
      attachments.push({
        dwrId: id,
        dpr: dprNumber,
        day,
        at: addMinutes(submittedAt, -12),
        lines: narrative,
      });
    }
  }

  await prisma.dailyWorkReport.createMany({ data: reports });
  for (let i = 0; i < tasks.length; i += 500) {
    await prisma.dWRTask.createMany({ data: tasks.slice(i, i + 500) });
  }
  // What approval does, once per line: the executed quantity is the sum of approved measurement.
  for (const [itemId, qty] of approvedByItem) {
    await prisma.bOQTaskItem.update({
      where: { id: itemId },
      data: { doneQty: { increment: qty } },
    });
  }

  for (const a of attachments) {
    const pdf = await ctx.renderPdf(
      `Measurement sheet — ${a.dpr}`,
      `${project.name}\nDate of work: ${iso(a.day)}\n\n${a.lines.join(
        '\n',
      )}\n\n` +
        `Measured jointly at site. Signed: Site Engineer / Client's representative.`,
    );
    const fileRef = await ctx.writeBlob(`dwr-attachments/${company.id}`, pdf);
    await prisma.dWRAttachment.create({
      data: {
        companyId: company.id,
        dwrId: a.dwrId,
        fileRef,
        fileName: `MB ${a.dpr} ${iso(a.day)}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        uploadedByUserId: submitter,
        uploadedAt: a.at,
      },
    });
  }

  bump('daily work reports', reports.length);
  bump('DWR lines', tasks.length);
  bump('DWR attachments', attachments.length);
  await checkBillCoverage(ctx, project);
}

type Fronts = Map<string, { km: number; pass: number; side: number }>;

/** Adds the top-up groups a flagship BOQ is missing, beside the lines already billed. */
async function topUpBoq(
  ctx: CompanyContext,
  project: ProjectRow,
): Promise<number> {
  const groups = BOQ_TOPUPS[project.code];
  if (!groups) return 0;
  const { prisma, company } = ctx;
  const have = new Set(
    (
      await prisma.bOQTaskGroup.findMany({
        where: { projectId: project.id },
        select: { boqNo: true },
      })
    ).map((g) => g.boqNo),
  );
  let lines = 0;
  for (const group of groups) {
    if (have.has(group.boqNo)) continue;
    const row = await prisma.bOQTaskGroup.create({
      data: {
        companyId: company.id,
        projectId: project.id,
        boqNo: group.boqNo,
        name: group.name,
        scopeQty: dec(0),
      },
    });
    await prisma.bOQTaskItem.createMany({
      data: group.items.map((item) => ({
        companyId: company.id,
        groupId: row.id,
        boqNo: item.boqNo,
        taskName: item.taskName,
        unit: item.unit,
        scopeQty: dec(item.scopeQty),
        rate: dec(item.rate),
      })),
    });
    lines += group.items.length;
  }
  return lines;
}

/**
 * Measures the top-up lines on the reports already filed for those days — the same crews, the
 * same day's sheet — and moves `doneQty` by exactly the approved part, so reconciliation stays at
 * zero. Runs once: a project whose top-up lines carry any measurement is left alone.
 */
async function extendDwrs(
  ctx: CompanyContext,
  project: ProjectRow,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const ext = EXTENSIONS[project.code];
  if (!ext) return;
  const { prisma, company, rng, today } = ctx;
  const boq = await boqLinesOf(ctx, project.id);
  const boqByNo = new Map(boq.map((b) => [b.boqNo, b]));
  const itemIds = ext.activities
    .map((a) => boqByNo.get(a.boqNo)?.id)
    .filter((id): id is string => Boolean(id));
  if (itemIds.length === 0) return;
  if (
    (await prisma.dWRTask.count({ where: { boqItemId: { in: itemIds } } })) > 0
  )
    return;
  const reports = await prisma.dailyWorkReport.findMany({
    where: { projectId: project.id },
    select: {
      id: true,
      workDate: true,
      status: true,
      weather: true,
      description: true,
      workerCount: true,
      machineryCount: true,
    },
    orderBy: [{ workDate: 'asc' }, { dprNumber: 'asc' }],
  });
  if (reports.length === 0) return;
  const byDay = new Map<string, (typeof reports)[number]>();
  for (const r of reports)
    if (!byDay.has(iso(r.workDate))) byDay.set(iso(r.workDate), r);
  const days = [...byDay.values()].map((r) => ({
    day: r.workDate,
    weather: {
      weather: r.weather,
      factor: r.weather === DwrWeather.rainy ? 0.5 : 1,
    },
  }));
  const linesByDay = distribute(ext.activities, days, boqByNo, rng, today);
  const equipment = await prisma.equipment.findMany({
    where: {
      companyId: company.id,
      deployedSiteId: { in: project.sites.map((s) => s.id) },
    },
    select: { id: true, name: true },
  });
  const front: Fronts = new Map();
  const tasks: Prisma.DWRTaskCreateManyInput[] = [];
  const approvedByItem = new Map<string, Prisma.Decimal>();
  for (const [day, lines] of linesByDay) {
    const report = byDay.get(day);
    if (!report) continue;
    const texts: string[] = [];
    for (const line of lines) {
      const activity = ext.activities.find((a) => a.boqNo === line.boqNo);
      if (!activity) continue;
      const built = lineToTask(line, activity, {
        dwrId: report.id,
        road: ext.road,
        front,
        equipment,
        engineer: project.client.contactPerson ?? null,
        rng,
        unit: boqByNo.get(line.boqNo)?.unit ?? '',
      });
      tasks.push(built.task);
      texts.push(built.text);
      if (report.status === DwrStatus.approved) {
        approvedByItem.set(
          line.boqItemId,
          (approvedByItem.get(line.boqItemId) ?? dec(0)).plus(line.qty),
        );
      }
    }
    await prisma.dailyWorkReport.update({
      where: { id: report.id },
      data: {
        description: [report.description, ...texts].filter(Boolean).join(' '),
        workerCount: report.workerCount + rng.int(60, 140),
        machineryCount: report.machineryCount + rng.int(8, 18),
      },
    });
  }
  for (let i = 0; i < tasks.length; i += 500) {
    await prisma.dWRTask.createMany({ data: tasks.slice(i, i + 500) });
  }
  for (const [itemId, qty] of approvedByItem) {
    await prisma.bOQTaskItem.update({
      where: { id: itemId },
      data: { doneQty: { increment: qty } },
    });
  }
  bump('DWR lines', tasks.length);
}

/**
 * The base seed numbered its sheet bills `PRPL/RA/01`, a spelling the app never produces: the app
 * numbers a project's client bills `RA-01`, `RA-02` … in one series shared by the sheet and the
 * package flow. Renumbered here — references in receipts follow — so the packages raised next
 * continue at RA-04 rather than starting a second RA-01 beside the first. The third sheet bill,
 * left in draft, is sent (dated the end of its month) and the second certified, as a project
 * three months in would have them.
 */
async function normaliseSheetBills(
  ctx: CompanyContext,
  projects: ProjectRow[],
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma } = ctx;
  for (const project of projects) {
    const bills = await prisma.clientBill.findMany({
      where: { projectId: project.id, package: { is: null } },
      select: {
        id: true,
        billNumber: true,
        status: true,
        grossAmount: true,
        certifiedAmount: true,
        billingDate: true,
      },
      orderBy: { billingDate: 'asc' },
    });
    if (bills.length === 0) continue;
    for (const bill of bills) {
      const m = /\/RA\/(\d+)$/.exec(bill.billNumber);
      if (!m) continue;
      const next = `RA-${m[1].padStart(2, '0')}`;
      const taken = await prisma.clientBill.findFirst({
        where: { projectId: project.id, billNumber: next },
        select: { id: true },
      });
      if (taken) continue;
      await prisma.clientBill.update({
        where: { id: bill.id },
        data: { billNumber: next },
      });
      const receipts = await prisma.revenue.findMany({
        where: {
          projectId: project.id,
          description: { startsWith: bill.billNumber },
        },
        select: { id: true, description: true },
      });
      for (const r of receipts) {
        await prisma.revenue.update({
          where: { id: r.id },
          data: {
            description: next + r.description.slice(bill.billNumber.length),
          },
        });
      }
      bill.billNumber = next;
      bump('sheet bills renumbered');
    }
    if (!BOQ_TOPUPS[project.code]) continue;
    const ra02 = bills.find((b) => b.billNumber === 'RA-02');
    if (ra02 && ra02.status === 'submitted' && ra02.certifiedAmount === null) {
      await prisma.clientBill.update({
        where: { id: ra02.id },
        data: {
          status: 'certified',
          certifiedAmount: dec(round2(ra02.grossAmount.toNumber() * 0.985)),
          certifiedAt: at(d('2026-09-29'), 14, 5),
        },
      });
      bump('sheet bills advanced');
    }
    const ra03 = bills.find((b) => b.billNumber === 'RA-03');
    if (ra03 && ra03.status === 'draft') {
      const gross = ra03.grossAmount.toNumber();
      const retention = round2(gross * 0.05);
      await prisma.clientBill.update({
        where: { id: ra03.id },
        data: {
          status: 'submitted',
          billingDate: d('2026-09-30'),
          submittedAt: at(d('2026-09-30'), 16, 30),
          retentionAmount: dec(retention),
          netAmount: dec(round2(gross - retention)),
        },
      });
      bump('sheet bills advanced');
    }
    await checkBillCoverage(ctx, project);
  }
}

/** Spreads each activity's quantity over the working days it runs, inside the BOQ line's scope. */
function distribute(
  activities: Activity[],
  workDays: { day: Date; weather: DayWeather }[],
  boqByNo: Map<
    string,
    {
      id: string;
      boqNo: string;
      scopeQty: Prisma.Decimal;
      doneQty: Prisma.Decimal;
    }
  >,
  rng: Rng,
  today: Date,
): Map<string, MeasuredLine[]> {
  const linesByDay = new Map<string, MeasuredLine[]>();
  const done = new Map<string, number>(
    [...boqByNo.values()].map((b) => [b.id, b.doneQty.toNumber()]),
  );

  for (const activity of activities) {
    const item = boqByNo.get(activity.boqNo);
    if (!item) continue;
    const from = d(activity.from);
    const to = d(activity.to) < today ? d(activity.to) : today;
    const span = workDays.filter((x) => x.day >= from && x.day <= to);
    if (span.length === 0) continue;
    const weights = span.map((x, i) =>
      i > 0 && i < span.length - 1 && rng.rand() < 0.12
        ? 0
        : (0.6 + rng.rand() * 0.8) * x.weather.factor,
    );
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let remaining = activity.total;
    span.forEach((x, i) => {
      if (weights[i] === 0) return;
      const isLast = i === span.length - 1;
      const target = isLast
        ? remaining
        : Math.min(remaining, (activity.total * weights[i]) / sum);
      const scopeLeft = item.scopeQty.toNumber() - (done.get(item.id) ?? 0);
      const m = measure(activity.kind, Math.min(target, scopeLeft));
      if (!m) return;
      const qty = computeMeasuredQty(m.factors).toDecimalPlaces(3);
      if (qty.toNumber() > scopeLeft + 1e-9) return;
      remaining -= qty.toNumber();
      done.set(item.id, (done.get(item.id) ?? 0) + qty.toNumber());
      const key = iso(x.day);
      const list = linesByDay.get(key) ?? [];
      list.push({
        boqItemId: item.id,
        boqNo: item.boqNo,
        qty,
        factors: m.factors,
        stretch: m.stretch,
      });
      linesByDay.set(key, list);
    });
  }
  return linesByDay;
}

/** One measured line as a DWRTask row, with the chainage its work front reached that day. */
function lineToTask(
  line: MeasuredLine,
  activity: Activity,
  o: {
    dwrId: string;
    road: [number, number];
    front: Fronts;
    equipment: { id: string; name: string }[];
    engineer: string | null;
    rng: Rng;
    unit: string;
  },
): { task: Prisma.DWRTaskCreateManyInput; text: string } {
  const { rng, front, equipment, engineer, unit } = o;
  const id = o.dwrId;
  const plan = { road: o.road };
  const tasks: Prisma.DWRTaskCreateManyInput[] = [];
  const narrative: string[] = [];
  let chainageFrom: number | null = null;
  let chainageTo: number | null = null;
  let roadSide: string | null = null;
  let layerNo: string | null = null;
  if (activity.at !== undefined) {
    chainageFrom = activity.at;
    chainageTo = round3(activity.at + 0.02);
  } else if (line.stretch !== null || activity.kind.k === 'direct') {
    const [start, end] = plan.road;
    const state = front.get(line.boqNo) ?? {
      km: round3(start + (end - start) * rng.rand() * 0.3),
      pass: 1,
      side: 0,
    };
    const metres =
      line.stretch ?? Math.min(1500, 200 + Math.round(rng.rand() * 900));
    chainageFrom = state.km;
    chainageTo = round3(Math.min(end, state.km + metres / 1000));
    roadSide =
      activity.kind.k === 'direct'
        ? 'Both'
        : (state.side + rng.int(0, 1)) % 2 === 0
        ? 'LHS'
        : 'RHS';
    layerNo = activity.layer ? `${activity.layer} L-${state.pass}` : null;
    if (chainageTo >= end) {
      state.km = round3(start + (end - start) * rng.rand() * 0.2);
      state.pass += 1;
      state.side += 1;
    } else {
      state.km = chainageTo;
    }
    front.set(line.boqNo, state);
  }
  const eq = activity.equipment
    ? equipment.find((e) => activity.equipment?.test(e.name))
    : undefined;
  tasks.push({
    id: randomUUID(),
    dwrId: id,
    boqItemId: line.boqItemId,
    paymentMode: 'work_basis',
    nos1: line.factors.nos1 ?? undefined,
    length: line.factors.length ?? undefined,
    breadth: line.factors.breadth ?? undefined,
    depth: line.factors.depth ?? undefined,
    density: line.factors.density ?? undefined,
    actualQty: line.qty,
    servedQty: null,
    equipmentId: eq?.id ?? null,
    chainageFrom: chainageFrom === null ? null : dec(chainageFrom),
    chainageTo: chainageTo === null ? null : dec(chainageTo),
    roadSide,
    layer: activity.layer ?? null,
    layerNo,
    section: activity.section,
    engineerName: engineer,
    remark:
      activity.kind.k === 'cum' && activity.layer
        ? rng.pick([
            'FDD taken, compaction passed.',
            'Level checked by the surveyor.',
            'Joint measurement with the client’s engineer.',
            null,
            null,
          ])
        : null,
    exceedsScope: false,
  });
  const fmt = (km: number | null) =>
    km === null
      ? ''
      : `${Math.floor(km)}+${String(Math.round((km % 1) * 1000)).padStart(
          3,
          '0',
        )}`;
  const where =
    chainageFrom !== null && chainageTo !== null && activity.at === undefined
      ? ` Km ${fmt(chainageFrom)}–${fmt(chainageTo)}${
          roadSide ? ` ${roadSide}` : ''
        }`
      : activity.at !== undefined
      ? ` at Ch. ${fmt(activity.at)}`
      : '';
  narrative.push(
    `${activity.layer ?? activity.section} (${line.boqNo}): ${line.qty.toFixed(
      line.qty.isInteger() ? 0 : 2,
    )} ${unit}${where}.`,
  );
  return { task: tasks[0], text: narrative[0] };
}

const addMinutes = (t: Date, n: number) => new Date(t.getTime() + n * 60_000);

/**
 * Every bill's quantity must already be approved measurement by its billing date — the claim the
 * whole billing chain rests on. Reported, not thrown: a base-seed change should not stop the run.
 */
async function checkBillCoverage(
  ctx: CompanyContext,
  project: ProjectRow,
): Promise<void> {
  const { prisma } = ctx;
  const [clientLines, raLines, tasks] = await Promise.all([
    prisma.clientBillLine.findMany({
      where: { clientBill: { projectId: project.id } },
      select: {
        boqTaskItemId: true,
        quantity: true,
        clientBill: { select: { billingDate: true, billNumber: true } },
      },
    }),
    prisma.rABillLine.findMany({
      where: { raBill: { projectId: project.id } },
      select: {
        quantity: true,
        workOrderBoqItem: {
          select: { boqTaskItemId: true, workOrderId: true },
        },
        raBill: { select: { billingDate: true, billNumber: true } },
      },
    }),
    prisma.dWRTask.findMany({
      where: { dwr: { projectId: project.id, status: DwrStatus.approved } },
      select: {
        boqItemId: true,
        actualQty: true,
        dwr: { select: { workDate: true } },
      },
    }),
  ]);
  const approvedBy = (itemId: string, date: Date) =>
    tasks
      .filter((t) => t.boqItemId === itemId && t.dwr.workDate <= date)
      .reduce((s, t) => s + (t.actualQty?.toNumber() ?? 0), 0);
  const series = [
    ...clientLines.map((l) => ({
      key: `client:${l.boqTaskItemId}`,
      item: l.boqTaskItemId,
      qty: l.quantity.toNumber(),
      date: l.clientBill.billingDate,
      bill: l.clientBill.billNumber,
    })),
    ...raLines
      .filter((l) => l.workOrderBoqItem.boqTaskItemId)
      .map((l) => ({
        key: `${l.workOrderBoqItem.workOrderId}:${l.workOrderBoqItem.boqTaskItemId}`,
        item: l.workOrderBoqItem.boqTaskItemId as string,
        qty: l.quantity.toNumber(),
        date: l.raBill.billingDate,
        bill: l.raBill.billNumber,
      })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  const cumulative = new Map<string, number>();
  for (const s of series) {
    const billed = (cumulative.get(s.key) ?? 0) + s.qty;
    cumulative.set(s.key, billed);
    const approved = approvedBy(s.item, s.date);
    if (billed > approved + 0.001) {
      console.warn(
        `    ${project.code} ${s.bill}: billed ${billed} by ${iso(
          s.date,
        )} but only ` + `${approved.toFixed(3)} approved by then`,
      );
    }
  }
}

// ─── Bill packages ─────────────────────────────────────────────────────────────

function billingServices(ctx: CompanyContext) {
  const prisma = ctx.prisma as unknown as PrismaService;
  const registry = new ProjectSourcesRegistry();
  new VendorIdentitySource(prisma, registry).onModuleInit();
  // Only the two reads billing makes are exercised; neither touches the other dependencies.
  const companies = new CompaniesService(
    ...([prisma] as unknown as ConstructorParameters<typeof CompaniesService>),
  );
  const periodFigures = new DwrPeriodFiguresService(
    prisma,
    null as never,
    null as never,
  );
  const packages = new BillPackageService(
    prisma,
    periodFigures,
    companies,
    registry,
    null as never,
  );
  const debitNotes = new DebitNoteService(prisma, companies, registry);
  return { packages, debitNotes };
}

async function seedPackages(
  ctx: CompanyContext,
  byCode: Map<string, ProjectRow>,
  workOrders: Map<string, { id: string; partnerId: string | null }>,
  people: People,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company } = ctx;
  const defs = PACKAGES[company.shortCode] ?? [];
  if (defs.length === 0) return;
  const { packages, debitNotes } = billingServices(ctx);
  const rls = { isSuperAdmin: false, companyId: company.id };
  const author = people.accountsUserId;
  const director = people.approverUserId;
  const notes = new Map<string, string>();

  for (const def of defs) {
    const project = byCode.get(def.project);
    if (!project) continue;
    const workOrder = def.workOrder ? workOrders.get(def.workOrder) : undefined;
    if (def.direction === BillDirection.to_subcontractor && !workOrder)
      continue;
    // Once per bill: the same schedule, counterparty and period is never composed twice.
    const already = await prisma.billPackage.findFirst({
      where: {
        projectId: project.id,
        direction: def.direction,
        counterpartyKey:
          def.direction === BillDirection.to_client
            ? project.clientId
            : workOrder?.id,
        periodFrom: d(def.from),
        periodTo: d(def.to),
      },
      select: { id: true },
    });
    if (already) continue;

    // Debit note first: it is raised in the month and recovered on the bill.
    let noteId: string | null = null;
    if (def.debitNote && workOrder) {
      const note = (DEBIT_NOTES[company.shortCode] ?? []).find(
        (n) => n.key === def.debitNote,
      );
      if (note && !notes.has(note.key)) {
        const raised = await debitNotes.raise(
          rls,
          company.id,
          author,
          project.id,
          {
            workOrderId: workOrder.id,
            noteDate: note.noteDate,
            natureOfWork: note.natureOfWork,
            gstPercent: '18',
            taxBasis: INTRA_STATE[project.code]
              ? BillTaxBasis.intra_state
              : BillTaxBasis.inter_state,
            lines: note.lines,
          },
        );
        await prisma.billPackageDebitNote.update({
          where: { id: raised.id },
          data: { recordedAt: at(d(note.noteDate), 16, 40) },
        });
        notes.set(note.key, raised.id);
        bump('debit notes');
      }
      noteId = note ? notes.get(note.key) ?? null : null;
    }

    let view: BillPackageView = await packages.compose(rls, company.id, {
      projectId: project.id,
      direction: def.direction,
      periodFrom: def.from,
      periodTo: def.to,
      workOrderId: workOrder?.id ?? null,
      externalBillNo: def.externalBillNo ?? null,
      externalWorkOrderNo:
        def.direction === BillDirection.to_client
          ? ORDER_NUMBERS[project.code] ?? null
          : null,
    });

    if (def.direction === BillDirection.to_client) {
      view = await offsetEarlierBills(ctx, packages, view, project, def.to);
    }
    for (const cut of def.claimCuts ?? []) {
      const claim = view.claims.find((c) => c.boqNo === cut.boqNo);
      if (!claim || claim.proposedQty === null) continue;
      const claimed = round3(Number(claim.proposedQty) * cut.factor);
      if (claimed <= 0 || claimed === Number(claim.proposedQty)) continue;
      view = await packages.setClaim(rls, view.id, claim.id, {
        claimedQty: claimed.toFixed(3),
        reason: cut.reason,
      });
    }
    for (const manual of def.manualClaims ?? []) {
      const claim = view.claims.find(
        (c) => c.description === manual.description,
      );
      if (!claim) continue;
      view = await packages.setClaim(rls, view.id, claim.id, {
        claimedQty: manual.qty.toFixed(3),
      });
    }
    if (def.deductionLines?.length) {
      view = await packages.setDeductionLines(rls, view.id, def.deductionLines);
    }
    const adjustments = { ...(def.adjustments ?? {}) };
    if (noteId) {
      await debitNotes.apply(rls, noteId, view.id);
      const note = await prisma.billPackageDebitNote.findUniqueOrThrow({
        where: { id: noteId },
        select: { netAmount: true },
      });
      adjustments.debitAgainstCivil = note.netAmount.toFixed(2);
    }
    if (Object.keys(adjustments).length > 0) {
      view = await packages.setAdjustments(rls, view.id, adjustments);
    }

    const composedAt = at(addDays(d(def.to), 1), 11, 15);
    if (def.target !== 'draft' && def.issuedOn) {
      const issued = d(def.issuedOn);
      const submittedAt = at(addDays(issued, -1), 16, 10);
      const approvedAt = at(issued, 11, 40);
      const issuedAt = at(issued, 15, 30);
      // The chain's decision, as `onApprovalCompleted` records it, then the app's own issue.
      await prisma.billPackage.update({
        where: { id: view.id },
        data: {
          status: BillPackageStatus.approved,
          submittedAt,
          approvedAt,
          approvedByUserId: director,
        },
      });
      await packages.issue(rls, company.id, author, view.id);
      let certifiedAt: Date | null = null;
      if (def.target === 'certified' && def.certifiedOn) {
        certifiedAt = at(d(def.certifiedOn), 14, 5);
        const current = await packages.view(rls, view.id);
        if (def.direction === BillDirection.to_client) {
          const lines = current.claims
            .filter((c) => c.billLineId && Number(c.claimedQty) > 0)
            .map((c) => {
              const cut = def.certifyCuts?.find((x) => x.boqNo === c.boqNo);
              return {
                lineId: c.billLineId as string,
                certifiedQty: cut
                  ? round3(Number(c.claimedQty) * cut.factor)
                  : Number(c.claimedQty),
              };
            });
          await packages.certify(rls, author, view.id, {
            lines,
            remarks: def.certifyRemarks ?? null,
          });
        } else {
          const bill = await prisma.rABill.findUniqueOrThrow({
            where: { id: current.raBillId as string },
            select: { grossAmount: true },
          });
          await packages.certify(rls, director, view.id, {
            certifiedAmount: bill.grossAmount.toFixed(2),
            remarks: 'Measurement verified against the approved site reports.',
          });
        }
      }
      // Back to the dates these things happened on.
      const pkg = await prisma.billPackage.update({
        where: { id: view.id },
        data: {
          createdAt: composedAt,
          issuedAt,
          certifiedAt,
          sharedAt: at(issued, 17, 5),
          sharedByUserId: author,
          sharedTo: 'By email and hand delivery',
        },
        select: { clientBillId: true, raBillId: true },
      });
      if (pkg.clientBillId) {
        await prisma.clientBill.update({
          where: { id: pkg.clientBillId },
          data: {
            createdAt: composedAt,
            submittedAt: issuedAt,
            certifiedAt,
          },
        });
      }
      if (pkg.raBillId) {
        await prisma.rABill.update({
          where: { id: pkg.raBillId },
          data: {
            createdAt: composedAt,
            submittedAt: issuedAt,
            approvedAt: certifiedAt,
            description: `Running bill for ${def.from} to ${def.to}`,
          },
        });
        await uploadSignedCopy(
          ctx,
          SignedCopySubject.ra_bill,
          pkg.raBillId,
          addDays(issued, 2) <= ctx.today ? addDays(issued, 2) : ctx.today,
          author,
          bump,
        );
        if (def.paidOn && certifiedAt) {
          await payPackageBill(ctx, pkg.raBillId, view.id, def, author, bump);
        }
      }
    } else {
      const pkg = await prisma.billPackage.update({
        where: { id: view.id },
        data: { createdAt: composedAt },
        select: { clientBillId: true, raBillId: true },
      });
      if (pkg.clientBillId)
        await prisma.clientBill.update({
          where: { id: pkg.clientBillId },
          data: { createdAt: composedAt },
        });
      if (pkg.raBillId)
        await prisma.rABill.update({
          where: { id: pkg.raBillId },
          data: {
            createdAt: composedAt,
            description: `Running bill for ${def.from} to ${def.to}`,
          },
        });
    }
    const appliedNote = (DEBIT_NOTES[company.shortCode] ?? []).find(
      (n) => n.key === def.debitNote,
    );
    if (noteId && appliedNote && def.target !== 'draft' && def.issuedOn) {
      const note = appliedNote;
      await uploadSignedCopy(
        ctx,
        SignedCopySubject.debit_note,
        noteId,
        addDays(d(note.noteDate), 2),
        author,
        bump,
      );
    }
    bump(
      def.direction === BillDirection.to_client
        ? 'bill packages to client'
        : 'bill packages to subcontractors',
    );
  }

  // Debit notes raised but not yet recovered on any bill — the register's open items.
  for (const note of DEBIT_NOTES[company.shortCode] ?? []) {
    if (notes.has(note.key)) continue;
    const wo = workOrders.get(note.workOrder);
    if (!wo) continue;
    const project = await prisma.workOrder.findUniqueOrThrow({
      where: { id: wo.id },
      select: { projectId: true },
    });
    const exists = await prisma.billPackageDebitNote.findFirst({
      where: { workOrderId: wo.id, natureOfWork: note.natureOfWork },
      select: { id: true },
    });
    if (exists) continue;
    const raised = await debitNotes.raise(
      rls,
      company.id,
      author,
      project.projectId,
      {
        workOrderId: wo.id,
        noteDate: note.noteDate,
        natureOfWork: note.natureOfWork,
        gstPercent: '18',
        taxBasis: BillTaxBasis.intra_state,
        lines: note.lines,
      },
    );
    await prisma.billPackageDebitNote.update({
      where: { id: raised.id },
      data: { recordedAt: at(d(note.noteDate), 16, 40) },
    });
    bump('debit notes');
  }
}

/**
 * Holds a client claim to what has not been billed yet. Approved measurement in the period is the
 * proposal; where running-account bills raised on the sheet (or earlier packages) already claimed
 * part of the same work, the claim is cut by that much with the reason the sheet prints.
 */
async function offsetEarlierBills(
  ctx: CompanyContext,
  packages: BillPackageService,
  view: BillPackageView,
  project: ProjectRow,
  periodTo: string,
): Promise<BillPackageView> {
  const { prisma, company } = ctx;
  const rls = { isSuperAdmin: false, companyId: company.id };
  const [sheet, packaged, approved] = await Promise.all([
    prisma.clientBillLine.groupBy({
      by: ['boqTaskItemId'],
      where: { clientBill: { projectId: project.id, package: { is: null } } },
      _sum: { quantity: true },
    }),
    prisma.clientBillLine.groupBy({
      by: ['boqTaskItemId'],
      where: {
        clientBill: {
          projectId: project.id,
          package: {
            is: {
              status: { not: BillPackageStatus.abandoned },
              id: { not: view.id },
            },
          },
        },
      },
      _sum: { quantity: true },
    }),
    prisma.dWRTask.groupBy({
      by: ['boqItemId'],
      where: {
        dwr: {
          projectId: project.id,
          status: DwrStatus.approved,
          workDate: { lte: d(periodTo) },
        },
      },
      _sum: { actualQty: true },
    }),
  ]);
  const sheetBy = new Map(
    sheet.map((r) => [r.boqTaskItemId, r._sum.quantity?.toNumber() ?? 0]),
  );
  const packagedBy = new Map(
    packaged.map((r) => [r.boqTaskItemId, r._sum.quantity?.toNumber() ?? 0]),
  );
  const approvedBy = new Map(
    approved.map((r) => [r.boqItemId, r._sum.actualQty?.toNumber() ?? 0]),
  );
  const sheetNumbers = (
    await prisma.clientBill.findMany({
      where: { projectId: project.id, package: { is: null } },
      select: { billNumber: true },
      orderBy: { billNumber: 'asc' },
    })
  ).map((b) => b.billNumber);
  for (const claim of view.claims) {
    if (claim.proposedQty === null) continue;
    const already = sheetBy.get(claim.scheduleLineId) ?? 0;
    if (already === 0) continue;
    const allowed = round3(
      (approvedBy.get(claim.scheduleLineId) ?? 0) -
        already -
        (packagedBy.get(claim.scheduleLineId) ?? 0),
    );
    const claimed = Number(claim.claimedQty);
    if (claimed <= allowed + 0.0005) continue;
    view = await packages.setClaim(rls, view.id, claim.id, {
      claimedQty: Math.max(0, allowed).toFixed(3),
      reason: `Less the quantity already billed on ${sheetNumbers.join(', ')}.`,
    });
  }
  return view;
}

async function payPackageBill(
  ctx: CompanyContext,
  raBillId: string,
  packageId: string,
  def: PackageDef,
  userId: string | null,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company, rng } = ctx;
  const [bill, pkg] = await Promise.all([
    prisma.rABill.findUniqueOrThrow({
      where: { id: raBillId },
      select: { netPayable: true, billNumber: true },
    }),
    prisma.billPackage.findUniqueOrThrow({
      where: { id: packageId },
      select: { tdsAmount: true },
    }),
  ]);
  const share = def.paidShare ?? 1;
  const amount =
    share >= 1
      ? bill.netPayable
      : bill.netPayable.times(share).toDecimalPlaces(0);
  if (amount.lessThanOrEqualTo(0)) return;
  await prisma.rABillPayment.create({
    data: {
      companyId: company.id,
      raBillId,
      paidOn: d(def.paidOn ?? iso(ctx.today)),
      amount,
      instrument: PaymentInstrument.bank_transfer,
      mode: amount.greaterThanOrEqualTo(200000) ? 'RTGS' : 'NEFT',
      reference: `UTR ${utr(rng)}`,
      transactionNo: `R5${rng.int(1000000, 9999999)}${rng.int(100000, 999999)}`,
      tdsAmount: share >= 1 ? pkg.tdsAmount : dec(0),
      particulars: `PV/${rng.int(120, 480)}/2026-27`,
      remarks:
        share >= 1
          ? `Full payment against ${bill.billNumber}.`
          : `Part payment against ${bill.billNumber}; balance on receipt of the client's IPC.`,
      recordedByUserId: userId,
      recordedAt: at(d(def.paidOn ?? iso(ctx.today)), 17, 20),
    },
  });
  bump('RA bill payments');
}

const utr = (rng: Rng) =>
  `SBIN${rng.int(100000, 999999)}${rng.int(100000, 999999)}`;

async function uploadSignedCopy(
  ctx: CompanyContext,
  subjectType: SignedCopySubject,
  subjectId: string,
  receivedOn: Date,
  userId: string | null,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company } = ctx;
  const exists = await prisma.signedCopy.findFirst({
    where: { subjectType, subjectId },
    select: { id: true },
  });
  if (exists) return;
  let title: string;
  let body: string;
  let fileName: string;
  if (subjectType === SignedCopySubject.ra_bill) {
    const bill = await prisma.rABill.findUniqueOrThrow({
      where: { id: subjectId },
      select: {
        billNumber: true,
        grossAmount: true,
        netPayable: true,
        billingDate: true,
        workOrder: { select: { code: true, workDetail: true } },
      },
    });
    title = `${bill.billNumber} — acknowledged copy`;
    body =
      `Work order: ${bill.workOrder?.code ?? '—'} — ${
        bill.workOrder?.workDetail ?? ''
      }\n` +
      `Bill date: ${iso(bill.billingDate)}\nValue of work done: Rs ${inr(
        bill.grossAmount,
      )}\n` +
      `Net payable: Rs ${inr(
        bill.netPayable,
      )}\n\nReceived and accepted the above bill with its ` +
      `measurement sheets and deductions.\n\nSignature and seal of the subcontractor\nDate: ${iso(
        receivedOn,
      )}`;
    fileName = `${bill.billNumber.replace(/\//g, '-')} signed.pdf`;
  } else {
    const note = await prisma.billPackageDebitNote.findUniqueOrThrow({
      where: { id: subjectId },
      select: { noteNumber: true, netAmount: true, natureOfWork: true },
    });
    title = `Debit note ${note.noteNumber} — acknowledged copy`;
    body =
      `${note.natureOfWork ?? ''}\nNet amount including GST: Rs ${inr(
        note.netAmount,
      )}\n\n` +
      `Accepted; to be recovered from our running bill.\n\nSignature and seal of the subcontractor\n` +
      `Date: ${iso(receivedOn)}`;
    fileName = `Debit note ${String(note.noteNumber).replace(
      /\//g,
      '-',
    )} signed.pdf`;
  }
  const pdf = await ctx.renderPdf(title, body);
  const fileRef = await ctx.writeBlob(`signed-copies/${company.id}`, pdf);
  await prisma.signedCopy.create({
    data: {
      companyId: company.id,
      subjectType,
      subjectId,
      fileRef,
      fileName,
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      receivedOn,
      uploadedByUserId: userId,
      uploadedAt: at(receivedOn, 12, 30),
    },
  });
  if (subjectType === SignedCopySubject.ra_bill) {
    await prisma.rABill.updateMany({
      where: { id: subjectId, acknowledgedAt: null },
      data: { acknowledgedAt: receivedOn },
    });
  }
  bump('signed copies');
}

// ─── The base seed's subcontractor bills: acknowledgement and payment ─────────

async function seedLegacyPayments(
  ctx: CompanyContext,
  people: People,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company, rng } = ctx;
  // Bills raised on the sheet rather than through a package, already certified.
  const bills = await prisma.rABill.findMany({
    where: { companyId: company.id, status: 'approved', package: null },
    select: {
      id: true,
      billNumber: true,
      billingDate: true,
      grossAmount: true,
      netPayable: true,
      _count: { select: { payments: true } },
    },
    orderBy: { billingDate: 'asc' },
  });
  for (const [index, bill] of bills.entries()) {
    await uploadSignedCopy(
      ctx,
      SignedCopySubject.ra_bill,
      bill.id,
      addDays(bill.billingDate, 3),
      people.accountsUserId,
      bump,
    );
    if (bill._count.payments > 0) continue;
    const tds = round2(bill.grossAmount.toNumber() * 0.02);
    if (index % 2 === 0) {
      // Paid in full: the transfer, and the TDS deposited against it.
      const paidOn = addDays(bill.billingDate, 24);
      await prisma.rABillPayment.createMany({
        data: [
          {
            companyId: company.id,
            raBillId: bill.id,
            paidOn,
            amount: dec(round2(bill.netPayable.toNumber() - tds)),
            instrument: PaymentInstrument.bank_transfer,
            mode: 'NEFT',
            reference: `UTR ${utr(rng)}`,
            transactionNo: `N${rng.int(100000000, 999999999)}`,
            tdsAmount: dec(tds),
            particulars: `PV/${rng.int(40, 119)}/2026-27`,
            remarks: `Payment against ${bill.billNumber}, net of TDS u/s 194C.`,
            recordedByUserId: people.accountsUserId,
            recordedAt: at(paidOn, 17, 10),
          },
          {
            companyId: company.id,
            raBillId: bill.id,
            paidOn,
            amount: dec(tds),
            instrument: PaymentInstrument.adjustment,
            reference: `TDS challan ${rng.int(10000, 99999)}`,
            tdsAmount: dec(0),
            remarks: `TDS u/s 194C @ 2% deducted on ${bill.billNumber} and deposited.`,
            recordedByUserId: people.accountsUserId,
            recordedAt: at(paidOn, 17, 12),
          },
        ],
      });
      bump('RA bill payments', 2);
    } else {
      // On account, the balance still owed.
      const paidOn = addDays(bill.billingDate, 24);
      const amount = Math.min(
        50000,
        Math.floor(bill.netPayable.toNumber() / 2),
      );
      if (amount <= 0 || paidOn > ctx.today) continue;
      await prisma.rABillPayment.create({
        data: {
          companyId: company.id,
          raBillId: bill.id,
          paidOn,
          amount: dec(amount),
          instrument: PaymentInstrument.cheque,
          mode: 'Cheque',
          reference: `Cheque ${rng.int(
            100000,
            999999,
          )}, State Bank of India, Deoli`,
          tdsAmount: dec(0),
          particulars: `PV/${rng.int(120, 300)}/2026-27`,
          remarks: `On-account payment against ${bill.billNumber}.`,
          recordedByUserId: people.accountsUserId,
          recordedAt: at(paidOn, 16, 45),
        },
      });
      bump('RA bill payments');
    }
  }
}

// ─── Client receipts ───────────────────────────────────────────────────────────

async function seedRevenue(
  ctx: CompanyContext,
  projects: ProjectRow[],
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company, rng, today } = ctx;
  const rates = await prisma.company.findUniqueOrThrow({
    where: { id: company.id },
    select: {
      cgstFraction: true,
      sgstFraction: true,
      igstFraction: true,
      tdsFraction: true,
      gstTdsFraction: true,
      bocwCessRate: true,
    },
  });
  for (const project of projects) {
    // Once per bill: a receipt names its bill first, so a bill with one is skipped.
    const recorded = await prisma.revenue.findMany({
      where: { projectId: project.id },
      select: { id: true, description: true, status: true },
    });
    const flags = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { cgstApplicable: true, clientRetentionFraction: true },
    });
    const bills = await prisma.clientBill.findMany({
      where: { projectId: project.id, status: { not: 'draft' } },
      select: {
        billNumber: true,
        billingDate: true,
        grossAmount: true,
        certifiedAmount: true,
        certifiedAt: true,
        package: { select: { taxBasis: true } },
      },
      orderBy: { billingDate: 'asc' },
    });
    const intra = bills[0]?.package
      ? bills[0].package.taxBasis === BillTaxBasis.intra_state
      : flags.cgstApplicable;
    const gst = intra
      ? rates.cgstFraction.plus(rates.sgstFraction).toNumber()
      : rates.igstFraction.toNumber();
    const held =
      (flags.clientRetentionFraction?.toNumber() ?? 0.05) +
      rates.tdsFraction.toNumber() +
      rates.gstTdsFraction.toNumber() +
      rates.bocwCessRate.toNumber();
    const client = project.client.name.replace(/ — .*/, '');
    const rows: Prisma.RevenueCreateManyInput[] = [];
    for (const bill of bills) {
      const prior = recorded.find((r) =>
        r.description.startsWith(`${bill.billNumber} `),
      );
      if (prior) {
        // A receipt written while the bill awaited certification is re-stated once it is certified.
        const stale =
          prior.status === 'pending' &&
          bill.certifiedAt !== null &&
          prior.description.includes('awaiting certification');
        if (!stale) continue;
        await prisma.revenue.delete({ where: { id: prior.id } });
      }
      const base = (bill.certifiedAmount ?? bill.grossAmount).toNumber();
      const amount = round2(base * (1 + gst - held));
      const due = bill.certifiedAt
        ? addDays(bill.certifiedAt, rng.int(6, 12))
        : null;
      if (due && dateOnlyUtc(due) <= today) {
        rows.push({
          companyId: company.id,
          projectId: project.id,
          description:
            `${bill.billNumber} — released by ${client}: certified Rs ${inr(
              base,
            )} plus GST, ` + `less retention, TDS, GST-TDS and BOCW cess`,
          amount: dec(amount),
          date: dateOnlyUtc(due),
          status: 'received',
        });
      } else {
        rows.push({
          companyId: company.id,
          projectId: project.id,
          description: bill.certifiedAt
            ? `${bill.billNumber} — certified, release awaited from ${client}`
            : `${bill.billNumber} — awaiting certification by ${client}`,
          amount: dec(amount),
          date: bill.billingDate,
          status: 'pending',
        });
      }
    }
    if (rows.length) {
      await prisma.revenue.createMany({ data: rows });
      bump('client receipts', rows.length);
    }
  }
}

const dateOnlyUtc = (t: Date) =>
  new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));

// ─── Budgets ───────────────────────────────────────────────────────────────────

async function seedBudgets(
  ctx: CompanyContext,
  projects: ProjectRow[],
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company, rng } = ctx;
  for (const project of projects) {
    const have = await prisma.projectBudget.findMany({
      where: { projectId: project.id },
      select: { category: true },
    });
    const missing = (
      Object.keys(BUDGET_SHARES) as ProjectBudgetCategory[]
    ).filter((c) => !have.some((h) => h.category === c));
    if (missing.length === 0) continue;
    // O&M work is labour and machinery heavy, light on materials.
    const om = /O&M|Operation and Maintenance/i.test(project.name);
    const value = project.contractValue.toNumber();
    await prisma.projectBudget.createMany({
      data: missing.map((category) => {
        let share = BUDGET_SHARES[category];
        if (om && category === 'materials') share = 0.26;
        if (om && category === 'labour') share = 0.2;
        share *= 0.92 + rng.rand() * 0.16;
        return {
          companyId: company.id,
          projectId: project.id,
          category,
          amount: dec(Math.round((value * share) / 10000) * 10000),
        };
      }),
    });
    bump('budget heads', missing.length);
  }
}

// ─── Bank guarantee scans ──────────────────────────────────────────────────────

async function seedBankGuaranteeScans(
  ctx: CompanyContext,
  people: People,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, company } = ctx;
  const guarantees = await prisma.bankGuarantee.findMany({
    where: { companyId: company.id, bgNumber: { not: null } },
    select: {
      id: true,
      type: true,
      bgNumber: true,
      amount: true,
      issueDate: true,
      expiryDate: true,
      claimPeriodEndDate: true,
      issuingBank: true,
      issuingBranch: true,
      status: true,
      releasedOn: true,
      tender: { select: { workName: true, departmentName: true } },
      _count: { select: { documents: true } },
    },
    orderBy: { issueDate: 'asc' },
  });
  // The most recently issued one is still waiting to be scanned, as one always is.
  const newest = guarantees[guarantees.length - 1]?.id;
  for (const bg of guarantees) {
    if (bg._count.documents > 0 || bg.id === newest) continue;
    const kind =
      bg.type === 'EMD' ? 'Earnest Money Deposit' : 'Performance Security';
    const pdf = await ctx.renderPdf(
      `${bg.issuingBank ?? 'Bank'} — Bank Guarantee No. ${bg.bgNumber}`,
      `Branch: ${bg.issuingBranch ?? '—'}\n\nTo: ${
        bg.tender.departmentName
      }\n\n` +
        `In consideration of ${company.name} having submitted a tender for "${bg.tender.workName}", ` +
        `we, ${
          bg.issuingBank ?? 'the bank'
        }, hereby irrevocably and unconditionally undertake to pay ` +
        `on demand any sum up to Rs ${inr(bg.amount)} towards ${kind}.\n\n` +
        `Date of issue: ${bg.issueDate ? iso(bg.issueDate) : '—'}\n` +
        `Valid up to: ${bg.expiryDate ? iso(bg.expiryDate) : '—'}\n` +
        (bg.claimPeriodEndDate
          ? `Claim period up to: ${iso(bg.claimPeriodEndDate)}\n`
          : '') +
        `\nFor ${bg.issuingBank ?? 'the bank'}\nAuthorised Signatory`,
    );
    const docs = [
      {
        title: 'BG copy',
        bytes: pdf,
        name: `BG ${bg.bgNumber}.pdf`,
        on: bg.issueDate,
      },
    ];
    if (bg.status === 'RELEASED' && bg.releasedOn) {
      docs.push({
        title: 'Release letter',
        bytes: await ctx.renderPdf(
          `Release of Bank Guarantee No. ${bg.bgNumber}`,
          `${
            bg.tender.departmentName
          }\n\nThe ${kind.toLowerCase()} furnished by ${company.name} ` +
            `against "${bg.tender.workName}" is no longer required and is hereby released. ` +
            `The bank is requested to cancel the guarantee and release the margin.\n\nDate: ${iso(
              bg.releasedOn,
            )}`,
        ),
        name: `BG ${bg.bgNumber} release letter.pdf`,
        on: bg.releasedOn,
      });
    }
    for (const doc of docs) {
      const fileRef = await ctx.writeBlob(
        `bank-guarantees/${company.id}`,
        doc.bytes,
      );
      await prisma.bankGuaranteeDocument.create({
        data: {
          companyId: company.id,
          bankGuaranteeId: bg.id,
          title: doc.title,
          fileRef,
          fileName: doc.name,
          contentType: 'application/pdf',
          sizeBytes: doc.bytes.length,
          uploadedByUserId:
            people.accountsUserId ?? people.approverUserId ?? '',
          uploadedAt: doc.on ? at(addDays(doc.on, 2), 12, 0) : new Date(),
        },
      });
      bump('bank guarantee documents');
    }
  }
}
