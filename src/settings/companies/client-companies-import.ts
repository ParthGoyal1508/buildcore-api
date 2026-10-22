import * as ExcelJS from 'exceljs';
import {
  canonicalStateName,
  cinStateName,
  gstStateCodeFor,
} from '../../common/gst-states';

/**
 * Reading the client data workbook's **Companies** tab into companies and their branches (041).
 *
 * The client fills one row per GST registration and repeats the company's short code, legal name,
 * PAN, CIN and TAN on each (Parth Realcon: five rows; Tirupati Enterprises: seven). This groups the
 * rows by short code into one company with one branch per row, and picks the head office: the row
 * in the state the CIN was registered in, or the first row for a company with no CIN.
 *
 * Pure — no database. `scripts/import-client-companies.ts` applies the plan.
 */

export interface CompanyRow {
  /** The sheet's own row number, for messages a person can find. */
  rowNumber: number;
  legalName: string;
  shortCode: string;
  address: string | null;
  city: string | null;
  state: string | null;
  pinCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  pan: string | null;
  cin: string | null;
  tan: string | null;
  pfEstablishmentCode: string | null;
  esicCode: string | null;
  professionalTaxRegNumber: string | null;
}

export interface CompanyPlan {
  shortCode: string;
  legalName: string;
  pan: string | null;
  cin: string | null;
  tan: string | null;
  /** The head office first, then the rest in sheet order. */
  branches: (CompanyRow & { isHeadOffice: boolean })[];
}

/** Header text → field, matched after dropping the template's " *" required marker. */
const HEADERS: Record<string, keyof Omit<CompanyRow, 'rowNumber'>> = {
  'company legal name': 'legalName',
  'short code': 'shortCode',
  'registered address': 'address',
  address: 'address',
  city: 'city',
  state: 'state',
  'pin code': 'pinCode',
  phone: 'phone',
  email: 'email',
  website: 'website',
  gstin: 'gstin',
  pan: 'pan',
  cin: 'cin',
  tan: 'tan',
  'pf establishment code': 'pfEstablishmentCode',
  'esic code': 'esicCode',
  'professional tax reg. no.': 'professionalTaxRegNumber',
};

/** A cell as text: hyperlinks and rich text flattened, numbers kept as typed (PIN, phone). */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return cellText(
        (v.richText as { text: string }[]).map((r) => r.text).join(''),
      );
    }
    if ('text' in v) return cellText(v.text as ExcelJS.CellValue);
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return null;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Reads the Companies tab; the header row is the one with "Company Legal Name" in it. */
export function readCompanyRows(sheet: ExcelJS.Worksheet): CompanyRow[] {
  let headerRow = 0;
  const columns = new Map<number, keyof Omit<CompanyRow, 'rowNumber'>>();
  sheet.eachRow((row, rowNumber) => {
    if (headerRow) return;
    const labels = (row.values as ExcelJS.CellValue[]).map((v) =>
      (cellText(v) ?? '').replace(/\*/g, '').trim().toLowerCase(),
    );
    if (!labels.includes('company legal name')) return;
    headerRow = rowNumber;
    labels.forEach((label, col) => {
      const field = HEADERS[label];
      if (field && !columns.has(col)) columns.set(col, field);
    });
  });
  if (!headerRow) {
    throw new Error('No "Company Legal Name" header row on the Companies tab.');
  }

  const rows: CompanyRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const record = { rowNumber } as CompanyRow;
    for (const [col, field] of columns) {
      (record as unknown as Record<string, string | null>)[field] = cellText(
        row.getCell(col).value,
      );
    }
    if (!record.legalName && !record.shortCode) return;
    record.shortCode = (record.shortCode ?? '').toUpperCase();
    record.gstin = record.gstin?.toUpperCase() ?? null;
    record.pan = record.pan?.toUpperCase() ?? null;
    record.state = canonicalStateName(record.state) ?? record.state;
    record.email = record.email?.toLowerCase() ?? null;
    rows.push(record);
  });
  return rows;
}

/**
 * Groups rows into companies and checks them. Every problem is collected and returned rather than
 * the first thrown, so one run of the script lists everything the client has to correct.
 */
export function planCompanies(rows: CompanyRow[]): {
  plans: CompanyPlan[];
  problems: string[];
} {
  const problems: string[] = [];
  const byCode = new Map<string, CompanyRow[]>();
  for (const row of rows) {
    if (!row.shortCode) {
      problems.push(`Row ${row.rowNumber}: no short code.`);
      continue;
    }
    byCode.set(row.shortCode, [...(byCode.get(row.shortCode) ?? []), row]);
  }

  const plans: CompanyPlan[] = [];
  for (const [shortCode, group] of byCode) {
    // The company-level fields must agree on every row (FR-023).
    for (const field of ['legalName', 'pan', 'cin', 'tan'] as const) {
      const values = new Set(
        group.map((r) => (r[field] ?? '').toUpperCase()).filter(Boolean),
      );
      if (values.size > 1) {
        problems.push(
          `Rows ${group
            .map((r) => r.rowNumber)
            .join(', ')} (${shortCode}): ${field} differs (${[...values].join(
            ' vs ',
          )}).`,
        );
      }
    }
    const first = (field: 'legalName' | 'pan' | 'cin' | 'tan') =>
      group.find((r) => r[field])?.[field] ?? null;
    const pan = first('pan');
    const cin = first('cin');

    const seen = new Set<string>();
    for (const row of group) {
      if (!row.gstin) continue;
      if (seen.has(row.gstin)) {
        problems.push(
          `Row ${row.rowNumber} (${shortCode}): GSTIN ${row.gstin} appears twice.`,
        );
      }
      seen.add(row.gstin);
      const stateCode = gstStateCodeFor(row.state);
      if (row.gstin.slice(0, 2) !== stateCode) {
        problems.push(
          `Row ${row.rowNumber} (${shortCode}): GSTIN ${
            row.gstin
          } starts ${row.gstin.slice(0, 2)}, ` +
            `but ${row.state ?? 'no state'} is ${
              stateCode ?? 'not a known state'
            }.`,
        );
      }
      if (pan && row.gstin.slice(2, 12) !== pan) {
        problems.push(
          `Row ${row.rowNumber} (${shortCode}): GSTIN ${row.gstin} does not carry the PAN ${pan}.`,
        );
      }
    }

    // FR-022: the row in the CIN's state, else the first row.
    const cinState = cinStateName(cin);
    const head =
      (cinState && group.find((r) => r.state === cinState)) || group[0];
    plans.push({
      shortCode,
      legalName: first('legalName') ?? shortCode,
      pan,
      cin,
      tan: first('tan'),
      branches: [head, ...group.filter((r) => r !== head)].map((r) => ({
        ...r,
        isHeadOffice: r === head,
      })),
    });
  }
  return { plans, problems };
}
