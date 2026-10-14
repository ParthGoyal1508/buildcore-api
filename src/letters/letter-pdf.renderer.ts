// `import = require` deliberately, for the reason `letters.service.ts` records at its own
// import: SWC builds the app and gives `import * as` true ESM semantics, handing back a
// namespace object that cannot be constructed, while ts-jest emits a bare require. The
// namespace form therefore passes every test and throws in the running server.
import PDFDocument = require('pdfkit');

/**
 * Rendering a letter onto the company's own stationery (2026-10-11).
 *
 * ## Why this moved out of `letters.service.ts`
 *
 * It was eighteen lines there — a title, a body, a signature — and the client's letters
 * need three things it could not do: the printed letterhead behind the text, a salary
 * annexure laid out as a table, and a reference number in the position every one of their
 * documents carries it. `bill-pdf.renderer.ts` is the precedent for keeping that away from
 * the service that decides *whether* to render.
 *
 * ## The letterhead is a full page, and that drives the geometry
 *
 * Both letterheads the client supplied are whole-page artwork: a header band at the top, a
 * contact block and footer rule at the bottom, blank in between — their pre-printed
 * stationery, scanned. So the image is drawn to the page edges and the body is laid inside
 * the clear middle. Treating it as a header strip would print the footer halfway down the
 * first page and nothing at all on the rest.
 *
 * It is drawn on **every** page, because that is what pre-printed paper does. A letter
 * whose second page is blank white is visibly a photocopy of a letter.
 */

/** A4 portrait, in points — pdfkit's unit. */
const PAGE = { width: 595.28, height: 841.89 };

/**
 * The clear band inside the artwork, measured off the two supplied letterheads.
 *
 * Parth Realcon's header ends at 11% of page height and its footer block begins at 86%;
 * Tirupati's are 9% and 81%, with a decorative shape down the left edge to 24% that stops
 * at 6% of page width. These margins clear the worst of both, so one geometry serves both
 * companies and the next one they send is likely to fit without a code change.
 *
 * Deliberately not per-company configuration. A number that has to be tuned per image is a
 * number nobody tunes, and the failure is text printed over a logo in a signed document.
 */
const SAFE = { top: 118, bottom: 168, left: 56, right: 56 };

const CONTENT_WIDTH = PAGE.width - SAFE.left - SAFE.right;

/** Body type. Small enough that a five-page appointment letter stays five pages. */
const BODY_SIZE = 10.5;
const TABLE_SIZE = 9.5;
const LINE_GAP = 2.5;

/** Cell padding inside a table, and the rule weight around it. */
const CELL_PAD = 5;
const RULE = 0.6;

/**
 * The signature graphic's box, and the space the whole block needs.
 *
 * Height is capped as well as width so a portrait scan is letterboxed rather than running
 * down into the footer artwork. `SIGNATURE_BLOCK` is the graphic at full height plus the
 * name and title beneath it — the figure the page-break check needs, so a signature is
 * never split from the name identifying it.
 */
const SIGNATURE_WIDTH = 130;
const SIGNATURE_MAX_HEIGHT = 52;
const SIGNATURE_BLOCK = 18 + SIGNATURE_MAX_HEIGHT + 6 + 26;

export interface LetterSignature {
  /**
   * The graphic. **Null on a preview** (2026-10-14): the name and title print, the graphic
   * does not. A preview is a file the browser keeps, and a signed one would be the signed
   * letter without the issue — the reason the letters module never hands the graphic out.
   */
  image: Buffer | null;
  name: string;
  title: string;
}

export interface RenderLetterInput {
  /** The kind's label, printed as the document heading. */
  title: string;
  /** The body, tokens already substituted. May contain pipe tables. */
  body: string;
  /**
   * The company's stationery as image bytes, or null for plain paper.
   *
   * Null is a legitimate state, not a missing precondition: a company that has not
   * supplied a letterhead still has letters to issue, and refusing the issue would make an
   * optional setting mandatory.
   */
  letterhead: Buffer | null;
  /** Printed top-left, above the heading. Blank until a letter is issued. */
  referenceNo?: string | null;
  /** Printed top-right, opposite the reference. */
  issueDate?: string | null;
  signature?: LetterSignature;
  /**
   * A preview, not the letter (2026-10-14): every page is marked DRAFT across its face. Nothing
   * a preview produces may be mistaken for what was issued — it has no reference number and no
   * signature graphic either.
   */
  draft?: boolean;
}

