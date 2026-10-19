/**
 * Plant completion: the machinery screens a road contractor's register actually fills.
 *
 * The base seed gives each company five machines with a month of logbook, fuel, services,
 * maintenance and two hire bills on the hired crane. This adds what a production company holds
 * beside them:
 *
 * - a road fleet — excavator, motor grader, tandem roller, hot-mix plant, tippers, water tanker,
 *   transit mixer — with their logbook and fuel history built the way the base seed builds it
 *   (logbook first, fuel and services derived from it), and the base machines' make, model,
 *   registration and purchase particulars;
 * - hired-in machinery (soil compactor, sensor paver, tipper) from plant-hire vendors, with the
 *   hire orders they came on and monthly / hourly hire bills raised against the logbook;
 * - each machine's registration papers and their scanned copies, a couple expiring soon so the
 *   reminder bell has something to say, and a photograph;
 * - fuel variance exceptions for every alerted fill (what the "raise" sweep would create), some
 *   reviewed — one recovered from a hirer's bill, operator recoveries through the approval chain;
 * - one sold machine (Parth Realcon), with the site release and history events disposal writes.
 *
 * Every derived figure goes through the API's own functions (variance, shortfall, hire-bill
 * arithmetic, book value, equipment codes, numbering) so the seeded rows are what the services
 * would have written.
 */
import { MeterType, Prisma } from '@prisma/client';
import type { Sharp, SharpOptions } from 'sharp';

import { bookValue } from '../../src/assets/depreciation';
import {
  computeFuelShortfall,
  computeFuelVariance,
} from '../../src/plant/fuel/fuel.service';
import {
  computeHireBillAmounts,
  expectedDiesel,
  monthlyGross,
} from '../../src/plant/hire-bills/hire-bills.service';
import { compressImageUpload } from '../../src/common/uploads/image-variants';
import {
  NAMED_SERIES_DEFAULT,
  namedCode,
  namedPrefixFor,
  namedSerialOf,
} from '../../src/settings/code-series/code-series.formats';
import { CodeSeriesService } from '../../src/settings/code-series/code-series.service';
import { at, type CompanyContext, type ModuleResult, money } from './support';

// Reached through a typed `require`, as `src/common/uploads/image-variants.ts` does.
type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: SharpFactory = require('sharp');

// ─── Small helpers ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const iso = (t: Date) => t.toISOString().slice(0, 10);
const ddmmyyyy = (t: Date) => iso(t).split('-').reverse().join('.');
const addDays = (t: Date, n: number) => new Date(t.getTime() + n * DAY_MS);
const addYears = (t: Date, n: number) =>
  new Date(Date.UTC(t.getUTCFullYear() + n, t.getUTCMonth(), t.getUTCDate()));
const ymd = (s: string) => new Date(`${s}T00:00:00.000Z`);
const inr = (n: number) =>
  n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A GSTIN with a correct check character (the mod-36 Luhn variant GSTN uses). */
