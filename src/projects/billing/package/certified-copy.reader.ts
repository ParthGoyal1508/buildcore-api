import { itemNumber } from '../../boq/boq-import.service';
import type { WorkbookRow, WorkbookSheet } from '../../boq/boq-workbook.reader';

/**
 * Reads a client's **certified copy** of a bill for the quantity it passed on each line
 * (2026-10-15).
 *
 * The reported case: a bill raised for 100 units of an item comes back from the client's engineer
 * with 95 passed. Until now Certify took one amount, so the 5 units nobody accepted stayed counted
 * as billed — and could not be claimed again without over-measuring. The certified copy usually
 * comes back as the same workbook the bill went out as, with the client's figures in it, so the
 * quantities are read out of it rather than typed again.
 *
 * **Pure, and it decides nothing.** It reads plain rows (`BoqWorkbookReader` has already turned the
 * bytes into strings and numbers) and proposes a certified quantity per bill line, saying where in
 * the file each one came from. A person confirms or corrects every figure before anything is
 * written; a line the file did not mention comes back `null`, which the screen shows as "not found"
 * rather than guessing it was passed in full.
 *
 * ## Which column is the certified quantity
 *
 * Real certified copies are the bill's own abstract with a two-row header — `Upto Date Bill` /
 * `Previous Bill` / `This Bill` over `Qty. | Amount` — or a plain schedule with a column headed
 * "Certified Qty" or "Passed Qty". In order of preference:
 *
 *   1. a quantity column headed certified / passed / approved / admitted / accepted;
 *   2. a quantity column headed this bill / present / current;
 *   3. up-to-date less previous, where both are present;
 *   4. a plain Qty / Quantity column, **only when it is the only one** — a BOQ (scope) quantity is
 *      never taken for a certified one.
 *
 * Every sheet is read; the sheets whose columns rank best are used, so a workbook carrying the
 * abstract and a measurement sheet per item reads its abstract, not the measurement sheets'
 * running serial numbers.
 */

/** One bill line the copy is read against. */
export interface CertifiedCopyLine {
  lineId: string;
  boqNo: string;
  description: string;
  unit: string;
  billedQty: number;
  /** The frozen rate, before the tender premium. */
  rate: number;
  /** Billed without the premium, so certified without it too. */
  nonBoq?: boolean;
}

export interface CertifiedCopySource {
  sheet: string;
  /** 1-based, as the spreadsheet application shows it. */
  row: number;
}

export interface CertifiedCopyLineReading extends CertifiedCopyLine {
  /** What the copy says was certified. `null` = the copy does not mention this line. */
  certifiedQty: number | null;
  source: CertifiedCopySource | null;
  matchedBy: 'item_number' | 'description' | null;
}

/** A row carrying a quantity that matched no line on this bill — shown so nothing is lost silently. */
export interface CertifiedCopyUnmatchedRow extends CertifiedCopySource {
  itemNo: string | null;
  description: string | null;
  qty: number;
  /** `duplicate`: the line it names was already read from an earlier row. */
  reason: 'no_line' | 'duplicate';
}

export type CertifiedCopyBasis =
  | 'certified'
  | 'this_bill'
  | 'upto_date_less_previous'
  | 'quantity';

/** Which headers a sheet was read from, so the person can see what the figures mean. */
export interface CertifiedCopyColumns {
  sheet: string;
  headerRow: number;
  itemColumn: string;
  descriptionColumn: string | null;
  quantityColumn: string;
  basis: CertifiedCopyBasis;
}

export interface CertifiedCopyReading {
  /** False when no quantity could be read at all — the screen opens manual entry instead. */
  readable: boolean;
  /** Why not, in words for whoever uploaded it. Null when readable, or when no file was sent. */
  reason: string | null;
  lines: CertifiedCopyLineReading[];
  unmatchedRows: CertifiedCopyUnmatchedRow[];
  columnsUsed: CertifiedCopyColumns[];
  /** How many lines a quantity was read for. */
  matchedCount: number;
}

/**
 * A reading that found nothing — for a PDF, an image, a workbook that could not be opened, or no
 * file at all (`reason` null): every line, for entering the certified quantities by hand.
 */
export function unreadableCopy(
  lines: CertifiedCopyLine[],
  reason: string | null,
): CertifiedCopyReading {
  return {
    readable: false,
    reason,
    lines: lines.map((line) => ({
      ...line,
      certifiedQty: null,
      source: null,
      matchedBy: null,
    })),
    unmatchedRows: [],
    columnsUsed: [],
    matchedCount: 0,
  };
}

