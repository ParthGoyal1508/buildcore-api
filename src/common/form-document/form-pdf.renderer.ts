import PDFDocument = require('pdfkit');

import {
  type FormAccent,
  type FormAlign,
  type FormBlock,
  type FormCell,
  type FormDocument,
  type FormField,
  type FormRun,
  bodyRows,
  placeRows,
} from './form-document.types';

/**
 * Draws a `FormDocument` as an A4 PDF (2026-10-15).
 *
 * Helvetica throughout, Times for the work order's clauses (as the source sets them). Every table
 * is ruled, its header repeats on each page it runs onto, and a cell spanning rows — the log
 * book's monthly average — is drawn once over the rows it covers.
 */

interface Palette {
  /** The band behind the company name (navy only). */
  band: string | null;
  name: string;
  /** Column-header cells. */
  head: string;
  headText: string;
  /** Label cells of a field grid, and panel titles. */
  label: string;
  bar: string;
  barText: string;
  rule: string;
}

const PALETTES: Record<FormAccent, Palette> = {
  navy: {
    band: '#17365D',
    name: '#FFFFFF',
    head: '#1F4E78',
    headText: '#FFFFFF',
    label: '#F3F6FA',
    bar: '#17365D',
    barText: '#FFFFFF',
    rule: '#8EA0B8',
  },
  blue: {
    band: null,
    name: '#1F4E79',
    head: '#D9EAF7',
    headText: '#000000',
    label: '#D9EAF7',
    bar: '#1F4E79',
    barText: '#FFFFFF',
    rule: '#9DB7CF',
  },
  amber: {
    band: null,
    name: '#000000',
    head: '#FCE08A',
    headText: '#000000',
    label: '#FCE08A',
    bar: '#FCE08A',
    barText: '#000000',
    rule: '#B8A160',
  },
  plain: {
    band: null,
    name: '#000000',
    head: '#F2F2F2',
    headText: '#000000',
    label: '#F2F2F2',
    bar: '#D9D9D9',
    barText: '#000000',
    rule: '#000000',
  },
};

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const ITALIC = 'Helvetica-Oblique';
const SERIF = 'Times-Roman';
const SERIF_BOLD = 'Times-Bold';
const MARGIN = 28;
const PAD = 3;

export async function renderFormPdf(form: FormDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: form.landscape ? 'landscape' : 'portrait',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: form.title },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  new FormPdf(doc, form).draw();
  doc.end();
  return done;
}