/** One parsed block of the body: a run of prose, or a table. */
type Block =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'table';
      rows: string[][];
      /**
       * Whether the first row is a heading: true when a `| --- |` separator follows it.
       * A table without one is a run of label / value rows — the payment advice's bank
       * details, the F&F sheet's employee block — and printing its first label in bold
       * makes one arbitrary row look like a column heading.
       */
      headed: boolean;
    };

/**
 * Splits a body into prose and pipe tables.
 *
 * A table is a run of consecutive lines that begin and end with `|`. A row of nothing but
 * dashes and pipes is a header separator and is dropped — it marks the first row as a
 * heading rather than being content, and a table without one has no heading row.
 *
 * Pipe tables rather than a second column on `LetterTemplate`, or a structured annexure
 * type: the client's tables — the salary annexure, the payment advice's particulars, the
 * F&F settlement sheet's sections — are small grids of labels and figures, and are already
 * edited as part of the body in the template screen that exists. A schema for them would
 * be a table engine nobody asked for, and the body would then have two editors.
 */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let text: string[] = [];
  let table: string[][] = [];
  let headed = false;

  const flushText = () => {
    if (text.length) blocks.push({ kind: 'text', lines: text });
    text = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ kind: 'table', rows: table, headed });
    table = [];
    headed = false;
  };

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const isRow =
      trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|');
    if (!isRow) {
      flushTable();
      text.push(line);
      continue;
    }
    flushText();
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    // A separator row carries no content. Dropped rather than rendered as a row of
    // dashes, which is what it looks like if you take it literally.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      if (table.length === 1) headed = true;
      continue;
    }
    table.push(cells);
  }
  flushText();
  flushTable();
  return blocks;
}

/**
 * Column widths for a table, proportional to the widest cell in each column.
 *
 * Proportional rather than equal: the annexure's first column holds "House Rent Allowance"
 * and the other two hold five-digit amounts, and equal thirds wrap the labels onto three
 * lines each while leaving the figures swimming in white space.
 */