function gstin(stateCode: string, pan: string): string {
  const body = `${stateCode}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const product = GST_CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return body + GST_CHARS[(36 - (sum % 36)) % 36];
}

// ─── What each company runs ───────────────────────────────────────────────────

type Papers = 'road' | 'cev' | 'offroad' | 'plant';
type PaperKind =
  | 'rc'
  | 'insurance'
  | 'fitness'
  | 'road_tax'
  | 'permit'
  | 'pollution';

interface VendorSpec {
  key: string;
  name: string;
  city: string;
  state: string;
  stateCode: string;
  pin: string;
  pan: string;
  address: string;
  bank: { name: string; branch: string; ifsc: string; account: string };
}

interface MachineSpec {
  /** Stable identity across reruns (stored as the chassis number). */
  chassisNo: string;
  name: string;
  category: string;
  power: 'diesel' | 'petrol' | 'electric' | 'manual';
  ownership: 'owned' | 'hired';
  vendor?: string;
  make: string;
  model: string;
  year: number;
  registrationNo?: string;
  engineNo: string;
  supplierName?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  depreciationRate?: number;
  /** The project code whose site the machine stands at. */
  project: string;
  operatorName: string;
  start: number;
  perDay: number;
  spread: number;
  /** Litres per meter unit actually burned; 0 for a machine on grid / plant power. */
  fuelPerUnit: number;
  /** First logbook day, as days before today. */
  fromDaysAgo: number;
  /** Last logbook day, as days before today (1 = yesterday). */
  toDaysAgo?: number;
  idleChance: number;
  papers: Papers;
  /** Paper expiries pinned relative to today (days); the rest fall 4–11 months out. */
  expiries?: Partial<Record<PaperKind, number>>;
  /** Fills (counted back from the latest, 1 = latest) where the day's burn breached benchmark. */
  leakyFills?: number[];
  service?: { type: string; interval: number };
  photo?: { body: string; accent: string };
  remarks: string[];
  /** The one sold machine. */
  sold?: {
    daysAgo: number;
    buyer: string;
    contact: string;
    amount: number;
    invoice: string;
  };
}

interface HireOrderSpec {
  vendor: string;
  /** Days before today. */
  daysAgo: number;
  project: string;
  referenceNo: string;
  remarks: string;
  lines: {
    machine?: string; // chassisNo of the machine the line hires
    baseCode?: string; // or a base-seed machine by code suffix
    title: string;
    description: string;
    quantity: number;
    uom: string;
    rate: number;
  }[];
}

interface HireBillSpec {
  machine: string;
  from: string;
  to: string;
  basis: 'monthly' | 'hours';
  rate: number;
  status: 'paid' | 'verified' | 'pending_verification';
  invoiceNo: string;
  /** Vendor claims a little over the log on an hourly bill. */
  claimFactor?: number;
  /** Diesel issued by the company is deducted on a wet-rate hire. */
  deductDiesel?: boolean;
  holdAmount?: number;
  description: string;
}

interface CompanyPlan {
  vendors: VendorSpec[];
  machines: MachineSpec[];
  /** Base-seed machines' particulars, by code suffix. */
  base: Record<string, Partial<MachineSpec> & { papers: Papers }>;
  orders: HireOrderSpec[];
  bills: HireBillSpec[];
}

const BLUE_ROLLER = { body: '#f2b705', accent: '#2b2b2b' };

const PLANS: Record<string, CompanyPlan> = {
  PRPL: {
    vendors: [
      {
        key: 'balaji',
        name: 'Shree Balaji Earthmovers',
        city: 'Tonk',
        state: 'Rajasthan',
        stateCode: '08',
        pin: '304001',
        pan: 'AAKFS4127M',
        address: 'Plot 14, Transport Nagar, Jaipur Road',
        bank: {
          name: 'State Bank of India',
          branch: 'Tonk Main',
          ifsc: 'SBIN0031046',
          account: '38211740552',
        },
      },
      {
        key: 'rajputana',
        name: 'Rajputana Road Equipments',
        city: 'Jaipur',
        state: 'Rajasthan',
        stateCode: '08',
        pin: '302013',
        pan: 'AAHFR8834K',
        address: 'F-112, Road No. 9, VKI Area',
        bank: {
          name: 'HDFC Bank',
          branch: 'VKI Area, Jaipur',
          ifsc: 'HDFC0002644',
          account: '50200061873194',
        },
      },
    ],
    base: {
      'EQ-EXC-01': {
        make: 'JCB',
        model: '3DX Super',
        year: 2019,
        registrationNo: 'RJ26-GA-0917',
        engineNo: 'SB320/40127/U2219',
        chassisNo: 'JCB3DXSCJK2848811',
        supplierName: 'Shree Ganesh Earthmovers, Jaipur',
        purchaseDate: '2019-07-16',
        purchaseCost: 3150000,
        depreciationRate: 15,
        operatorName: 'Bhanwar Lal Mali',
        papers: 'cev',
      },
      'EQ-TRN-01': {
        make: 'Tata Motors',
        model: 'LPT 1613 Tipper',
        year: 2017,
        registrationNo: 'RJ26-GA-4402',
        engineNo: '697TC61HVZ804417',
        chassisNo: 'MAT447218H2F31604',
        supplierName: 'Bhandari Automobiles, Tonk',
        purchaseDate: '2017-11-03',
        purchaseCost: 1780000,
        depreciationRate: 15,
        operatorName: 'Sukhdev Gurjar',
        papers: 'road',
        expiries: { insurance: 19 },
      },
      'EQ-CRN-01': {
        make: 'Escorts',
        model: 'Hydra 14',
        year: 2018,
        registrationNo: 'RJ14-GC-2207',
        engineNo: 'EK41Y0026518',
        chassisNo: 'ESCHYD14N180331',
        operatorName: 'Ramkishan (vendor operator)',
        vendor: 'sundaram',
        papers: 'road',
        expiries: { fitness: 26 },
      },
      'EQ-CNC-01': {
        make: 'Schwing Stetter',
        model: 'CP 30',
        year: 2020,
        engineNo: 'SS-CP30-20-1184',
        chassisNo: 'SSCP30200118',
        supplierName: 'Schwing Stetter (India) Pvt Ltd',
        purchaseDate: '2020-12-08',
        purchaseCost: 6800000,
        depreciationRate: 10,
        operatorName: 'Gopal Bairwa',
        papers: 'plant',
      },
      'EQ-GEN-01': {
        make: 'Kirloskar',
        model: 'KG1-125AS',
        year: 2021,
        engineNo: 'KG1125-21-77341',
        chassisNo: 'KOELDG125A21773',
        supplierName: 'Kirloskar Oil Engines — Jaipur dealer',
        purchaseDate: '2021-04-22',
        purchaseCost: 985000,
        depreciationRate: 15,
        operatorName: 'Gopal Bairwa',
        papers: 'plant',
      },
    },
    machines: [
      {
        chassisNo: 'THZX220CL22K0457',
        name: 'Tata Hitachi Zaxis 220 Excavator',
        category: 'EXCAVATOR',
        power: 'diesel',
        ownership: 'owned',
        make: 'Tata Hitachi',
        model: 'Zaxis 220 LC',
        year: 2022,
        registrationNo: 'RJ26-GA-3317',
        engineNo: '6BG1-TQA-224871',
        supplierName: 'Tata Hitachi — Sanghi Earthmovers, Jaipur',
        purchaseDate: '2022-03-18',
        purchaseCost: 9640000,
        depreciationRate: 15,
        project: 'PRPL-2501',
        operatorName: 'Bhanwar Lal Mali',
        start: 5812,
        perDay: 8,
        spread: 3,
        fuelPerUnit: 14.2,
        fromDaysAgo: 46,
        idleChance: 0.1,
        papers: 'cev',
        expiries: { insurance: 37 },
        leakyFills: [1, 3, 6],
        service: {
          type: 'Engine oil, fuel & hydraulic filter change',
          interval: 250,
        },
        photo: { body: '#f28c00', accent: '#1f1f1f' },
        remarks: [
          'Embankment cutting Km 314+200 to 314+650',
          'Loading tippers at borrow area, Sodra village',
          'Drain excavation LHS Km 318+100',
          'Subgrade preparation Km 320 stretch',
        ],
      },
      {
        chassisNo: 'CAT0120KJ8N01933',
        name: 'CAT 120 Motor Grader',
        category: 'MOTOR GRADER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Caterpillar',
        model: '120 GC',
        year: 2021,
        registrationNo: 'RJ26-GA-2864',
        engineNo: 'C7.1-ACERT-N8J21604',
        supplierName: 'GMMCO Ltd, Jaipur',
        purchaseDate: '2021-09-27',
        purchaseCost: 13200000,
        depreciationRate: 15,
        project: 'PRPL-2501',
        operatorName: 'Jagdish Prasad Meena',
        start: 4127,
        perDay: 7,
        spread: 2.5,
        fuelPerUnit: 10.6,
        fromDaysAgo: 46,
        idleChance: 0.14,
        papers: 'cev',
        service: { type: 'Engine oil & filter change', interval: 250 },
        photo: { body: '#f2b705', accent: '#262626' },
        remarks: [
          'GSB spreading and grading Km 315+000 to 315+500',
          'WMM grading LHS carriageway',
          'Camber correction, service road',
        ],
      },
      {
        chassisNo: 'HAMMHD99T23H1207',
        name: 'Hamm Tandem Roller HD 99',
        category: 'COMPACTOR',
        power: 'diesel',
        ownership: 'owned',
        make: 'Hamm (Wirtgen India)',
        model: 'HD 99',
        year: 2023,
        engineNo: 'TCD3.6L4-23-118842',
        supplierName: 'Wirtgen India Pvt Ltd',
        purchaseDate: '2023-02-10',
        purchaseCost: 5650000,
        depreciationRate: 15,
        project: 'PRPL-2501',
        operatorName: 'Mukesh Kumar Bairwa',
        start: 2386,
        perDay: 7.5,
        spread: 2.5,
        fuelPerUnit: 6.1,
        fromDaysAgo: 46,
        idleChance: 0.12,
        papers: 'offroad',
        service: {
          type: 'Engine oil, vibration bearing grease',
          interval: 250,
        },
        photo: BLUE_ROLLER,
        remarks: [
          'DBM rolling Km 316+000 to 316+400',
          'BC breakdown rolling behind paver',
          'Finish rolling, RHS carriageway',
        ],
      },
      {
        chassisNo: 'APLANP1200HM2009',
        name: 'Hot Mix Plant Apollo 120 TPH',
        category: 'HOT MIX PLANT',
        power: 'electric',
        ownership: 'owned',
        make: 'Apollo Infratech',
        model: 'ANP 1200 Drum Mix',
        year: 2020,
        engineNo: 'ANP1200-20-0418',
        supplierName: 'Apollo Infratech Pvt Ltd, Mehsana',
        purchaseDate: '2020-10-14',
        purchaseCost: 28500000,
        depreciationRate: 10,
        project: 'PRPL-2502',
        operatorName: 'Rameshwar Lal Sharma',
        start: 6904,
        perDay: 9,
        spread: 3,
        fuelPerUnit: 0,
        fromDaysAgo: 46,
        idleChance: 0.18,
        papers: 'plant',
        service: { type: 'Burner, drum & bag-filter service', interval: 500 },
        photo: { body: '#e8e3d3', accent: '#b3261e' },
        remarks: [
          'DBM Grade-II production for Deoli–Uniyara Km 6 to 9',
          'BC production, 40 mm',
          'Plant calibration and trial mix',
        ],
      },
      {
        chassisNo: 'MAT828061P7J22715',
        name: 'Tata Signa 2823 Tipper',
        category: 'TIPPER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Tata Motors',
        model: 'Signa 2823.K',
        year: 2023,
        registrationNo: 'RJ26-GB-4821',
        engineNo: '5.6NGD-23-K7J41209',
        supplierName: 'Bhandari Automobiles, Tonk',
        purchaseDate: '2023-07-05',
        purchaseCost: 4680000,
        depreciationRate: 15,
        project: 'PRPL-2502',
        operatorName: 'Sukhdev Gurjar',
        start: 61840,
        perDay: 128,
        spread: 50,
        fuelPerUnit: 0.29,
        fromDaysAgo: 46,
        idleChance: 0.1,
        papers: 'road',
        service: { type: 'Full service & oil change', interval: 10000 },
        photo: { body: '#2f6db5', accent: '#e8e8e8' },
        remarks: [
          'Murrum haulage from Bassi borrow pit',
          'Aggregate from Banas crusher to HMP',
          'GSB material to Km 7 stretch',
        ],
      },
      {
        chassisNo: 'MB1PBEFC2KPLM6610',
        name: 'Ashok Leyland Water Tanker 12 KL',
        category: 'WATER TANKER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Ashok Leyland',
        model: '1616 IL with 12 KL tank',
        year: 2019,
        registrationNo: 'RJ26-GA-1194',
        engineNo: 'H6-IL-19-KP37720',
        supplierName: 'Shakti Motors, Jaipur',
        purchaseDate: '2019-05-21',
        purchaseCost: 2460000,
        depreciationRate: 15,
        project: 'PRPL-2501',
        operatorName: 'Prahlad Saini',
        start: 98410,
        perDay: 74,
        spread: 30,
        fuelPerUnit: 0.24,
        fromDaysAgo: 46,
        idleChance: 0.1,
        papers: 'road',
        expiries: { pollution: -6 },
        service: { type: 'Full service & oil change', interval: 10000 },
        photo: { body: '#c62828', accent: '#f5f5f5' },
        remarks: [
          'Water sprinkling on haul road, dust suppression',
          'Curing of culvert and drain',
          'Water for embankment compaction (OMC)',
        ],
      },
      {
        chassisNo: 'VCESD110C21P04478',
        name: 'Volvo Soil Compactor SD110',
        category: 'COMPACTOR',
        power: 'diesel',
        ownership: 'hired',
        vendor: 'balaji',
        make: 'Volvo CE',
        model: 'SD110C',
        year: 2021,
        engineNo: 'D4.8-21-VCE118023',
        project: 'PRPL-2501',
        operatorName: 'Hukam Singh (vendor operator)',
        start: 3926,
        perDay: 8,
        spread: 2,
        fuelPerUnit: 7.4,
        fromDaysAgo: 60,
        idleChance: 0.08,
        papers: 'offroad',
        leakyFills: [2, 7],
        remarks: [
          'Embankment compaction Km 316+200 to 316+600',
          'Subgrade compaction, 97% MDD',
          'Shoulder compaction RHS',
        ],
      },
      {
        chassisNo: 'VGL18003I21W0912',
        name: 'Vogele Paver Super 1800-3i',
        category: 'PAVER',
        power: 'diesel',
        ownership: 'hired',
        vendor: 'rajputana',
        make: 'Vogele (Wirtgen Group)',
        model: 'Super 1800-3i',
        year: 2021,
        engineNo: 'TCD6.1-21-V0912',
        project: 'PRPL-2501',
        operatorName: 'Salim Khan (vendor operator)',
        start: 7215,
        perDay: 7.5,
        spread: 2.5,
        fuelPerUnit: 13.1,
        fromDaysAgo: 44,
        idleChance: 0.15,
        papers: 'offroad',
        remarks: [
          'DBM laying 50 mm, Km 316+000 to 316+450',
          'BC laying RHS carriageway',
          'Sensor paving with string line',
        ],
      },
      {
        chassisNo: 'MAT466307K3C11986',
        name: 'Tata LPK 2518 Tipper',
        category: 'TIPPER',
        power: 'diesel',
        ownership: 'hired',
        vendor: 'balaji',
        make: 'Tata Motors',
        model: 'LPK 2518',
        year: 2020,
        registrationNo: 'RJ26-GA-5530',
        engineNo: '697TC62CVY401255',
        project: 'PRPL-2501',
        operatorName: 'Raju Bairwa (vendor driver)',
        start: 182300,
        perDay: 118,
        spread: 45,
        fuelPerUnit: 0.29,
        fromDaysAgo: 48,
        idleChance: 0.1,
        papers: 'road',
        remarks: [
          'Earth haulage from Sodra borrow area',
          'Debris removal, Km 312 junction',
        ],
      },
      {
        chassisNo: 'MAT448123E2N17703',
        name: 'Tata LPT 2518 Tipper',
        category: 'TIPPER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Tata Motors',
        model: 'LPT 2518 TC',
        year: 2014,
        registrationNo: 'RJ26-GA-0817',
        engineNo: '697TC59BRY611482',
        supplierName: 'Bhandari Automobiles, Tonk',
        purchaseDate: '2014-06-12',
        purchaseCost: 2140000,
        depreciationRate: 7.5,
        project: 'PRPL-2502',
        operatorName: 'Sukhdev Gurjar',
        start: 412650,
        perDay: 96,
        spread: 40,
        fuelPerUnit: 0.31,
        fromDaysAgo: 80,
        toDaysAgo: 26,
        idleChance: 0.2,
        papers: 'road',
        expiries: {
          insurance: 170,
          fitness: 150,
          permit: 210,
          pollution: 120,
          road_tax: 160,
        },
        remarks: ['Aggregate haulage to HMP', 'Murrum haulage, Km 9 stretch'],
        sold: {
          daysAgo: 22,
          buyer: 'Shree Shyam Truck Bazaar, Tonk',
          contact: '98290 41637',
          amount: 415000,
          invoice: 'PRPL/ASSET-SALE/26-27/003',
        },
      },
    ],
    orders: [
      {
        vendor: 'sundaram',
        daysAgo: 68,
        project: 'PRPL-2503',
        referenceNo: 'PRPL/PLANT/HO/26-27/011',
        remarks:
          'Hydra with operator for culvert pipe and precast drain placement. Diesel by vendor.',
        lines: [
          {
            baseCode: 'EQ-CRN-01',
            title:
              'Hiring of Escorts Hydra 14T mobile crane for Deva Khera–Dhor Road',
            description: 'Crane hire services with operator - Hours',
            quantity: 500,
            uom: 'HRS',
            rate: 1450,
          },
        ],
      },
      {
        vendor: 'balaji',
        daysAgo: 66,
        project: 'PRPL-2501',
        referenceNo: 'PRPL/PLANT/HO/26-27/012',
        remarks:
          'Dry hire: diesel issued by PRPL from site stock, average 8 L/hr (compactor) and 3.5 km/L (tipper). Operator / driver by vendor.',
        lines: [
          {
            machine: 'VCESD110C21P04478',
            title:
              'Hiring of Volvo SD110 soil compactor for embankment and subgrade',
            description: 'Machinery hire services-Months',
            quantity: 3,
            uom: 'MON',
            rate: 185000,
          },
          {
            machine: 'MAT466307K3C11986',
            title: 'Hiring of Tata LPK 2518 tipper (16 cum) for earth haulage',
            description: 'Goods transport vehicle hire services-Months',
            quantity: 3,
            uom: 'MON',
            rate: 112000,
          },
        ],
      },
      {
        vendor: 'rajputana',
        daysAgo: 50,
        project: 'PRPL-2501',
        referenceNo: 'PRPL/PLANT/HO/26-27/015',
        remarks:
          'Sensor paver with operator and screed man. HSD issued by PRPL to be deducted at actuals from each bill.',
        lines: [
          {
            machine: 'VGL18003I21W0912',
            title:
              'Hiring of Vogele Super 1800-3i sensor paver for DBM / BC laying',
            description: 'Machinery hire services-Hours',
            quantity: 450,
            uom: 'HRS',
            rate: 2650,
          },
        ],
      },
    ],
    bills: [
      {
        machine: 'VCESD110C21P04478',
        from: 'P1',
        to: 'P1',
        basis: 'monthly',
        rate: 185000,
        status: 'paid',
        invoiceNo: 'SBE/26-27/118',
        description: 'Volvo SD110 soil compactor hire',
      },
      {
        machine: 'VCESD110C21P04478',
        from: 'P2',
        to: 'P2',
        basis: 'monthly',
        rate: 185000,
        status: 'verified',
        invoiceNo: 'SBE/26-27/141',
        description: 'Volvo SD110 soil compactor hire',
      },
      {
        machine: 'MAT466307K3C11986',
        from: 'P2',
        to: 'P2',
        basis: 'monthly',
        rate: 112000,
        status: 'paid',
        invoiceNo: 'SBE/26-27/142',
        holdAmount: 11200,
        description: 'Tata LPK 2518 tipper hire — 3 days breakdown held',
      },
      {
        machine: 'VGL18003I21W0912',
        from: 'START',
        to: 'P2',
        basis: 'hours',
        rate: 2650,
        status: 'pending_verification',
        invoiceNo: 'RRE/2026/0387',
        claimFactor: 1.03,
        deductDiesel: true,
        description: 'Sensor paver hire with operator',
      },
    ],
  },

  TE: {
    vendors: [
      {
        key: 'awadh',
        name: 'Awadh Infra Equipment Hire',
        city: 'Lucknow',
        state: 'Uttar Pradesh',
        stateCode: '09',
        pin: '226021',
        pan: 'AAPFA6619Q',
        address: '27/4, Kursi Road, Jankipuram',
        bank: {
          name: 'Punjab National Bank',
          branch: 'Jankipuram, Lucknow',
          ifsc: 'PUNB0416400',
          account: '4164002100018832',
        },
      },
      {
        key: 'haryana',
        name: 'Haryana Road Machines',
        city: 'Gurugram',
        state: 'Haryana',
        stateCode: '06',
        pin: '122004',
        pan: 'AAJFH2290B',
        address: 'Khasra 118, Daulatabad Industrial Area',
        bank: {
          name: 'ICICI Bank',
          branch: 'Sector 14, Gurugram',
          ifsc: 'ICIC0000614',
          account: '061405007219',
        },
      },
    ],
    base: {
      'EQ-EXC-01': {
        make: 'JCB',
        model: '3DX Eco Xcellence',
        year: 2020,
        registrationNo: 'RJ26-GA-1548',
        engineNo: 'SB320/40211/U2008',
        chassisNo: 'JCB3DXECL02911274',
        supplierName: 'Shree Ganesh Earthmovers, Jaipur',
        purchaseDate: '2020-02-11',
        purchaseCost: 2980000,
        depreciationRate: 15,
        operatorName: 'Imran Khan',
        papers: 'cev',
      },
      'EQ-TRN-01': {
        make: 'Tata Motors',
        model: 'LPT 1613 Tipper',
        year: 2018,
        registrationNo: 'UP32-MT-7716',
        engineNo: '697TC61HWZ205581',
        chassisNo: 'MAT447218J2H40972',
        supplierName: 'Sun Motors, Lucknow',
        purchaseDate: '2018-09-14',
        purchaseCost: 1840000,
        depreciationRate: 15,
        operatorName: 'Ram Naresh Yadav',
        papers: 'road',
        expiries: { pollution: 9 },
      },
      'EQ-CRN-01': {
        make: 'Escorts',
        model: 'Hydra 14',
        year: 2017,
        registrationNo: 'RJ14-GB-8831',
        engineNo: 'EK41X0019240',
        chassisNo: 'ESCHYD14N170918',
        operatorName: 'Bhola Ram (vendor operator)',
        vendor: 'sundaram',
        papers: 'road',
      },
      'EQ-CNC-01': {
        make: 'Schwing Stetter',
        model: 'CP 30',
        year: 2019,
        engineNo: 'SS-CP30-19-0962',
        chassisNo: 'SSCP30190096',
        supplierName: 'Schwing Stetter (India) Pvt Ltd',
        purchaseDate: '2019-11-26',
        purchaseCost: 6450000,
        depreciationRate: 10,
        operatorName: 'Lalit Soni',
        papers: 'plant',
      },
      'EQ-GEN-01': {
        make: 'Kirloskar',
        model: 'KG1-125AS',
        year: 2022,
        engineNo: 'KG1125-22-80217',
        chassisNo: 'KOELDG125A22802',
        supplierName: 'Kirloskar Oil Engines — Lucknow dealer',
        purchaseDate: '2022-01-19',
        purchaseCost: 1010000,
        depreciationRate: 15,
        operatorName: 'Imran Khan',
        papers: 'plant',
      },
    },
    machines: [
      {
        chassisNo: 'JCBJS205LC21R7741',
        name: 'JCB JS205 Excavator',
        category: 'EXCAVATOR',
        power: 'diesel',
        ownership: 'owned',
        make: 'JCB',
        model: 'JS205 LC',
        year: 2021,
        registrationNo: 'UP32-NT-4409',
        engineNo: 'JCB448TA4-21-63318',
        supplierName: 'JCB — Awadh Earthmovers, Lucknow',
        purchaseDate: '2021-08-30',
        purchaseCost: 8870000,
        depreciationRate: 15,
        project: 'TE-2502',
        operatorName: 'Imran Khan',
        start: 6644,
        perDay: 7.5,
        spread: 3,
        fuelPerUnit: 13.6,
        fromDaysAgo: 46,
        idleChance: 0.12,
        papers: 'cev',
        leakyFills: [2, 5],
        service: {
          type: 'Engine oil, fuel & hydraulic filter change',
          interval: 250,
        },
        photo: { body: '#f2b705', accent: '#1f1f1f' },
        remarks: [
          'Pothole cutting and shoulder dressing Km 452–448',
          'Drain desilting, Itaunja bazaar stretch',
          'Median cutting for U-turn, Km 431',
        ],
      },
      {
        chassisNo: 'HAMMHD99T22H0984',
        name: 'Hamm Tandem Roller HD 99',
        category: 'COMPACTOR',
        power: 'diesel',
        ownership: 'owned',
        make: 'Hamm (Wirtgen India)',
        model: 'HD 99',
        year: 2022,
        engineNo: 'TCD3.6L4-22-109377',
        supplierName: 'Wirtgen India Pvt Ltd',
        purchaseDate: '2022-06-15',
        purchaseCost: 5420000,
        depreciationRate: 15,
        project: 'TE-2501',
        operatorName: 'Satbir Singh',
        start: 3012,
        perDay: 6.5,
        spread: 2.5,
        fuelPerUnit: 6,
        fromDaysAgo: 46,
        idleChance: 0.16,
        papers: 'offroad',
        service: {
          type: 'Engine oil, vibration bearing grease',
          interval: 250,
        },
        photo: BLUE_ROLLER,
        remarks: [
          'BC renewal rolling, Km 8 to 10 LHS',
          'Patch repair rolling, NH-148A',
        ],
      },
      {
        chassisNo: 'MC2BFCRC0NA071552',
        name: 'Eicher Water Tanker 10 KL',
        category: 'WATER TANKER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Eicher',
        model: 'Pro 3015 with 10 KL tank',
        year: 2022,
        registrationNo: 'HR55-AK-3071',
        engineNo: 'E494-22-CRD4417',
        supplierName: 'Eicher — Gurgaon Commercial Vehicles',
        purchaseDate: '2022-04-04',
        purchaseCost: 2180000,
        depreciationRate: 15,
        project: 'TE-2501',
        operatorName: 'Rakesh Kumar',
        start: 54210,
        perDay: 66,
        spread: 25,
        fuelPerUnit: 0.21,
        fromDaysAgo: 46,
        idleChance: 0.1,
        papers: 'road',
        service: { type: 'Full service & oil change', interval: 10000 },
        photo: { body: '#1565c0', accent: '#f5f5f5' },
        remarks: [
          'Median plantation watering, Km 2 to 12',
          'Curing of kerb repair',
        ],
      },
      {
        chassisNo: 'MEC0628CPM0072904',
        name: 'BharatBenz 2828C Tipper',
        category: 'TIPPER',
        power: 'diesel',
        ownership: 'owned',
        make: 'BharatBenz',
        model: '2828C',
        year: 2023,
        registrationNo: 'UP32-PT-2290',
        engineNo: 'OM926-23-0728811',
        supplierName: 'Sun Motors, Lucknow',
        purchaseDate: '2023-03-09',
        purchaseCost: 4950000,
        depreciationRate: 15,
        project: 'TE-2502',
        operatorName: 'Ram Naresh Yadav',
        start: 70922,
        perDay: 122,
        spread: 45,
        fuelPerUnit: 0.3,
        fromDaysAgo: 46,
        idleChance: 0.1,
        papers: 'road',
        expiries: { fitness: 40 },
        service: { type: 'Full service & oil change', interval: 10000 },
        photo: { body: '#e0e0e0', accent: '#0d47a1' },
        remarks: [
          'Milled material shifting, Km 440',
          'Aggregate for pothole repair from Sitapur crusher',
        ],
      },
      {
        chassisNo: 'MAT458112L1K60315',
        name: 'Schwing Stetter Transit Mixer AM 6',
        category: 'TRANSIT MIXER',
        power: 'diesel',
        ownership: 'owned',
        make: 'Schwing Stetter',
        model: 'AM 6 FHC on Tata 1618',
        year: 2020,
        registrationNo: 'RJ26-GA-6986',
        engineNo: '697TC61LRZ330178',
        supplierName: 'Schwing Stetter (India) Pvt Ltd',
        purchaseDate: '2020-11-18',
        purchaseCost: 3260000,
        depreciationRate: 15,
        project: 'TE-2503',
        operatorName: 'Pappu Lal Meena',
        start: 46317,
        perDay: 58,
        spread: 25,
        fuelPerUnit: 0.34,
        fromDaysAgo: 46,
        idleChance: 0.14,
        papers: 'road',
        expiries: { permit: 12 },
        service: { type: 'Full service & drum gearbox oil', interval: 8000 },
        photo: { body: '#f5f5f5', accent: '#c62828' },
        remarks: [
          'M30 concrete for drain cover slabs, packing plant road',
          'PQC patch, clinker yard road',
        ],
      },
      {
        chassisNo: 'VCESD110C20P03912',
        name: 'Volvo Soil Compactor SD110',
        category: 'COMPACTOR',
        power: 'diesel',
        ownership: 'hired',
        vendor: 'awadh',
        make: 'Volvo CE',
        model: 'SD110C',
        year: 2020,
        engineNo: 'D4.8-20-VCE097614',
        project: 'TE-2502',
        operatorName: 'Shiv Kumar (vendor operator)',
        start: 4580,
        perDay: 7,
        spread: 2,
        fuelPerUnit: 7.3,
        fromDaysAgo: 60,
        idleChance: 0.1,
        papers: 'offroad',
        leakyFills: [3, 8],
        remarks: [
          'Shoulder reconstruction compaction, Km 466–462',
          'Service road subgrade, Itaunja',
        ],
      },
      {
        chassisNo: 'VGL18003I19W0628',
        name: 'Vogele Paver Super 1800-3i',
        category: 'PAVER',
        power: 'diesel',
        ownership: 'hired',
        vendor: 'haryana',
        make: 'Vogele (Wirtgen Group)',
        model: 'Super 1800-3i',
        year: 2019,
        engineNo: 'TCD6.1-19-V0628',
        project: 'TE-2501',
        operatorName: 'Mahavir (vendor operator)',
        start: 9902,
        perDay: 6.5,
        spread: 2.5,
        fuelPerUnit: 12.8,
        fromDaysAgo: 44,
        idleChance: 0.2,
        papers: 'offroad',
        remarks: [
          'BC overlay 40 mm, Km 4 to 6 RHS',
          'Renewal coat, toll plaza approach',
        ],
      },
    ],
    orders: [
      {
        vendor: 'sundaram',
        daysAgo: 68,
        project: 'TE-2503',
        referenceNo: 'TE/PLANT/HO/26-27/007',
        remarks:
          'Hydra with operator for precast drain units at the packing plant road. Diesel by vendor.',
        lines: [
          {
            baseCode: 'EQ-CRN-01',
            title:
              'Hiring of Escorts Hydra 14T mobile crane for Mangalam Cement plant roads',
            description: 'Crane hire services with operator - Hours',
            quantity: 500,
            uom: 'HRS',
            rate: 1450,
          },
        ],
      },
      {
        vendor: 'awadh',
        daysAgo: 66,
        project: 'TE-2502',
        referenceNo: 'TE/PLANT/HO/26-27/009',
        remarks:
          'Dry hire: diesel issued by Tirupati Enterprises, average 8 L/hr. Operator by vendor.',
        lines: [
          {
            machine: 'VCESD110C20P03912',
            title:
              'Hiring of Volvo SD110 soil compactor for shoulder reconstruction',
            description: 'Machinery hire services-Months',
            quantity: 3,
            uom: 'MON',
            rate: 178000,
          },
        ],
      },
      {
        vendor: 'haryana',
        daysAgo: 50,
        project: 'TE-2501',
        referenceNo: 'TE/PLANT/HO/26-27/012',
        remarks:
          'Sensor paver with operator. HSD issued by Tirupati Enterprises to be deducted at actuals.',
        lines: [
          {
            machine: 'VGL18003I19W0628',
            title: 'Hiring of Vogele Super 1800-3i sensor paver for BC overlay',
            description: 'Machinery hire services-Hours',
            quantity: 300,
            uom: 'HRS',
            rate: 2700,
          },
        ],
      },
    ],
    bills: [
      {
        machine: 'VCESD110C20P03912',
        from: 'P1',
        to: 'P1',
        basis: 'monthly',
        rate: 178000,
        status: 'paid',
        invoiceNo: 'AIEH/2026-27/064',
        description: 'Volvo SD110 soil compactor hire',
      },
      {
        machine: 'VCESD110C20P03912',
        from: 'P2',
        to: 'P2',
        basis: 'monthly',
        rate: 178000,
        status: 'verified',
        invoiceNo: 'AIEH/2026-27/081',
        description: 'Volvo SD110 soil compactor hire',
      },
      {
        machine: 'VGL18003I19W0628',
        from: 'START',
        to: 'P2',
        basis: 'hours',
        rate: 2700,
        status: 'pending_verification',
        invoiceNo: 'HRM/26-27/219',
        claimFactor: 1.04,
        deductDiesel: true,
        description: 'Sensor paver hire with operator',
      },
    ],
  },
};

const SUNDARAM: VendorSpec = {
  key: 'sundaram',
  name: 'Sundaram Equipment Hire',
  city: '',
  state: '',
  stateCode: '',
  pin: '',
  pan: '',
  address: '',
  bank: { name: '', branch: '', ifsc: '', account: '' },
};

/** Categories a road contractor adds beside the ten defaults. */
const EXTRA_CATEGORIES: { name: string; meterType: MeterType }[] = [
  { name: 'MOTOR GRADER', meterType: 'hours' },
  { name: 'PAVER', meterType: 'hours' },
  { name: 'HOT MIX PLANT', meterType: 'hours' },
  { name: 'WATER TANKER', meterType: 'km' },
];

/** Litres per meter unit the yard expects — set only where the category has none. */
const BENCHMARKS: Record<string, number> = {
  EXCAVATOR: 15,
  'MOTOR GRADER': 11.5,
  COMPACTOR: 8,
  PAVER: 14,
  TIPPER: 0.31,
  'WATER TANKER': 0.26,
  'TRANSIT MIXER': 0.36,
  Earthmoving: 5.6,
  Transport: 0.28,
  Power: 3.2,
};

/** Hourly / per-km hire rates for categories hired in, where none is on file. */
const HIRE_RATES: Record<string, number> = {
  COMPACTOR: 1150,
  PAVER: 2650,
  TIPPER: 42,
};

const INSURERS = [
  { name: 'The New India Assurance Co. Ltd', prefix: '3313003126' },
  { name: 'ICICI Lombard General Insurance Co. Ltd', prefix: '3005/2' },
  {
    name: 'Bajaj Allianz General Insurance Co. Ltd',
    prefix: 'OG-27-1501-1801-',
  },
  { name: 'United India Insurance Co. Ltd', prefix: '1414003126P' },
] as const;

const PAPER_DOC_TYPE: Record<PaperKind, string> = {
  rc: 'REGISTRATION CERTIFICATE',
  insurance: 'INSURANCE',
  fitness: 'FITNESS CERTIFICATE',
  road_tax: 'ROAD TAX',
  permit: 'PERMIT',
  pollution: 'POLLUTION CERTIFICATE',
};

const PAPER_SETS: Record<
  Papers,
  Record<PaperKind, 'held' | 'not_applicable' | 'lifetime'>
> = {
  road: {
    rc: 'held',
    insurance: 'held',
    fitness: 'held',
    road_tax: 'held',
    permit: 'held',
    pollution: 'held',
  },
  // Construction-equipment vehicles: registered, insured, one-time road tax, no permit.
  cev: {
    rc: 'held',
    insurance: 'held',
    fitness: 'not_applicable',
    road_tax: 'lifetime',
    permit: 'not_applicable',
    pollution: 'held',
  },
  offroad: {
    rc: 'not_applicable',
    insurance: 'held',
    fitness: 'not_applicable',
    road_tax: 'not_applicable',
    permit: 'not_applicable',
    pollution: 'not_applicable',
  },
  plant: {
    rc: 'not_applicable',
    insurance: 'held',
    fitness: 'not_applicable',
    road_tax: 'not_applicable',
    permit: 'not_applicable',
    pollution: 'not_applicable',
  },
};

// ─── The module ───────────────────────────────────────────────────────────────

type Db = Prisma.TransactionClient;

interface Machine {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  meterType: MeterType;
  ownership: string;
  vendorId: string | null;
  registrationNo: string | null;
  spec: Partial<MachineSpec> & { papers: Papers };
}

export async function seedPlant(ctx: CompanyContext): Promise<ModuleResult> {
  const plan = PLANS[ctx.company.shortCode];
  if (!plan) return {};
  const { prisma, company, today, rng } = ctx;
  const db = prisma as unknown as Db;
  const companyId = company.id;
  const result: ModuleResult = {};
  const bump = (key: string, n = 1) => {
    if (n) result[key] = (result[key] ?? 0) + n;
  };
  const codeSeries = new CodeSeriesService();

  // ── People: who raises, verifies, reviews ──────────────────────────────────
  const usersByRole = async (role: string) =>
    (
      await prisma.userRole.findMany({
        where: { role: { name: role }, user: { companyId } },
        include: { user: { select: { id: true, displayName: true } } },
        orderBy: { user: { username: 'asc' } },
      })
    ).map((r) => r.user);
  const [siteIncharges, headOffice, superAdmins] = await Promise.all([
    usersByRole('Site Incharge'),
    usersByRole('Head Office'),
    usersByRole('Super Admin'),
  ]);
  const anyUser = await prisma.user.findFirst({ where: { companyId } });
  if (!anyUser) return {};
  const siteUser = siteIncharges[0] ?? anyUser;
  const hoUser = headOffice[0] ?? anyUser;
  const hoUser2 = headOffice[1] ?? hoUser;
  const director = superAdmins[0] ?? hoUser;

  // ── Places and projects ────────────────────────────────────────────────────
  const sites = await prisma.site.findMany({ where: { companyId } });
  const projects = await prisma.project.findMany({ where: { companyId } });
  const projectByCode = new Map(projects.map((p) => [p.code, p]));
  const siteOfProject = (code: string) => {
    const project = projectByCode.get(code);
    return sites.find((s) => s.projectId === project?.id) ?? null;
  };

  // ── Vendors: the plant-hire firms machines come from ───────────────────────
  const vendorIds = new Map<string, string>();
  const sundaram = await prisma.vendor.findFirst({
    where: { companyId, name: SUNDARAM.name },
  });
  if (sundaram) vendorIds.set('sundaram', sundaram.id);
  for (const v of plan.vendors) {
    const existing = await prisma.vendor.findFirst({
      where: { companyId, name: v.name },
    });
    if (existing) {
      vendorIds.set(v.key, existing.id);
      continue;
    }
    const code = await codeSeries.next(
      db,
      companyId,
      'VENDORS',
      'V',
      async (candidate) =>
        !!(await prisma.vendor.findFirst({
          where: { companyId, code: candidate },
          select: { id: true },
        })),
    );
    const row = await prisma.vendor.create({
      data: {
        companyId,
        code,
        name: v.name,
        type: 'hire',
        gstin: gstin(v.stateCode, v.pan),
        pan: v.pan,
        tdsSection: '194C',
        tdsRate: money(2),
        address: v.address,
        city: v.city,
        state: v.state,
        pinCode: v.pin,
        bankAccountHolderName: v.name,
        bankName: v.bank.name,
        bankBranch: v.bank.branch,
        ifscCode: v.bank.ifsc,
        bankAccountNumber: v.bank.account,
      },
    });
    vendorIds.set(v.key, row.id);
    bump('vendors');
  }
  const fuelVendor = await prisma.vendor.findFirst({
    where: { companyId, type: 'fuel' },
    orderBy: { code: 'asc' },
  });

  // ── Categories, benchmarks, hire rates ─────────────────────────────────────
  for (const c of EXTRA_CATEGORIES) {
    const exists = await prisma.equipmentCategory.findFirst({
      where: { companyId, name: c.name },
    });
    if (!exists) {
      await prisma.equipmentCategory.create({
        data: { companyId, name: c.name, meterType: c.meterType },
      });
      bump('categories');
    }
  }
  const categories = await prisma.equipmentCategory.findMany({
    where: { companyId },
  });
  for (const cat of categories) {
    const benchmark = BENCHMARKS[cat.name];
    if (benchmark && cat.fuelBenchmark === null) {
      await prisma.equipmentCategory.update({
        where: { id: cat.id },
        data: { fuelBenchmark: money(benchmark) },
      });
      cat.fuelBenchmark = money(benchmark);
      bump('benchmarks');
    }
    const hireRate = HIRE_RATES[cat.name];
    if (
      hireRate &&
      !(await prisma.hireRate.findFirst({ where: { categoryId: cat.id } }))
    ) {
      await prisma.hireRate.create({
        data: {
          companyId,
          categoryId: cat.id,
          ratePerUnit: money(hireRate),
          effectiveFrom: ymd('2026-04-01'),
        },
      });
      bump('hireRates');
    }
  }
  const categoryByName = new Map(categories.map((c) => [c.name, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const benchmarkOf = (categoryId: string) => {
    const b = categoryById.get(categoryId)?.fuelBenchmark;
    return b === null || b === undefined ? null : Number(b);
  };

  // ── Operators the logbook can name ─────────────────────────────────────────
  const designations = await prisma.designation.findMany({
    where: { companyId },
  });
  const operatorDesignations = designations
    .filter((x) => /operator|driver/i.test(x.name))
    .map((x) => x.id);
  const operatorPool = await prisma.employee.findMany({
    where: { companyId, designationId: { in: operatorDesignations } },
    orderBy: { employeeCode: 'asc' },
    select: { id: true, firstName: true, lastName: true },
  });
  const operatorFor = (spec: Partial<MachineSpec>) => {
    const named = operatorPool.find(
      (e) =>
        `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() === spec.operatorName,
    );
    return named?.id ?? null;
  };

  // ── Base-seed machines: their particulars ──────────────────────────────────
  const machines: Machine[] = [];
  for (const [suffix, spec] of Object.entries(plan.base)) {
    const row = await prisma.equipment.findFirst({
      where: { companyId, code: `${company.shortCode}-${suffix}` },
    });
    if (!row) continue;
    if (!row.make) {
      const vendorId = spec.vendor ? vendorIds.get(spec.vendor) ?? null : null;
      await prisma.equipment.update({
        where: { id: row.id },
        data: {
          make: spec.make,
          model: spec.model,
          manufacturingYear: spec.year,
          registrationNo: spec.registrationNo ?? null,
          engineNo: spec.engineNo,
          chassisNo: spec.chassisNo,
          supplierName: spec.supplierName ?? null,
          registeredOwner:
            row.ownership === 'hired' ? SUNDARAM.name : company.name,
          operatorName: spec.operatorName,
          purchaseDate: spec.purchaseDate ? ymd(spec.purchaseDate) : null,
          purchaseCost:
            spec.purchaseCost !== undefined ? money(spec.purchaseCost) : null,
          depreciationRate:
            spec.depreciationRate !== undefined
              ? money(spec.depreciationRate)
              : null,
          ...(vendorId && !row.vendorId ? { vendorId } : {}),
        },
      });
      bump('machinesDetailed');
    }
    machines.push({
      id: row.id,
      code: row.code,
      name: row.name,
      categoryId: row.categoryId,
      meterType: row.meterType,
      ownership: row.ownership,
      vendorId:
        row.vendorId ??
        (spec.vendor ? vendorIds.get(spec.vendor) ?? null : null),
      registrationNo: spec.registrationNo ?? row.registrationNo,
      spec,
    });
  }

  // ── New machines, each with the history the base seed gives its own ────────
  for (const spec of plan.machines) {
    const category = categoryByName.get(spec.category);
    const site = siteOfProject(spec.project);
    if (!category || !site) continue;
    const vendorId = spec.vendor ? vendorIds.get(spec.vendor) ?? null : null;
    if (spec.ownership === 'hired' && !vendorId) continue;

    let row = await prisma.equipment.findFirst({
      where: { companyId, chassisNo: spec.chassisNo },
    });
    if (!row) {
      const prefix = namedPrefixFor(spec.name);
      const taken = await prisma.equipment.findMany({
        where: { companyId, code: { startsWith: prefix } },
        select: { code: true },
      });
      const highest = taken.reduce(
        (max, t) =>
          Math.max(
            max,
            namedSerialOf(NAMED_SERIES_DEFAULT, t.code, prefix) ?? 0,
          ),
        0,
      );
      row = await prisma.equipment.create({
        data: {
          companyId,
          code: namedCode(NAMED_SERIES_DEFAULT, prefix, highest + 1, spec.year),
          name: spec.name,
          manufacturingYear: spec.year,
          categoryId: category.id,
          make: spec.make,
          model: spec.model,
          registrationNo: spec.registrationNo ?? null,
          engineNo: spec.engineNo,
          chassisNo: spec.chassisNo,
          supplierName: spec.supplierName ?? null,
          registeredOwner:
            spec.ownership === 'hired'
              ? plan.vendors.find((v) => v.key === spec.vendor)?.name ?? null
              : company.name,
          operatorName: spec.operatorName,
          remarks: spec.sold ? null : site.name.split(' — ')[0],
          ownership: spec.ownership,
          vendorId,
          powerSource: spec.power,
          purchaseDate: spec.purchaseDate ? ymd(spec.purchaseDate) : null,
          purchaseCost:
            spec.purchaseCost !== undefined ? money(spec.purchaseCost) : null,
          depreciationRate:
            spec.depreciationRate !== undefined
              ? money(spec.depreciationRate)
              : null,
          meterType: category.meterType,
          currentReading: money(spec.start),
          deployedSiteId: spec.sold ? null : site.id,
          status: spec.sold ? 'sold' : 'active',
          createdAt: at(addDays(today, -spec.fromDaysAgo - 2), 11, 15),
        },
      });
      bump('machines');
      await seedHistory(
        ctx,
        row,
        spec,
        category,
        site,
        operatorFor(spec),
        fuelVendor?.id ?? null,
        bump,
      );
    }
    machines.push({
      id: row.id,
      code: row.code,
      name: row.name,
      categoryId: row.categoryId,
      meterType: row.meterType,
      ownership: row.ownership,
      vendorId: row.vendorId,
      registrationNo: row.registrationNo,
      spec,
    });
  }

  // ── Registration papers and their scanned copies ───────────────────────────
  const docTypes = await prisma.equipmentDocType.findMany({
    where: { companyId },
  });
  const docTypeId = (name: string) => docTypes.find((t) => t.name === name)?.id;
  for (const m of machines) {
    const already = await prisma.equipmentRegistrationItem.count({
      where: { equipmentId: m.id },
    });
    if (already > 0) continue;
    const spec = m.spec;
    const papers = PAPER_SETS[spec.papers];
    const regDate = spec.purchaseDate
      ? ymd(spec.purchaseDate)
      : ymd(`${spec.year ?? 2020}-04-15`);
    const insurer = rng.pick(INSURERS);
    const plate = (m.registrationNo ?? m.code).replace(/[^A-Z0-9]/gi, '');
    for (const kind of Object.keys(papers) as PaperKind[]) {
      const status = papers[kind];
      let expiresAt: Date | null = null;
      let number: string | null = null;
      if (status === 'held') {
        const pinned = spec.expiries?.[kind];
        expiresAt =
          kind === 'rc'
            ? addYears(regDate, 15)
            : addDays(today, pinned ?? rng.int(120, 330));
        number =
          kind === 'rc'
            ? m.registrationNo ?? null
            : kind === 'insurance'
            ? `${insurer.prefix}${rng.int(10000000, 99999999)}`
            : kind === 'fitness'
            ? `FC/${plate.slice(0, 4)}/${
                expiresAt.getUTCFullYear() - 1
              }/${rng.int(1000, 9999)}`
            : kind === 'road_tax'
            ? `${plate.slice(0, 4)}/TAX/2026/${rng.int(10000, 99999)}`
            : kind === 'permit'
            ? `${plate.slice(0, 2)}/NP/${
                expiresAt.getUTCFullYear() - 1
              }/${rng.int(1000, 9999)}`
            : `${plate.slice(0, 4)}00${rng.int(1000000, 9999999)}`;
      } else if (status === 'lifetime' && kind === 'road_tax') {
        number = `${plate.slice(
          0,
          4,
        )}/OTT/${regDate.getUTCFullYear()}/${rng.int(1000, 9999)}`;
      }
      await prisma.equipmentRegistrationItem.create({
        data: { companyId, equipmentId: m.id, kind, status, expiresAt, number },
      });
      bump('registrationItems');

      // A scan for every paper held (and the one-time tax receipt).
      const typeId = docTypeId(PAPER_DOC_TYPE[kind]);
      if (!typeId || status === 'not_applicable') continue;
      const pdf = await ctx.renderPdf(
        paperTitle(kind),
        paperBody(kind, {
          machine: m,
          owner:
            m.ownership === 'hired'
              ? m.spec.vendor === 'sundaram'
                ? SUNDARAM.name
                : plan.vendors.find((v) => v.key === m.spec.vendor)?.name ??
                  company.name
              : company.name,
          number,
          insurer: insurer.name,
          regDate,
          expiresAt,
          issued: expiresAt
            ? kind === 'rc'
              ? regDate
              : addDays(addYears(expiresAt, -1), 1)
            : regDate,
        }),
      );
      const fileRef = await ctx.writeBlob('equipment-documents', pdf);
      const issued =
        expiresAt && kind !== 'rc' ? addYears(expiresAt, -1) : regDate;
      await prisma.equipmentDocument.create({
        data: {
          companyId,
          equipmentId: m.id,
          docTypeId: typeId,
          fileRef,
          fileName: `${plate}_${PAPER_DOC_TYPE[kind].replace(/ /g, '_')}${
            expiresAt && kind !== 'rc' ? `_${expiresAt.getUTCFullYear()}` : ''
          }.pdf`,
          mimeType: 'application/pdf',
          expiresAt,
          uploadedByUserId: hoUser.id,
          uploadedAt: at(
            (() => {
              const day = addDays(issued, rng.int(1, 6));
              return day > today ? today : day;
            })(),
            12,
            rng.int(5, 55),
          ),
        },
      });
      bump('documents');
    }
  }

  // ── Photographs ────────────────────────────────────────────────────────────
  for (const m of machines) {
    if (m.spec.sold) continue;
    const look = m.spec.photo ?? { body: '#d9a400', accent: '#1f1f1f' };
    if (await prisma.equipmentPhoto.count({ where: { equipmentId: m.id } })) {
      continue;
    }
    const source = await machinePhoto(
      m,
      categoryById.get(m.categoryId)?.name ?? m.name,
      look,
      m.ownership === 'hired' ? 'On hire' : company.name,
    );
    const image = await compressImageUpload(source, 'image/jpeg');
    if (!image) continue;
    const [fileRef, thumbnailRef] = [
      await ctx.writeBlob('equipment-photos', image.main.data),
      await ctx.writeBlob('equipment-photos', image.thumbnail.data),
    ];
    await prisma.equipmentPhoto.create({
      data: {
        companyId,
        equipmentId: m.id,
        fileRef,
        thumbnailRef,
        contentType: image.main.contentType,
        fileName: `${m.code.replace(/\//g, '-')}_front.jpg`,
        width: image.main.width,
        height: image.main.height,
        sizeBytes: image.main.data.length,
        isMain: true,
        uploadedByUserId: siteUser.id,
        uploadedAt: at(addDays(today, -rng.int(5, 30)), 16, rng.int(0, 59)),
      },
    });
    bump('photos');
  }

  // ── Hire orders ────────────────────────────────────────────────────────────
  const machineByChassis = new Map(
    machines.map((m) => [m.spec.chassisNo ?? m.code, m]),
  );
  const baseMachine = (suffix: string) =>
    machines.find((m) => m.code === `${company.shortCode}-${suffix}`);
  const orderIds = new Map<string, string>(); // machine id → hire order id
  if ((await prisma.hireOrder.count({ where: { companyId } })) === 0) {
    for (const o of plan.orders) {
      const vendorId = vendorIds.get(o.vendor);
      const project = projectByCode.get(o.project);
      const site = siteOfProject(o.project);
      if (!vendorId) continue;
      const code = await codeSeries.next(
        db,
        companyId,
        'WORK_ORDER',
        'WO',
        async (candidate) =>
          !!(await prisma.hireOrder.findFirst({
            where: { companyId, code: candidate },
            select: { id: true },
          })) ||
          !!(await prisma.workOrder.findFirst({
            where: { companyId, code: candidate },
            select: { id: true },
          })),
      );
      const date = addDays(today, -o.daysAgo);
      const order = await prisma.hireOrder.create({
        data: {
          companyId,
          code,
          referenceNo: o.referenceNo,
          date,
          vendorId,
          projectId: project?.id ?? null,
          pointOfDelivery: site?.name ?? null,
          remarks: o.remarks,
          createdByUserId: hoUser.id,
          createdAt: at(date, 15, 30),
          lines: {
            create: o.lines.map((line, index) => {
              const m = line.machine
                ? machineByChassis.get(line.machine)
                : line.baseCode
                ? baseMachine(line.baseCode)
                : undefined;
              return {
                companyId,
                position: index + 1,
                equipmentId: m?.id ?? null,
                title: line.title,
                description: line.description,
                sacCode: '997313',
                taxRate: money(18),
                quantity: money(line.quantity),
                uom: line.uom,
                rate: money(line.rate),
                amount: money(r2(line.quantity * line.rate)),
              };
            }),
          },
        },
        include: { lines: true },
      });
      bump('hireOrders');
      bump('hireOrderLines', order.lines.length);
      for (const line of order.lines) {
        if (line.equipmentId) orderIds.set(line.equipmentId, order.id);
      }
    }
  } else {
    const lines = await prisma.hireOrderLine.findMany({
      where: { companyId, equipmentId: { not: null } },
    });
    for (const line of lines) {
      if (line.equipmentId) orderIds.set(line.equipmentId, line.hireOrderId);
    }
  }

  // The base seed's crane bills came on the crane's order.
  const crane = baseMachine('EQ-CRN-01');
  if (crane && orderIds.get(crane.id)) {
    const bills = await prisma.hireBill.findMany({
      where: { equipmentId: crane.id, hireOrderId: null },
      orderBy: { billingPeriodFrom: 'asc' },
    });
    for (const [i, bill] of bills.entries()) {
      await prisma.hireBill.update({
        where: { id: bill.id },
        data: {
          hireOrderId: orderIds.get(crane.id),
          invoiceNo: `SEH/26-27/${String(
            212 + i * 37 + (company.shortCode === 'TE' ? 5 : 0),
          )}`,
          billDate: addDays(bill.billingPeriodTo, 2),
          description: 'Hydra 14T crane hire with operator',
          periodDays:
            Math.round(
              (bill.billingPeriodTo.getTime() -
                bill.billingPeriodFrom.getTime()) /
                DAY_MS,
            ) + 1,
          createdByUserId: bill.createdByUserId ?? siteUser.id,
        },
      });
      bump('hireBillsLinked');
    }
  }

  // ── Hire bills for the machines hired in ───────────────────────────────────
  for (const b of plan.bills) {
    const m = machineByChassis.get(b.machine);
    if (!m || !m.vendorId) continue;
    const first = await prisma.logbookEntry.findFirst({
      where: { equipmentId: m.id },
      orderBy: { date: 'asc' },
    });
    if (!first) continue;
    const arrival = first.date;
    const monthStart = (t: Date) =>
      new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    const monthEnd = (t: Date) =>
      new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
    const currentMonth = monthStart(today);
    const p2Start = monthStart(addDays(currentMonth, -1));
    const p1Start = monthStart(addDays(p2Start, -1));
    const resolve = (token: string, end: boolean): Date =>
      token === 'START'
        ? arrival
        : token === 'P1'
        ? end
          ? monthEnd(p1Start)
          : p1Start < arrival
          ? arrival
          : p1Start
        : end
        ? monthEnd(p2Start)
        : p2Start < arrival
        ? arrival
        : p2Start;
    const from = resolve(b.from, false);
    const to = resolve(b.to, true);
    if (to < from) continue;
    const overlapping = await prisma.hireBill.findFirst({
      where: {
        equipmentId: m.id,
        billingPeriodFrom: { lte: to },
        billingPeriodTo: { gte: from },
      },
    });
    if (overlapping) continue;

    const period = { equipmentId: m.id, date: { gte: from, lte: to } };
    const [logbook, firstIn, lastIn, fuel] = await Promise.all([
      prisma.logbookEntry.aggregate({
        where: period,
        _sum: { totalHours: true },
      }),
      prisma.logbookEntry.findFirst({
        where: period,
        orderBy: { date: 'asc' },
      }),
      prisma.logbookEntry.findFirst({
        where: period,
        orderBy: { date: 'desc' },
      }),
      prisma.fuelEntry.aggregate({
        where: period,
        _sum: { quantity: true, amount: true },
      }),
    ]);
    const logbookHours = Number(logbook._sum.totalHours ?? 0);
    const startReading = firstIn ? Number(firstIn.openingReading) : null;
    const endReading = lastIn ? Number(lastIn.closingReading) : null;
    const run =
      startReading !== null && endReading !== null
        ? r3(endReading - startReading)
        : logbookHours;
    const benchmark = benchmarkOf(m.categoryId);
    const agreedAverage =
      benchmark && benchmark > 0
        ? m.meterType === 'km'
          ? Math.round((1 / benchmark) * 1000) / 1000
          : benchmark
        : null;
    const dieselGiven = Number(fuel._sum.quantity ?? 0);
    const deductionAmount = b.deductDiesel
      ? r2(Number(fuel._sum.amount ?? 0))
      : 0;
    const holdAmount = b.holdAmount ?? 0;
    const periodDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    const monthly = b.basis === 'monthly';
    const billedHours = monthly ? run : r2(logbookHours * (b.claimFactor ?? 1));
    const amounts = computeHireBillAmounts({
      billedHours,
      rate: b.rate,
      tdsRate: 2,
      ...(monthly
        ? { grossAmount: monthlyGross(b.rate, periodDays, from) }
        : {}),
      otherDeductions: [deductionAmount, holdAmount],
    });
    const billDate = addDays(to, 3) > today ? today : addDays(to, 3);
    const verified = b.status !== 'pending_verification';
    await prisma.hireBill.create({
      data: {
        companyId,
        equipmentId: m.id,
        vendorId: m.vendorId,
        billedHours: money(billedHours),
        rate: money(b.rate),
        grossAmount: money(amounts.grossAmount),
        billingPeriodFrom: from,
        billingPeriodTo: to,
        logbookHours: money(logbookHours),
        variance: money(r3(billedHours - logbookHours)),
        tdsRate: money(2),
        tdsAmount: money(amounts.tdsAmount),
        netPayable: money(amounts.netPayable),
        status: b.status,
        basis: b.basis,
        hireOrderId: orderIds.get(m.id) ?? null,
        billDate,
        invoiceNo: b.invoiceNo,
        taxInvoiceRef: b.invoiceNo,
        taxInvoiceDate: billDate,
        description: `${b.description}, ${ddmmyyyy(from)} to ${ddmmyyyy(to)}`,
        periodDays,
        monthlyRate: monthly ? money(b.rate) : null,
        agreedAverage: agreedAverage !== null ? money(agreedAverage) : null,
        startReading: startReading !== null ? money(startReading) : null,
        endReading: endReading !== null ? money(endReading) : null,
        dieselGiven: money(r3(dieselGiven)),
        actualDiesel: (() => {
          const litres = expectedDiesel(m.meterType, run, agreedAverage);
          return litres === null ? null : money(litres);
        })(),
        deductionAmount: money(deductionAmount),
        holdAmount: money(holdAmount),
        createdByUserId: siteUser.id,
        verifiedByUserId: verified ? hoUser.id : null,
        verifiedAt: verified
          ? at(
              addDays(billDate, 2) > today ? today : addDays(billDate, 2),
              15,
              10,
            )
          : null,
        paymentDate: b.status === 'paid' ? addDays(billDate, 9) : null,
        paymentReference:
          b.status === 'paid'
            ? `NEFT/${company.shortCode}/${iso(addDays(billDate, 9)).replace(
                /-/g,
                '',
              )}/${rng.int(100, 999)}`
            : null,
        createdAt: at(billDate, 17, 5),
      },
    });
    bump('hireBills');
  }

  // ── Fuel variance exceptions: the sweep, and what reviewers decided ────────
  if (
    (await prisma.fuelVarianceException.count({ where: { companyId } })) === 0
  ) {
    await seedFuelExceptions(ctx, {
      machines,
      benchmarkOf,
      reviewer: hoUser,
      siteApprover: siteUser,
      finalApprover: hoUser2,
      bump,
    });
  }

  // ── The one disposal ───────────────────────────────────────────────────────
  const soldSpec = plan.machines.find((m) => m.sold);
  const sold = soldSpec ? machineByChassis.get(soldSpec.chassisNo) : undefined;
  if (
    sold &&
    soldSpec?.sold &&
    (await prisma.equipmentDisposal.count({ where: { companyId } })) === 0
  ) {
    const s = soldSpec.sold;
    const site = siteOfProject(soldSpec.project);
    const project = projectByCode.get(soldSpec.project);
    const disposalDate = addDays(today, -s.daysAgo);
    const book = bookValue(
      {
        purchaseCost: soldSpec.purchaseCost ?? 0,
        depreciationRatePercent: soldSpec.depreciationRate ?? 0,
        salvageValue: 0,
        capitalisationDate: ymd(soldSpec.purchaseDate ?? '2014-04-01'),
      },
      disposalDate,
    );
    const approvedBy = director.displayName ?? 'Director';
    const invoicePdf = await ctx.renderPdf(
      `${company.name.toUpperCase()}\nTAX INVOICE — SALE OF USED VEHICLE`,
      [
        `Invoice No.: ${s.invoice}`,
        `Date: ${ddmmyyyy(disposalDate)}`,
        '',
        `Buyer: ${s.buyer}`,
        `Contact: ${s.contact}`,
        '',
        `Vehicle: ${soldSpec.make} ${soldSpec.model} (${soldSpec.year})`,
        `Registration No.: ${soldSpec.registrationNo}`,
        `Engine No.: ${soldSpec.engineNo}`,
        `Chassis No.: ${soldSpec.chassisNo}`,
        `Odometer: ${inr(
          Number(
            (
              await prisma.equipment.findUnique({ where: { id: sold.id } })
            )?.currentReading ?? 0,
          ),
        ).replace('.00', '')} km`,
        '',
        `Sale consideration: Rs. ${inr(
          s.amount,
        )} (inclusive of GST under the margin scheme)`,
        'Sold on "as is where is" basis. Form 29 and 30 handed over to the buyer; RC transfer to be applied for at DTO Tonk by the buyer within 30 days.',
        '',
        `Approved by: ${approvedBy}`,
        'For ' + company.name,
        '',
        'Authorised Signatory',
      ].join('\n'),
    );
    const attachmentRef = await ctx.writeBlob('equipment-disposal', invoicePdf);
    const disposal = await prisma.equipmentDisposal.create({
      data: {
        companyId,
        equipmentId: sold.id,
        type: 'sold',
        disposalDate,
        counterpartyName: s.buyer,
        buyerContact: s.contact,
        paymentMode: 'bank_transfer',
        invoiceNumber: s.invoice,
        valueRealised: money(s.amount),
        bookValue: money(book),
        bookValueSource: 'depreciation',
        profitLoss: money(r2(s.amount - book)),
        approvedBy,
        remarks:
          'Twelve-year-old tipper, frequent gearbox and chassis repairs; replaced by the Signa 2823. Sold after three quotations.',
        attachmentRef,
        attachmentName: `${s.invoice.replace(/\//g, '-')}.pdf`,
        attachmentMime: 'application/pdf',
        previousStatus: 'active',
        releasedSiteId: site?.id ?? null,
        projectId: project?.id ?? null,
        createdByUserId: director.id,
        createdAt: at(disposalDate, 16, 40),
      },
    });
    bump('disposals');
    if (site) {
      await prisma.equipmentEvent.create({
        data: {
          companyId,
          equipmentId: sold.id,
          kind: 'site_released',
          summary: `Released from ${site.name} on disposal`,
          detail: { siteId: site.id, disposalId: disposal.id },
          actorUserId: director.id,
          createdAt: at(disposalDate, 16, 40),
        },
      });
      bump('equipmentEvents');
    }
    await prisma.equipmentEvent.create({
      data: {
        companyId,
        equipmentId: sold.id,
        kind: 'disposed_sold',
        summary: `Sold to ${s.buyer} on ${iso(disposalDate)}`,
        detail: { disposalId: disposal.id, approvedBy },
        actorUserId: director.id,
        createdAt: new Date(at(disposalDate, 16, 40).getTime() + 1000),
      },
    });
    bump('equipmentEvents');
  }

  return result;
}

