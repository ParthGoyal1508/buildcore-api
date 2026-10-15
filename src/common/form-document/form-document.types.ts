/**
 * A printed form as data (2026-10-15).
 *
 * The plant and store documents the client sent — the vehicle log book and diesel report, the
 * vehicle register, the hire work order, the vehicle hiring bill, the daily issue register, the
 * maintenance job card, and the indent / challan / GRN / issue slip / transfer slip set — are all
 * the same few things arranged differently: a company header, label-and-value grids, ruled tables,
 * a few paragraphs, and a row of signatures. Each document is therefore written once as a
 * `FormDocument`, and `renderFormPdf`, `renderFormWorkbook` and `renderFormDocx` draw it; the
 * three copies read the same strings, so a PDF and its Excel twin cannot disagree.
 *
 * The client's rule for these formats — "the text highlighted in yellow should be configurable,
 * everything else stays static" — maps onto this split: the builders put the entered values into
 * the spec, and every label, heading and clause is a constant in the builder.
 */

export interface FormCompany {
  name: string;
  address: string | null;
  logo: Buffer | null;
}

/**
 * How the header and the shaded cells are coloured, after the source formats:
 * - `navy` — the job card and daily issue register: a dark band, white headings.
 * - `blue` — the store forms: the company name in blue, pale-blue label cells.
 * - `amber` — the vehicle hiring bill: pale-amber headings.
 * - `plain` — the log book, the register and the work order: black on white, grey headings.
 */
export type FormAccent = 'navy' | 'blue' | 'amber' | 'plain';

export interface FormDocument {
  company: FormCompany;
  /** Centred lines under the company name — the project on a job card. */
  subHeading?: string[];
  title: string;
  /** The italic line under the title — "Site Material Demand Form". */
  caption?: string;
  landscape?: boolean;
  accent: FormAccent;
  blocks: FormBlock[];
  /** Small print at the foot of every page. */
  footer?: string;
  /** Excel sheet name; defaults to the title. */
  sheetName?: string;
}

/** A run of text, optionally bold — for the work order's "issue to **ABC Infra**". */
export interface FormRun {
  text: string;
  bold?: boolean;
}

export type FormAlign = 'left' | 'center' | 'right';

export interface FormField {
  label: string;
  value?: string | null;
  /** A tick-box field: every option printed with a box, the chosen ones filled. */
  options?: string[];
  selected?: string[];
  /** How many label/value pairs this field takes across the row; defaults to 1. */
  span?: number;
}

export interface FormColumn {
  label: string;
  /** Relative width; the columns of a table share the page width in these proportions. */
  width: number;
  align?: FormAlign;
}

export interface FormCell {
  text: string;
  /** Columns this cell covers, from its own. */
  span?: number;
  /** Rows this cell covers, from its own; the covered rows leave that column out. */
  rowSpan?: number;
  bold?: boolean;
  align?: FormAlign;
  /** Larger type — the log book's average, the bill's net figure. */
  large?: boolean;
  /** A background, as hex without `#` — the register's expiring (amber) and lapsed (red) dates. */
  fill?: string;
}

export type FormRow = (string | FormCell)[];

export interface FormClauseSection {
  title: string;
  intro?: string;
  clauses: { text: string; level: 1 | 2 }[];
}

export type FormBlock =
  /** A filled heading bar across the page — "1. JOB CARD & EQUIPMENT DETAILS". */
  | { kind: 'bar'; text: string }
  /** A bold heading on its own line — "Vehicle and Hiring Charges", "PART-A". */
  | {
      kind: 'heading';
      text: string;
      align?: FormAlign;
      underline?: boolean;
      size?: 'normal' | 'large';
    }
  /** Label/value pairs, `columns` pairs to a row. */
  | { kind: 'fields'; columns: number; fields: FormField[] }
  | {
      kind: 'table';
      columns: FormColumn[];
      rows: FormRow[];
      /** Bold rows under the body — totals. */
      foot?: FormRow[];
      /** What an empty table says in its one row; defaults to "No entries". */
      emptyText?: string;
      /** A heading row spanning the table, above the column labels — "PART-A". */
      caption?: string;
      fontSize?: number;
    }
  /** Side-by-side boxes with a shaded title — the bill's Company | Sub Contractor | Bill Details. */
  | { kind: 'panels'; panels: { title: string; lines: string[] }[] }
  | {
      kind: 'paragraph';
      text: string | FormRun[];
      align?: FormAlign;
      bold?: boolean;
      italic?: boolean;
      small?: boolean;
    }
  /** A large bold figure set to the right — "Net amount after deduction: 1,27,200.00". */
  | { kind: 'amount'; label: string; value: string }
  /**
   * Signature places. `lines` are printed under the caption ("Name:", "Signature:"); without
   * them the place is a rule with the caption beneath it, as the store forms have.
   */
  | {
      kind: 'signatures';
      items: { caption: string; sub?: string; lines?: string[] }[];
      boxed?: boolean;
    }
  | { kind: 'clauses'; sections: FormClauseSection[]; startAt?: number }
  | { kind: 'spacer'; size?: number }
  | { kind: 'pageBreak' };

/** The text and options of a cell, whichever way the row gave it. */
export function cellOf(cell: string | FormCell): FormCell {
  return typeof cell === 'string' ? { text: cell } : cell;
}

/**
 * The rows of a table laid onto its column grid: for each row, the cells it actually draws with
 * their starting column, after the columns taken by a row-span from above are skipped. Shared by
 * the three renderers so they agree on where every cell lands.
 */
export function placeRows(
  rows: FormRow[],
  columnCount: number,
): { col: number; cell: FormCell }[][] {
  const covered = new Map<number, number>(); // col → rows still covered
  return rows.map((row) => {
    const placed: { col: number; cell: FormCell }[] = [];
    let col = 0;
    const skip = () => {
      while ((covered.get(col) ?? 0) > 0 && col < columnCount) col++;
    };
    for (const raw of row) {
      skip();
      if (col >= columnCount) break;
      const cell = cellOf(raw);
      const span = Math.max(1, Math.min(cell.span ?? 1, columnCount - col));
      placed.push({ col, cell: { ...cell, span } });
      if ((cell.rowSpan ?? 1) > 1) {
        for (let c = col; c < col + span; c++) covered.set(c, cell.rowSpan!);
      }
      col += span;
    }
    // This row is done: every covering span has one row fewer to go. The cell that started a
    // span this row counts this row as its first.
    for (const [c, left] of covered) {
      if (left <= 1) covered.delete(c);
      else covered.set(c, left - 1);
    }
    return placed;
  });
}

/**
 * A table's body rows, or one row saying it is empty (2026-10-15). A document prints a record,
 * so it lists the record's own lines — padding with blank numbered rows, as a paper form has,
 * made a one-line indent look like six with five left unfilled.
 */
export function bodyRows(
  block: Extract<FormBlock, { kind: 'table' }>,
): FormRow[] {
  if (block.rows.length > 0) return block.rows;
  return [
    [
      {
        text: block.emptyText ?? 'No entries',
        span: block.columns.length,
        align: 'center',
      },
    ],
  ];
}
