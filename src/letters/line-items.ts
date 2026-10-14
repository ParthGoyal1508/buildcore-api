import { rupeesFirstInWords } from '../common/rupees-in-words';

/**
 * The item table of a commercial letter — an LOI's BOQ annexure, a work order's schedule, a
 * purchase order's materials — and the totals worked out from it (2026-10-14).
 *
 * The client's three formats each carry a table of priced lines with a basic total, the GST on
 * it and the order value, and the order value again in words. A letter template is text with
 * scalar tokens, so the table cannot be a token per cell: the number of lines differs on every
 * order. Instead the issuer types the lines into one box — one per line, `Description | Unit |
 * Quantity | Rate`, the order a spreadsheet row pastes in — and this expands them into the
 * printed table and the figures the body quotes. Amounts are computed, never typed: a total
 * typed beside the lines it totals is a total that can disagree with them.
 *
 * Pure: no Nest, no Prisma. The expansion runs at render, from the variables the letter was
 * composed with, so an issued letter re-renders identically.
 */

/** The typed inputs. Declared as fields on the templates that print a table. */
export const LINE_ITEM_INPUTS = [
  'lineItems',
  'gstRate',
  'gstOnBills',
  'gstInclusion',
] as const;

/** The tokens the expansion supplies. Never declared as fields: nobody types them. */
export const LINE_ITEM_OUTPUTS = [
  'lineItemsTable',
  'basicAmount',
  'basicAmountInWords',
  'taxAmount',
  'totalAmount',
  'totalAmountInWords',
  'contractValue',
  'contractValueInWords',
] as const;

export interface LineItem {
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  hsn: string;
  amount: number;
}

/** A line the issuer typed that cannot be read. Carries the line's number for the message. */
export class LineItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineItemsError';
  }
}

/** How one kind prints its table — the column headings and the order of the totals. */
interface TableLayout {
  headings: string[];
  /** Cells for one line, in the layout's column order. */
  row: (item: LineItem, index: number) => string[];
  basicLabel: string;
  totalLabel: string;
  /** Whether the tax splits into CGST + SGST where the project says so. */
  splitsTax: boolean;
}

const LAYOUTS: Record<string, TableLayout> = {
  letter_loi: {
    headings: [
      'S.No.',
      'Description of Work',
      'Unit',
      'Quantity',
      'Rate (Rs.)',
      'Amount (Rs.)',
    ],
    row: (item, i) => [
      String(i + 1),
      item.description,
      item.unit,
      quantity(item.quantity),
      money(item.rate),
      money(item.amount),
    ],
    basicLabel: 'SUBTOTAL',
    totalLabel: 'GRAND TOTAL',
    splitsTax: false,
  },
  letter_work_order: {
    headings: [
      'S.No.',
      'Description',
      'HSN Code',
      'Unit',
      'Quantity',
      'Rate',
      'Amount',
    ],
    row: (item, i) => [
      String(i + 1),
      item.description,
      item.hsn,
      item.unit,
      quantity(item.quantity),
      money(item.rate),
      money(item.amount),
    ],
    basicLabel: 'Basic',
    totalLabel: 'Total Order Value',
    splitsTax: true,
  },
  letter_purchase_order: {
    headings: [
      'SR No.',
      'Material No. / Description',
      'Order Qty',
      'Unit',
      'Net Rate (INR)',
      'Net Value (INR)',
    ],
    row: (item, i) => [
      String(i + 1),
      item.description,
      quantity(item.quantity),
      item.unit,
      money(item.rate),
      money(item.amount),
    ],
    basicLabel: 'Gross Price',
    totalLabel: 'Total Order Value',
    splitsTax: false,
  },
};

/** Whether a kind prints an item table. */
export function hasLineItems(kindKey: string): boolean {
  return kindKey in LAYOUTS;
}

/**
 * Rupees to two places on the Indian grouping — `5,67,03,000.00`, as the formats print it.
 * Quoted in the body as `Rs. …`: the PDF's built-in font has no rupee sign, and drew `¹`.
 */