// ─── Logbook, fuel and service history for a new machine ──────────────────────

async function seedHistory(
  ctx: CompanyContext,
  machine: {
    id: string;
    companyId: string;
    categoryId: string;
    meterType: MeterType;
  },
  spec: MachineSpec,
  category: {
    id: string;
    fuelBenchmark: Prisma.Decimal | null;
    fuelVarianceThresholdPercent: Prisma.Decimal;
    targetHoursPerMonth: number;
  },
  site: { id: string; projectId: string | null },
  operatorId: string | null,
  fuelVendorId: string | null,
  bump: (key: string, n?: number) => void,
): Promise<void> {
  const { prisma, today, rng } = ctx;
  const benchmark =
    category.fuelBenchmark === null ? null : Number(category.fuelBenchmark);
  const threshold = Number(category.fuelVarianceThresholdPercent);
  let reading = spec.start;
  const logged: { date: Date; hours: number; fuel: number }[] = [];
  const last = spec.toDaysAgo ?? 1;

  for (let back = spec.fromDaysAgo; back >= last; back--) {
    const day = addDays(today, -back);
    if (day.getUTCDay() === 0) continue;
    if (rng.rand() < spec.idleChance) continue;
    const worked = r2(spec.perDay + (rng.rand() - 0.5) * spec.spread);
    if (worked <= 0) continue;
    const opening = reading;
    const closing = r3(opening + worked);
    const fuel =
      spec.fuelPerUnit > 0
        ? r2(worked * spec.fuelPerUnit * (0.93 + rng.rand() * 0.12))
        : null;
    logged.push({ date: day, hours: worked, fuel: fuel ?? 0 });
    reading = closing;
    await prisma.logbookEntry.create({
      data: {
        companyId: machine.companyId,
        equipmentId: machine.id,
        date: day,
        openingReading: money(opening),
        closingReading: money(closing),
        totalHours: money(worked),
        fuelConsumed: fuel !== null ? money(fuel) : null,
        operatorId,
        projectId: site.projectId,
        remarks: rng.rand() < 0.45 ? rng.pick(spec.remarks) : null,
        createdAt: at(day, 19, rng.int(0, 50)),
      },
    });
    bump('logbookEntries');
  }

  // Fills every fourth working day, against what the logbook burned in between. On a "leaky"
  // fill the fill day itself burned well past benchmark — which is what the API's variance
  // check reads (that day's logbook against the category), so the alert is the API's own.
  if (spec.fuelPerUnit > 0) {
    const fillIndices: number[] = [];
    for (let k = 3; k < logged.length; k += 4) fillIndices.push(k);
    const leaky = new Set(
      (spec.leakyFills ?? [])
        .map((n) => fillIndices[fillIndices.length - n])
        .filter((k) => k !== undefined),
    );
    for (const k of fillIndices) {
      const day = logged[k];
      if (leaky.has(k) && benchmark) {
        day.fuel = r2(day.hours * benchmark * (1.21 + rng.rand() * 0.09));
        await prisma.logbookEntry.update({
          where: {
            equipmentId_date: { equipmentId: machine.id, date: day.date },
          },
          data: { fuelConsumed: money(day.fuel) },
        });
      }
      const window = logged.slice(Math.max(0, k - 3), k + 1);
      const burned = window.reduce((sum, l) => sum + l.fuel, 0);
      const quantity = r2(burned * (0.98 + rng.rand() * 0.05));
      const rate = r2(93.6 + rng.rand() * 2.8);
      const variance = computeFuelVariance({
        fuelConsumed: day.fuel,
        totalHours: day.hours,
        benchmark,
        thresholdPercent: threshold,
      });
      await prisma.fuelEntry.create({
        data: {
          companyId: machine.companyId,
          equipmentId: machine.id,
          date: day.date,
          quantity: money(quantity),
          rate: money(rate),
          amount: money(r2(quantity * rate)),
          cardNo: `IOCL-FC-${
            7700 + (spec.chassisNo.charCodeAt(4) % 90)
          }${spec.chassisNo.slice(-4)}`,
          vendorId: fuelVendorId,
          siteId: site.id,
          variancePercent:
            variance.variancePercent === null
              ? null
              : money(variance.variancePercent),
          varianceAlert: variance.varianceAlert,
          createdAt: at(day.date, 18, rng.int(0, 59)),
        },
      });
      bump('fuelEntries');
    }
  }

  // The meter is the last reading anyone wrote down. Utilisation is month-to-date hours over the
  // category's target, as the logbook service computes it; for a km machine that formula gives
  // a distance over hours, so the base seed's share-of-working-days is kept for those instead.
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const thisMonth = logged.filter((l) => l.date >= monthStart);
  const utilisation =
    machine.meterType === 'km'
      ? Math.min(
          100,
          r2(
            (logged.filter((l) => l.date >= addDays(today, -30)).length / 26) *
              100,
          ),
        )
      : r2(
          (thisMonth.reduce((s, l) => s + l.hours, 0) /
            (category.targetHoursPerMonth || 176)) *
            100,
        );
  await prisma.equipment.update({
    where: { id: machine.id },
    data: {
      currentReading: money(reading),
      utilizationPercent: money(spec.sold ? 0 : utilisation),
      lastServiceDate: spec.service ? addDays(today, -rng.int(12, 40)) : null,
    },
  });

  if (spec.service && !spec.sold) {
    const interval = spec.service.interval;
    const lastDone = r3(reading - interval * (0.5 + rng.rand() * 0.42));
    await prisma.serviceSchedule.create({
      data: {
        companyId: machine.companyId,
        equipmentId: machine.id,
        serviceType: spec.service.type,
        ...(machine.meterType === 'km'
          ? { intervalKm: money(interval) }
          : { intervalHours: money(interval) }),
        lastDoneReading: money(lastDone),
        nextDueReading: money(r3(lastDone + interval)),
      },
    });
    bump('serviceSchedules');
  }
}

