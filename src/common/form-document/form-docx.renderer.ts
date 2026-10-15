import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlign,
  VerticalMergeType,
  WidthType,
} from 'docx';

import {
  type FormAccent,
  type FormAlign,
  type FormBlock,
  type FormDocument,
  type FormField,
  type FormRun,
  bodyRows,
  placeRows,
} from './form-document.types';

/**
 * Draws a `FormDocument` as a Word file (2026-10-15).
 *
 * Every table carries fixed DXA column widths and a fixed layout, as the bill's Word copy does —
 * Pages and Preview otherwise collapse a table to its narrowest content.
 */

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

const MARGIN = 720;
const ALIGN: Record<
  FormAlign,
  (typeof AlignmentType)[keyof typeof AlignmentType]
> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};
const LINE = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

interface ParaOptions {
  bold?: boolean;
  italics?: boolean;
  size?: number; // points
  align?: FormAlign;
  color?: string;
  underline?: boolean;
  font?: string;
  after?: number;
}

function para(text: string | FormRun[], o: ParaOptions = {}): Paragraph {
  const runs: FormRun[] = typeof text === 'string' ? [{ text }] : text;
  return new Paragraph({
    alignment: ALIGN[o.align ?? 'left'],
    spacing: { after: o.after ?? 0 },
    children: runs.flatMap((run) =>
      run.text.split('\n').map(
        (line, i) =>
          new TextRun({
            text: line,
            break: i > 0 ? 1 : undefined,
            bold: o.bold || run.bold,
            italics: o.italics,
            size: Math.round((o.size ?? 9) * 2),
            color: o.color,
            font: o.font ?? 'Arial',
            underline: o.underline ? { type: UnderlineType.SINGLE } : undefined,
          }),
      ),
    ),
  });
}

function cell(
  children: Paragraph[],
  width: number,
  o: {
    span?: number;
    fill?: string;
    borders?: boolean;
    vMerge?: 'restart' | 'continue';
    middle?: boolean;
  } = {},
): TableCell {
  const border = o.borders === false ? NONE : LINE;
  return new TableCell({
    children: children.length ? children : [para('')],
    // Each cell's own width as well as the grid's: Word reads the grid, but Pages and the macOS
    // preview size a row from its cells.
    width: { size: width, type: WidthType.DXA },
    columnSpan: o.span && o.span > 1 ? o.span : undefined,
    verticalMerge:
      o.vMerge === 'restart'
        ? VerticalMergeType.RESTART
        : o.vMerge === 'continue'
        ? VerticalMergeType.CONTINUE
        : undefined,
    verticalAlign: o.middle ? VerticalAlign.CENTER : VerticalAlign.TOP,
    shading: o.fill
      ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill }
      : undefined,
    margins: { top: 40, bottom: 40, left: 70, right: 70 },
    borders: { top: border, bottom: border, left: border, right: border },
  });
}

function table(widths: number[], rows: TableRow[]): Table {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows,
  });
}