function columnWidths(rows: string[][], measure: (s: string) => number) {
  const count = Math.max(...rows.map((r) => r.length));
  const natural = Array.from({ length: count }, (_, i) =>
    Math.max(
      ...rows.map((r) => measure(r[i] ?? '')),
      // A floor, so an empty column still takes a share rather than collapsing to a
      // hairline the reader cannot see is a column at all.
      24,
    ),
  );
  const total = natural.reduce((a, b) => a + b, 0);
  const usable = CONTENT_WIDTH - count * 2 * CELL_PAD;
  return natural.map((w) => (w / total) * usable + 2 * CELL_PAD);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- pdfkit ships no types for the
   subset used here; the same escape `bill-pdf.renderer.ts` takes. */
type Doc = any;

/** Draws one table, breaking it across pages a row at a time. */
function drawTable(
  doc: Doc,
  rows: string[][],
  headed: boolean,
  newPage: () => void,
): void {
  doc.fontSize(TABLE_SIZE);
  const widths = columnWidths(rows, (s) => doc.widthOfString(s));
  const bottomLimit = PAGE.height - SAFE.bottom;

  rows.forEach((row, rowIndex) => {
    const isHeading = headed && rowIndex === 0;
    doc.font(isHeading ? 'Helvetica-Bold' : 'Helvetica');

    const heights = row.map((cell, i) =>
      doc.heightOfString(cell ?? '', { width: widths[i] - 2 * CELL_PAD }),
    );
    const rowHeight = Math.max(...heights, TABLE_SIZE) + 2 * CELL_PAD;

    // Measured before the row is drawn, not after: a row split across a page boundary
    // leaves its own top border on one page and its text on the next.
    if (doc.y + rowHeight > bottomLimit) newPage();

    const top = doc.y;
    let x = SAFE.left;
    row.forEach((cell, i) => {
      doc
        .lineWidth(RULE)
        .rect(x, top, widths[i], rowHeight)
        .strokeColor('#999999')
        .stroke();
      doc.fillColor('#000000').text(cell ?? '', x + CELL_PAD, top + CELL_PAD, {
        width: widths[i] - 2 * CELL_PAD,
        // Numbers right, labels left — read off the cell's own content rather than
        // configured, because a column of figures is recognisable and a template author
        // should not have to declare it.
        // A date ("31.12.2026") is made of the same characters and is not a figure: right-
        // aligned it read as an amount in the middle of a work order's terms (2026-10-14).
        align:
          /^[₹\s]*[\d,.\-()]+$/.test(cell ?? '') &&
          !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test((cell ?? '').trim())
            ? 'right'
            : 'left',
      });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  });
  doc.font('Helvetica').fontSize(BODY_SIZE);
}

/**
 * Renders a letter to a PDF buffer.
 *
 * Exported as a plain function rather than a service: it reads nothing, writes nothing and
 * decides nothing, which is what makes it testable by handing it a body and reading the
 * bytes back.
 */
export function renderLetterPdf(input: RenderLetterInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc: Doc = new PDFDocument({
      size: 'A4',
      // Zero, because the letterhead is drawn edge to edge and the text is positioned
      // against SAFE explicitly. A pdfkit margin here would offset the artwork too.
      margin: 0,
      autoFirstPage: false,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Decoded **once** and drawn by reference on each page. Passing the buffer to
    // `doc.image()` per page makes pdfkit embed a fresh copy every time: a five-page
    // appointment letter on a 71 KB letterhead carried 355 KB of duplicate artwork, which
    // is most of the file. `openImage` registers it as one XObject that every page points
    // at — and it is also where a corrupt file throws, so the fallback lives here rather
    // than being retried per page.
    let stationeryImage: unknown = null;
    if (input.letterhead) {
      try {
        stationeryImage = doc.openImage(input.letterhead);
      } catch {
        // A letterhead pdfkit cannot decode must not lose the letter. It renders on plain
        // paper; the words are the document.
        stationeryImage = null;
      }
    }
    const stationery = () => {
      if (!stationeryImage) return;
      doc.image(stationeryImage, 0, 0, {
        width: PAGE.width,
        height: PAGE.height,
      });
    };

    const draftMark = () => {
      if (!input.draft) return;
      doc
        .save()
        .rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] })
        .font('Helvetica-Bold')
        .fontSize(64)
        .fillColor('#d1d5db')
        .fillOpacity(0.55)
        .text('DRAFT - NOT ISSUED', 0, PAGE.height / 2 - 40, {
          width: PAGE.width,
          align: 'center',
          lineBreak: false,
        })
        .restore();
      // Restored to the body's settings, not merely un-rotated: `save`/`restore` keep the
      // transform but not the font size, and a page started mid-paragraph carried on in 64pt.
      doc
        .font('Helvetica')
        .fontSize(BODY_SIZE)
        .fillOpacity(1)
        .fillColor('#000000');
    };

    const newPage = () => {
      doc.addPage();
      stationery();
      draftMark();
      doc.x = SAFE.left;
      doc.y = SAFE.top;
    };

    newPage();

    // Reference and date on one line, as every document the client sent carries them.
    // Skipped entirely when neither is known, rather than printing an empty rule.
    if (input.referenceNo || input.issueDate) {
      doc.fontSize(BODY_SIZE).fillColor('#000000');
      const top = doc.y;
      if (input.referenceNo) {
        doc.text(`Ref. No.: ${input.referenceNo}`, SAFE.left, top, {
          width: CONTENT_WIDTH / 2,
          align: 'left',
        });
      }
      if (input.issueDate) {
        doc.text(
          `Date: ${input.issueDate}`,
          SAFE.left + CONTENT_WIDTH / 2,
          top,
          {
            width: CONTENT_WIDTH / 2,
            align: 'right',
          },
        );
      }
      doc.y = top + BODY_SIZE + 10;
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(input.title, SAFE.left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
        underline: true,
      });
    doc.font('Helvetica').fontSize(BODY_SIZE);
    doc.y += 14;

    const blocks = parseBlocks(input.body);
    // The closing line — "For Parth Realcon Private Limited" — belongs with the signature under
    // it. Rendered as part of the body, a long letter put the closing at the foot of one page and
    // the signature alone on the next (2026-10-14). So the last paragraph of the body is split off
    // and moved over together with the signature when the two do not fit.
    let closing: string | null = null;
    const last = blocks[blocks.length - 1];
    if (input.signature && last?.kind === 'text') {
      const lines = [...last.lines];
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const breakAt = lines.map((l) => l.trim()).lastIndexOf('');
      const tail = lines.slice(breakAt + 1);
      if (tail.length > 0 && tail.length <= 3) {
        closing = tail.join('\n');
        last.lines = lines.slice(0, breakAt + 1);
      }
    }

    for (const block of blocks) {
      if (block.kind === 'table') {
        doc.y += 4;
        drawTable(doc, block.rows, block.headed, newPage);
        doc.y += 8;
        continue;
      }
      // pdfkit paginates prose itself, but only against its own margins — which are zero
      // here — so the bottom limit is given explicitly and `height` makes it break rather
      // than run over the footer artwork.
      let remaining = block.lines.join('\n');
      while (remaining.length > 0) {
        const available = PAGE.height - SAFE.bottom - doc.y;
        if (available < BODY_SIZE * 2) {
          newPage();
          continue;
        }
        const before = doc.y;
        doc.text(remaining, SAFE.left, before, {
          width: CONTENT_WIDTH,
          align: 'left',
          lineGap: LINE_GAP,
          height: available,
          ellipsis: false,
        });
        // pdfkit reports how much it consumed through the cursor; anything it could not
        // fit is re-measured and carried to the next page.
        const consumed = measureConsumed(doc, remaining, before, available);
        if (consumed >= remaining.length) break;
        remaining = remaining.slice(consumed).replace(/^\s+/, '');
        newPage();
      }
    }

    if (closing !== null) {
      const height = doc.heightOfString(closing, {
        width: CONTENT_WIDTH,
        lineGap: LINE_GAP,
      });
      // The blank line that separated it from the paragraph above, which the split took away.
      const gap = doc.currentLineHeight(true) + LINE_GAP;
      if (PAGE.height - SAFE.bottom - doc.y < gap + height + SIGNATURE_BLOCK) {
        newPage();
      } else {
        doc.y += gap;
      }
      doc.text(closing, SAFE.left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'left',
        lineGap: LINE_GAP,
      });
    }

    if (input.signature) {
      if (PAGE.height - SAFE.bottom - doc.y < SIGNATURE_BLOCK) newPage();
      doc.y += 18;
      const top = doc.y;
      const image = input.signature.image;
      if (!image) {
        // A preview: where the graphic will go, said rather than drawn.
        doc
          .fontSize(9)
          .fillColor('#6b7280')
          .text('[Signature applied on issue]', SAFE.left, top + 12);
        doc.fillColor('#000000');
        doc.y = top + 36;
      } else {
        try {
          // Measured, not assumed. The cursor used to advance by a fixed 46pt, which is
          // about right for a wide, short signature scan and wrong for anything else: a
          // portrait graphic drew 184pt tall and the signatory's name printed across the
          // middle of it. `openImage` gives the real aspect ratio, and the drawn box is
          // capped so a tall scan cannot reach into the footer artwork.
          const graphic = doc.openImage(image);
          const scale = Math.min(
            SIGNATURE_WIDTH / graphic.width,
            SIGNATURE_MAX_HEIGHT / graphic.height,
          );
          const height = graphic.height * scale;
          doc.image(graphic, SAFE.left, top, {
            width: graphic.width * scale,
            height,
          });
          doc.y = top + height + 6;
        } catch {
          // Same reasoning as the letterhead: a graphic that will not decode must not cost
          // the letter. The name and title below still identify who signed.
          doc.fontSize(9).text('[signature]', SAFE.left, top);
          doc.y = top + 16;
        }
      }
      doc
        .fontSize(BODY_SIZE)
        .font('Helvetica-Bold')
        .text(input.signature.name, SAFE.left, doc.y, { width: CONTENT_WIDTH });
      doc
        .font('Helvetica')
        .fontSize(9)
        .text(input.signature.title, SAFE.left, doc.y, {
          width: CONTENT_WIDTH,
        });
    }

    doc.end();
  });
}