class FormPdf {
  private readonly p: Palette;
  private readonly x0 = MARGIN;
  private readonly width: number;
  private readonly bottom: number;
  private y = MARGIN;

  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly form: FormDocument,
  ) {
    this.p = PALETTES[form.accent];
    this.width = doc.page.width - MARGIN * 2;
    // Room kept at the foot for the page line.
    this.bottom = doc.page.height - MARGIN - 14;
    doc.lineWidth(0.5);
  }

  draw() {
    this.header();
    for (const block of this.form.blocks) this.block(block);
    this.pageFooters();
  }

  // ── primitives ─────────────────────────────────────────────────────────────

  private text(
    value: string,
    x: number,
    y: number,
    w: number,
    o: {
      font?: string;
      size?: number;
      align?: FormAlign;
      color?: string;
      underline?: boolean;
    } = {},
  ) {
    this.doc
      .font(o.font ?? REGULAR)
      .fontSize(o.size ?? 8)
      .fillColor(o.color ?? '#000000')
      .text(value, x, y, {
        width: Math.max(1, w),
        align: o.align ?? 'left',
        underline: o.underline,
        lineGap: 0.5,
      });
    this.doc.fillColor('#000000');
  }

  private height(value: string, w: number, size = 8, font = REGULAR) {
    if (!value) return 0;
    return this.doc
      .font(font)
      .fontSize(size)
      .heightOfString(value, { width: Math.max(1, w), lineGap: 0.5 });
  }

  private rect(x: number, y: number, w: number, h: number, fill?: string) {
    if (fill) {
      this.doc.save().rect(x, y, w, h).fill(fill).restore();
    }
    this.doc.save().strokeColor(this.p.rule).rect(x, y, w, h).stroke();
    this.doc.restore();
  }

  private newPage() {
    this.doc.addPage({
      size: 'A4',
      layout: this.form.landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
    });
    this.doc.lineWidth(0.5);
    this.y = MARGIN;
  }

  /** Starts a new page unless `h` more points fit on this one. */
  private ensure(h: number) {
    if (this.y + h > this.bottom) this.newPage();
  }

  // ── header ─────────────────────────────────────────────────────────────────

  private header() {
    const { company, subHeading = [], title, caption } = this.form;
    const W = this.width;
    const logoW = 90;

    if (this.p.band) {
      // Navy: name (and project) on a dark band, the title on a pale one beneath it.
      const nameH = this.height(company.name, W - logoW * 2, 15, BOLD);
      const subH = subHeading.reduce(
        (sum, line) => sum + this.height(line, W - logoW * 2, 8.5, BOLD) + 1,
        0,
      );
      const addressH = company.address
        ? this.height(company.address, W - logoW * 2, 7.5)
        : 0;
      const bandH = Math.max(44, nameH + subH + addressH + 16);
      this.doc.save().rect(this.x0, this.y, W, bandH).fill(this.p.band);
      this.doc.restore();
      this.logo(this.x0 + 6, this.y + 5, logoW - 12, bandH - 10);
      let ty = this.y + 7;
      this.text(company.name, this.x0 + logoW, ty, W - logoW * 2, {
        font: BOLD,
        size: 15,
        align: 'center',
        color: this.p.name,
      });
      ty += nameH + 1;
      if (company.address) {
        this.text(company.address, this.x0 + logoW, ty, W - logoW * 2, {
          size: 7.5,
          align: 'center',
          color: '#DCE6F2',
        });
        ty += addressH + 1;
      }
      for (const line of subHeading) {
        this.text(line, this.x0 + logoW, ty, W - logoW * 2, {
          font: BOLD,
          size: 8.5,
          align: 'center',
          color: '#DCE6F2',
        });
        ty += this.height(line, W - logoW * 2, 8.5, BOLD) + 1;
      }
      this.y += bandH;
      const capH = caption ? this.height(caption, W, 8) + 1 : 0;
      const titleH = Math.max(22, this.height(title, W, 12, BOLD) + capH + 10);
      this.doc.save().rect(this.x0, this.y, W, titleH).fill('#D9EAF7');
      this.doc.restore();
      this.text(title, this.x0, this.y + 5, W, {
        font: BOLD,
        size: 12,
        align: 'center',
        color: '#17365D',
      });
      if (caption) {
        this.text(
          caption,
          this.x0,
          this.y + 5 + this.height(title, W, 12, BOLD),
          W,
          { font: ITALIC, size: 8, align: 'center', color: '#333333' },
        );
      }
      this.y += titleH + 8;
      return;
    }

    const top = this.y;
    const hasLogo = this.logo(this.x0, top, logoW, 40);
    const inner = hasLogo ? W - logoW * 2 : W;
    const ix = hasLogo ? this.x0 + logoW : this.x0;
    let ty = top + 2;
    this.text(company.name, ix, ty, inner, {
      font: BOLD,
      size: 15,
      align: 'center',
      color: this.p.name,
    });
    ty += this.height(company.name, inner, 15, BOLD) + 1;
    if (company.address) {
      this.text(company.address, ix, ty, inner, {
        size: 7.5,
        align: 'center',
        color: '#444444',
      });
      ty += this.height(company.address, inner, 7.5) + 1;
    }
    for (const line of subHeading) {
      this.text(line, ix, ty, inner, {
        font: BOLD,
        size: 8.5,
        align: 'center',
        color: this.p.name,
      });
      ty += this.height(line, inner, 8.5, BOLD) + 1;
    }
    ty += 2;
    this.text(title, ix, ty, inner, { font: BOLD, size: 12, align: 'center' });
    ty += this.height(title, inner, 12, BOLD) + 1;
    if (caption) {
      this.text(caption, ix, ty, inner, {
        font: ITALIC,
        size: 8.5,
        align: 'center',
      });
      ty += this.height(caption, inner, 8.5) + 1;
    }
    this.y = Math.max(ty, hasLogo ? top + 42 : ty) + 8;
  }

  /** Draws the logo fitted into the box; false when there is none or it cannot be read. */
  private logo(x: number, y: number, w: number, h: number): boolean {
    const logo = this.form.company.logo;
    if (!logo) return false;
    try {
      this.doc.image(logo, x, y, { fit: [w, h] });
      return true;
    } catch {
      // An image pdfkit cannot read leaves the space blank rather than failing the document.
      return false;
    }
  }

  // ── blocks ─────────────────────────────────────────────────────────────────

  private block(block: FormBlock) {
    switch (block.kind) {
      case 'bar':
        return this.bar(block.text);
      case 'heading':
        return this.heading(block);
      case 'fields':
        return this.fields(block.columns, block.fields);
      case 'table':
        return this.table(block);
      case 'panels':
        return this.panels(block.panels);
      case 'paragraph':
        return this.paragraph(block);
      case 'amount':
        return this.amount(block.label, block.value);
      case 'signatures':
        return this.signatures(block.items, block.boxed);
      case 'clauses':
        return this.clauses(block.sections, block.startAt ?? 1);
      case 'spacer':
        this.y += block.size ?? 8;
        return;
      case 'pageBreak':
        this.newPage();
        return;
    }
  }

  private bar(value: string) {
    const h = Math.max(16, this.height(value, this.width - 10, 9, BOLD) + 6);
    this.ensure(h + 30);
    this.doc.save().rect(this.x0, this.y, this.width, h).fill(this.p.bar);
    this.doc.restore();
    this.text(value, this.x0 + 5, this.y + 4, this.width - 10, {
      font: BOLD,
      size: 9,
      color: this.p.barText,
    });
    this.y += h;
  }

  private heading(block: Extract<FormBlock, { kind: 'heading' }>) {
    const size = block.size === 'large' ? 13 : 10;
    const h = this.height(block.text, this.width, size, BOLD);
    this.ensure(h + 24);
    this.y += 3;
    this.text(block.text, this.x0, this.y, this.width, {
      font: BOLD,
      size,
      align: block.align,
      underline: block.underline,
    });
    this.y += h + 3;
  }

  /** Lays the tick boxes of an options field into a width; returns the lines of options. */
  private optionLines(field: FormField, w: number): string[][] {
    const lines: string[][] = [[]];
    let used = 0;
    this.doc.font(REGULAR).fontSize(8);
    for (const option of field.options ?? []) {
      const need = 11 + this.doc.widthOfString(option) + 8;
      if (used + need > w && lines[lines.length - 1].length > 0) {
        lines.push([]);
        used = 0;
      }
      lines[lines.length - 1].push(option);
      used += need;
    }
    return lines;
  }

  private fields(columns: number, fields: FormField[]) {
    const W = this.width;
    const pairW = W / columns;
    const labelW = Math.min(pairW * (columns === 1 ? 0.25 : 0.42), 130);

    // Pack the fields into rows of `columns` pairs.
    const rows: FormField[][] = [];
    let row: FormField[] = [];
    let used = 0;
    for (const field of fields) {
      const span = Math.min(field.span ?? 1, columns);
      if (used + span > columns) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push({ ...field, span });
      used += span;
    }
    if (row.length) rows.push(row);

    for (const r of rows) {
      // A short last row stretches its last field to the edge, so the grid stays square.
      const spans = r.map((f) => f.span ?? 1);
      const total = spans.reduce((a, b) => a + b, 0);
      spans[spans.length - 1] += columns - total;

      const heights = r.map((f, i) => {
        const valueW = pairW * spans[i] - labelW - PAD * 2;
        const labelH = this.height(f.label, labelW - PAD * 2, 8, BOLD);
        const valueH = f.options
          ? this.optionLines(f, valueW).length * 11
          : this.height(f.value ?? '', valueW, 8);
        return Math.max(labelH, valueH);
      });
      const h = Math.max(16, ...heights.map((v) => v + PAD * 2 + 1));
      this.ensure(h);
      let x = this.x0;
      r.forEach((f, i) => {
        const valueW = pairW * spans[i] - labelW;
        this.rect(x, this.y, labelW, h, this.p.label);
        this.text(f.label, x + PAD, this.y + PAD + 1, labelW - PAD * 2, {
          font: BOLD,
        });
        this.rect(x + labelW, this.y, valueW, h);
        if (f.options) {
          this.options(f, x + labelW + PAD, this.y + PAD + 1, valueW - PAD * 2);
        } else {
          this.text(
            f.value ?? '',
            x + labelW + PAD,
            this.y + PAD + 1,
            valueW - PAD * 2,
          );
        }
        x += pairW * spans[i];
      });
      this.y += h;
    }
    this.y += 4;
  }

  private options(field: FormField, x: number, y: number, w: number) {
    const chosen = new Set(field.selected ?? []);
    let ly = y;
    for (const line of this.optionLines(field, w)) {
      let lx = x;
      for (const option of line) {
        this.doc
          .save()
          .strokeColor('#000000')
          .rect(lx, ly + 1, 7, 7)
          .stroke();
        if (chosen.has(option)) {
          this.doc.rect(lx + 1.5, ly + 2.5, 4, 4).fill('#000000');
        }
        this.doc.restore();
        this.text(option, lx + 10, ly, w, { size: 8 });
        lx += 11 + this.doc.font(REGULAR).fontSize(8).widthOfString(option) + 8;
      }
      ly += 11;
    }
  }

  private table(block: Extract<FormBlock, { kind: 'table' }>) {
    const W = this.width;
    const size = block.fontSize ?? 8;
    const total = block.columns.reduce((sum, c) => sum + c.width, 0);
    const widths = block.columns.map((c) => (c.width / total) * W);
    const xs = widths.map((_, i) =>
      widths.slice(0, i).reduce((a, b) => a + b, this.x0),
    );
    const spanW = (col: number, span: number) =>
      widths.slice(col, col + span).reduce((a, b) => a + b, 0);

    const body = bodyRows(block);

    const headH = Math.max(
      16,
      ...block.columns.map(
        (c, i) => this.height(c.label, widths[i] - PAD * 2, size, BOLD) + 7,
      ),
    );
    const drawHead = () => {
      if (block.caption) {
        const ch = this.height(block.caption, W, 10, BOLD) + 7;
        this.rect(this.x0, this.y, W, ch);
        this.text(block.caption, this.x0, this.y + 4, W, {
          font: BOLD,
          size: 10,
          align: 'center',
        });
        this.y += ch;
      }
      block.columns.forEach((c, i) => {
        this.rect(xs[i], this.y, widths[i], headH, this.p.head);
        this.text(c.label, xs[i] + PAD, this.y + 4, widths[i] - PAD * 2, {
          font: BOLD,
          size,
          align: 'center',
          color: this.p.headText,
        });
      });
      this.y += headH;
    };

    this.ensure(headH + 40);
    drawHead();

    interface OpenSpan {
      col: number;
      span: number;
      cell: FormCell;
      top: number;
      left: number;
      first: boolean;
    }
    const open: OpenSpan[] = [];
    const closeSpan = (s: OpenSpan, bottom: number) => {
      const x = xs[s.col];
      const w = spanW(s.col, s.span);
      this.rect(x, s.top, w, bottom - s.top);
      if (s.first) {
        const fs = s.cell.large ? 13 : size;
        const font = s.cell.bold || s.cell.large ? BOLD : REGULAR;
        const th = this.height(s.cell.text, w - PAD * 2, fs, font);
        this.text(
          s.cell.text,
          x + PAD,
          s.top + Math.max(PAD, (bottom - s.top - th) / 2),
          w - PAD * 2,
          { font, size: fs, align: s.cell.align ?? 'center' },
        );
      }
    };

    const placedBody = placeRows(body, block.columns.length);
    const placedFoot = placeRows(block.foot ?? [], block.columns.length);
    const drawRows = (rows: ReturnType<typeof placeRows>, isFoot: boolean) => {
      for (const placed of rows) {
        const h = Math.max(
          isFoot ? 18 : 15,
          ...placed
            .filter((p) => (p.cell.rowSpan ?? 1) <= 1)
            .map(({ col, cell }) => {
              const fs = cell.large ? 13 : size;
              return (
                this.height(
                  cell.text,
                  spanW(col, cell.span ?? 1) - PAD * 2,
                  fs,
                  cell.bold || isFoot || cell.large ? BOLD : REGULAR,
                ) +
                PAD * 2 +
                1
              );
            }),
        );
        if (this.y + h > this.bottom) {
          for (const s of open) {
            closeSpan(s, this.y);
            s.first = false;
          }
          this.newPage();
          drawHead();
          for (const s of open) s.top = this.y;
        }
        for (const { col, cell } of placed) {
          if ((cell.rowSpan ?? 1) > 1) {
            open.push({
              col,
              span: cell.span ?? 1,
              cell,
              top: this.y,
              left: cell.rowSpan!,
              first: true,
            });
            continue;
          }
          const x = xs[col];
          const w = spanW(col, cell.span ?? 1);
          this.rect(x, this.y, w, h, cell.fill ? `#${cell.fill}` : undefined);
          const fs = cell.large ? 13 : size;
          const font = cell.bold || isFoot || cell.large ? BOLD : REGULAR;
          const align =
            cell.align ??
            ((cell.span ?? 1) > 1 ? 'right' : block.columns[col]?.align);
          this.text(cell.text, x + PAD, this.y + PAD + 1, w - PAD * 2, {
            font,
            size: fs,
            align,
          });
        }
        this.y += h;
        for (let i = open.length - 1; i >= 0; i--) {
          open[i].left -= 1;
          if (open[i].left <= 0) {
            closeSpan(open[i], this.y);
            open.splice(i, 1);
          }
        }
      }
    };
    drawRows(placedBody, false);
    // A span that ran past the body (more rows promised than given) closes at the body's foot.
    for (const s of open.splice(0)) closeSpan(s, this.y);
    drawRows(placedFoot, true);
    for (const s of open.splice(0)) closeSpan(s, this.y);
    this.y += 4;
  }

  private panels(panels: { title: string; lines: string[] }[]) {
    const w = this.width / panels.length;
    const titleH = Math.max(
      16,
      ...panels.map((p) => this.height(p.title, w - PAD * 2, 8.5, BOLD) + 7),
    );
    const bodyH = Math.max(
      20,
      ...panels.map(
        (p) => this.height(p.lines.join('\n'), w - PAD * 2, 8) + PAD * 2 + 2,
      ),
    );
    this.ensure(titleH + bodyH);
    panels.forEach((p, i) => {
      const x = this.x0 + i * w;
      this.rect(x, this.y, w, titleH, this.p.label);
      this.text(p.title, x + PAD, this.y + 4, w - PAD * 2, {
        font: BOLD,
        size: 8.5,
      });
      this.rect(x, this.y + titleH, w, bodyH);
      this.text(
        p.lines.join('\n'),
        x + PAD,
        this.y + titleH + PAD + 1,
        w - PAD * 2,
      );
    });
    this.y += titleH + bodyH + 4;
  }

  private paragraph(block: Extract<FormBlock, { kind: 'paragraph' }>) {
    const size = block.small ? 7.5 : 9;
    const runs: FormRun[] =
      typeof block.text === 'string'
        ? [{ text: block.text, bold: block.bold }]
        : block.text;
    const plain = runs.map((r) => r.text).join('');
    const h = this.height(plain, this.width, size, BOLD);
    this.ensure(h + 4);
    const base = block.italic ? ITALIC : REGULAR;
    this.doc.fontSize(size).fillColor(block.small ? '#444444' : '#000000');
    runs.forEach((run, i) => {
      this.doc.font(run.bold ? BOLD : base);
      const options = {
        width: this.width,
        align: block.align ?? 'left',
        continued: i < runs.length - 1,
        lineGap: 1,
      };
      if (i === 0) this.doc.text(run.text, this.x0, this.y, options);
      else this.doc.text(run.text, options);
    });
    this.doc.fillColor('#000000');
    this.y = Math.max(this.y + h, this.doc.y) + 4;
  }

  private amount(label: string, value: string) {
    this.ensure(22);
    this.y += 4;
    this.text(`${label}  ${value}`, this.x0, this.y, this.width, {
      font: BOLD,
      size: 12,
      align: 'right',
    });
    this.y += 20;
  }

  private signatures(
    items: { caption: string; sub?: string; lines?: string[] }[],
    boxed?: boolean,
  ) {
    // A lone signature takes half the page, as a signature line does on paper.
    const w = this.width / Math.max(items.length, 2);
    if (boxed) {
      const titleH = 16;
      const bodyH = Math.max(
        30,
        ...items.map((i) => (i.lines?.length ?? 0) * 11 + PAD * 2 + 6),
      );
      this.ensure(titleH + bodyH);
      items.forEach((item, i) => {
        const x = this.x0 + i * w;
        this.rect(x, this.y, w, titleH, this.p.label);
        this.text(item.caption, x + PAD, this.y + 4, w - PAD * 2, {
          font: BOLD,
        });
        this.rect(x, this.y + titleH, w, bodyH);
        (item.lines ?? []).forEach((line, n) =>
          this.text(
            line,
            x + PAD,
            this.y + titleH + PAD + 3 + n * 11,
            w - PAD * 2,
          ),
        );
      });
      this.y += titleH + bodyH + 6;
      return;
    }
    this.ensure(56);
    this.y += 26;
    items.forEach((item, i) => {
      const x = this.x0 + i * w;
      this.doc
        .save()
        .moveTo(x + 8, this.y)
        .lineTo(x + w - 8, this.y)
        .strokeColor('#000000')
        .stroke()
        .restore();
      this.text(item.caption, x, this.y + 3, w, {
        font: BOLD,
        align: 'center',
      });
      if (item.sub) {
        this.text(item.sub, x, this.y + 13, w, { align: 'center' });
      }
      (item.lines ?? []).forEach((line, n) =>
        this.text(line, x + 8, this.y + 24 + n * 11, w - 16),
      );
    });
    const extra = Math.max(0, ...items.map((i) => (i.lines?.length ?? 0) * 11));
    this.y += 26 + extra + 4;
  }

  private clauses(
    sections: {
      title: string;
      intro?: string;
      clauses: { text: string; level: 1 | 2 }[];
    }[],
    startAt: number,
  ) {
    const W = this.width;
    sections.forEach((section, si) => {
      const n = startAt + si;
      const headH = this.height(`${n}. ${section.title}`, W, 9.5, SERIF_BOLD);
      this.ensure(headH + 30);
      this.y += 4;
      this.text(`${n}.  ${section.title}`, this.x0, this.y, W, {
        font: SERIF_BOLD,
        size: 9.5,
        underline: true,
      });
      this.y += headH + 3;
      if (section.intro) {
        const h = this.height(section.intro, W - 30, 9, SERIF);
        this.ensure(h);
        this.text(section.intro, this.x0 + 30, this.y, W - 30, {
          font: SERIF,
          size: 9,
        });
        this.y += h + 2;
      }
      let clause = 0;
      let sub = 0;
      for (const c of section.clauses) {
        if (c.level === 1) {
          clause += 1;
          sub = 0;
          const label = `${n}.${clause}`;
          const h = this.height(c.text, W - 34, 9, SERIF);
          this.ensure(h);
          this.text(label, this.x0 + 4, this.y, 30, { font: SERIF, size: 9 });
          this.text(c.text, this.x0 + 34, this.y, W - 34, {
            font: SERIF,
            size: 9,
            align: 'justify' as FormAlign,
          });
          this.y += h + 3;
        } else {
          const label = `(${String.fromCharCode(97 + sub)})`;
          sub += 1;
          const h = this.height(c.text, W - 58, 9, SERIF);
          this.ensure(h);
          this.text(label, this.x0 + 36, this.y, 22, { font: SERIF, size: 9 });
          this.text(c.text, this.x0 + 58, this.y, W - 58, {
            font: SERIF,
            size: 9,
          });
          this.y += h + 2;
        }
      }
    });
    this.y += 4;
  }

  private pageFooters() {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const y = this.doc.page.height - MARGIN - 8;
      // pdfkit would push text written below the bottom margin onto a new page.
      const saved = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      if (this.form.footer) {
        this.text(this.form.footer, this.x0, y, this.width - 80, {
          size: 6.5,
          color: '#666666',
        });
      }
      this.text(
        `Page ${i - range.start + 1} of ${range.count}`,
        this.x0 + this.width - 80,
        y,
        80,
        { size: 6.5, align: 'right', color: '#666666' },
      );
      this.doc.page.margins.bottom = saved;
    }
  }
}