/** Integer DXA widths in the given proportions, summing exactly to `total`. */
function split(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

export async function renderFormDocx(form: FormDocument): Promise<Buffer> {
  const width = (form.landscape ? 16838 : 11906) - MARGIN * 2;
  const p = PALETTES[form.accent];
  const children: (Paragraph | Table)[] = [
    ...header(form, p, width),
    ...form.blocks.flatMap((block) => drawBlock(block, p, width)),
  ];
  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 18 } } },
    },
    sections: [
      {
        properties: {
          page: {
            size: form.landscape
              ? { orientation: PageOrientation.LANDSCAPE }
              : undefined,
            margin: {
              top: MARGIN,
              bottom: MARGIN,
              left: MARGIN,
              right: MARGIN,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: form.footer ? `${form.footer}    ` : '',
                    size: 14,
                    color: '666666',
                  }),
                  new TextRun({
                    children: [
                      'Page ',
                      PageNumber.CURRENT,
                      ' of ',
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 14,
                    color: '666666',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function header(
  form: FormDocument,
  p: Palette,
  width: number,
): (Paragraph | Table)[] {
  const { company, subHeading = [], title, caption } = form;
  const logo = company.logo
    ? [
        new Paragraph({
          children: [
            new ImageRun({
              type: company.logo[0] === 0x89 ? 'png' : 'jpg',
              data: company.logo,
              transformation: { width: 110, height: 42 },
            }),
          ],
        }),
      ]
    : [];
  const textColor = p.band ? p.name : p.name;
  const centre = [
    para(company.name, {
      bold: true,
      size: 15,
      align: 'center',
      color: textColor,
    }),
    ...(company.address
      ? [
          para(company.address, {
            size: 7.5,
            align: 'center',
            color: p.band ? 'DCE6F2' : '444444',
          }),
        ]
      : []),
    ...subHeading.map((line) =>
      para(line, {
        bold: true,
        size: 8.5,
        align: 'center',
        color: p.band ? 'DCE6F2' : p.name,
      }),
    ),
  ];
  const widths = split([1.4, 5, 1.4], width);
  const band = table(widths, [
    new TableRow({
      children: [
        cell(logo, widths[0], {
          fill: p.band ?? undefined,
          borders: false,
          middle: true,
        }),
        cell(centre, widths[1], {
          fill: p.band ?? undefined,
          borders: false,
          middle: true,
        }),
        cell([], widths[2], { fill: p.band ?? undefined, borders: false }),
      ],
    }),
  ]);
  const titleRows = [
    para(title, {
      bold: true,
      size: 12,
      align: 'center',
      color: p.band ? '17365D' : undefined,
    }),
    ...(caption
      ? [para(caption, { italics: true, size: 8.5, align: 'center' })]
      : []),
  ];
  const titleBlock = p.band
    ? table(
        [width],
        [
          new TableRow({
            children: [
              cell(titleRows, width, { fill: 'D9EAF7', borders: false }),
            ],
          }),
        ],
      )
    : null;
  return [
    band,
    ...(titleBlock ? [titleBlock] : titleRows),
    para('', { after: 80 }),
  ];
}

function drawBlock(
  block: FormBlock,
  p: Palette,
  width: number,
): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'bar':
      return [
        table(
          [width],
          [
            new TableRow({
              children: [
                cell(
                  [
                    para(block.text, {
                      bold: true,
                      size: 9.5,
                      color: p.barText,
                    }),
                  ],
                  width,
                  { fill: p.bar, borders: false },
                ),
              ],
            }),
          ],
        ),
      ];
    case 'heading':
      return [
        para(block.text, {
          bold: true,
          size: block.size === 'large' ? 13 : 10,
          align: block.align,
          underline: block.underline,
          after: 60,
        }),
      ];
    case 'fields':
      return [fields(block.columns, block.fields, p, width), para('')];
    case 'table':
      return [dataTable(block, p, width), para('')];
    case 'panels': {
      const widths = split(
        block.panels.map(() => 1),
        width,
      );
      return [
        table(widths, [
          new TableRow({
            children: block.panels.map((panel, i) =>
              cell([para(panel.title, { bold: true })], widths[i], {
                fill: p.label,
              }),
            ),
          }),
          new TableRow({
            children: block.panels.map((panel, i) =>
              cell(
                panel.lines.map((line) => para(line)),
                widths[i],
              ),
            ),
          }),
        ]),
        para(''),
      ];
    }
    case 'paragraph':
      return [
        para(block.text, {
          bold: block.bold,
          italics: block.italic,
          size: block.small ? 7.5 : 9,
          align: block.align,
          color: block.small ? '444444' : undefined,
          after: 80,
        }),
      ];
    case 'amount':
      return [
        para(`${block.label}  ${block.value}`, {
          bold: true,
          size: 12,
          align: 'right',
          after: 120,
        }),
      ];
    case 'signatures': {
      const widths = split(
        block.items.map(() => 1),
        width,
      );
      if (block.boxed) {
        return [
          table(widths, [
            new TableRow({
              children: block.items.map((item, i) =>
                cell([para(item.caption, { bold: true })], widths[i], {
                  fill: p.label,
                }),
              ),
            }),
            new TableRow({
              children: block.items.map((item, i) =>
                cell(
                  (item.lines ?? []).map((line) => para(line, { after: 60 })),
                  widths[i],
                ),
              ),
            }),
          ]),
          para(''),
        ];
      }
      return [
        para('', { after: 500 }),
        table(widths, [
          new TableRow({
            children: block.items.map(
              (item, i) =>
                new TableCell({
                  width: { size: widths[i], type: WidthType.DXA },
                  margins: { left: 200, right: 200 },
                  borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      border: {
                        top: {
                          style: BorderStyle.SINGLE,
                          size: 6,
                          color: '000000',
                        },
                      },
                      children: [
                        new TextRun({
                          text: item.caption,
                          bold: true,
                          size: 18,
                        }),
                      ],
                    }),
                    ...(item.sub ? [para(item.sub, { align: 'center' })] : []),
                    ...(item.lines ?? []).map((line) => para(line)),
                  ],
                }),
            ),
          }),
        ]),
        para(''),
      ];
    }
    case 'clauses': {
      const out: Paragraph[] = [];
      const start = block.startAt ?? 1;
      block.sections.forEach((section, si) => {
        const n = start + si;
        out.push(
          para(`${n}.  ${section.title}`, {
            bold: true,
            size: 10,
            underline: true,
            font: 'Times New Roman',
            after: 60,
          }),
        );
        if (section.intro) {
          out.push(
            new Paragraph({
              indent: { left: 560 },
              spacing: { after: 60 },
              children: [
                new TextRun({
                  text: section.intro,
                  size: 19,
                  font: 'Times New Roman',
                }),
              ],
            }),
          );
        }
        let clause = 0;
        let sub = 0;
        for (const c of section.clauses) {
          const label =
            c.level === 1
              ? `${n}.${++clause}`
              : `(${String.fromCharCode(97 + sub++)})`;
          if (c.level === 1) sub = 0;
          out.push(
            new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              indent:
                c.level === 1
                  ? { left: 560, hanging: 560 }
                  : { left: 1000, hanging: 440 },
              spacing: { after: 60 },
              children: [
                new TextRun({
                  text: `${label}\t`,
                  size: 19,
                  font: 'Times New Roman',
                }),
                new TextRun({
                  text: c.text,
                  size: 19,
                  font: 'Times New Roman',
                }),
              ],
              tabStops: [
                { type: 'left', position: c.level === 1 ? 560 : 1000 },
              ],
            }),
          );
        }
      });
      return out;
    }
    case 'spacer':
      return [para('')];
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })];
  }
}