// ─── Fuel variance exceptions, recoveries and their approvals ─────────────────

async function seedFuelExceptions(
  ctx: CompanyContext,
  input: {
    machines: Machine[];
    benchmarkOf: (categoryId: string) => number | null;
    reviewer: { id: string };
    siteApprover: { id: string };
    finalApprover: { id: string };
    bump: (key: string, n?: number) => void;
  },
): Promise<void> {
  const { prisma, company, today } = ctx;
  const { bump } = input;
  const isTe = company.shortCode === 'TE';
  const alerted = await prisma.fuelEntry.findMany({
    where: { companyId: company.id, varianceAlert: true },
    orderBy: [{ date: 'asc' }],
    include: { equipment: true },
  });
  const chain = await prisma.approvalChain.findFirst({
    where: {
      companyId: company.id,
      actionType: 'operator_fuel_recovery',
      isActive: true,
    },
    include: { levels: { orderBy: { position: 'asc' } } },
  });

  const seen = new Map<string, number>(); // machine → alerts so far
  for (const entry of alerted) {
    const nth = seen.get(entry.equipmentId) ?? 0;
    seen.set(entry.equipmentId, nth + 1);
    const machine = input.machines.find((m) => m.id === entry.equipmentId);
    const raisedAt = at(addDays(entry.date, 1), 10, 20 + nth);
    const reviewedAt = at(
      addDays(entry.date, 3) > today ? today : addDays(entry.date, 3),
      12,
      45,
    );

    const logbook = await prisma.logbookEntry.findUnique({
      where: {
        equipmentId_date: { equipmentId: entry.equipmentId, date: entry.date },
      },
    });
    const shortfall = computeFuelShortfall({
      fuelConsumed:
        logbook?.fuelConsumed !== null && logbook?.fuelConsumed !== undefined
          ? Number(logbook.fuelConsumed)
          : logbook
          ? Number(entry.quantity)
          : null,
      totalHours: logbook ? Number(logbook.totalHours) : null,
      benchmark: input.benchmarkOf(entry.equipment.categoryId),
      rate: Number(entry.rate),
    });

    // What a reviewer made of it, by machine and by how many alerts it has had.
    type Decision =
      | { kind: 'open' }
      | { kind: 'dismissed'; reason: string }
      | { kind: 'neither'; reason: string }
      | { kind: 'hirer' }
      | { kind: 'operator'; recovery: 'approved' | 'pending1' | 'pending2' };
    let decision: Decision = { kind: 'open' };
    const isBaseTipper = entry.equipment.code.endsWith('EQ-TRN-01');
    const isHired = entry.equipment.ownership === 'hired';
    const operatorKnown = !!logbook?.operatorId;
    const recent = entry.date >= addDays(today, -4);
    if (recent) {
      decision = { kind: 'open' };
    } else if (isBaseTipper) {
      decision =
        nth === 0
          ? {
              kind: 'neither',
              reason: isTe
                ? 'Ran loaded on the diversion through Itaunja market during the culvert closure — slow traffic, extra burn accepted by the project manager.'
                : 'Haul road through the Banas sand stretch at Km 9 while the diversion was in use — extra burn accepted by the project manager.',
            }
          : nth === 1
          ? {
              kind: 'dismissed',
              reason:
                'Logbook km under-recorded: odometer cable was replaced that week; the trip sheet shows the extra distance.',
            }
          : { kind: 'open' };
    } else if (isHired) {
      decision = nth === 0 ? { kind: 'hirer' } : { kind: 'open' };
    } else if (operatorKnown && shortfall.shortfallAmount > 0) {
      decision =
        nth === 0
          ? { kind: 'operator', recovery: isTe ? 'pending1' : 'approved' }
          : nth === 1 && !isTe
          ? { kind: 'operator', recovery: 'pending2' }
          : { kind: 'open' };
    }
    if (decision.kind === 'hirer' && shortfall.shortfallAmount <= 0) {
      decision = { kind: 'open' };
    }

    const exception = await prisma.fuelVarianceException.create({
      data: {
        companyId: company.id,
        fuelEntryId: entry.id,
        status:
          decision.kind === 'open'
            ? 'open'
            : decision.kind === 'dismissed'
            ? 'dismissed'
            : 'confirmed',
        attribution:
          decision.kind === 'neither'
            ? 'neither'
            : decision.kind === 'hirer'
            ? 'hirer'
            : decision.kind === 'operator'
            ? 'operator'
            : null,
        operatorEmployeeId:
          decision.kind === 'operator' ? logbook?.operatorId ?? null : null,
        reviewedByUserId: decision.kind === 'open' ? null : input.reviewer.id,
        reviewedAt: decision.kind === 'open' ? null : reviewedAt,
        reason:
          decision.kind === 'dismissed' || decision.kind === 'neither'
            ? decision.reason
            : decision.kind === 'hirer'
            ? 'Dry hire at an agreed 8 L/hr; vendor operator ran the machine at idle through lunch on the compaction stretch.'
            : decision.kind === 'operator'
            ? 'Fill-day burn well above benchmark with no breakdown or extra work in the site diary.'
            : null,
        createdAt: raisedAt,
      },
    });
    bump('fuelExceptions');

    if (decision.kind === 'hirer' && machine?.vendorId) {
      // As deductFromHireBill: the bill covering the date, or — when that one is paid — the
      // next unpaid bill for the same machine and vendor.
      const covering = await prisma.hireBill.findFirst({
        where: {
          equipmentId: entry.equipmentId,
          billingPeriodFrom: { lte: entry.date },
          billingPeriodTo: { gte: entry.date },
        },
        orderBy: { createdAt: 'desc' },
      });
      const target =
        covering && covering.status !== 'paid'
          ? covering
          : covering
          ? await prisma.hireBill.findFirst({
              where: {
                equipmentId: covering.equipmentId,
                vendorId: covering.vendorId,
                status: { not: 'paid' },
                billingPeriodFrom: { gt: covering.billingPeriodFrom },
              },
              orderBy: { billingPeriodFrom: 'asc' },
            })
          : null;
      if (target) {
        await prisma.hireBillDeduction.create({
          data: {
            companyId: company.id,
            hireBillId: target.id,
            fuelVarianceExceptionId: exception.id,
            amount: money(shortfall.shortfallAmount),
            createdByUserId: input.reviewer.id,
            createdAt: reviewedAt,
          },
        });
        const bill = await prisma.hireBill.findUniqueOrThrow({
          where: { id: target.id },
          include: { fuelDeductions: { select: { amount: true } } },
        });
        const { netPayable } = computeHireBillAmounts({
          billedHours: Number(bill.billedHours),
          rate: Number(bill.rate),
          tdsRate: bill.tdsRate === null ? null : Number(bill.tdsRate),
          deductions: bill.fuelDeductions.map((d) => Number(d.amount)),
          ...(bill.basis === 'monthly'
            ? { grossAmount: Number(bill.grossAmount) }
            : {}),
          otherDeductions: [
            Number(bill.deductionAmount),
            Number(bill.holdAmount),
          ],
        });
        await prisma.hireBill.update({
          where: { id: target.id },
          data: { netPayable: money(netPayable) },
        });
        bump('hireBillDeductions');
      }
    }

    if (decision.kind === 'operator' && logbook?.operatorId && chain) {
      const recovery = await prisma.operatorFuelRecovery.create({
        data: {
          companyId: company.id,
          fuelVarianceExceptionId: exception.id,
          employeeId: logbook.operatorId,
          amount: money(shortfall.shortfallAmount),
          status:
            decision.recovery === 'approved' ? 'approved' : 'pending_approval',
          createdByUserId: input.reviewer.id,
          createdAt: reviewedAt,
        },
      });
      const levels = chain.levels;
      const finalPosition = levels[levels.length - 1]?.position ?? 1;
      const instance = await prisma.approvalInstance.create({
        data: {
          companyId: company.id,
          chainId: chain.id,
          entityType: 'operator_fuel_recovery',
          entityId: recovery.id,
          subject: `${entry.equipment.code} — fuel recovery of ${shortfall.shortfallAmount} from operator`,
          href: '/dashboard/plant/fuel',
          viewPermission: 'MACHINERY',
          originatorUserId: input.reviewer.id,
          currentPosition:
            decision.recovery === 'approved'
              ? finalPosition
              : decision.recovery === 'pending2'
              ? Math.min(2, finalPosition)
              : 1,
          state: decision.recovery === 'approved' ? 'approved' : 'pending',
          createdAt: reviewedAt,
        },
      });
      const approvers = [input.siteApprover, input.finalApprover];
      const decided =
        decision.recovery === 'approved'
          ? levels.length
          : decision.recovery === 'pending2'
          ? Math.min(1, levels.length - 1)
          : 0;
      for (let i = 0; i < decided; i++) {
        await prisma.approvalDecision.create({
          data: {
            approvalInstanceId: instance.id,
            companyId: company.id,
            round: 1,
            position: levels[i].position,
            actorUserId: approvers[Math.min(i, approvers.length - 1)].id,
            action: 'approve',
            decidedAt: new Date(
              reviewedAt.getTime() + (i + 1) * 26 * 3_600_000,
            ),
          },
        });
        bump('approvalDecisions');
      }
      await prisma.operatorFuelRecovery.update({
        where: { id: recovery.id },
        data: { approvalItemId: instance.id },
      });
      bump('operatorFuelRecoveries');
      bump('approvalInstances');
    }
  }
}

