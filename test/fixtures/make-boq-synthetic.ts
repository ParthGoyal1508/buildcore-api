/**
 * Builds `boq-synthetic.xls` — every pathology of the client's tender, in miniature (008 T092).
 *
 * **Why a generator and not just the committed file**: the real tender is a client's commercial
 * data. Every assertion that must hold forever runs against this instead, so the suite stays
 * meaningful to somebody who cannot hold that file. The real one is exercised by one opt-in test
 * that skips with a reason when it is absent.
 *
 * Run with `npx ts-node test/fixtures/make-boq-synthetic.ts` after changing anything here, and
 * commit the result.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

import * as XLSX from 'xlsx';

/** Column indices chosen to match the real template's shape, including the far block. */
const WIDTH = 60;
const FAR = 48;

function row(
  cells: Record<number, string | number>,
): (string | number | null)[] {
  const out: (string | number | null)[] = new Array(WIDTH).fill(null);
  for (const [index, value] of Object.entries(cells))
    out[Number(index)] = value;
  return out;
}

const rows: (string | number | null)[][] = [
  row({ 0: 'Percentage BoQ' }),
  row({ 0: 'Bidder Name :', 1: 'M/S SYNTHETIC' }),
  // The header row. Deliberately carries embedded newlines, as the real one does.
  row({
    0: 'Sl.\nNo.',
    1: 'Item Description',
    3: 'Quantity',
    4: 'Units',
    5: 'Rate',
    12: 'BASIC RATE In Figures To be entered by the Bidder \nRs.      P',
    13: 'Excise Duty',
    14: 'VAT',
    20: 'IIIrd Party i.e DGS&D / RITES etc Inspection Charges @0.34%+Service Tax',
    21: 'Less for Cenvat Credit,if any respect of Supplies Under full Excise Duty Category',
    22: 'TOTAL AMOUNT',
  }),
  // A line before any heading — a warning, not an error.
  row({ 0: 1, 1: 'Site clearance', 3: 100, 4: 'Sqm', 5: 12.5, 22: 1250 }),
  // A heading: description, no quantity.
  row({ 0: 2, 1: 'Earthwork' }),
  row({
    0: 3,
    1: 'Excavation in ordinary rock',
    3: 825.7287,
    4: 'Cum',
    5: 251,
    22: 207257.9037,
  }),
  row({
    0: 4,
    1: 'Excavation in hard rock',
    3: 10,
    4: 'Cum.',
    5: 300,
    22: 3000,
  }),
  // Two consecutive headings — nested deeper than the model holds, folded into one group name.
  row({ 0: 5, 1: 'Electrical' }),
  row({ 0: 6, 1: 'Light fittings' }),
  row({ 0: 7, 1: 'LED batten 1950 lm', 3: 45, 4: 'Each', 5: 1620, 22: 72900 }),
  row({ 0: 8, 1: 'LED batten 650 lm', 3: 24, 4: 'EACH', 5: 810, 22: 19440 }),
  // The running-metre family: four spellings of one unit, which periods alone do not unify.
  row({ 0: 9, 1: 'Conduit run A', 3: 10, 4: 'R Mtr.', 5: 50, 22: 500 }),
  row({ 0: 10, 1: 'Conduit run B', 3: 10, 4: 'R. Mtr.', 5: 50, 22: 500 }),
  row({ 0: 11, 1: 'Conduit run C', 3: 10, 4: 'R.Mtr.', 5: 50, 22: 500 }),
  row({ 0: 12, 1: 'Conduit run D', 3: 10, 4: 'R. mtr', 5: 50, 22: 500 }),
  // A heading with a stray value outside the block — the span rule disposes of it unnamed.
  row({ 0: 13, 1: 'Rejects', 57: 385 }),
  // One of each rejection: no rate, no unit, a quantity that cannot be billed.
  row({ 0: 14, 1: 'Unpriced item', 3: 5, 4: 'Nos' }),
  row({ 0: 15, 1: 'Unitless item', 3: 5, 5: 10 }),
  row({ 0: 16, 1: 'Zero quantity', 3: 0, 4: 'Nos', 5: 10 }),
  // A last good line, so the rejects above are not the end of the schedule.
  row({ 0: 17, 1: 'Final item', 3: 2, 4: 'Set', 5: 1000, 22: 2000 }),
  // Footer. 1250 + 207257.90 + 3000 + 72900 + 19440 + 500×4 + 2000 = 307847.90
  row({ 0: 'Total in Figures', 22: 307847.9037 }),
  row({
    0: 'Quoted Rate in Figures',
    4: 'Excess (+)',
    5: 0.0246,
    22: 315420.95,
  }),
  row({ 0: 'Quoted Rate in Words', 2: 'INR Three Lakh Fifteen Thousand' }),
];

// The far block: item-shaped rows outside the schedule's span, which an importer scanning for
// populated columns would swallow and add to the tender.
rows[6][FAR] = 1.02;
rows[6][FAR + 1] = 'Construction of chamber for 100mm';
rows[6][FAR + 3] = 213;
rows[6][FAR + 4] = 'Nos';
rows[7][FAR] = 2;
rows[7][FAR + 1] = 'Construction of chamber for 150mm';
rows[7][FAR + 3] = 10;
rows[7][FAR + 4] = 'Nos';

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([['Please Enable Macros to View BoQ information']]),
  'Macros',
);
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'BoQ1');

const target = join(__dirname, 'boq-synthetic.xls');
writeFileSync(
  target,
  XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer,
);
// eslint-disable-next-line no-console
console.log(`wrote ${target}`);
