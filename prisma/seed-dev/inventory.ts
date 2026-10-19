/**
 * Inventory and partners completion (`SEED_DEV_ONLY=inventory`).
 *
 * The base seed leaves each company with six bare vendors (a name and a type), ten items and a
 * purchase register. This fills what a company that has been buying for a season would hold:
 *
 * - vendor particulars (GSTIN, PAN, address, bank, TDS) where the base seed left them blank, a
 *   handful more vendors — bitumen, crusher, road marking, a second hire firm, a subcontractor,
 *   a second labour contractor, a transporter — contacts, and what each deals in;
 * - five more items the rate contracts need (10 mm aggregate, GSB, RS-1, 16 mm TMT, diesel) and
 *   HSN codes on the items that had none;
 * - rate contracts (`VendorItemRate`), with a revision history where the market moves (bitumen
 *   every fortnight, diesel), current-only elsewhere;
 * - purchase orders exactly as the app makes them: a `letter_purchase_order` letter composed by
 *   the store keeper, its 016 approval chain decided level by level, issued with the next
 *   `PRPL/2026-27/NNNN` reference and the client's PDF rendered through the app's own renderer,
 *   and — for the issued ones — the `PurchaseOrder` + lines `PurchaseOrdersService.sync` would
 *   materialise. August and September POs are received by the purchases already in the
 *   register (closed / partly received); October ones are open, awaiting issue, pending at
 *   either level, or rejected;
 * - the company's purchase-order terms (Settings → Terms), hire terms for the hire vendors,
 *   contractor profiles with their statutory documents (PDFs under `contractor-documents`, the
 *   upload path's namespace), monthly PF/ESIC filings, and BOCW cess payments per project.
 *
 * Numbering: no `CodeFormat` rows — a company that never opened Settings → Numbering runs on the
 * built-in formats, which are Parth Realcon's. New vendors take the next `2022NNN` code the
 * VENDORS series would allocate, and that series' `CodeSequence` is moved past them so the next
 * vendor created in the app does not have to step over them.
 */
import { promises as fs } from 'fs';
import { resolve as resolvePath } from 'path';

import {
  ContractorDocumentType,
  MonthlyComplianceStatus,
  Prisma,
  TermsDocumentKind,
  VendorType,
} from '@prisma/client';

import config from '../../src/common/configs/config';
import {
  decryptBlob,
  parseEncryptionKey,
} from '../../src/common/storage/blob-cipher';
import { S3StorageAdapter } from '../../src/common/storage/s3-storage.adapter';
import { LETTER_LAYOUTS } from '../../src/letters/letter-layouts';
import { renderLetterPdf } from '../../src/letters/letter-pdf.renderer';
import {
  nextReference,
  referencePrefix,
} from '../../src/letters/letter-reference';
import {
  composeAddress,
  presentLetterValues,
} from '../../src/letters/letter-values';
import { expandLineItems, parseLineItems } from '../../src/letters/line-items';
import { renderTemplate } from '../../src/letters/template-resolver';
import {
  CODE_SERIES_FORMATS,
  formatCode,
} from '../../src/settings/code-series/code-series.formats';
import { STANDARD_TERMS } from '../../src/settings/terms-templates/standard-terms';
import { lastCompletedMonth } from '../../src/partners/compliance/compliance-status.service';
import { at, d, dateOnly, money } from './support';
import type { CompanyContext, ModuleResult } from './support';

// ─── Constants the app defines elsewhere ──────────────────────────────────────

/** `PURCHASE_ORDER_KIND` / `ACTION_LETTER_PURCHASE_ORDER`. */
const PO_KIND = 'letter_purchase_order';
/** `webRoutes.inventoryPurchaseOrders()` — where the approval inbox sends a PO approver. */
const PO_HREF = '/dashboard/inventory/purchase-orders';
/** `LETTER_NAMESPACE` — where issued letter PDFs live. */
const LETTER_NAMESPACE = 'letter';
/** What `ContractorsService.uploadDocument` stores documents under. */
const CONTRACTOR_DOC_NAMESPACE = 'contractor-documents';