const BASIS_RANK: Record<CertifiedCopyBasis, number> = {
  certified: 0,
  this_bill: 1,
  upto_date_less_previous: 2,
  quantity: 3,
};

/** How far down a sheet a header is looked for. Letterheads run to a dozen rows; 60 is generous. */
const HEADER_SEARCH_ROWS = 60;

interface Layout {
  headerRow: number;
  /** Index into `rows` of the first data row. */
  dataFrom: number;
  item: { index: number; label: string };
  description: { index: number; label: string } | null;
  quantity:
    | { kind: 'single'; index: number; label: string }
    | {
        kind: 'derived';
        uptoDate: number;
        previous: number;
        label: string;
      };
  basis: CertifiedCopyBasis;
}

interface SheetResult {
  layout: Layout;
  sheet: string;
  /** Row readings in sheet order, before lines are assigned. */
  rows: {
    row: number;
    itemCell: string | number | null;
    itemNo: string | null;
    description: string | null;
    qty: number;
  }[];
}

export function readCertifiedCopy(
  sheets: WorkbookSheet[],
  lines: CertifiedCopyLine[],
): CertifiedCopyReading {
  const matcher = lineMatcher(lines);

  const results: { result: SheetResult; matches: number }[] = [];
  let ambiguous: string | null = null;
  for (const sheet of sheets) {
    const found = layoutOf(sheet.rows);
    if (!found) continue;
    if ('ambiguous' in found) {
      ambiguous ??= `${sheet.name}: ${found.ambiguous}`;
      continue;
    }
    const result = readRows(sheet, found);
    const matches = result.rows.filter((row) => matcher.find(row)).length;
    if (matches > 0) results.push({ result, matches });
  }

  if (results.length === 0) {
    return unreadableCopy(
      lines,
      ambiguous
        ? `The file has more than one quantity column and none is headed certified, passed or ` +
            `this bill, so which one the client certified cannot be told (${ambiguous}). Enter ` +
            `the certified quantities below.`
        : 'No column of item numbers beside a certified quantity was found that matches the ' +
            'lines on this bill. Enter the certified quantities below.',
    );
  }

  // The best-ranked basis wins; every sheet read on it is used, the fullest first. A workbook
  // that splits the schedule across sheets (Bill-I, Bill-II) reads all of them; one that carries
  // an abstract and a measurement sheet per item reads the abstract alone.
  const best = Math.min(
    ...results.map(({ result }) => BASIS_RANK[result.layout.basis]),
  );
  const used = results
    .filter(({ result }) => BASIS_RANK[result.layout.basis] === best)
    .sort((a, b) => b.matches - a.matches)
    .map(({ result }) => result);

  const readings = new Map<
    string,
    {
      qty: number;
      source: CertifiedCopySource;
      by: 'item_number' | 'description';
    }
  >();
  const unmatchedRows: CertifiedCopyUnmatchedRow[] = [];
  for (const result of used) {
    for (const row of result.rows) {
      const match = matcher.find(row);
      const at = { sheet: result.sheet, row: row.row };
      if (!match) {
        unmatchedRows.push({
          ...at,
          itemNo: row.itemNo,
          description: row.description,
          qty: row.qty,
          reason: 'no_line',
        });
      } else if (readings.has(match.line.lineId)) {
        unmatchedRows.push({
          ...at,
          itemNo: row.itemNo,
          description: row.description,
          qty: row.qty,
          reason: 'duplicate',
        });
      } else {
        readings.set(match.line.lineId, {
          qty: row.qty,
          source: at,
          by: match.by,
        });
      }
    }
  }

  return {
    readable: true,
    reason: null,
    lines: lines.map((line) => {
      const reading = readings.get(line.lineId);
      return {
        ...line,
        certifiedQty: reading?.qty ?? null,
        source: reading?.source ?? null,
        matchedBy: reading?.by ?? null,
      };
    }),
    unmatchedRows,
    columnsUsed: used.map((result) => ({
      sheet: result.sheet,
      headerRow: result.layout.headerRow,
      itemColumn: result.layout.item.label,
      descriptionColumn: result.layout.description?.label ?? null,
      quantityColumn: result.layout.quantity.label,
      basis: result.layout.basis,
    })),
    matchedCount: readings.size,
  };
}

// ── Header detection ───────────────────────────────────────────────────────

type LayoutOrAmbiguity = Layout | { ambiguous: string } | null;