// ─── Paper scans ──────────────────────────────────────────────────────────────

function paperTitle(kind: PaperKind): string {
  return {
    rc: 'CERTIFICATE OF REGISTRATION (FORM 23)',
    insurance: 'CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE',
    fitness: 'CERTIFICATE OF FITNESS (FORM 38)',
    road_tax: 'MOTOR VEHICLE TAX RECEIPT',
    permit: 'NATIONAL PERMIT — GOODS CARRIAGE (FORM 48)',
    pollution: 'POLLUTION UNDER CONTROL CERTIFICATE',
  }[kind];
}

function paperBody(
  kind: PaperKind,
  p: {
    machine: Machine;
    owner: string;
    number: string | null;
    insurer: string;
    regDate: Date;
    expiresAt: Date | null;
    issued: Date;
  },
): string {
  const s = p.machine.spec;
  const vehicle = [
    `Registration No.: ${
      p.machine.registrationNo ?? 'Not registered (off-road machine)'
    }`,
    `Make / Model: ${s.make ?? ''} ${s.model ?? ''}`,
    `Year of manufacture: ${s.year ?? ''}`,
    `Engine No.: ${s.engineNo ?? ''}`,
    `Chassis No.: ${s.chassisNo ?? ''}`,
    `Fuel: ${
      p.machine.spec.power === 'electric' ? 'Electric / grid' : 'Diesel'
    }`,
  ];
  const rto = (p.machine.registrationNo ?? '').startsWith('UP32')
    ? 'RTO Lucknow (UP-32)'
    : (p.machine.registrationNo ?? '').startsWith('HR55')
    ? 'RTA Gurugram (HR-55)'
    : (p.machine.registrationNo ?? '').startsWith('RJ14')
    ? 'RTO Jaipur (RJ-14)'
    : 'DTO Tonk (RJ-26)';
  const lines: string[] = [];
  switch (kind) {
    case 'rc':
      lines.push(
        `Registering authority: ${rto}`,
        `Registered owner: ${p.owner}`,
        `Date of registration: ${ddmmyyyy(p.regDate)}`,
        `Registration valid up to: ${
          p.expiresAt ? ddmmyyyy(p.expiresAt) : '—'
        }`,
        `Class of vehicle: ${
          s.papers === 'cev'
            ? 'Construction Equipment Vehicle'
            : 'Goods Carrier (HGV)'
        }`,
        ...vehicle,
      );
      break;
    case 'insurance':
      lines.push(
        `Insurer: ${p.insurer}`,
        `Policy No.: ${p.number}`,
        `Insured: ${p.owner}`,
        `Period of insurance: ${ddmmyyyy(p.issued)} 00:00 hrs to ${
          p.expiresAt ? ddmmyyyy(p.expiresAt) : '—'
        } midnight`,
        `Cover: ${
          s.papers === 'road'
            ? 'Package policy — commercial vehicle (goods carrying)'
            : 'Contractor’s Plant and Machinery (CPM) policy'
        }`,
        `Insured declared value: Rs. ${inr(
          Math.round((s.purchaseCost ?? 2500000) * 0.62),
        )}`,
        ...vehicle,
        '',
        'Subject to the IMT endorsements and conditions printed on the policy.',
      );
      break;
    case 'fitness':
      lines.push(
        `Issuing authority: ${rto}`,
        `Certificate No.: ${p.number}`,
        `Owner: ${p.owner}`,
        `Inspected on: ${ddmmyyyy(p.issued)}`,
        `Certificate valid up to: ${p.expiresAt ? ddmmyyyy(p.expiresAt) : '—'}`,
        ...vehicle,
        '',
        'Certified that the vehicle complies with the provisions of the Motor Vehicles Act, 1988 and the rules made thereunder.',
      );
      break;
    case 'road_tax':
      lines.push(
        `Taxation authority: ${rto}`,
        `Receipt No.: ${p.number}`,
        `Owner: ${p.owner}`,
        p.expiresAt
          ? `Tax paid for the period: ${ddmmyyyy(p.issued)} to ${ddmmyyyy(
              p.expiresAt,
            )}`
          : `One-time tax paid on registration (${ddmmyyyy(
              p.regDate,
            )}) — valid for the life of the vehicle`,
        ...vehicle,
      );
      break;
    case 'permit':
      lines.push(
        `Issuing authority: ${rto}`,
        `Permit No.: ${p.number}`,
        `Permit holder: ${p.owner}`,
        `Valid from ${ddmmyyyy(p.issued)} to ${
          p.expiresAt ? ddmmyyyy(p.expiresAt) : '—'
        }`,
        'Area of operation: Whole of India (national permit, authorisation renewed annually)',
        ...vehicle,
      );
      break;
    case 'pollution':
      lines.push(
        `Certificate No.: ${p.number}`,
        `Owner: ${p.owner}`,
        `Date of test: ${ddmmyyyy(p.issued)}`,
        `Valid up to: ${p.expiresAt ? ddmmyyyy(p.expiresAt) : '—'}`,
        'Smoke density (HSU): 41.6 — within the prescribed limit of 65',
        ...vehicle,
      );
      break;
  }
  return lines.join('\n');
}