function money(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** A quantity as typed, without trailing zeros: `3`, `12.5`, `0.125`. */
function quantity(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

/** To the paisa, half away from zero — the same rounding the bill abstract uses. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** `₹ 1,25,000` or `1,25,000.50` or `125000` — a figure as people type it. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * Reads the typed box: one line per item, `Description | Unit | Quantity | Rate`, with an
 * optional fifth cell for the HSN code. A tab separates as well as a pipe, so rows copied out
 * of a spreadsheet paste straight in. Blank lines are skipped.
 */
export function parseLineItems(text: string): LineItem[] {
  const items: LineItem[] = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
      if (!line.trim()) return;
      const cells = line.split(/\t|\|/).map((c) => c.trim());
      if (cells.length < 4) {
        throw new LineItemsError(
          `Item line ${
            index + 1
          } needs four parts — Description | Unit | Quantity | Rate — ` +
            `and has ${cells.length}: "${raw.trim()}".`,
        );
      }
      const [description, unit, qtyText, rateText, hsn = ''] = cells;
      const qty = parseNumber(qtyText);
      const rate = parseNumber(rateText);
      if (!description) {
        throw new LineItemsError(`Item line ${index + 1} has no description.`);
      }
      if (qty === null || rate === null) {
        throw new LineItemsError(
          `Item line ${
            index + 1
          } ("${description}") needs a number for the quantity and ` +
            `the rate; read "${qtyText}" and "${rateText}".`,
        );
      }
      items.push({
        description,
        unit,
        quantity: qty,
        rate,
        hsn,
        amount: round2(qty * rate),
      });
    });
  return items;
}

/** One table row, padded or cut to the layout's width so every row has the same columns. */
function pipeRow(cells: string[], width: number): string {
  const padded = Array.from({ length: width }, (_, i) =>
    (cells[i] ?? '').replace(/\|/g, '/'),
  );
  return `| ${padded.join(' | ')} |`;
}

/**
 * The derived tokens for a kind that prints an item table; an empty object for any other.
 *
 * Throws `LineItemsError` for a line that cannot be read, so compose refuses it with the line
 * named rather than issuing a work order with a row missing.
 */
export function expandLineItems(
  kindKey: string,
  values: Record<string, string>,
): Record<string, string> {
  const layout = LAYOUTS[kindKey];
  if (!layout) return {};

  const items = parseLineItems(values.lineItems ?? '');
  const gstPercent = parseNumber(values.gstRate ?? '') ?? 18;
  const basic = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const tax = round2((basic * gstPercent) / 100);
  const total = round2(basic + tax);

  // CGST + SGST where the project charges them — the work order prints the two halves, as the
  // client's own does — and a single row everywhere else.
  const split =
    layout.splitsTax && !/igst/i.test(values.gstOnBills ?? 'CGST + SGST');
  const half = round2(tax / 2);
  const percent = (p: number) => `${Number(p.toFixed(3))}%`;
  const taxRows: [string, number][] = split
    ? [
        [`CGST @ ${percent(gstPercent / 2)}`, half],
        [`SGST @ ${percent(gstPercent / 2)}`, round2(tax - half)],
      ]
    : [
        [
          layout.splitsTax
            ? `IGST @ ${percent(gstPercent)}`
            : `GST @ ${percent(gstPercent)}`,
          tax,
        ],
      ];

  const width = layout.headings.length;
  const footer = (label: string, amount: number) => {
    const cells = Array<string>(width).fill('');
    cells[1] = label;
    cells[width - 1] = money(amount);
    return pipeRow(cells, width);
  };
  const table = [
    pipeRow(layout.headings, width),
    `|${' --- |'.repeat(width)}`,
    ...items.map((item, i) => pipeRow(layout.row(item, i), width)),
    footer(layout.basicLabel, basic),
    ...taxRows.map(([label, amount]) => footer(label, amount)),
    footer(layout.totalLabel, total),
  ].join('\n');

  const inclusive = /^incl/i.test((values.gstInclusion ?? '').trim());
  const contract = inclusive ? total : basic;

  return {
    lineItemsTable: table,
    basicAmount: `Rs. ${money(basic)}`,
    basicAmountInWords: rupeesFirstInWords(basic),
    taxAmount: `Rs. ${money(tax)}`,
    totalAmount: `Rs. ${money(total)}`,
    totalAmountInWords: rupeesFirstInWords(total),
    contractValue: `Rs. ${money(contract)}`,
    contractValueInWords: rupeesFirstInWords(contract),
  };
}