/** The first row (or pair of rows) in a sheet that heads an item column and a quantity column. */
function layoutOf(rows: WorkbookRow[]): LayoutOrAmbiguity {
  let ambiguity: { ambiguous: string } | null = null;
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const top = rows[i].cells.map(text);
    const next =
      rows[i + 1] && rows[i + 1].rowNumber === rows[i].rowNumber + 1
        ? rows[i + 1].cells.map(text)
        : null;

    const single = identify(top, rows[i].rowNumber, i + 1);
    // A two-row header: a group label over its sub-columns, carried right across the cells it
    // spans (a merged cell holds its text in the first one only).
    let double: LayoutOrAmbiguity = null;
    if (next && next.some((cell) => cell !== '')) {
      const width = Math.max(top.length, next.length);
      const labels: string[] = [];
      let group = '';
      for (let c = 0; c < width; c++) {
        const above = top[c] ?? '';
        const below = next[c] ?? '';
        if (above !== '') group = above;
        else if (below === '') group = '';
        labels.push(
          [above !== '' ? above : below !== '' ? group : '', below]
            .filter(Boolean)
            .join(' '),
        );
      }
      double = identify(labels, rows[i].rowNumber, i + 2);
    }

    const layouts = [single, double].filter(
      (layout): layout is Layout => !!layout && !('ambiguous' in layout),
    );
    if (layouts.length > 0) {
      return layouts.sort(
        (a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis],
      )[0];
    }
    for (const layout of [single, double]) {
      if (layout && 'ambiguous' in layout) ambiguity ??= layout;
    }
  }
  return ambiguity;
}

const ITEM_PRIMARY =
  /^(item|bill item)( (no|number|code|ref|reference))?$|^(boq|item) (no|number|code|ref|item)/;
const ITEM_SERIAL = /^(s|sr|sl|serial)( no| number)?$|^(sno|srno|slno)$/;
const DESCRIPTION = /desc|particular|item of work|name of (the )?(item|work)/;
const QUANTITY = /\bqty\b|\bquantit|\bqnty\b|\bquan\b/;
const NOT_QUANTITY =
  /\brate\b|\bamount\b|\bamt\b|\bvalue\b|\bunit\b|\bpercent|%/;
const CERTIFIED = /certif|\bpass|approv|admit|accept|allow/;
const PREVIOUS = /previous|\bprev\b|\blast\b/;
const UPTO_DATE = /up ?to ?date|\btodate\b|cumulative|progressive/;
const THIS_BILL = /\bthis\b|present|current|\bnow\b/;
const SCOPE =
  /\bboq\b|tender|scope|agreement|contract|estimate|sanction|original|revised|awarded/;

function identify(
  rawLabels: string[],
  headerRow: number,
  dataFrom: number,
): LayoutOrAmbiguity {
  const labels = rawLabels.map(normaliseLabel);

  let item: Layout['item'] | null = null;
  let serial: Layout['item'] | null = null;
  let description: Layout['description'] = null;
  const qty: {
    index: number;
    label: string;
    certified: boolean;
    role: 'this' | 'upto' | 'previous' | 'scope' | 'other';
  }[] = [];

  for (const [index, label] of labels.entries()) {
    if (label === '') continue;
    const raw = rawLabels[index].trim();
    if (QUANTITY.test(label) && !NOT_QUANTITY.test(label)) {
      qty.push({
        index,
        label: raw,
        certified: CERTIFIED.test(label),
        role: PREVIOUS.test(label)
          ? 'previous'
          : UPTO_DATE.test(label)
          ? 'upto'
          : THIS_BILL.test(label)
          ? 'this'
          : SCOPE.test(label)
          ? 'scope'
          : 'other',
      });
      continue;
    }
    if (!item && ITEM_PRIMARY.test(label)) item = { index, label: raw };
    else if (!serial && ITEM_SERIAL.test(label)) serial = { index, label: raw };
    else if (!description && DESCRIPTION.test(label)) {
      description = { index, label: raw };
    }
  }

  const itemColumn = item ?? serial;
  if (!itemColumn || qty.length === 0) return null;

  const pick = (
    quantity: Layout['quantity'],
    basis: CertifiedCopyBasis,
  ): Layout => ({
    headerRow,
    dataFrom,
    item: itemColumn,
    description,
    quantity,
    basis,
  });

  const certified = qty.find(
    (col) => col.certified && (col.role === 'this' || col.role === 'other'),
  );
  if (certified) {
    return pick(
      { kind: 'single', index: certified.index, label: certified.label },
      'certified',
    );
  }
  const thisBill = qty.find((col) => col.role === 'this');
  if (thisBill) {
    return pick(
      { kind: 'single', index: thisBill.index, label: thisBill.label },
      'this_bill',
    );
  }
  const prefer = <T extends { certified: boolean }>(cols: T[]) =>
    cols.find((col) => col.certified) ?? cols[0];
  const upto = prefer(qty.filter((col) => col.role === 'upto'));
  const previous = prefer(qty.filter((col) => col.role === 'previous'));
  if (upto && previous) {
    return pick(
      {
        kind: 'derived',
        uptoDate: upto.index,
        previous: previous.index,
        label: `${upto.label} less ${previous.label}`,
      },
      'upto_date_less_previous',
    );
  }
  const plain = qty.filter((col) => col.role === 'other');
  if (plain.length === 1) {
    return pick(
      { kind: 'single', index: plain[0].index, label: plain[0].label },
      'quantity',
    );
  }
  if (plain.length > 1) {
    return { ambiguous: plain.map((col) => `"${col.label}"`).join(', ') };
  }
  return null;
}