// ─── A machine photograph ─────────────────────────────────────────────────────

const xmlSafe = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A plain yard shot: sky, a gravel hardstand, the machine's silhouette in its livery and the
 * asset plate painted on it. Rendered with sharp from SVG, so no image files ship with the seed.
 */
async function machinePhoto(
  m: Machine,
  category: string,
  look: { body: string; accent: string },
  owner: string,
): Promise<Buffer> {
  const cat = categoryShape(category);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9cc6e8"/><stop offset="1" stop-color="#e6eef3"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b9a382"/><stop offset="1" stop-color="#8d7a5c"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="640" fill="url(#sky)"/>
  <path d="M0 600 L220 540 L430 575 L700 520 L980 570 L1250 530 L1600 580 L1600 660 L0 660 Z" fill="#a9b29a"/>
  <rect y="640" width="1600" height="427" fill="url(#ground)"/>
  <ellipse cx="800" cy="905" rx="610" ry="38" fill="#000" opacity="0.22"/>
  ${cat(look.body, look.accent)}
  <rect x="40" y="40" width="560" height="120" rx="10" fill="#000" opacity="0.45"/>
  <text x="64" y="92" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#fff">${xmlSafe(
    m.code,
  )}</text>
  <text x="64" y="138" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#fff">${xmlSafe(
    m.registrationNo ?? m.name,
  )}</text>
  <text x="1560" y="1035" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#fff" opacity="0.85">${xmlSafe(
    owner,
  )}</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