// ─── Small helpers ────────────────────────────────────────────────────────────

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A GSTIN with a correct check character (the GSTN mod-36 scheme). */
function gstin(stateCode: string, pan: string): string {
  const body = `${stateCode}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const product = GSTIN_CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return body + GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const addDays = (day: Date, n: number) => {
  const t = new Date(day);
  t.setUTCDate(t.getUTCDate() + n);
  return t;
};
const addMonths = (day: Date, n: number) => {
  const t = new Date(day);
  t.setUTCMonth(t.getUTCMonth() + n);
  return t;
};
/** `dd/mm/yyyy` of the IST calendar date — what `formatLetterDate` prints on an IST server. */
const letterDate = (t: Date) => {
  const day = dateOnly(t);
  return `${String(day.getUTCDate()).padStart(2, '0')}/${String(
    day.getUTCMonth() + 1,
  ).padStart(2, '0')}/${day.getUTCFullYear()}`;
};
const monthKey = (day: Date) =>
  `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`;

const r2 =
  process.env.STORAGE_DRIVER === 's3'
    ? new S3StorageAdapter({
        get: (key: string) =>
          (config() as unknown as Record<string, unknown>)[key],
      } as never)
    : null;

/** Reads a stored blob as the API's storage would; null when it is not there. */
async function readBlob(ref: string | null): Promise<Buffer | null> {
  if (!ref) return null;
  try {
    if (r2) return await r2.get(ref);
    const path = resolvePath(
      process.cwd(),
      process.env.STORAGE_LOCAL_PATH || 'var/storage',
      ref,
    );
    return decryptBlob(
      await fs.readFile(path),
      parseEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY),
    );
  } catch {
    return null;
  }
}

// ─── Reference data ───────────────────────────────────────────────────────────

interface VendorParticulars {
  pan: string;
  state: string;
  stateCode: string;
  address: string;
  city: string;
  pinCode: string;
  tdsSection: string | null;
  tdsRate: number | null;
  bankName: string;
  bankBranch: string;
  bankAccountNumber: string;
  ifscCode: string;
  /** Unregistered small suppliers carry a PAN and no GSTIN. */
  unregistered?: boolean;
}

interface VendorSpec extends VendorParticulars {
  key: string;
  name: string;
  type: VendorType;
  categories: string[];
  contacts: { name: string; phone: string; email: string | null }[];
}

/** The base seed's six, by the suffix of their code (`PRPL-V-1001`). Same suppliers for both. */
const BASE_VENDORS: Record<string, Omit<VendorSpec, 'name' | 'type'>> = {
  'V-1001': {
    key: 'utcl',
    pan: 'AAACU7731N',
    state: 'Rajasthan',
    stateCode: '08',
    address: 'Dealer Depot, F-62, RIICO Industrial Area, Sitapura',
    city: 'Jaipur',
    pinCode: '302022',
    tdsSection: '194Q',
    tdsRate: 0.1,
    bankName: 'State Bank of India',
    bankBranch: 'Sitapura Industrial Area, Jaipur',
    bankAccountNumber: '38214457702',
    ifscCode: 'SBIN0031025',
    categories: ['Material', 'Cement & Binders', 'Aggregates'],
    contacts: [
      {
        name: 'Rohit Saxena',
        phone: '9928201455',
        email: 'rohit.saxena.utcl@gmail.com',
      },
      { name: 'Manish Choudhary', phone: '9636018827', email: null },
    ],
  },
  'V-1002': {
    key: 'balaji',
    pan: 'ABMFS4417K',
    state: 'Rajasthan',
    stateCode: '08',
    address: 'G-112, Loha Mandi, Road No. 9, VKI Area',
    city: 'Jaipur',
    pinCode: '302013',
    tdsSection: '194Q',
    tdsRate: 0.1,
    bankName: 'HDFC Bank',
    bankBranch: 'VKI Area, Jaipur',
    bankAccountNumber: '50200048813327',
    ifscCode: 'HDFC0002316',
    categories: ['Material', 'Steel'],
    contacts: [
      {
        name: 'Pawan Agarwal',
        phone: '9829054418',
        email: 'sribalajisteel.jpr@gmail.com',
      },
    ],
  },
  'V-1003': {
    key: 'ioc',
    pan: 'AAJFD5512Q',
    state: 'Rajasthan',
    stateCode: '08',
    address: 'Deoli Fuel Point, NH-52 Bypass, Near Krishi Upaj Mandi',
    city: 'Deoli',
    pinCode: '304804',
    tdsSection: null,
    tdsRate: null,
    bankName: 'Bank of Baroda',
    bankBranch: 'Deoli',
    bankAccountNumber: '29870200001456',
    ifscCode: 'BARB0DEOLIX',
    categories: ['Fuel'],
    contacts: [
      {
        name: 'Suresh Chand Jain',
        phone: '9414031176',
        email: 'deolifuelpoint@gmail.com',
      },
      { name: 'Raju Sen', phone: '9530112244', email: null },
    ],
  },
  'V-1004': {
    key: 'sundaram',
    pan: 'AXYPS8820L',
    state: 'Rajasthan',
    stateCode: '08',
    address: 'Plot 7, Transport Nagar',
    city: 'Kota',
    pinCode: '324005',
    tdsSection: '194I',
    tdsRate: 2,
    bankName: 'Punjab National Bank',
    bankBranch: 'Transport Nagar, Kota',
    bankAccountNumber: '0723002100045512',
    ifscCode: 'PUNB0072300',
    categories: ['Hire'],
    contacts: [
      {
        name: 'Sundar Lal Sharma',
        phone: '9414178830',
        email: 'sundaramequipment.kota@gmail.com',
      },
      { name: 'Mukesh Nagar', phone: '9785512036', email: null },
    ],
  },
  'V-1005': {
    key: 'ashok',
    pan: 'BQZPM3361D',
    state: 'Rajasthan',
    stateCode: '08',
    address: 'Ward No. 7, Bheru Ji Chowk',
    city: 'Deoli',
    pinCode: '304804',
    tdsSection: '194C',
    tdsRate: 1,
    bankName: 'State Bank of India',
    bankBranch: 'Deoli',
    bankAccountNumber: '34418620915',
    ifscCode: 'SBIN0007786',
    categories: ['Labour Supply', 'Subcontractor'],
    contacts: [{ name: 'Ashok Kumar Meena', phone: '9460217736', email: null }],
  },
  'V-1006': {
    key: 'survey',
    pan: 'AAQFP2290C',
    state: 'Rajasthan',
    stateCode: '08',
    address: '214, Shyam Plaza, Ajmer Road',
    city: 'Jaipur',
    pinCode: '302006',
    tdsSection: '194J',
    tdsRate: 2,
    bankName: 'ICICI Bank',
    bankBranch: 'Ajmer Road, Jaipur',
    bankAccountNumber: '067405001882',
    ifscCode: 'ICIC0000674',
    categories: ['Service'],
    contacts: [
      {
        name: 'Amit Bhardwaj',
        phone: '9314503392',
        email: 'amit@precisionsurvey.in',
      },
      { name: 'Dinesh Prajapat', phone: '8003915527', email: null },
    ],
  },
};

/** Vendors each company added after the base six, in the order they were registered. */
const NEW_VENDORS: Record<string, VendorSpec[]> = {
  PRPL: [
    {
      key: 'bitumen',
      name: 'Rajasthan Bitumen & Emulsions Pvt Ltd',
      type: 'material',
      pan: 'AAFCR6618H',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'E-271, RIICO Industrial Area, Sitapura',
      city: 'Jaipur',
      pinCode: '302022',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'Axis Bank',
      bankBranch: 'Sitapura, Jaipur',
      bankAccountNumber: '921020034417586',
      ifscCode: 'UTIB0000589',
      categories: ['Material', 'Bitumen & Emulsion'],
      contacts: [
        {
          name: 'Vikas Agarwal',
          phone: '9829064412',
          email: 'vikas.agarwal@rbepl.co.in',
        },
        {
          name: 'Naresh Kumawat',
          phone: '9772153360',
          email: 'dispatch@rbepl.co.in',
        },
      ],
    },
    {
      key: 'crusher',
      name: 'Shree Kalyan Stone Crusher',
      type: 'material',
      pan: 'ADGFS1174P',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'Khasra No. 412, Rajmahal Road, Village Santhali',
      city: 'Deoli',
      pinCode: '304804',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'State Bank of India',
      bankBranch: 'Deoli',
      bankAccountNumber: '36120458871',
      ifscCode: 'SBIN0007786',
      categories: ['Material', 'Aggregates'],
      contacts: [
        {
          name: 'Bhanwar Lal Saini',
          phone: '9414687120',
          email: 'shreekalyancrusher@gmail.com',
        },
        { name: 'Raju Mali', phone: '9649118205', email: null },
      ],
    },
    {
      key: 'marking',
      name: 'Marudhar Road Safety Products',
      type: 'material',
      pan: 'ACJFM3307B',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'B-14, Road No. 14, Vishwakarma Industrial Area',
      city: 'Jaipur',
      pinCode: '302013',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'HDFC Bank',
      bankBranch: 'Vishwakarma Industrial Area, Jaipur',
      bankAccountNumber: '50200061127745',
      ifscCode: 'HDFC0001790',
      categories: ['Material', 'Road Marking & Safety'],
      contacts: [
        {
          name: 'Gaurav Jain',
          phone: '9928114506',
          email: 'sales@marudharroadsafety.in',
        },
      ],
    },
    {
      key: 'hire2',
      name: 'Bajrang Earthmovers',
      type: 'hire',
      pan: 'CEKPC5524R',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'Near RTO Office, Jaipur Road',
      city: 'Tonk',
      pinCode: '304001',
      tdsSection: '194I',
      tdsRate: 2,
      bankName: 'Bank of Baroda',
      bankBranch: 'Tonk',
      bankAccountNumber: '18690100007719',
      ifscCode: 'BARB0TONKXX',
      categories: ['Hire', 'Transport'],
      contacts: [
        {
          name: 'Bajrang Lal Choudhary',
          phone: '9413357821',
          email: 'bajrangearthmovers@gmail.com',
        },
        { name: 'Hanuman Jat', phone: '8875432109', email: null },
      ],
    },
    {
      key: 'sub',
      name: 'Kanha Infra Projects',
      type: 'subcontractor',
      pan: 'AANFK8841G',
      state: 'Rajasthan',
      stateCode: '08',
      address: '45, Talwandi, Sector-B',
      city: 'Kota',
      pinCode: '324005',
      tdsSection: '194C',
      tdsRate: 2,
      bankName: 'ICICI Bank',
      bankBranch: 'Talwandi, Kota',
      bankAccountNumber: '125605002218',
      ifscCode: 'ICIC0001256',
      categories: ['Subcontractor'],
      contacts: [
        {
          name: 'Rajendra Nagar',
          phone: '9351126634',
          email: 'kanhainfra.kota@gmail.com',
        },
        { name: 'Pawan Meena', phone: '7737412290', email: null },
      ],
    },
    {
      key: 'labour2',
      name: 'Devnarayan Labour Supply',
      type: 'labour_contractor',
      pan: 'DHVPG7718M',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'Village Dhoola, Tehsil Deoli',
      city: 'Deoli',
      pinCode: '304804',
      tdsSection: '194C',
      tdsRate: 1,
      bankName: 'State Bank of India',
      bankBranch: 'Deoli',
      bankAccountNumber: '39027716604',
      ifscCode: 'SBIN0007786',
      categories: ['Labour Supply'],
      contacts: [
        { name: 'Gopal Lal Gurjar', phone: '9784021537', email: null },
      ],
    },
    {
      key: 'transport',
      name: 'Tonk Roadways Transport Co.',
      type: 'service',
      pan: 'AAHFT2219J',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'Transport Nagar, Jaipur Road',
      city: 'Tonk',
      pinCode: '304001',
      tdsSection: '194C',
      tdsRate: 2,
      bankName: 'Punjab National Bank',
      bankBranch: 'Tonk',
      bankAccountNumber: '1840002100031187',
      ifscCode: 'PUNB0184000',
      categories: ['Transport', 'Service'],
      contacts: [
        {
          name: 'Imran Khan',
          phone: '9414329918',
          email: 'tonkroadways@gmail.com',
        },
      ],
    },
  ],
  TE: [
    {
      key: 'bitumen',
      name: 'Shiv Shakti Bitumen Industries Pvt Ltd',
      type: 'material',
      pan: 'AAKCS4421D',
      state: 'Haryana',
      stateCode: '06',
      address: 'Plot 118, Sector 16, HSIIDC Industrial Estate, Bahadurgarh',
      city: 'Jhajjar',
      pinCode: '124507',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'Kotak Mahindra Bank',
      bankBranch: 'Bahadurgarh',
      bankAccountNumber: '4812553907',
      ifscCode: 'KKBK0004263',
      categories: ['Material', 'Bitumen & Emulsion'],
      contacts: [
        {
          name: 'Ankit Goyal',
          phone: '9812044716',
          email: 'ankit@shivshaktibitumen.com',
        },
        { name: 'Sandeep Dahiya', phone: '9671203348', email: null },
      ],
    },
    {
      key: 'crusher',
      name: 'Awadh Grit & Stone Suppliers',
      type: 'material',
      pan: 'ABBFA5530K',
      state: 'Uttar Pradesh',
      stateCode: '09',
      address: 'Sitapur Road, Near Bakshi Ka Talab',
      city: 'Lucknow',
      pinCode: '226201',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'Bank of Baroda',
      bankBranch: 'Bakshi Ka Talab, Lucknow',
      bankAccountNumber: '33850200000921',
      ifscCode: 'BARB0BKTLUC',
      categories: ['Material', 'Aggregates'],
      contacts: [
        {
          name: 'Mohd. Arif Siddiqui',
          phone: '9415023876',
          email: 'awadhgrit@gmail.com',
        },
        { name: 'Shailendra Yadav', phone: '8004412763', email: null },
      ],
    },
    {
      key: 'marking',
      name: 'Hadoti Roadmark Industries',
      type: 'material',
      pan: 'ACBFH6602E',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'SP-41, RIICO Industrial Area, Kansua',
      city: 'Kota',
      pinCode: '324003',
      tdsSection: '194Q',
      tdsRate: 0.1,
      bankName: 'HDFC Bank',
      bankBranch: 'Kansua, Kota',
      bankAccountNumber: '50200071004418',
      ifscCode: 'HDFC0003417',
      categories: ['Material', 'Road Marking & Safety'],
      contacts: [
        {
          name: 'Sunil Maheshwari',
          phone: '9414187705',
          email: 'hadotiroadmark@gmail.com',
        },
      ],
    },
    {
      key: 'hire2',
      name: 'Aravali Earthmovers',
      type: 'hire',
      pan: 'BFTPY2271A',
      state: 'Haryana',
      stateCode: '06',
      address: 'Village Dhunela, Sohna Road',
      city: 'Gurugram',
      pinCode: '122102',
      tdsSection: '194I',
      tdsRate: 2,
      bankName: 'Punjab National Bank',
      bankBranch: 'Sohna, Gurugram',
      bankAccountNumber: '4231000100058823',
      ifscCode: 'PUNB0423100',
      categories: ['Hire', 'Transport'],
      contacts: [
        {
          name: 'Satbir Yadav',
          phone: '9813356624',
          email: 'aravaliearthmovers@gmail.com',
        },
      ],
    },
    {
      key: 'sub',
      name: 'Shubh Labh Infra',
      type: 'subcontractor',
      pan: 'AAPFS9915L',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'B-56, Indraprastha Industrial Area',
      city: 'Kota',
      pinCode: '324005',
      tdsSection: '194C',
      tdsRate: 2,
      bankName: 'State Bank of India',
      bankBranch: 'Indraprastha Industrial Area, Kota',
      bankAccountNumber: '37740219983',
      ifscCode: 'SBIN0011702',
      categories: ['Subcontractor'],
      contacts: [
        {
          name: 'Vinod Agrawal',
          phone: '9829236617',
          email: 'shubhlabhinfra@gmail.com',
        },
        { name: 'Deepak Sharma', phone: '7014528830', email: null },
      ],
    },
    {
      key: 'labour2',
      name: 'Sitapur Labour Services',
      type: 'labour_contractor',
      pan: 'CJWPV4482N',
      state: 'Uttar Pradesh',
      stateCode: '09',
      address: 'Mohalla Lalbagh, Near Roadways Bus Stand',
      city: 'Sitapur',
      pinCode: '261001',
      tdsSection: '194C',
      tdsRate: 1,
      bankName: 'Union Bank of India',
      bankBranch: 'Sitapur',
      bankAccountNumber: '402102010031776',
      ifscCode: 'UBIN0540218',
      categories: ['Labour Supply'],
      contacts: [
        { name: 'Ramkishore Verma', phone: '9450371882', email: null },
      ],
    },
    {
      key: 'transport',
      name: 'Deoli Road Carriers',
      type: 'service',
      pan: 'AAIFD7103H',
      state: 'Rajasthan',
      stateCode: '08',
      address: 'Kota Road, Near Bus Stand',
      city: 'Deoli',
      pinCode: '304804',
      tdsSection: '194C',
      tdsRate: 2,
      bankName: 'Bank of Baroda',
      bankBranch: 'Deoli',
      bankAccountNumber: '29870200002387',
      ifscCode: 'BARB0DEOLIX',
      categories: ['Transport', 'Service'],
      contacts: [
        {
          name: 'Prakash Mali',
          phone: '9461208834',
          email: 'deoliroadcarriers@gmail.com',
        },
      ],
    },
  ],
};

/** Vendor categories a company adds beside the six shipped defaults. */
const EXTRA_VENDOR_CATEGORIES: { name: string; description: string }[] = [
  {
    name: 'Cement & Binders',
    description: 'OPC / PPC cement, lime and other binders',
  },
  { name: 'Steel', description: 'TMT bars, structural steel, binding wire' },
  {
    name: 'Bitumen & Emulsion',
    description: 'Paving bitumen (VG grades), emulsions SS-1 / RS-1',
  },
  {
    name: 'Aggregates',
    description: 'Crushed aggregates, GSB, WMM, crusher dust',
  },
  {
    name: 'Road Marking & Safety',
    description: 'Thermoplastic paint, glass beads, studs, PPE',
  },
  {
    name: 'Labour Supply',
    description: 'Contract labour supplied under a CLRA licence',
  },
];

/** Items the rate contracts need that the base item master does not carry. */
const EXTRA_ITEMS: {
  code: string;
  name: string;
  unit: 'BAG' | 'CUM' | 'KG' | 'NOS' | 'MT' | 'LTR';
  cat: string;
  hsn: string;
  reorder?: number;
}[] = [
  {
    code: 'AGG-10MM',
    name: '10mm Aggregate',
    unit: 'CUM',
    cat: 'Aggregates',
    hsn: '2517',
  },
  {
    code: 'AGG-GSB',
    name: 'Granular Sub-Base (GSB) Grading-I',
    unit: 'CUM',
    cat: 'Aggregates',
    hsn: '2517',
  },
  {
    code: 'BIT-RS1',
    name: 'Bitumen Emulsion RS-1',
    unit: 'KG',
    cat: 'Bitumen & Emulsion',
    hsn: '2715',
  },
  {
    code: 'STL-TMT16',
    name: 'TMT Bar Fe500D 16mm',
    unit: 'MT',
    cat: 'Steel',
    hsn: '7214',
  },
  {
    code: 'FUL-HSD',
    name: 'High Speed Diesel (HSD)',
    unit: 'LTR',
    cat: 'FUEL',
    hsn: '2710',
    reorder: 2000,
  },
];

/** HSN codes for the base items, which the base seed left blank. */
const BASE_HSN: Record<string, string> = {
  'AGG-20MM': '2517',
  'AGG-MSAND': '2517',
  'BIT-SS1': '2715',
  'BIT-VG30': '2713',
  'CEM-OPC53': '2523',
  'CEM-PPC': '2523',
  'RDM-BEADS': '7018',
  'RDM-THERMO': '3208',
  'SAF-HELMET': '6506',
  'STL-TMT12': '7214',
};

/** `[vendorKey, itemCode, [from, to | null, rate][]]` — a rate contract and its revisions. */
type RateSpec = [string, string, [string, string | null, number][]];

const RATES: Record<string, RateSpec[]> = {
  PRPL: [
    [
      'utcl',
      'CEM-OPC53',
      [
        ['2026-07-01', '2026-09-30', 378],
        ['2026-10-01', null, 372],
      ],
    ],
    [
      'utcl',
      'CEM-PPC',
      [
        ['2026-07-01', '2026-09-30', 348],
        ['2026-10-01', null, 344],
      ],
    ],
    ['balaji', 'STL-TMT12', [['2026-10-01', null, 61800]]],
    ['balaji', 'STL-TMT16', [['2026-10-01', null, 61250]]],
    [
      'bitumen',
      'BIT-VG30',
      [
        ['2026-04-01', '2026-06-15', 46850],
        ['2026-06-16', '2026-09-15', 48400],
        ['2026-09-16', null, 49650],
      ],
    ],
    [
      'bitumen',
      'BIT-SS1',
      [
        ['2026-04-01', '2026-09-15', 50.25],
        ['2026-09-16', null, 51.6],
      ],
    ],
    ['bitumen', 'BIT-RS1', [['2026-09-16', null, 53.4]]],
    ['crusher', 'AGG-20MM', [['2026-07-01', null, 1175]]],
    ['crusher', 'AGG-10MM', [['2026-07-01', null, 1240]]],
    ['crusher', 'AGG-GSB', [['2026-07-01', null, 785]]],
    ['crusher', 'AGG-MSAND', [['2026-07-01', null, 915]]],
    ['marking', 'RDM-THERMO', [['2026-08-01', null, 87.5]]],
    ['marking', 'RDM-BEADS', [['2026-08-01', null, 94]]],
    ['marking', 'SAF-HELMET', [['2026-08-01', null, 235]]],
    [
      'ioc',
      'FUL-HSD',
      [
        ['2026-04-01', '2026-07-31', 91.48],
        ['2026-08-01', null, 92.15],
      ],
    ],
  ],
  TE: [
    [
      'utcl',
      'CEM-OPC53',
      [
        ['2026-07-01', '2026-09-30', 381],
        ['2026-10-01', null, 375],
      ],
    ],
    ['utcl', 'CEM-PPC', [['2026-10-01', null, 346]]],
    ['balaji', 'STL-TMT12', [['2026-10-01', null, 62100]]],
    ['balaji', 'STL-TMT16', [['2026-10-01', null, 61600]]],
    [
      'bitumen',
      'BIT-VG30',
      [
        ['2026-05-01', '2026-06-15', 47300],
        ['2026-06-16', '2026-09-15', 48900],
        ['2026-09-16', null, 50150],
      ],
    ],
    [
      'bitumen',
      'BIT-SS1',
      [
        ['2026-05-01', '2026-09-15', 50.8],
        ['2026-09-16', null, 52.1],
      ],
    ],
    ['bitumen', 'BIT-RS1', [['2026-09-16', null, 53.9]]],
    ['crusher', 'AGG-20MM', [['2026-07-01', null, 1290]]],
    ['crusher', 'AGG-10MM', [['2026-07-01', null, 1345]]],
    ['crusher', 'AGG-GSB', [['2026-07-01', null, 860]]],
    ['crusher', 'AGG-MSAND', [['2026-07-01', null, 990]]],
    ['marking', 'RDM-THERMO', [['2026-08-01', null, 88.75]]],
    ['marking', 'RDM-BEADS', [['2026-08-01', null, 95.5]]],
    ['marking', 'SAF-HELMET', [['2026-08-01', null, 238]]],
    [
      'ioc',
      'FUL-HSD',
      [
        ['2026-04-01', '2026-07-31', 91.48],
        ['2026-08-01', null, 92.15],
      ],
    ],
  ],
};

/** Hire terms for the two plant-hire vendors of each company. */
const HIRE_DETAILS: Record<
  string,
  Record<string, Omit<Prisma.VendorHireDetailUncheckedCreateInput, 'vendorId'>>
> = {
  PRPL: {
    sundaram: {
      hireType: 'taken',
      contractCode: 'PRPL/HIRE/2026-27/004',
      periodFrom: d('2026-06-01'),
      periodTo: d('2027-03-31'),
      machineCategory: 'EXCAVATOR',
      machineName: 'Tata Hitachi EX 200 LC Super+ (1.0 cum bucket)',
      requiredAvg: money(13.5),
      chargesBase: 'monthly',
      rate: money(185000),
      minWorkingDays: 26,
      allowBdDays: false,
      allowIdleDays: true,
      operatorCharges: money(22000),
      helperCharges: money(12000),
      maintenanceCharges: null,
      fuelCharges: null,
    },
    hire2: {
      hireType: 'taken',
      contractCode: 'PRPL/HIRE/2026-27/007',
      periodFrom: d('2026-08-10'),
      periodTo: d('2027-01-31'),
      machineCategory: 'COMPACTOR',
      machineName: 'L&T 1107 EX Vibratory Soil Compactor (11 t)',
      requiredAvg: money(7.5),
      chargesBase: 'daily',
      rate: money(7200),
      minWorkingDays: 25,
      allowBdDays: false,
      allowIdleDays: false,
      operatorCharges: money(900),
      helperCharges: null,
      maintenanceCharges: null,
      fuelCharges: null,
    },
  },
  TE: {
    sundaram: {
      hireType: 'taken',
      contractCode: 'TE/HIRE/2026-27/002',
      periodFrom: d('2026-05-15'),
      periodTo: d('2027-04-30'),
      machineCategory: 'LOADER',
      machineName: 'JCB 3DX Super Backhoe Loader',
      requiredAvg: money(5.5),
      chargesBase: 'monthly',
      rate: money(98000),
      minWorkingDays: 26,
      allowBdDays: false,
      allowIdleDays: true,
      operatorCharges: money(18500),
      helperCharges: null,
      maintenanceCharges: null,
      fuelCharges: null,
    },
    hire2: {
      hireType: 'taken',
      contractCode: 'TE/HIRE/2026-27/005',
      periodFrom: d('2026-07-01'),
      periodTo: d('2027-03-31'),
      machineCategory: 'TIPPER',
      machineName: 'Tata Signa 2823.K Tipper (16 cum)',
      requiredAvg: money(3.2),
      chargesBase: 'daily',
      rate: money(5200),
      minWorkingDays: 24,
      allowBdDays: false,
      allowIdleDays: false,
      operatorCharges: null,
      helperCharges: null,
      maintenanceCharges: null,
      fuelCharges: null,
    },
  },
};

const HIRE_TERMS = [
  '1. Machine to be deployed in sound working condition with valid RC, insurance, fitness and PUC.',
  '2. Hours/days as per the joint logbook signed daily by our site engineer; vendor’s own record will not be considered.',
  '3. Diesel issued by the Company is recovered at actuals beyond the agreed average.',
  '4. Breakdown beyond 24 hours is deducted pro rata; replacement machine to be provided within 48 hours.',
  '5. Operator to hold a valid licence and follow site safety rules; PPE is the vendor’s responsibility.',
  '6. Bills monthly by the 5th with logbook copies; TDS deducted as applicable.',
].join('\n');

const HIRE_REQUIREMENTS =
  'Operator with minimum 3 years’ experience; machine to report at site by 8:00 am; ' +
  'two shifts on request at the same hourly rate.';

/** The company's own purchase-order terms — the shipped set with what experience added. */
const PO_TERMS_EXTRA: Record<string, string[]> = {
  PRPL: [
    '9. Bitumen and emulsion shall be accompanied by the refinery / manufacturer test certificate for every tanker; loads without one will not be unloaded.',
    '10. Quantity of aggregates and bitumen shall be as per the weighbridge slip at our Tonk Bypass camp; the supplier’s slip is for reference only.',
    '11. All disputes are subject to the jurisdiction of courts at Tonk, Rajasthan.',
  ],
  TE: [
    '9. Bitumen and emulsion shall be accompanied by the refinery / manufacturer test certificate for every tanker.',
    '10. Deliveries on NHAI stretches only between 7:00 am and 6:00 pm, with the vehicle carrying a valid e-way bill.',
    '11. All disputes are subject to the jurisdiction of courts at Deoli (Tonk), Rajasthan.',
  ],
};

/** What each kind of material warrants, as the PO prints it. */
const WARRANTY: Record<string, [string, string]> = {
  CEM: ['3 months', '3 months'],
  STL: ['12 months', '12 months'],
  BIT: ['6 months', '6 months'],
  AGG: ['Not applicable', 'Not applicable'],
  RDM: ['24 months', '18 months'],
  SAF: ['12 months', '12 months'],
};

const PAYMENT_TERMS: Record<string, string> = {
  CEM: 'Within 30 days of receipt of material at site, against GST invoice and GRN',
  STL: 'Within 21 days of receipt of material at site, against GST invoice, mill test certificate and GRN',
  BIT: '50% advance against proforma invoice, balance within 15 days of receipt at site',
  AGG: 'Fortnightly, against GST invoice with weighbridge slips and GRN',
  RDM: 'Within 30 days of receipt of material at site, against GST invoice and GRN',
};

const DELIVERY_TERMS: Record<string, string> = {
  CEM: 'FOR site, inclusive of freight and unloading',
  STL: 'FOR site, inclusive of freight; unloading by the Company',
  BIT: 'FOR site in bulk tanker (VG-30) / sealed drums (emulsion), freight inclusive',
  AGG: 'FOR site by tipper, measured at our weighbridge',
  RDM: 'FOR site, inclusive of freight',
};

/** GST the PO is worked at, by the first item's group (one rate per PO, as the format prints). */
const GST_OF: Record<string, number> = {
  CEM: 18,
  STL: 18,
  BIT: 18,
  AGG: 5,
  RDM: 18,
  SAF: 18,
};

const groupOf = (code: string) => code.split('-')[0];

// ─── The module ───────────────────────────────────────────────────────────────

type Tx = CompanyContext['prisma'];

interface Person {
  userId: string;
  name: string;
  email: string;
  mobile: string | null;
}

export async function seedInventory(
  ctx: CompanyContext,
): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const result: ModuleResult = {};
  const add = (label: string, n: number) => {
    if (n > 0) result[label] = (result[label] ?? 0) + n;
  };
  const newVendorSpecs = NEW_VENDORS[company.shortCode];
  if (!newVendorSpecs) return result;

  const people = await loadPeople(prisma, company.id);

  // ── Vendor categories ──────────────────────────────────────────────────────
  for (const cat of EXTRA_VENDOR_CATEGORIES) {
    const existing = await prisma.vendorCategory.findUnique({
      where: { companyId_name: { companyId: company.id, name: cat.name } },
    });
    if (existing) continue;
    await prisma.vendorCategory.create({
      data: {
        companyId: company.id,
        name: cat.name,
        description: cat.description,
      },
    });
    add('vendor categories', 1);
  }
  const categoryIds = new Map(
    (
      await prisma.vendorCategory.findMany({
        where: { companyId: company.id },
      })
    ).map((c) => [c.name, c.id]),
  );

  // ── Vendors: particulars on the base six, then the ones added since ────────
  const vendors = new Map<
    string,
    { id: string; code: string; name: string; spec: VendorSpec }
  >();
  const particulars = (spec: VendorParticulars) => ({
    gstin: spec.unregistered ? null : gstin(spec.stateCode, spec.pan),
    pan: spec.pan,
    tdsSection: spec.tdsSection,
    tdsRate: spec.tdsRate === null ? null : money(spec.tdsRate),
    address: spec.address,
    city: spec.city,
    state: spec.state,
    pinCode: spec.pinCode,
    bankName: spec.bankName,
    bankBranch: spec.bankBranch,
    bankAccountNumber: spec.bankAccountNumber,
    ifscCode: spec.ifscCode,
  });

  const baseRows = await prisma.vendor.findMany({
    where: { companyId: company.id },
    orderBy: { code: 'asc' },
  });
  for (const row of baseRows) {
    const suffix = row.code.replace(`${company.shortCode}-`, '');
    const base = BASE_VENDORS[suffix];
    if (!base) continue;
    const spec: VendorSpec = { ...base, name: row.name, type: row.type };
    vendors.set(spec.key, { id: row.id, code: row.code, name: row.name, spec });
    if (row.gstin === null && row.pan === null && row.address === null) {
      const p = particulars(spec);
      await prisma.vendor.update({
        where: { id: row.id },
        data: { ...p, bankAccountHolderName: row.name },
      });
      add('vendor particulars', 1);
    }
  }

  const vendorFormat = CODE_SERIES_FORMATS.VENDORS ?? {
    prefix: '2022',
    base: 0,
    step: 1,
    width: 3,
  };
  const taken = new Set(baseRows.map((v) => v.code));
  let serial = 0;
  for (const spec of newVendorSpecs) {
    const existing = baseRows.find((v) => v.name === spec.name);
    if (existing) {
      vendors.set(spec.key, {
        id: existing.id,
        code: existing.code,
        name: existing.name,
        spec,
      });
      continue;
    }
    let code: string;
    do {
      serial += 1;
      code = formatCode(vendorFormat, serial);
    } while (taken.has(code));
    taken.add(code);
    const created = await prisma.vendor.create({
      data: {
        companyId: company.id,
        code,
        name: spec.name,
        type: spec.type,
        ...particulars(spec),
        bankAccountHolderName: spec.name,
        createdAt: at(d('2026-04-01'), 11, 0),
      },
    });
    vendors.set(spec.key, { id: created.id, code, name: spec.name, spec });
    add('vendors', 1);
  }

  // The VENDORS series has to sit past the codes above, or the app's next vendor steps over them
  // one by one (it would still work — `isTaken` — but the counter would read wrong).
  const highest = [...taken]
    .filter((code) => code.startsWith(vendorFormat.prefix))
    .map((code) => Number(code.slice(vendorFormat.prefix.length)))
    .filter((n) => Number.isInteger(n))
    .reduce((max, n) => Math.max(max, n), 0);
  if (highest > 0) {
    const seq = await prisma.codeSequence.findUnique({
      where: {
        companyId_seriesType: { companyId: company.id, seriesType: 'VENDORS' },
      },
    });
    if (!seq) {
      await prisma.codeSequence.create({
        data: {
          companyId: company.id,
          seriesType: 'VENDORS',
          lastNumber: highest,
        },
      });
      add('code sequences', 1);
    } else if (seq.lastNumber < highest) {
      await prisma.codeSequence.update({
        where: { id: seq.id },
        data: { lastNumber: highest },
      });
    }
  }

  // ── Contacts and what each vendor deals in ─────────────────────────────────
  for (const v of vendors.values()) {
    const count = await prisma.vendorContact.count({
      where: { vendorId: v.id },
    });
    if (count === 0) {
      for (const [i, contact] of v.spec.contacts.entries()) {
        await prisma.vendorContact.create({
          data: {
            vendorId: v.id,
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            createdAt: new Date(Date.UTC(2026, 3, 1, 6, i)),
          },
        });
        add('vendor contacts', 1);
      }
    }
    const deals = await prisma.vendorDealsIn.createMany({
      data: v.spec.categories
        .map((name) => categoryIds.get(name))
        .filter((id): id is string => Boolean(id))
        .map((categoryId) => ({ vendorId: v.id, categoryId })),
      skipDuplicates: true,
    });
    add('vendor deals-in', deals.count);
  }

  // ── Items the contracts need, and HSN codes ────────────────────────────────
  const itemCats = new Map(
    (
      await prisma.itemCategory.findMany({ where: { companyId: company.id } })
    ).map((c) => [c.name, c.id]),
  );
  for (const it of EXTRA_ITEMS) {
    const exists = await prisma.item.findFirst({
      where: {
        companyId: company.id,
        OR: [{ code: it.code }, { name: it.name }],
      },
    });
    const categoryId = itemCats.get(it.cat);
    if (exists || !categoryId) continue;
    await prisma.item.create({
      data: {
        companyId: company.id,
        code: it.code,
        name: it.name,
        categoryId,
        unit: it.unit,
        hsnCode: it.hsn,
        reorderLevel: it.reorder ? money(it.reorder) : null,
      },
    });
    add('items', 1);
  }
  for (const [code, hsn] of Object.entries(BASE_HSN)) {
    const updated = await prisma.item.updateMany({
      where: { companyId: company.id, code, hsnCode: null },
      data: { hsnCode: hsn },
    });
    add('item HSN codes', updated.count);
  }
  const items = new Map(
    (await prisma.item.findMany({ where: { companyId: company.id } })).map(
      (i) => [i.code, i],
    ),
  );

  // ── Rate contracts ─────────────────────────────────────────────────────────
  const rateRows: Prisma.VendorItemRateCreateManyInput[] = [];
  for (const [vendorKey, code, periods] of RATES[company.shortCode] ?? []) {
    const vendor = vendors.get(vendorKey);
    const item = items.get(code);
    if (!vendor || !item) continue;
    for (const [from, to, rate] of periods) {
      rateRows.push({
        companyId: company.id,
        vendorId: vendor.id,
        itemId: item.id,
        rate: money(rate),
        effectiveFrom: d(from),
        effectiveTo: to ? d(to) : null,
        createdAt: at(d(from), 12, 0),
      });
    }
  }
  const rates = await prisma.vendorItemRate.createMany({
    data: rateRows,
    skipDuplicates: true,
  });
  add('rate contracts', rates.count);
  const agreed = (vendorKey: string, code: string): number | null => {
    const spec = (RATES[company.shortCode] ?? []).find(
      ([v, c]) => v === vendorKey && c === code,
    );
    const current = spec?.[2].find(([, to]) => to === null);
    return current ? current[2] : null;
  };

  // ── Purchase-order terms (Settings → Terms) ────────────────────────────────
  const terms = await prisma.termsTemplate.findUnique({
    where: {
      companyId_documentKind: {
        companyId: company.id,
        documentKind: TermsDocumentKind.purchase_order,
      },
    },
  });
  if (!terms) {
    await prisma.termsTemplate.create({
      data: {
        companyId: company.id,
        documentKind: TermsDocumentKind.purchase_order,
        body: [
          STANDARD_TERMS[TermsDocumentKind.purchase_order],
          ...(PO_TERMS_EXTRA[company.shortCode] ?? []),
        ].join('\n'),
        updatedByUserId: people.director?.userId ?? null,
        createdAt: at(d('2026-04-06'), 15, 30),
        updatedAt: at(d('2026-07-14'), 12, 10),
      },
    });
    add('terms templates', 1);
  }

  // ── Hire terms ─────────────────────────────────────────────────────────────
  for (const [key, detail] of Object.entries(
    HIRE_DETAILS[company.shortCode] ?? {},
  )) {
    const vendor = vendors.get(key);
    if (!vendor) continue;
    const exists = await prisma.vendorHireDetail.findUnique({
      where: { vendorId: vendor.id },
    });
    if (exists) continue;
    await prisma.vendorHireDetail.create({
      data: {
        vendorId: vendor.id,
        ...detail,
        termsAndConditions: HIRE_TERMS,
        requirements: HIRE_REQUIREMENTS,
      },
    });
    add('vendor hire details', 1);
  }

  // ── Purchase orders ────────────────────────────────────────────────────────
  const poCounts = await seedPurchaseOrders(
    ctx,
    people,
    vendors,
    items,
    agreed,
  );
  for (const [label, n] of Object.entries(poCounts)) add(label, n);

  // ── Contractors ────────────────────────────────────────────────────────────
  const contractorCounts = await seedContractors(ctx, people, vendors);
  for (const [label, n] of Object.entries(contractorCounts)) add(label, n);

  // ── BOCW cess ──────────────────────────────────────────────────────────────
  add('BOCW payments', await seedBocw(ctx, people));

  return result;
}

// ─── People ───────────────────────────────────────────────────────────────────

interface People {
  storeKeeper: Person | null;
  accountant: Person | null;
  hrExecutive: Person | null;
  director: Person | null;
  byRole: Map<string, Person[]>;
}

async function loadPeople(prisma: Tx, companyId: string): Promise<People> {
  const rows = await prisma.$queryRaw<
    {
      userId: string;
      name: string;
      email: string;
      mobile: string | null;
      designation: string | null;
      roleId: string | null;
    }[]
  >`
    SELECT u."id" AS "userId",
           COALESCE(u."displayName", e."firstName" || ' ' || e."lastName") AS "name",
           u."email", e."mobile", dg."name" AS "designation", ur."roleId"
    FROM "shared"."User" u
    JOIN "hr"."Employee" e ON e."userId" = u."id"
    LEFT JOIN "settings"."Designation" dg ON dg."id" = e."designationId"
    LEFT JOIN "settings"."UserRole" ur ON ur."userId" = u."id"
    WHERE u."companyId" = ${companyId} AND u."status" = 'active'
    ORDER BY e."employeeCode" ASC
  `;
  const person = (r: (typeof rows)[number]): Person => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    mobile: r.mobile,
  });
  const find = (designation: string) => {
    const r = rows.find((row) => row.designation === designation);
    return r ? person(r) : null;
  };
  const byRole = new Map<string, Person[]>();
  for (const r of rows) {
    if (!r.roleId) continue;
    const list = byRole.get(r.roleId) ?? [];
    if (!list.some((p) => p.userId === r.userId)) list.push(person(r));
    byRole.set(r.roleId, list);
  }
  return {
    storeKeeper: find('Store Keeper'),
    accountant: find('Accountant'),
    hrExecutive: find('HR Executive'),
    director: find('Director'),
    byRole,
  };
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

interface PoPlan {
  vendorKey: string;
  siteIndex: number;
  lines: { code: string; quantity: number; rate: number }[];
  composedAt: Date;
  /** One per chain level reached, in order. */
  decisions: { at: Date; action: 'approve' | 'reject'; reason?: string }[];
  issuedAt: Date | null;
  /** Purchases already in the register that this PO's lines were received by. */
  receipts?: Map<string, string[]>;
}

async function seedPurchaseOrders(
  ctx: CompanyContext,
  people: People,
  vendors: Map<
    string,
    { id: string; code: string; name: string; spec: VendorSpec }
  >,
  items: Map<string, { id: string; code: string; name: string; unit: string }>,
  agreed: (vendorKey: string, code: string) => number | null,
): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const out: ModuleResult = {};

  const kind = await prisma.letterKind.findFirst({
    where: {
      key: PO_KIND,
      OR: [{ companyId: null }, { companyId: company.id }],
    },
  });
  if (!kind) return out;
  const already = await prisma.issuedLetter.count({
    where: { companyId: company.id, letterKindId: kind.id },
  });
  if (already > 0) return out;

  const [template, signatory, chain, companyRow] = await Promise.all([
    prisma.letterTemplate.findFirst({
      where: { companyId: company.id, letterKindId: kind.id, isActive: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.signatory.findFirst({
      where: { companyId: company.id, isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.approvalChain.findFirst({
      where: { companyId: company.id, actionType: PO_KIND, isActive: true },
      include: { levels: { orderBy: { position: 'asc' } } },
    }),
    prisma.company.findUnique({ where: { id: company.id } }),
  ]);
  const composer = people.storeKeeper ?? people.accountant;
  if (!template || !signatory || !chain || !companyRow || !composer) {
    console.warn(
      `  ${company.shortCode}: purchase orders skipped — no PO template, signatory, approval ` +
        `chain or store keeper to compose them.`,
    );
    return out;
  }
  // Who decides at each level: the role the slot maps to, never the person who raised it.
  const slotRoles = new Map(
    (
      await prisma.roleSlotMapping.findMany({
        where: { companyId: company.id },
      })
    ).map((m) => [m.slotKey, m.roleId]),
  );
  const deciders = chain.levels.map((level) => {
    const holders = (
      people.byRole.get(slotRoles.get(level.slotKey) ?? '') ?? []
    ).filter((p) => p.userId !== composer.userId);
    const preferred = level.isFinalAuthority
      ? holders.find((p) => p.userId === people.director?.userId)
      : holders.find((p) => p.userId === people.accountant?.userId);
    return preferred ?? holders[0] ?? null;
  });
  if (deciders.some((p) => p === null)) {
    console.warn(
      `  ${company.shortCode}: purchase orders skipped — a PO approval level has nobody mapped.`,
    );
    return out;
  }

  const sites = await prisma.site.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: 'asc' },
  });
  const storeSites = sites.filter((s) => !/office/i.test(s.name));
  const projects = new Map(
    (await prisma.project.findMany({ where: { companyId: company.id } })).map(
      (p) => [p.id, p],
    ),
  );

  // History, out of the purchase register: one PO per vendor, site and delivery round for the
  // cement and steel that arrived after the opening stock. The August round was ordered to the
  // quantity delivered (closed); September's was ordered with headroom (partly received).
  const plans: PoPlan[] = [];
  const history = await prisma.purchase.findMany({
    where: {
      companyId: company.id,
      deleted: false,
      purchaseOrderLineId: null,
      remarks: null,
      vendorId: {
        in: [vendors.get('utcl')?.id, vendors.get('balaji')?.id].filter(
          (id): id is string => Boolean(id),
        ),
      },
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  const itemById = new Map([...items.values()].map((i) => [i.id, i]));
  const rounds = [...new Set(history.map((p) => monthKey(p.date)))].sort();
  for (const [ri, round] of rounds.entries()) {
    const groups = new Map<string, typeof history>();
    for (const p of history) {
      const code = itemById.get(p.itemId)?.code ?? '';
      if (monthKey(p.date) !== round || !['CEM', 'STL'].includes(groupOf(code)))
        continue;
      const key = `${p.vendorId}|${p.siteId}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const purchases of groups.values()) {
      const first = purchases[0];
      const vendorKey = [...vendors.entries()].find(
        ([, v]) => v.id === first.vendorId,
      )?.[0];
      const siteIndex = storeSites.findIndex((s) => s.id === first.siteId);
      if (!vendorKey || siteIndex < 0) continue;
      const headroom = ri === rounds.length - 1;
      const receipts = new Map<string, string[]>();
      const lines = purchases.flatMap((p) => {
        const item = itemById.get(p.itemId);
        if (!item) return [];
        const delivered = Number(p.quantity);
        receipts.set(item.code, [p.id]);
        return [
          {
            code: item.code,
            quantity: headroom
              ? item.unit === 'BAG'
                ? Math.ceil((delivered * 1.25) / 50) * 50
                : Math.ceil(delivered * 1.25)
              : round3(delivered),
            rate: Number(p.rate),
          },
        ];
      });
      const delivery = first.date;
      plans.push({
        vendorKey,
        siteIndex,
        lines,
        composedAt: at(addDays(delivery, -5), 11, 20),
        decisions: [
          { at: at(addDays(delivery, -4), 10, 5), action: 'approve' },
          { at: at(addDays(delivery, -4), 17, 40), action: 'approve' },
        ],
        // The steel order follows the cement one by an hour, as one person issues them in turn.
        issuedAt: at(
          addDays(delivery, -3),
          vendorKey === 'balaji' ? 11 : 10,
          vendorKey === 'balaji' ? 35 : 30,
        ),
        receipts,
      });
    }
  }

  // October: open orders at the contract rates, and the ones still in the chain.
  const today = ctx.today;
  const ago = (n: number, h: number, m: number) => at(addDays(today, -n), h, m);
  const line = (vendorKey: string, code: string, quantity: number) => ({
    code,
    quantity,
    rate: agreed(vendorKey, code) ?? 0,
  });
  const approved = (n: number) => [
    { at: ago(n, 10, 15), action: 'approve' as const },
    { at: ago(n, 18, 5), action: 'approve' as const },
  ];
  plans.push(
    {
      vendorKey: 'bitumen',
      siteIndex: 0,
      lines: [
        line('bitumen', 'BIT-VG30', 30),
        line('bitumen', 'BIT-SS1', 6000),
      ],
      composedAt: ago(16, 12, 40),
      decisions: approved(15),
      issuedAt: ago(14, 11, 0),
    },
    {
      vendorKey: 'crusher',
      siteIndex: 1,
      lines: [
        line('crusher', 'AGG-20MM', 450),
        line('crusher', 'AGG-10MM', 300),
        line('crusher', 'AGG-GSB', 800),
      ],
      composedAt: ago(13, 16, 10),
      decisions: approved(12),
      issuedAt: ago(11, 10, 45),
    },
    {
      vendorKey: 'bitumen',
      siteIndex: 1,
      lines: [
        line('bitumen', 'BIT-RS1', 4000),
        line('bitumen', 'BIT-VG30', 18),
      ],
      composedAt: ago(10, 15, 0),
      decisions: [
        { at: ago(9, 11, 30), action: 'approve' },
        {
          at: ago(8, 17, 15),
          action: 'reject',
          reason:
            'Hold — bituminous course on this stretch is not due before December. Raise it again ' +
            'with the November requirement.',
        },
      ],
      issuedAt: null,
    },
    {
      vendorKey: 'utcl',
      siteIndex: 0,
      lines: [line('utcl', 'CEM-OPC53', 1500), line('utcl', 'CEM-PPC', 1000)],
      composedAt: ago(8, 11, 5),
      decisions: approved(7),
      issuedAt: ago(6, 10, 20),
    },
    {
      vendorKey: 'balaji',
      siteIndex: 2,
      lines: [line('balaji', 'STL-TMT12', 10), line('balaji', 'STL-TMT16', 6)],
      composedAt: ago(4, 12, 30),
      decisions: approved(3),
      issuedAt: null,
    },
    {
      vendorKey: 'marking',
      siteIndex: 0,
      lines: [
        line('marking', 'RDM-THERMO', 5000),
        line('marking', 'RDM-BEADS', 1200),
        line('marking', 'SAF-HELMET', 120),
      ],
      composedAt: ago(3, 15, 45),
      decisions: [{ at: ago(2, 11, 50), action: 'approve' }],
      issuedAt: null,
    },
    {
      vendorKey: 'crusher',
      siteIndex: 2,
      lines: [
        line('crusher', 'AGG-MSAND', 250),
        line('crusher', 'AGG-20MM', 300),
      ],
      composedAt: ago(1, 17, 20),
      decisions: [],
      issuedAt: null,
    },
  );

  // References in issue order, after whatever this company's series already holds.
  const issuedPlans = plans
    .filter((p) => p.issuedAt)
    .sort((a, b) => Number(a.issuedAt) - Number(b.issuedAt));
  const references = new Map<PoPlan, string>();
  for (const plan of issuedPlans) {
    // Shifted to the IST wall clock: `referencePrefix` reads the month in the server's zone.
    const prefix = referencePrefix(
      company.shortCode,
      false,
      new Date(Number(plan.issuedAt) + 330 * 60_000),
    );
    const existing = await prisma.issuedLetter.findMany({
      where: { companyId: company.id, referenceNo: { startsWith: prefix } },
      select: { referenceNo: true },
    });
    const ref = nextReference(prefix, [
      ...existing.map((r) => r.referenceNo ?? ''),
      ...references.values(),
    ]);
    references.set(plan, ref);
  }

  const brand = {
    logo: await readBlob(companyRow.logoRef),
    name: companyRow.name,
    lines: [
      composeAddress(companyRow)
        ? `Registered Office: ${composeAddress(companyRow)}`
        : '',
      [
        companyRow.phone ? `Ph: ${companyRow.phone}` : null,
        companyRow.email ? `Email: ${companyRow.email}` : null,
      ]
        .filter(Boolean)
        .join('  |  '),
      companyRow.website ? `Website: ${companyRow.website}` : '',
    ].filter(Boolean),
  };
  const signatureImage = await readBlob(signatory.signatureRef);
  const layout = LETTER_LAYOUTS[PO_KIND];

  for (const plan of plans.sort(
    (a, b) => a.composedAt.getTime() - b.composedAt.getTime(),
  )) {
    const vendor = vendors.get(plan.vendorKey);
    const site = storeSites[plan.siteIndex % storeSites.length];
    if (!vendor || !site) continue;
    const vendorRow = await prisma.vendor.findUnique({
      where: { id: vendor.id },
      include: { contacts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!vendorRow) continue;
    const group = groupOf(plan.lines[0].code);
    const gstRate = GST_OF[group] ?? 18;
    const project = site.projectId ? projects.get(site.projectId) : null;
    const lineItems = plan.lines
      .map((l) => {
        const item = items.get(l.code);
        if (!item) throw new Error(`No item ${l.code}`);
        return `${item.code} - ${item.name} | ${item.unit} | ${
          l.quantity
        } | ${l.rate.toFixed(2)}`;
      })
      .join('\n');
    // What the composer typed. The company's GSTIN and name are resolved from Settings at issue.
    const composed: Record<string, string> = {
      vendorName: vendorRow.name,
      vendorAddress: composeAddress(vendorRow),
      vendorCode: vendorRow.code,
      vendorAttention: vendorRow.contacts[0]
        ? `${vendorRow.contacts[0].name}${
            vendorRow.contacts[0].phone
              ? ` (${vendorRow.contacts[0].phone})`
              : ''
          }`
        : '',
      buyerName: composer.name,
      buyerMobile: composer.mobile ?? '',
      buyerEmail: composer.email,
      deliveryAddress: `${site.name}, ${site.address ?? ''}`.replace(/, $/, ''),
      paymentTerms: PAYMENT_TERMS[group] ?? PAYMENT_TERMS.CEM,
      deliveryTerms: DELIVERY_TERMS[group] ?? DELIVERY_TERMS.CEM,
      poProject: project ? `${project.code} — ${project.name}` : '',
      warrantyFromDispatch: (WARRANTY[group] ?? WARRANTY.CEM)[0],
      warrantyFromCommissioning: (WARRANTY[group] ?? WARRANTY.CEM)[1],
      lineItems,
      gstRate: String(gstRate),
    };

    const letter = await prisma.issuedLetter.create({
      data: {
        companyId: company.id,
        letterKindId: kind.id,
        subjectType: 'vendor',
        subjectId: vendor.id,
        templateId: template.id,
        signatoryId: signatory.id,
        composedVariables: composed,
        renderedRef: '',
        issuedAt: null,
        issuedBy: composer.userId,
        createdAt: plan.composedAt,
      },
    });
    out['purchase order letters'] = (out['purchase order letters'] ?? 0) + 1;

    // 016's chain, decided the way `ApprovalService.decide` records it.
    const last = plan.decisions[plan.decisions.length - 1];
    const state =
      last?.action === 'reject'
        ? 'rejected'
        : plan.decisions.length === chain.levels.length
        ? 'approved'
        : 'pending';
    const instance = await prisma.approvalInstance.create({
      data: {
        companyId: company.id,
        chainId: chain.id,
        entityType: PO_KIND,
        entityId: letter.id,
        subject: `${kind.label} — ${vendor.name}`,
        href: PO_HREF,
        viewPermission: 'INVENTORY',
        originatorUserId: composer.userId,
        currentPosition:
          state === 'pending'
            ? plan.decisions.length + 1
            : Math.max(1, plan.decisions.length),
        state,
        createdAt: plan.composedAt,
        updatedAt: last?.at ?? plan.composedAt,
      },
    });
    out['approval instances'] = (out['approval instances'] ?? 0) + 1;
    for (const [i, decision] of plan.decisions.entries()) {
      await prisma.approvalDecision.create({
        data: {
          approvalInstanceId: instance.id,
          companyId: company.id,
          round: 1,
          position: chain.levels[i].position,
          actorUserId: deciders[i]?.userId ?? composer.userId,
          action: decision.action,
          reason: decision.reason ?? null,
          decidedAt: decision.at,
        },
      });
      out['approval decisions'] = (out['approval decisions'] ?? 0) + 1;
    }

    if (!plan.issuedAt) continue;

    // Issue: the reference, then the document rendered with it, as `issueResolved` does.
    const referenceNo = references.get(plan) ?? '';
    const variables = {
      ...composed,
      companyGstin: companyRow.gstin ?? '',
      companyName: companyRow.name,
    };
    const issueDate = letterDate(plan.issuedAt);
    const body = renderTemplate(template.bodyTemplate, {
      issueDate,
      referenceNo,
      ...presentLetterValues(PO_KIND, variables),
      ...expandLineItems(PO_KIND, variables),
    });
    const pdf = await renderLetterPdf({
      title: layout?.title ?? 'PURCHASE ORDER',
      body,
      letterhead: null,
      brandHeader: brand,
      referenceLabel: layout?.referenceLabel,
      referenceNo,
      issueDate,
      signature: {
        image: signatureImage,
        name: signatory.name,
        title: signatory.title,
      },
      draft: false,
    });
    await prisma.issuedLetter.update({
      where: { id: letter.id },
      data: {
        referenceNo,
        renderedRef: await ctx.writeBlob(
          `${LETTER_NAMESPACE}/${company.id}`,
          pdf,
        ),
        appliedSignatureRef: signatory.signatureRef,
        issuedAt: plan.issuedAt,
        issuedBy: composer.userId,
      },
    });

    // The structure `PurchaseOrdersService.sync` reads out of an issued letter, made now so the
    // deliveries already in the register can be received against its lines.
    const parsed = parseLineItems(lineItems);
    const order = await prisma.purchaseOrder.create({
      data: {
        companyId: company.id,
        letterId: letter.id,
        referenceNo,
        version: 1,
        vendorId: vendor.id,
        issuedAt: plan.issuedAt,
        gstPercent: money(gstRate),
        createdAt: new Date(plan.issuedAt.getTime() + 20 * 60_000),
        lines: {
          create: parsed.map((row, index) => ({
            companyId: company.id,
            lineNo: index + 1,
            itemId: items.get(row.description.split(' - ')[0])?.id ?? null,
            description: row.description,
            unit: row.unit,
            quantity: money(row.quantity),
            rate: money(row.rate),
            amount: money(row.amount),
            gstPercent: money(gstRate),
            createdAt: new Date(Number(plan.issuedAt) + 20 * 60_000),
          })),
        },
      },
      include: { lines: true },
    });
    out['purchase orders'] = (out['purchase orders'] ?? 0) + 1;
    out['purchase order lines'] =
      (out['purchase order lines'] ?? 0) + order.lines.length;

    for (const poLine of order.lines) {
      const code = poLine.description.split(' - ')[0];
      const purchaseIds = plan.receipts?.get(code) ?? [];
      if (purchaseIds.length === 0) continue;
      const linked = await prisma.purchase.updateMany({
        where: { id: { in: purchaseIds }, purchaseOrderLineId: null },
        data: { purchaseOrderLineId: poLine.id },
      });
      out['purchases received against POs'] =
        (out['purchases received against POs'] ?? 0) + linked.count;
    }
  }
  return out;
}

// ─── Contractors ──────────────────────────────────────────────────────────────

interface ContractorPlan {
  key: string;
  licence: string;
  pf: string;
  esic: string;
  bocw: string;
  insurance: string;
  workers: number;
  firstMonth: string;
  /** How the last concluded month stands: filed both, PF only, or not at all. */
  lastMonth: 'submitted' | 'partial' | 'none';
  licenceExpiry: string;
  insuranceExpiry: string;
  bocwExpiry: string;
}

const CONTRACTORS: Record<string, ContractorPlan[]> = {
  PRPL: [
    {
      key: 'ashok',
      licence: 'CLRA/TNK/2025/0147',
      pf: 'RJRAJ0048117000',
      esic: '15000671250001001',
      bocw: 'RJ/BOCW/TNK/2024/00892',
      insurance: 'EC/3412/2026/004517',
      workers: 46,
      firstMonth: '2026-04',
      lastMonth: 'submitted',
      licenceExpiry: '2027-03-31',
      insuranceExpiry: '2027-01-14',
      bocwExpiry: '2029-08-31',
    },
    {
      key: 'labour2',
      licence: 'CLRA/TNK/2026/0063',
      pf: 'RJRAJ0051284000',
      esic: '15000689010001001',
      bocw: 'RJ/BOCW/TNK/2026/01211',
      insurance: 'EC/3412/2025/011906',
      workers: 28,
      firstMonth: '2026-06',
      lastMonth: 'partial',
      licenceExpiry: '2026-11-12',
      insuranceExpiry: '2026-11-04',
      bocwExpiry: '2031-05-31',
    },
    {
      key: 'sub',
      licence: 'CLRA/KOT/2025/0419',
      pf: 'RJKOT0039906000',
      esic: '15000612740001002',
      bocw: 'RJ/BOCW/KOT/2023/00418',
      insurance: 'EC/2109/2026/002277',
      workers: 34,
      firstMonth: '2026-07',
      lastMonth: 'none',
      licenceExpiry: '2027-05-31',
      insuranceExpiry: '2027-06-30',
      bocwExpiry: '2028-03-31',
    },
  ],
  TE: [
    {
      key: 'ashok',
      licence: 'CLRA/TNK/2025/0151',
      pf: 'RJRAJ0048117000',
      esic: '15000671250001001',
      bocw: 'RJ/BOCW/TNK/2024/00892',
      insurance: 'EC/3412/2026/004592',
      workers: 32,
      firstMonth: '2026-05',
      lastMonth: 'submitted',
      licenceExpiry: '2027-03-31',
      insuranceExpiry: '2027-02-09',
      bocwExpiry: '2029-08-31',
    },
    {
      key: 'labour2',
      licence: 'ALC/LKO/2026/0388',
      pf: 'UPLKO0072215000',
      esic: '21000394880001001',
      bocw: 'UP/BOCW/STP/2025/03316',
      insurance: 'EC/5520/2026/000871',
      workers: 41,
      firstMonth: '2026-06',
      lastMonth: 'submitted',
      licenceExpiry: '2027-06-14',
      insuranceExpiry: '2026-11-09',
      bocwExpiry: '2030-02-28',
    },
    {
      key: 'sub',
      licence: 'CLRA/KOT/2026/0102',
      pf: 'RJKOT0044571000',
      esic: '15000654410001001',
      bocw: 'RJ/BOCW/KOT/2025/00957',
      insurance: 'EC/2109/2026/003145',
      workers: 22,
      firstMonth: '2026-07',
      lastMonth: 'partial',
      licenceExpiry: '2027-06-30',
      insuranceExpiry: '2027-06-30',
      bocwExpiry: '2030-06-30',
    },
  ],
};

const DOC_TITLES: Record<ContractorDocumentType, string> = {
  labour_license:
    'FORM VI — LICENCE (Contract Labour (Regulation & Abolition) Act, 1970)',
  pf_registration:
    'EMPLOYEES’ PROVIDENT FUND ORGANISATION — Certificate of Registration',
  esic_registration:
    'EMPLOYEES’ STATE INSURANCE CORPORATION — Registration Certificate (Form C-11)',
  insurance: 'EMPLOYEES’ COMPENSATION INSURANCE POLICY — Schedule',
  bocw_registration:
    'BUILDING & OTHER CONSTRUCTION WORKERS — Certificate of Registration',
};
const DOC_FILE: Record<ContractorDocumentType, string> = {
  labour_license: 'Labour licence',
  pf_registration: 'PF registration',
  esic_registration: 'ESIC registration',
  insurance: 'EC insurance policy',
  bocw_registration: 'BOCW registration',
};

async function seedContractors(
  ctx: CompanyContext,
  people: People,
  vendors: Map<
    string,
    { id: string; code: string; name: string; spec: VendorSpec }
  >,
): Promise<ModuleResult> {
  const { prisma, company, rng } = ctx;
  const out: ModuleResult = {};
  const add = (label: string, n: number) => {
    if (n > 0) out[label] = (out[label] ?? 0) + n;
  };
  const uploader = people.hrExecutive ?? people.accountant ?? people.director;
  const verifier = people.accountant ?? people.director;
  if (!uploader) return out;
  const concluded = lastCompletedMonth(at(ctx.today, 12, 0));

  for (const plan of CONTRACTORS[company.shortCode] ?? []) {
    const vendor = vendors.get(plan.key);
    if (
      !vendor ||
      !['subcontractor', 'labour_contractor'].includes(vendor.spec.type)
    )
      continue;
    const firstDay = d(`${plan.firstMonth}-01`);

    let profile = await prisma.contractorProfile.findUnique({
      where: { vendorId: vendor.id },
    });
    if (!profile) {
      profile = await prisma.contractorProfile.create({
        data: {
          companyId: company.id,
          vendorId: vendor.id,
          licenceNumber: plan.licence,
          pfRegistration: plan.pf,
          esicRegistration: plan.esic,
          bocwRegistration: plan.bocw,
          insurancePolicyNumber: plan.insurance,
          createdAt: at(addDays(firstDay, -6), 12, 0),
        },
      });
      add('contractor profiles', 1);
    }

    // The statutory papers, uploaded when the contractor was engaged.
    if (
      (await prisma.contractorDocument.count({
        where: { contractorProfileId: profile.id },
      })) === 0
    ) {
      const docs: [ContractorDocumentType, string, string | null][] = [
        [
          'labour_license',
          `Licence No.: ${plan.licence}\nLicensee: ${
            vendor.name
          }, ${composeAddress(vendor.spec)}\n` +
            `Principal employer: ${company.name}\nNature of work: Road construction — earthwork, ` +
            `GSB/WMM, bituminous works and drainage\nMaximum number of contract labour: ${
              plan.workers + 20
            }\nValid up to: ${
              plan.licenceExpiry
            }\n\nIssued by the Licensing Officer under ` +
            `Section 12 of the Act. Fee and security deposit received.`,
          plan.licenceExpiry,
        ],
        [
          'pf_registration',
          `Establishment code: ${plan.pf}\nName of establishment: ${vendor.name}\n` +
            `Address: ${composeAddress(vendor.spec)}\nPAN: ${
              vendor.spec.pan
            }\n\n` +
            `The establishment is covered under the Employees’ Provident Funds & Miscellaneous ` +
            `Provisions Act, 1952 with effect from the date of coverage shown on the portal. ` +
            `This is a system-generated certificate and needs no signature.`,
          null,
        ],
        [
          'esic_registration',
          `Employer code: ${plan.esic}\nName of factory / establishment: ${vendor.name}\n` +
            `Address: ${composeAddress(
              vendor.spec,
            )}\n\nYou are hereby informed that your ` +
            `establishment has been registered under Section 2A of the ESI Act, 1948, and allotted ` +
            `the employer code above, to be quoted in all correspondence and challans.`,
          null,
        ],
        [
          'insurance',
          `Policy No.: ${plan.insurance}\nInsured: ${vendor.name}\nSection: Employees’ Compensation ` +
            `Act, 1923 (with medical extension)\nNumber of employees covered: ${plan.workers}\n` +
            `Location of work: sites of ${company.name}\nPeriod of insurance: 12 months, ` +
            `expiring midnight ${plan.insuranceExpiry}\n\nPremium received. Subject to the ` +
            `policy wording and endorsements attached.`,
          plan.insuranceExpiry,
        ],
        [
          'bocw_registration',
          `Registration No.: ${plan.bocw}\nEmployer: ${
            vendor.name
          }\nAddress: ${composeAddress(
            vendor.spec,
          )}\nMaximum number of building workers: ${
            plan.workers + 15
          }\nValid up to: ${
            plan.bocwExpiry
          }\n\nRegistered under Section 7 of the Building and Other Construction Workers ` +
            `(RE&CS) Act, 1996.`,
          plan.bocwExpiry,
        ],
      ];
      for (const [i, [type, body, expiry]] of docs.entries()) {
        const pdf = await ctx.renderPdf(DOC_TITLES[type], body);
        await prisma.contractorDocument.create({
          data: {
            contractorProfileId: profile.id,
            documentType: type,
            fileRef: await ctx.writeBlob(CONTRACTOR_DOC_NAMESPACE, pdf),
            fileName: `${DOC_FILE[type]} - ${vendor.name}.pdf`,
            expiresAt: expiry ? d(expiry) : null,
            uploadedByUserId: uploader.userId,
            uploadedAt: at(addDays(firstDay, -5), 11, 10 + i * 4),
          },
        });
        add('contractor documents', 1);
      }
    }

    // PF and ESIC, filed month by month from engagement to the last concluded month.
    const rows: Prisma.MonthlyComplianceCreateManyInput[] = [];
    for (let m = firstDay; monthKey(m) <= concluded; m = addMonths(m, 1)) {
      const month = monthKey(m);
      const isLast = month === concluded;
      if (isLast && plan.lastMonth === 'none') continue;
      const due = addMonths(m, 1);
      const headcount = plan.workers + rng.int(-4, 4);
      const pfAmount = round2(headcount * 9750 * 0.245 + rng.int(0, 900));
      const esicAmount = round2(headcount * 11200 * 0.04 + rng.int(0, 300));
      const pfDate = addDays(due, rng.int(8, 13));
      const esicDate = addDays(due, rng.int(9, 14));
      const withEsic = !(isLast && plan.lastMonth === 'partial');
      const monthsBack =
        (Number(concluded.slice(0, 4)) - m.getUTCFullYear()) * 12 +
        (Number(concluded.slice(5)) - (m.getUTCMonth() + 1));
      const verified = monthsBack >= 2 && verifier;
      rows.push({
        companyId: company.id,
        contractorProfileId: profile.id,
        month,
        pfChallanNumber: `${String(
          1032600000000 + rng.int(1_000_000, 9_999_999),
        )}`,
        pfAmount: money(pfAmount),
        pfDate,
        esicChallanNumber: withEsic
          ? `${plan.esic.slice(0, 2)}${String(
              rng.int(10_000_000, 99_999_999),
            )}${month.slice(2, 4)}${month.slice(5)}`
          : null,
        esicAmount: withEsic ? money(esicAmount) : null,
        esicDate: withEsic ? esicDate : null,
        status: verified
          ? MonthlyComplianceStatus.verified
          : withEsic
          ? MonthlyComplianceStatus.submitted
          : MonthlyComplianceStatus.partial,
        verifiedByUserId: verified ? verifier.userId : null,
        verifiedAt: verified ? at(addDays(due, 20), 15, 30) : null,
        createdAt: at(pfDate, 16, 0),
        updatedAt: at(withEsic ? esicDate : pfDate, 16, 30),
      });
    }
    const filed = await prisma.monthlyCompliance.createMany({
      data: rows,
      skipDuplicates: true,
    });
    add('monthly compliance', filed.count);

    // The persisted status, recomputed the way `ComplianceStatusService.recompute` does.
    const record = await prisma.monthlyCompliance.findUnique({
      where: {
        contractorProfileId_month: {
          contractorProfileId: profile.id,
          month: concluded,
        },
      },
    });
    const status = !record
      ? 'non_compliant'
      : record.status === 'submitted' || record.status === 'verified'
      ? 'compliant'
      : record.status === 'partial'
      ? 'partially_compliant'
      : 'non_compliant';
    if (profile.complianceStatus !== status) {
      await prisma.contractorProfile.update({
        where: { id: profile.id },
        data: { complianceStatus: status },
      });
    }
  }
  return out;
}

// ─── BOCW cess ────────────────────────────────────────────────────────────────

async function seedBocw(ctx: CompanyContext, people: People): Promise<number> {
  const { prisma, company, rng } = ctx;
  const recorder = people.accountant ?? people.director;
  if (!recorder) return 0;
  if (
    (await prisma.bOCWPayment.count({ where: { companyId: company.id } })) > 0
  )
    return 0;
  const companyRow = await prisma.company.findUnique({
    where: { id: company.id },
    select: { bocwCessRate: true },
  });
  const cessRate = Number(companyRow?.bocwCessRate ?? 0.01);
  const projects = await prisma.project.findMany({
    where: { companyId: company.id, status: 'ongoing' },
    include: { client: true },
    orderBy: { code: 'asc' },
  });
  let created = 0;
  for (const project of projects) {
    const liability = Number(project.contractValue) * cessRate;
    const client = project.client?.name ?? '';
    const isNhai = /National Highways/i.test(client);
    const isPwd = /Public Works/i.test(client);
    const site = await prisma.site.findFirst({
      where: { projectId: project.id },
    });
    const state = /Haryana/i.test(site?.address ?? '')
      ? 'Haryana'
      : /Uttar Pradesh/i.test(site?.address ?? '')
      ? 'Uttar Pradesh'
      : 'Rajasthan';
    const board = `${state} Building & Other Construction Workers Welfare Board`;
    const start = dateOnly(project.startDate);
    for (let k = 1; k <= 6; k++) {
      const paymentDate = addDays(addMonths(start, 3 * k), 12);
      if (paymentDate > addDays(ctx.today, -5)) break;
      const amount = Math.round(liability * (0.07 + rng.rand() * 0.04));
      const bill = String(k * 2).padStart(2, '0');
      const [referenceNumber, remarks] = isNhai
        ? [
            `IPC-${bill}/${project.code}`,
            `Labour cess @ ${
              cessRate * 100
            }% deducted at source by ${client} from IPC-${bill} ` +
              `and remitted to the ${board}.`,
          ]
        : isPwd
        ? [
            `RA-${bill}/${project.code}`,
            `Cess deducted by ${client} from running bill ${bill}; deduction certificate on file.`,
          ]
        : [
            `GRAS/${paymentDate.getUTCFullYear()}/${rng.int(
              10_000_000,
              99_999_999,
            )}`,
            `Deposited by e-challan to the ${board} — instalment ${k} on the estimated cost of work.`,
          ];
      await prisma.bOCWPayment.create({
        data: {
          companyId: company.id,
          projectId: project.id,
          amountPaid: money(amount),
          paymentDate,
          referenceNumber,
          remarks,
          recordedByUserId: recorder.userId,
          createdAt: at(addDays(paymentDate, 2), 12, 30),
        },
      });
      created++;
    }
  }
  return created;
}