// ── Rows ───────────────────────────────────────────────────────────────────

const TOTAL_ROW = /^(grand |sub ?)?total\b/;

function readRows(sheet: WorkbookSheet, layout: Layout): SheetResult {
  const rows: SheetResult['rows'] = [];
  for (const row of sheet.rows.slice(layout.dataFrom)) {
    const cell = (index: number) => row.cells[index] ?? null;
    let qty: number | null;
    if (layout.quantity.kind === 'single') {
      qty = numberOf(cell(layout.quantity.index));
    } else {
      const upto = numberOf(cell(layout.quantity.uptoDate));
      qty =
        upto === null
          ? null
          : round3(upto - (numberOf(cell(layout.quantity.previous)) ?? 0));
    }
    if (qty === null || qty < 0) continue;

    const itemCell = cell(layout.item.index);
    const itemNo =
      itemCell === null || text(itemCell) === ''
        ? null
        : itemNumber(itemCell, 0).trim();
    const descCell = layout.description
      ? text(cell(layout.description.index))
      : '';
    const description = descCell === '' ? null : descCell;
    if (!itemNo && !description) continue;
    // A total row is not a line, whatever quantity it carries.
    if (TOTAL_ROW.test(normaliseLabel(itemNo ?? description ?? ''))) continue;

    rows.push({ row: row.rowNumber, itemCell, itemNo, description, qty });
  }
  return { layout, sheet: sheet.name, rows };
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * Item number first, normalised the way the BOQ import spells it (`itemNumber`), then the
 * description, exactly. Only an **unambiguous** match counts: a key two lines share matches neither.
 */
function lineMatcher(lines: CertifiedCopyLine[]) {
  const byKey = groupBy(lines, (line) => itemKey(line.boqNo));
  const byNumber = groupBy(lines, (line) => {
    const n = numericItem(line.boqNo);
    return n === null ? '' : String(n);
  });
  const byDescription = groupBy(lines, (line) =>
    descriptionKey(line.description),
  );
  const only = (found: CertifiedCopyLine[] | undefined) =>
    found && found.length === 1 ? found[0] : null;

  return {
    find(row: SheetResult['rows'][number]): {
      line: CertifiedCopyLine;
      by: 'item_number' | 'description';
    } | null {
      if (row.itemNo) {
        const exact = only(byKey.get(itemKey(row.itemNo)));
        if (exact) return { line: exact, by: 'item_number' };
        // A numeric cell reads `1.1` where the BOQ was imported as text `1.10`.
        if (typeof row.itemCell === 'number') {
          const numeric = only(byNumber.get(String(round3(row.itemCell))));
          if (numeric) return { line: numeric, by: 'item_number' };
        }
      }
      if (row.description) {
        const described = only(
          byDescription.get(descriptionKey(row.description)),
        );
        if (described) return { line: described, by: 'description' };
      }
      return null;
    },
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === '') continue;
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

function itemKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^(item|boq)(no)?[.:#-]*/, '')
    .replace(/\.+$/, '');
}

function numericItem(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return round3(Number(trimmed));
}

function descriptionKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Cells ──────────────────────────────────────────────────────────────────

function text(cell: string | number | null | undefined): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/\s+/g, ' ').trim();
}

function normaliseLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/** A number, or numeric text with thousands separators. Anything else is not a quantity. */
function numberOf(cell: string | number | null): number | null {
  if (cell === null) return null;
  if (typeof cell === 'number')
    return Number.isFinite(cell) ? round3(cell) : null;
  const cleaned = cell.replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return round3(Number(cleaned));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