function fields(
  columns: number,
  list: FormField[],
  p: Palette,
  width: number,
): Table {
  // Each pair is a label column and a value column.
  const pair = Math.floor(width / columns);
  const labelW = Math.round(pair * (columns === 1 ? 0.25 : 0.42));
  const widths: number[] = [];
  for (let i = 0; i < columns; i++) widths.push(labelW, pair - labelW);
  widths[widths.length - 1] += width - widths.reduce((a, b) => a + b, 0);

  const rows: TableRow[] = [];
  let cells: TableCell[] = [];
  let used = 0;
  const flush = () => {
    rows.push(new TableRow({ children: cells }));
    cells = [];
    used = 0;
  };
  list.forEach((field, index) => {
    let span = Math.min(field.span ?? 1, columns);
    if (used + span > columns) flush();
    const next = list[index + 1];
    const nextSpan = next ? Math.min(next.span ?? 1, columns) : columns + 1;
    if (used + span + nextSpan > columns) span = columns - used;
    const value = field.options
      ? field.options
          .map((o) => `${(field.selected ?? []).includes(o) ? '☒' : '☐'} ${o}`)
          .join('   ')
      : field.value ?? '';
    const valueSpan = span * 2 - 1;
    const valueW = widths
      .slice(used * 2 + 1, used * 2 + 1 + valueSpan)
      .reduce((a, b) => a + b, 0);
    cells.push(
      cell([para(field.label, { bold: true })], widths[used * 2], {
        fill: p.label,
      }),
    );
    cells.push(cell([para(value)], valueW, { span: valueSpan }));
    used += span;
  });
  if (cells.length) flush();
  return table(widths, rows);
}

function dataTable(
  block: Extract<FormBlock, { kind: 'table' }>,
  p: Palette,
  width: number,
): Table {
  const widths = split(
    block.columns.map((c) => c.width),
    width,
  );
  const size = Math.min(9, block.fontSize ?? 8.5);
  const spanW = (col: number, span: number) =>
    widths.slice(col, col + span).reduce((a, b) => a + b, 0);
  const rows: TableRow[] = [];
  if (block.caption) {
    rows.push(
      new TableRow({
        children: [
          cell(
            [para(block.caption, { bold: true, size: 10, align: 'center' })],
            width,
            {
              span: block.columns.length,
            },
          ),
        ],
      }),
    );
  }
  rows.push(
    new TableRow({
      tableHeader: true,
      children: block.columns.map((c, i) =>
        cell(
          [
            para(c.label, {
              bold: true,
              size,
              align: 'center',
              color: p.headText,
            }),
          ],
          widths[i],
          { fill: p.head, middle: true },
        ),
      ),
    }),
  );

  const body = bodyRows(block);

  // Word merges rows with a "continue" cell in each covered row, so the covered columns are
  // filled back in here from the placement.
  const emit = (all: ReturnType<typeof placeRows>, isFoot: boolean) => {
    const covering = new Map<number, { span: number; left: number }>();
    for (const placed of all) {
      const byCol = new Map(placed.map((pc) => [pc.col, pc.cell]));
      const children: TableCell[] = [];
      let col = 0;
      while (col < block.columns.length) {
        const cover = covering.get(col);
        if (cover && cover.left > 0) {
          children.push(
            cell([], spanW(col, cover.span), {
              span: cover.span,
              vMerge: 'continue',
            }),
          );
          cover.left -= 1;
          if (cover.left === 0) covering.delete(col);
          col += cover.span;
          continue;
        }
        const c = byCol.get(col);
        if (!c) {
          children.push(cell([], widths[col]));
          col += 1;
          continue;
        }
        const span = c.span ?? 1;
        const align =
          c.align ?? (span > 1 ? 'right' : block.columns[col]?.align ?? 'left');
        const merged = (c.rowSpan ?? 1) > 1;
        children.push(
          cell(
            [
              para(c.text, {
                bold: c.bold || isFoot || c.large,
                size: c.large ? 13 : size,
                align,
              }),
            ],
            spanW(col, span),
            {
              span,
              vMerge: merged ? 'restart' : undefined,
              middle: merged,
              fill: c.fill,
            },
          ),
        );
        if (merged) covering.set(col, { span, left: c.rowSpan! - 1 });
        col += span;
      }
      rows.push(new TableRow({ children }));
    }
  };
  emit(placeRows(body, block.columns.length), false);
  emit(placeRows(block.foot ?? [], block.columns.length), true);
  return table(widths, rows);
}
