import * as ExcelJS from 'exceljs';

import {
  type FormAccent,
  type FormAlign,
  type FormBlock,
  type FormDocument,
  type FormField,
  placeRows,
} from './form-document.types';

/**
 * Draws a `FormDocument` as a one-sheet workbook (2026-10-15).
 *
 * Every block is laid onto one grid of narrow columns, and each cell merges across the columns
 * its share of the width needs. Tables with different column counts — the log book's nine, the
 * register's twenty — can then sit on one sheet, as they do on the paper form. Figures that are
 * plain numbers are written as numbers with Indian grouping, so the sheet still adds up when
 * someone totals a column by hand.
 *
 * `import * as ExcelJS` as in `bill-workbook.renderer.ts` — see `src/common/swc-interop.spec.ts`.
 */

const GRID = 48;

interface Palette {
  band: string | null;
  name: string;
  head: string;
  headText: string;
  label: string;
  bar: string;
  barText: string;
}

const PALETTES: Record<FormAccent, Palette> = {
  navy: {
    band: '17365D',
    name: 'FFFFFF',
    head: '1F4E78',
    headText: 'FFFFFF',
    label: 'F3F6FA',
    bar: '17365D',
    barText: 'FFFFFF',
  },
  blue: {
    band: null,
    name: '1F4E79',
    head: 'D9EAF7',
    headText: '000000',
    label: 'D9EAF7',
    bar: '1F4E79',
    barText: 'FFFFFF',
  },
  amber: {
    band: null,
    name: '000000',
    head: 'FCE08A',
    headText: '000000',
    label: 'FCE08A',
    bar: 'FCE08A',
    barText: '000000',
  },
  plain: {
    band: null,
    name: '000000',
    head: 'F2F2F2',
    headText: '000000',
    label: 'F2F2F2',
    bar: 'D9D9D9',
    barText: '000000',
  },
};

const THIN: Partial<ExcelJS.Border> = {
  style: 'thin',
  color: { argb: 'FF808080' },
};
const BORDER: Partial<ExcelJS.Borders> = {
  top: THIN,
  left: THIN,
  bottom: THIN,
  right: THIN,
};

/** Splits `total` grid units across `weights`, every share at least one, summing exactly. */
function shares(weights: number[], total = GRID): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map((r) => Math.max(1, Math.floor(r)));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    out[order[k].i] += 1;
    left -= 1;
  }
  while (left < 0) {
    const i = out.indexOf(Math.max(...out));
    out[i] -= 1;
    left += 1;
  }
  return out;
}