/**
 * How many characters of `text` fitted in `available` points.
 *
 * pdfkit has no "how much did you draw" answer, so this re-measures prefixes. A binary
 * search rather than a scan: the appointment letter is fourteen thousand characters and a
 * per-character `heightOfString` on that is thousands of layout passes per page.
 */
function measureConsumed(
  doc: Doc,
  text: string,
  _top: number,
  available: number,
): number {
  const fits = (n: number) =>
    doc.heightOfString(text.slice(0, n), {
      width: CONTENT_WIDTH,
      lineGap: LINE_GAP,
    }) <= available;

  if (fits(text.length)) return text.length;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  // Back up to a word boundary so a page never breaks mid-word.
  const boundary = text.lastIndexOf(' ', low);
  return boundary > low / 2 ? boundary : low;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The date a letter bears, as the client's own documents write it: `16/09/2026`.
 *
 * `dd/mm/yyyy` rather than a locale-formatted date, for the reason `bank-sheet.service.ts`
 * records about value dates: a date rendered by whichever locale happens to be running is
 * a date that reads differently on two machines, and `09/16/2026` on an appointment letter
 * is a different month.
 */
export function formatLetterDate(when: Date): string {
  const day = String(when.getDate()).padStart(2, '0');
  const month = String(when.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${when.getFullYear()}`;
}