function categoryShape(
  category: string,
): (body: string, accent: string) => string {
  const wheel = (cx: number, cy: number, r: number) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#1c1c1c"/><circle cx="${cx}" cy="${cy}" r="${
      r * 0.45
    }" fill="#8a8a8a"/>`;
  const drum = (x: number, y: number, w: number, h: number, body: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${
      h / 2
    }" fill="${body}" stroke="#222" stroke-width="6"/>`;
  if (/EXCAVATOR|Earthmoving/i.test(category)) {
    return (b, a) => `
      <rect x="380" y="790" width="760" height="110" rx="55" fill="#2b2b2b"/>
      ${[440, 560, 680, 800, 920, 1040]
        .map((x) => `<circle cx="${x}" cy="845" r="32" fill="#4a4a4a"/>`)
        .join('')}
      <rect x="430" y="610" width="560" height="170" rx="18" fill="${b}"/>
      <rect x="820" y="470" width="190" height="200" rx="14" fill="${b}"/>
      <rect x="845" y="495" width="140" height="110" rx="8" fill="#9fc3d6" stroke="${a}" stroke-width="6"/>
      <path d="M1000 600 L1230 360 L1270 390 L1060 640 Z" fill="${b}"/>
      <path d="M1230 360 L1380 560 L1340 585 L1205 400 Z" fill="${b}"/>
      <path d="M1330 560 L1420 610 L1390 700 L1300 650 Z" fill="${a}"/>`;
  }
  if (/COMPACTOR|ROLLER/i.test(category)) {
    return (b, a) => `
      ${drum(380, 720, 330, 180, b)}${drum(930, 720, 330, 180, b)}
      <rect x="560" y="600" width="520" height="150" rx="16" fill="${b}"/>
      <rect x="760" y="420" width="190" height="190" rx="10" fill="none" stroke="${a}" stroke-width="12"/>
      <rect x="770" y="560" width="170" height="50" fill="${a}"/>`;
  }
  if (/GRADER/i.test(category)) {
    return (b, a) => `
      ${wheel(360, 840, 75)}${wheel(1080, 840, 75)}${wheel(1260, 840, 75)}
      <rect x="300" y="700" width="1050" height="70" rx="20" fill="${b}"/>
      <rect x="1000" y="560" width="300" height="150" rx="14" fill="${b}"/>
      <rect x="1030" y="470" width="190" height="110" rx="8" fill="#9fc3d6" stroke="${a}" stroke-width="6"/>
      <path d="M560 860 L860 820 L870 850 L570 895 Z" fill="${a}"/>`;
  }
  if (/PAVER/i.test(category)) {
    return (b, a) => `
      <rect x="360" y="800" width="840" height="100" rx="50" fill="#2b2b2b"/>
      <rect x="380" y="610" width="800" height="200" rx="14" fill="${b}"/>
      <rect x="300" y="760" width="120" height="120" fill="${a}"/>
      <rect x="1180" y="790" width="180" height="90" fill="${a}"/>
      <rect x="760" y="470" width="220" height="150" rx="8" fill="none" stroke="${a}" stroke-width="12"/>`;
  }
  if (/HOT MIX|BATCHING|Concreting|PLANT/i.test(category)) {
    return (b, a) => `
      <rect x="260" y="520" width="380" height="380" fill="${b}" stroke="#555" stroke-width="6"/>
      ${drum(660, 700, 560, 150, a)}
      <rect x="1220" y="300" width="70" height="600" fill="#7a7a7a"/>
      <rect x="300" y="420" width="90" height="100" fill="${a}"/><rect x="420" y="420" width="90" height="100" fill="${a}"/><rect x="540" y="420" width="90" height="100" fill="${a}"/>`;
  }
  if (/GENERATOR|Power/i.test(category)) {
    return (b, a) => `
      <rect x="430" y="600" width="740" height="300" rx="16" fill="${b}" stroke="#333" stroke-width="6"/>
      ${[0, 1, 2, 3, 4, 5]
        .map(
          (i) =>
            `<rect x="${
              500 + i * 100
            }" y="660" width="60" height="180" fill="${a}" opacity="0.6"/>`,
        )
        .join('')}`;
  }
  if (/CRANE|Lifting/i.test(category)) {
    return (b, a) => `
      ${wheel(470, 850, 70)}${wheel(1130, 850, 70)}
      <rect x="380" y="690" width="860" height="120" rx="14" fill="${b}"/>
      <rect x="390" y="560" width="230" height="140" rx="10" fill="${b}"/>
      <path d="M700 690 L1360 330 L1385 370 L740 720 Z" fill="${a}"/>
      <line x1="1370" y1="350" x2="1370" y2="620" stroke="#222" stroke-width="5"/>`;
  }
  // Road vehicles: tipper, tanker, transit mixer.
  return (b, a) => {
    const load = /TANKER/i.test(category)
      ? drum(560, 560, 700, 240, b)
      : /MIXER/i.test(category)
      ? `<ellipse cx="900" cy="650" rx="360" ry="150" fill="${b}" stroke="${a}" stroke-width="10"/>`
      : `<path d="M560 560 L1290 560 L1250 800 L560 800 Z" fill="${b}"/>`;
    return `
      ${wheel(420, 860, 70)}${wheel(1000, 860, 70)}${wheel(1160, 860, 70)}
      <rect x="320" y="780" width="1000" height="40" fill="#2b2b2b"/>
      <path d="M300 800 L300 610 L360 520 L520 520 L520 800 Z" fill="${a}"/>
      <path d="M335 610 L375 545 L490 545 L490 610 Z" fill="#9fc3d6"/>
      ${load}`;
  };
}