const FIGURE = /^-?\d{1,3}(,\d{2,3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

export async function renderFormWorkbook(form: FormDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = form.company.name;
  new FormSheet(workbook, form).draw();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

class FormSheet {
  private readonly ws: ExcelJS.Worksheet;
  private readonly p: Palette;
  /** Characters across the printable width, spread over the grid. */
  private readonly chars: number;
  private row = 1;

  constructor(
    private readonly workbook: ExcelJS.Workbook,
    private readonly form: FormDocument,
  ) {
    const name = (form.sheetName ?? form.title)
      .replace(/[\\/?*[\]:]/g, ' ')
      .slice(0, 31);
    this.ws = workbook.addWorksheet(name, {
      pageSetup: {
        paperSize: 9,
        orientation: form.landscape ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.4,
          right: 0.4,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
      },
      views: [{ showGridLines: false }],
    });
    this.p = PALETTES[form.accent];
    this.chars = form.landscape ? 170 : 115;
    const unit = this.chars / GRID;
    for (let c = 1; c <= GRID; c++) this.ws.getColumn(c).width = unit;
    if (form.footer)
      this.ws.headerFooter.oddFooter = `&L&8${form.footer}&R&8Page &P of &N`;
  }

  draw() {
    this.header();
    for (const block of this.form.blocks) this.block(block);
  }

  // ── primitives ─────────────────────────────────────────────────────────────

  /** Rough line count of `text` in a merged cell `units` wide, for the row height. */
  private lines(text: string, units: number, size = 9): number {
    if (!text) return 1;
    const perLine = Math.max(
      4,
      Math.floor(((units * this.chars) / GRID) * (9 / size) * 1.15),
    );
    return text
      .split('\n')
      .reduce(
        (sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)),
        0,
      );
  }

  private put(
    row: number,
    from: number,
    units: number,
    value: string,
    o: {
      bold?: boolean;
      italic?: boolean;
      size?: number;
      align?: FormAlign;
      fill?: string;
      color?: string;
      border?: boolean;
      underline?: boolean;
      rows?: number;
      valign?: 'top' | 'middle';
      font?: string;
      numeric?: boolean;
    } = {},
  ) {
    const to = from + units - 1;
    const lastRow = row + (o.rows ?? 1) - 1;
    if (to > from || lastRow > row) {
      this.ws.mergeCells(row, from, lastRow, to);
    }
    const cell = this.ws.getCell(row, from);
    const text = value ?? '';
    if (o.numeric && FIGURE.test(text.trim())) {
      const number = Number(text.replace(/,/g, ''));
      const decimals = (text.split('.')[1] ?? '').length;
      cell.value = number;
      cell.numFmt =
        decimals > 0
          ? `[>=10000000]##\\,##\\,##\\,##0.${'0'.repeat(
              decimals,
            )};[>=100000]##\\,##\\,##0.${'0'.repeat(
              decimals,
            )};##,##0.${'0'.repeat(decimals)}`
          : '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
    } else {
      cell.value = text;
    }
    cell.font = {
      name: o.font ?? 'Arial',
      size: o.size ?? 9,
      bold: o.bold,
      italic: o.italic,
      underline: o.underline,
      color: { argb: `FF${o.color ?? '000000'}` },
    };
    cell.alignment = {
      horizontal: o.align ?? 'left',
      vertical: o.valign ?? 'top',
      wrapText: true,
    };
    if (o.fill) {
      for (let r = row; r <= lastRow; r++) {
        for (let c = from; c <= to; c++) {
          this.ws.getCell(r, c).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: `FF${o.fill}` },
          };
        }
      }
    }
    if (o.border) {
      for (let r = row; r <= lastRow; r++) {
        for (let c = from; c <= to; c++) {
          this.ws.getCell(r, c).border = BORDER;
        }
      }
    }
  }

  private height(row: number, lines: number, size = 9) {
    const r = this.ws.getRow(row);
    const wanted = Math.max(15, lines * (size + 4) + 4);
    r.height = Math.max(r.height ?? 0, wanted);
  }

  // ── header ─────────────────────────────────────────────────────────────────

  private header() {
    const { company, subHeading = [], title, caption } = this.form;
    const band = this.p.band;
    const first = this.row;
    if (company.logo) {
      try {
        const isPng = company.logo[0] === 0x89 && company.logo[1] === 0x50;
        const id = this.workbook.addImage({
          buffer: company.logo as unknown as ExcelJS.Buffer,
          extension: isPng ? 'png' : 'jpeg',
        });
        this.ws.addImage(id, {
          tl: { col: 0.2, row: first - 1 + 0.15 },
          ext: { width: 110, height: 42 },
        });
      } catch {
        // A logo ExcelJS cannot read leaves the corner blank.
      }
    }
    const left = 8; // grid units kept clear for the logo
    const inner = GRID - left * 2;
    const line = (text: string, o: Parameters<FormSheet['put']>[4]) => {
      this.put(this.row, left + 1, inner, text, {
        align: 'center',
        valign: 'middle',
        ...o,
      });
      if (band) {
        for (let c = 1; c <= GRID; c++) {
          this.ws.getCell(this.row, c).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: `FF${band}` },
          };
        }
      }
      this.height(this.row, this.lines(text, inner, o?.size ?? 9), o?.size);
      this.row += 1;
    };
    line(company.name, { bold: true, size: 15, color: this.p.name });
    if (company.address) {
      line(company.address, {
        size: 8,
        color: band ? 'DCE6F2' : '444444',
      });
    }
    for (const sub of subHeading) {
      line(sub, { bold: true, size: 9, color: band ? 'DCE6F2' : this.p.name });
    }
    // Keep the band at least as tall as the logo.
    if (this.row - first < 2) {
      line('', {});
    }
    const titleFill = band ? 'D9EAF7' : undefined;
    this.put(this.row, 1, GRID, title, {
      bold: true,
      size: 12,
      align: 'center',
      valign: 'middle',
      fill: titleFill,
      color: band ? '17365D' : '000000',
    });
    this.height(this.row, 1, 12);
    this.row += 1;
    if (caption) {
      this.put(this.row, 1, GRID, caption, {
        italic: true,
        size: 9,
        align: 'center',
        fill: titleFill,
      });
      this.row += 1;
    }
    this.row += 1;
  }

  // ── blocks ─────────────────────────────────────────────────────────────────

  private block(block: FormBlock) {
    switch (block.kind) {
      case 'bar':
        this.put(this.row, 1, GRID, block.text, {
          bold: true,
          size: 9.5,
          fill: this.p.bar,
          color: this.p.barText,
          valign: 'middle',
        });
        this.height(this.row, 1, 9.5);
        this.row += 1;
        return;
      case 'heading': {
        const size = block.size === 'large' ? 13 : 10;
        this.put(this.row, 1, GRID, block.text, {
          bold: true,
          size,
          align: block.align,
          underline: block.underline,
        });
        this.height(this.row, this.lines(block.text, GRID, size), size);
        this.row += 1;
        return;
      }
      case 'fields':
        return this.fields(block.columns, block.fields);
      case 'table':
        return this.table(block);
      case 'panels':
        return this.panels(block.panels);
      case 'paragraph': {
        const text =
          typeof block.text === 'string'
            ? block.text
            : block.text.map((r) => r.text).join('');
        const allBold =
          typeof block.text === 'string'
            ? block.bold
            : block.text.every((r) => r.bold);
        const cell = this.ws.getCell(this.row, 1);
        this.put(this.row, 1, GRID, text, {
          bold: allBold,
          italic: block.italic,
          size: block.small ? 8 : 9,
          align: block.align,
          color: block.small ? '444444' : '000000',
        });
        if (typeof block.text !== 'string' && !allBold) {
          cell.value = {
            richText: block.text.map((r) => ({
              text: r.text,
              font: { name: 'Arial', size: 9, bold: r.bold },
            })),
          };
        }
        this.height(this.row, this.lines(text, GRID, block.small ? 8 : 9));
        this.row += 1;
        return;
      }
      case 'amount':
        this.put(this.row, 1, GRID, `${block.label}  ${block.value}`, {
          bold: true,
          size: 12,
          align: 'right',
        });
        this.height(this.row, 1, 12);
        this.row += 2;
        return;
      case 'signatures':
        return this.signatures(block.items, block.boxed);
      case 'clauses':
        return this.clauses(block.sections, block.startAt ?? 1);
      case 'spacer':
        this.row += 1;
        return;
      case 'pageBreak':
        this.ws.getRow(this.row - 1).addPageBreak();
        return;
    }
  }

  private fields(columns: number, fields: FormField[]) {
    const pair = shares(Array(columns).fill(1));
    const labelOf = (units: number) =>
      Math.max(2, Math.round(units * (columns === 1 ? 0.25 : 0.42)));
    let used = 0;
    let col = 1;
    let maxLines = 1;
    const flush = () => {
      this.height(this.row, maxLines);
      this.row += 1;
      used = 0;
      col = 1;
      maxLines = 1;
    };
    fields.forEach((field, index) => {
      let span = Math.min(field.span ?? 1, columns);
      if (used + span > columns) flush();
      // The last field of a row takes what is left of it.
      const next = fields[index + 1];
      const nextSpan = next ? Math.min(next.span ?? 1, columns) : columns + 1;
      if (used + span + nextSpan > columns) span = columns - used;
      const units = pair.slice(used, used + span).reduce((a, b) => a + b, 0);
      const labelUnits = labelOf(pair[used]);
      const valueUnits = units - labelUnits;
      const value = field.options
        ? field.options
            .map(
              (o) => `${(field.selected ?? []).includes(o) ? '☒' : '☐'} ${o}`,
            )
            .join('   ')
        : field.value ?? '';
      this.put(this.row, col, labelUnits, field.label, {
        bold: true,
        fill: this.p.label,
        border: true,
      });
      this.put(this.row, col + labelUnits, valueUnits, value, {
        border: true,
      });
      maxLines = Math.max(
        maxLines,
        this.lines(field.label, labelUnits),
        this.lines(value, valueUnits),
      );
      col += units;
      used += span;
    });
    if (used > 0) flush();
    this.row += 1;
  }

  private table(block: Extract<FormBlock, { kind: 'table' }>) {
    const units = shares(block.columns.map((c) => c.width));
    const starts = units.map((_, i) =>
      units.slice(0, i).reduce((a, b) => a + b, 1),
    );
    const spanUnits = (col: number, span: number) =>
      units.slice(col, col + span).reduce((a, b) => a + b, 0);
    const size = Math.min(9, block.fontSize ?? 9);

    if (block.caption) {
      this.put(this.row, 1, GRID, block.caption, {
        bold: true,
        size: 10,
        align: 'center',
        border: true,
      });
      this.row += 1;
    }
    let headLines = 1;
    block.columns.forEach((c, i) => {
      this.put(this.row, starts[i], units[i], c.label, {
        bold: true,
        size,
        align: 'center',
        valign: 'middle',
        fill: this.p.head,
        color: this.p.headText,
        border: true,
      });
      headLines = Math.max(headLines, this.lines(c.label, units[i], size));
    });
    this.height(this.row, headLines, size);
    // The column labels repeat at the top of each printed page.
    this.ws.pageSetup.printTitlesRow = `${this.row}:${this.row}`;
    this.row += 1;

    const body = [...block.rows];
    if (block.minRows && body.length < block.minRows) {
      for (let n = body.length + 1; n <= block.minRows; n++) {
        body.push([String(n), ...block.columns.slice(1).map(() => '')]);
      }
    }
    const write = (rows: ReturnType<typeof placeRows>, isFoot: boolean) => {
      for (const placed of rows) {
        let lines = 1;
        for (const { col, cell } of placed) {
          const span = cell.span ?? 1;
          const width = spanUnits(col, span);
          this.put(this.row, starts[col], width, cell.text, {
            bold: cell.bold || isFoot || cell.large,
            size: cell.large ? 13 : size,
            align:
              cell.align ??
              (span > 1 ? 'right' : block.columns[col]?.align ?? 'left'),
            valign: (cell.rowSpan ?? 1) > 1 ? 'middle' : 'top',
            border: true,
            fill: cell.fill,
            rows: cell.rowSpan,
            numeric: (block.columns[col]?.align ?? 'left') === 'right',
          });
          if ((cell.rowSpan ?? 1) <= 1) {
            lines = Math.max(lines, this.lines(cell.text, width, size));
          }
        }
        this.height(this.row, lines, size);
        this.row += 1;
      }
    };
    write(placeRows(body, block.columns.length), false);
    write(placeRows(block.foot ?? [], block.columns.length), true);
    this.row += 1;
  }

  private panels(panels: { title: string; lines: string[] }[]) {
    const units = shares(panels.map(() => 1));
    let col = 1;
    let lines = 1;
    panels.forEach((p, i) => {
      this.put(this.row, col, units[i], p.title, {
        bold: true,
        fill: this.p.label,
        border: true,
      });
      const text = p.lines.join('\n');
      this.put(this.row + 1, col, units[i], text, { border: true });
      lines = Math.max(lines, this.lines(text, units[i]));
      col += units[i];
    });
    this.height(this.row, 1);
    this.height(this.row + 1, lines);
    this.row += 3;
  }

  private signatures(
    items: { caption: string; sub?: string; lines?: string[] }[],
    boxed?: boolean,
  ) {
    const units = shares(items.map(() => 1));
    let col = 1;
    if (boxed) {
      let lines = 1;
      items.forEach((item, i) => {
        this.put(this.row, col, units[i], item.caption, {
          bold: true,
          fill: this.p.label,
          border: true,
        });
        const text = (item.lines ?? []).join('\n');
        this.put(this.row + 1, col, units[i], text, { border: true });
        lines = Math.max(lines, item.lines?.length ?? 1);
        col += units[i];
      });
      this.height(this.row + 1, lines + 1);
      this.row += 3;
      return;
    }
    this.row += 2; // room to sign
    let extra = 0;
    items.forEach((item, i) => {
      const text = [item.caption, item.sub, ...(item.lines ?? [])]
        .filter(Boolean)
        .join('\n');
      this.put(this.row, col + 1, units[i] - 2, text, {
        bold: true,
        align: 'center',
      });
      for (let c = col + 1; c < col + units[i] - 1; c++) {
        this.ws.getCell(this.row, c).border = { top: THIN };
      }
      extra = Math.max(extra, text.split('\n').length);
      col += units[i];
    });
    this.height(this.row, extra);
    this.row += 2;
  }

  private clauses(
    sections: {
      title: string;
      intro?: string;
      clauses: { text: string; level: 1 | 2 }[];
    }[],
    startAt: number,
  ) {
    const font = 'Times New Roman';
    sections.forEach((section, si) => {
      const n = startAt + si;
      this.put(this.row, 1, GRID, `${n}.  ${section.title}`, {
        bold: true,
        size: 10,
        underline: true,
        font,
      });
      this.row += 1;
      if (section.intro) {
        this.put(this.row, 4, GRID - 3, section.intro, { size: 9.5, font });
        this.height(this.row, this.lines(section.intro, GRID - 3, 9.5));
        this.row += 1;
      }
      let clause = 0;
      let sub = 0;
      for (const c of section.clauses) {
        if (c.level === 1) {
          clause += 1;
          sub = 0;
          this.put(this.row, 1, 3, `${n}.${clause}`, { size: 9.5, font });
          this.put(this.row, 4, GRID - 3, c.text, { size: 9.5, font });
          this.height(this.row, this.lines(c.text, GRID - 3, 9.5));
        } else {
          this.put(this.row, 4, 2, `(${String.fromCharCode(97 + sub)})`, {
            size: 9.5,
            font,
          });
          sub += 1;
          this.put(this.row, 6, GRID - 5, c.text, { size: 9.5, font });
          this.height(this.row, this.lines(c.text, GRID - 5, 9.5));
        }
        this.row += 1;
      }
    });
    this.row += 1;
  }
}
