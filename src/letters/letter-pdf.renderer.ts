// `import = require` deliberately, for the reason `letters.service.ts` records at its own
// import: SWC builds the app and gives `import * as` true ESM semantics, handing back a
// namespace object that cannot be constructed, while ts-jest emits a bare require. The
// namespace form therefore passes every test and throws in the running server.
import PDFDocument = require('pdfkit');

import { readFileSync } from 'fs';
import { join } from 'path';

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

/**
 * The letter face (2026-10-15): Inter, embedded, because the client's formats print amounts with
 * "₹" and pdfkit's built-in Helvetica has no such glyph — it printed "¹", so the templates said
 * "Rs." instead. Inter (SIL Open Font License, `fonts/OFL.txt`) has it, and the "–", "’" and "•"
 * the formats use besides.
 *
 * Read from `fonts/` beside this file, which `nest-cli.json` copies into `dist/` with the build.
 * Should the files be missing — a build that lost its assets — the letter still renders, in
 * Helvetica with "₹" written "Rs.": a letter in the fallback face beats no letter.
 */
interface Faces {
  regular: string;
  bold: string;
}
const FALLBACK: Faces = { regular: 'Helvetica', bold: 'Helvetica-Bold' };
let fontFiles: { regular: Buffer; bold: Buffer } | null | undefined;
export function letterFontFiles(): { regular: Buffer; bold: Buffer } | null {
  if (fontFiles === undefined) {
    try {
      fontFiles = {
        regular: readFileSync(join(__dirname, 'fonts', 'Inter-Regular.woff')),
        bold: readFileSync(join(__dirname, 'fonts', 'Inter-SemiBold.woff')),
      };
    } catch {
      fontFiles = null;
    }
  }
  return fontFiles;
}

/** Whether the embedded face is available — false only on a build that lost its fonts. */
export function hasRupeeGlyph(): boolean {
  return letterFontFiles() !== null;
}

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

/**
 * Body type. Small enough that a five-page appointment letter stays five pages. 10pt since the
 * face became Inter (2026-10-15), which sets larger than Helvetica at the same size: at 10.5 the
 * two-page offer letter ran its closing onto a third page.
 */
const BODY_SIZE = 10;
const TABLE_SIZE = 9;
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
/** The blank left to sign by hand in, when a format's signing block has no signatory's graphic. */
const UNSIGNED_SPACE = 40;

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
  /**
   * The company's logo and name across the top of the first page, in place of the letterhead
   * artwork (2026-10-14). The client's work order and purchase order are not written on
   * letterhead: each opens with the logo, the company name and the registered office, then the
   * document. Set, the letterhead is not drawn even when there is one.
   */
  brandHeader?: BrandHeader;
  /**
   * Two signing blocks at the foot of every page — the work order's "For Parth Realcon Private
   * Limited / For M/s …", each over "Authorized Signatory" (2026-10-14). A work order is signed
   * page by page, so the place for the signatures is on every page, not only the last.
   */
  pageFooter?: { left: string; right: string };
  /** What the reference is called on this document — "LOI No.", "WO No.". "Ref. No." if unset. */
  referenceLabel?: string;
  /**
   * The title above the reference line instead of below it (2026-10-15) — the offer, appointment
   * and transfer letters open with their heading. A body's `[[title]]` overrides both positions.
   * An empty `title` prints no heading at all, as the increment and termination letters have none.
   */
  titleFirst?: boolean;
  /**
   * Printed opposite the last line of the closing — "Employee Signature" across from "For Parth
   * Realcon Private Limited" on the offer letter (2026-10-15), where the candidate signs the copy
   * they return.
   */
  acceptanceLabel?: string;
  /**
   * Printed under the signature in place of the signatory's name and title — "Authorized
   * Signatory" (2026-10-15). Set, the letter always closes with a signing block: when no
   * signatory signs it, the space is left blank, to be signed by hand.
   */
  signatureLines?: string[];
}

export interface BrandHeader {
  logo: Buffer | null;
  name: string;
  /** Registered office, phone, email, website — one line each, blank ones left out. */
  lines: string[];
}

/**
 * One parsed block of the body: a run of prose, a table, or one of three markers a template
 * writes on a line of its own (2026-10-14):
 *
 * - `## Heading` — a heading, in bold. The work order runs to seven pages of numbered clauses
 *   whose headings are what a reader navigates by.
 * - `[[pagebreak]]` — the rest starts on a new page. The LOI's BOQ is an annexure, and an
 *   annexure begins on its own page.
 * - `[[signature]]` — where the signature goes, when it is not at the end. The LOI and the
 *   purchase order are signed by the company and *then* carry the vendor's acceptance; at the
 *   end, the company's signature would sit under the vendor's acceptance block.
 * - `[[title]]` — where the document's heading goes, when not at the top (2026-10-15). The
 *   relieving letter prints it under the employee's name and project lines.
 */
type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'break' }
  | { kind: 'signature' }
  | { kind: 'title' }
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
    if (
      trimmed === '[[pagebreak]]' ||
      trimmed === '[[signature]]' ||
      trimmed === '[[title]]'
    ) {
      flushText();
      flushTable();
      blocks.push({
        kind:
          trimmed === '[[pagebreak]]'
            ? 'break'
            : trimmed === '[[title]]'
            ? 'title'
            : 'signature',
      });
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushText();
      flushTable();
      blocks.push({ kind: 'heading', text: trimmed.slice(3).trim() });
      continue;
    }
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
export function columnWidths(rows: string[][], measure: (s: string) => number) {
  const count = Math.max(...rows.map((r) => r.length));
  const natural = Array.from({ length: count }, (_, i) =>
    Math.max(
      ...rows.map((r) => measure(r[i] ?? '')),
      // A floor, so an empty column still takes a share rather than collapsing to a
      // hairline the reader cannot see is a column at all.
      24,
    ),
  );
  const usable = CONTENT_WIDTH - count * 2 * CELL_PAD;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= usable) {
    return natural.map((w) => (w / total) * usable + 2 * CELL_PAD);
  }
  // How narrow each column may be made (2026-10-15): never narrower than its longest word, so a
  // reference or a code is not broken across lines — the F&F sheet printed "PRPL/" over
  // "HR/2026-27/0009" — and never narrower than an equal share when its content fits in one,
  // so a short column does not wrap to make room for a long one that wraps happily anyway.
  const floors = Array.from({ length: count }, (_, i) =>
    Math.min(
      natural[i],
      Math.max(
        usable / count,
        ...rows.flatMap((r) =>
          (r[i] ?? '').split(/\s+/).map((word) => measure(word)),
        ),
      ),
    ),
  );
  // Too wide for the page: the widest columns give up the space, not every column in
  // proportion (2026-10-14). Shrunk proportionally, a work order's seven columns wrapped its
  // rates mid-figure — "4,850." over "00" — to make room for a description that would have
  // wrapped happily. Taking the excess off the top leaves the short columns their width.
  const widths = [...natural];
  let excess = total - usable;
  while (excess > 0.5) {
    const open = widths
      .map((w, i) => i)
      .filter((i) => widths[i] - floors[i] > 0.01);
    if (open.length === 0) break;
    const widest = Math.max(...open.map((i) => widths[i]));
    const top = open.filter((i) => widths[i] >= widest - 0.01);
    const next = Math.max(
      0,
      ...open.filter((i) => !top.includes(i)).map((i) => widths[i]),
    );
    // Bring the widest down towards the next widest or their own floor, whichever is nearer,
    // or by the whole excess if that is less.
    const step = Math.min(
      ...top.map((i) => widest - Math.max(next, floors[i])),
    );
    const cut = Math.min(step * top.length, excess);
    for (const i of top) widths[i] -= cut / top.length;
    excess -= cut;
  }
  // The floors themselves do not fit: every column gives up its share after all.
  const sum = widths.reduce((a, b) => a + b, 0);
  const scale = sum > usable ? usable / sum : 1;
  return widths.map((w) => w * scale + 2 * CELL_PAD);
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
  bottomLimit: number,
  faces: Faces,
): void {
  doc.fontSize(TABLE_SIZE);
  // Measured in the body face, with a margin for the bold heading row — measured exactly, a
  // heading like "S.No." broke over two lines in its own column.
  const widths = columnWidths(rows, (s) => doc.widthOfString(s) * 1.08);

  rows.forEach((row, rowIndex) => {
    const isHeading = headed && rowIndex === 0;
    doc.font(isHeading ? faces.bold : faces.regular);

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
        // "Rs. 20,000" is a figure too (2026-10-15): the appointment letter's annexure states its
        // amounts with the currency, as the client's own does.
        align:
          /^(Rs\.?)?[₹\s]*[\d,.\-()]+(\/-)?$/.test(cell ?? '') &&
          !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test((cell ?? '').trim())
            ? 'right'
            : 'left',
      });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  });
  doc.font(faces.regular).fontSize(BODY_SIZE);
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

    const files = letterFontFiles();
    let faces = FALLBACK;
    if (files) {
      doc.registerFont('Letter', files.regular);
      doc.registerFont('Letter-Bold', files.bold);
      faces = { regular: 'Letter', bold: 'Letter-Bold' };
    } else {
    }
    // The fallback face has no "₹": said in letters rather than printed as "¹".
    // A tick box is glued to its label (2026-10-15): "[ ] Pending  [ ] N/A" broke as "[ ]" at the
    // end of one line and "N/A" at the start of the next. No-break spaces inside the box and after
    // it keep "[ ] N/A" in one piece; the two spaces between boxes are where a line may break.
    const boxed = input.body.replace(
      /\[([ Xx])\] /g,
      (_, mark: string) => `[${mark === ' ' ? '\u00A0' : mark}]\u00A0`,
    );
    const bodyText = files ? boxed : boxed.replace(/₹\s?/g, 'Rs. ');
    doc.font(faces.regular);

    // Decoded **once** and drawn by reference on each page. Passing the buffer to
    // `doc.image()` per page makes pdfkit embed a fresh copy every time: a five-page
    // appointment letter on a 71 KB letterhead carried 355 KB of duplicate artwork, which
    // is most of the file. `openImage` registers it as one XObject that every page points
    // at — and it is also where a corrupt file throws, so the fallback lives here rather
    // than being retried per page.
    const open = (bytes: Buffer | null | undefined): unknown => {
      if (!bytes) return null;
      try {
        return doc.openImage(bytes);
      } catch {
        // Artwork pdfkit cannot decode must not lose the letter. It renders without it;
        // the words are the document.
        return null;
      }
    };
    const brand = input.brandHeader ?? null;
    const stationeryImage = brand ? null : open(input.letterhead);
    const logoImage: any = brand ? open(brand.logo) : null;

    // The clear band. Letterhead artwork reserves its own header and footer; a page that
    // prints its own header (the work order's logo band) only needs a margin, plus room at the
    // foot for the signing blocks when it carries them. Plain paper keeps the letterhead's
    // geometry, so a company that uploads one later does not see its letters reflow.
    const geometry = brand
      ? { top: 40, bottom: input.pageFooter ? 96 : 56 }
      : { top: SAFE.top, bottom: SAFE.bottom };
    const bottomLimit = PAGE.height - geometry.bottom;

    const stationery = () => {
      if (!stationeryImage) return;
      doc.image(stationeryImage, 0, 0, {
        width: PAGE.width,
        height: PAGE.height,
      });
    };

    const footer = () => {
      if (!input.pageFooter) return;
      const top = PAGE.height - geometry.bottom + 22;
      const half = CONTENT_WIDTH / 2;
      doc.font(faces.bold).fontSize(9).fillColor('#000000');
      doc.text(input.pageFooter.left, SAFE.left, top, { width: half - 10 });
      doc.text(input.pageFooter.right, SAFE.left + half, top, {
        width: half,
        align: 'right',
      });
      doc.font(faces.regular).fontSize(9);
      doc.text('Authorized Signatory', SAFE.left, top + 40, {
        width: half - 10,
      });
      doc.text('Authorized Signatory', SAFE.left + half, top + 40, {
        width: half,
        align: 'right',
      });
      doc.fontSize(BODY_SIZE);
    };

    const draftMark = () => {
      if (!input.draft) return;
      doc
        .save()
        .rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] })
        .font(faces.bold)
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
        .font(faces.regular)
        .fontSize(BODY_SIZE)
        .fillOpacity(1)
        .fillColor('#000000');
    };

    const newPage = () => {
      doc.addPage();
      stationery();
      footer();
      draftMark();
      doc.x = SAFE.left;
      doc.y = geometry.top;
    };

    newPage();

    if (brand) {
      // Logo on the left, the name and the registered office beside it, a rule under both —
      // the band the client's work order and purchase order open with.
      const top = doc.y;
      let textLeft = SAFE.left;
      let logoBottom = top;
      if (logoImage) {
        const scale = Math.min(120 / logoImage.width, 56 / logoImage.height);
        doc.image(logoImage, SAFE.left, top, {
          width: logoImage.width * scale,
          height: logoImage.height * scale,
        });
        textLeft = SAFE.left + logoImage.width * scale + 14;
        logoBottom = top + logoImage.height * scale;
      }
      const textWidth = SAFE.left + CONTENT_WIDTH - textLeft;
      doc
        .font(faces.bold)
        .fontSize(15)
        .fillColor('#000000')
        .text((brand.name ?? '').toUpperCase(), textLeft, top, {
          width: textWidth,
        });
      doc.font(faces.regular).fontSize(8.5);
      for (const line of brand.lines) {
        doc.text(line, textLeft, doc.y + 1, { width: textWidth });
      }
      const ruleAt = Math.max(doc.y, logoBottom) + 8;
      doc
        .lineWidth(1)
        .strokeColor('#333333')
        .moveTo(SAFE.left, ruleAt)
        .lineTo(SAFE.left + CONTENT_WIDTH, ruleAt)
        .stroke();
      doc.font(faces.regular).fontSize(BODY_SIZE).fillColor('#000000');
      doc.y = ruleAt + 12;
    }

    // The signature block's real height, for the page-break checks below (2026-10-15). The
    // graphic is capped at `SIGNATURE_MAX_HEIGHT`, but a wide, short scan is half that, and
    // reserving the cap pushed the offer letter's closing onto a third page of its own.
    // A signing block is drawn when somebody signs, or when the format always has one.
    const signed = Boolean(input.signature || input.signatureLines);
    const captionHeight = input.signatureLines
      ? input.signatureLines.length * (BODY_SIZE + 4)
      : 26;
    let signatureBlock = SIGNATURE_BLOCK;
    if (!input.signature && input.signatureLines) {
      signatureBlock = 18 + UNSIGNED_SPACE + captionHeight;
    } else if (input.signature) {
      let graphicHeight = 36; // the preview's "[Signature applied on issue]" line
      if (input.signature.image) {
        try {
          const graphic = doc.openImage(input.signature.image);
          graphicHeight =
            graphic.height *
              Math.min(
                SIGNATURE_WIDTH / graphic.width,
                SIGNATURE_MAX_HEIGHT / graphic.height,
              ) +
            6;
        } catch {
          graphicHeight = 16;
        }
      }
      signatureBlock = 18 + graphicHeight + captionHeight;
    }

    const blocks = parseBlocks(bodyText);
    const titleInBody = blocks.some((b) => b.kind === 'title');
    const drawTitle = () => {
      if (!input.title.trim()) return;
      doc.font(faces.bold).fontSize(13).text(input.title, SAFE.left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
        underline: true,
      });
      doc.font(faces.regular).fontSize(BODY_SIZE);
      doc.y += 14;
    };
    if (input.titleFirst && !titleInBody) drawTitle();

    // Reference and date on one line, as every document the client sent carries them.
    // Skipped entirely when neither is known, rather than printing an empty rule.
    if (input.referenceNo || input.issueDate) {
      doc.fontSize(BODY_SIZE).fillColor('#000000');
      const top = doc.y;
      if (input.referenceNo) {
        doc.text(
          `${input.referenceLabel ?? 'Ref. No.'}: ${input.referenceNo}`,
          SAFE.left,
          top,
          {
            width: CONTENT_WIDTH / 2,
            align: 'left',
          },
        );
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

    if (!input.titleFirst && !titleInBody) drawTitle();
    // Where the signature goes: at a `[[signature]]` marker, else after everything.
    let signatureAt = blocks.findIndex((b) => b.kind === 'signature');
    if (signatureAt < 0) signatureAt = blocks.length;

    // The closing line — "For Parth Realcon Private Limited" — belongs with the signature under
    // it. Rendered as part of the body, a long letter put the closing at the foot of one page and
    // the signature alone on the next (2026-10-14). So the last paragraph before the signature is
    // split off and moved over together with the signature when the two do not fit.
    let closing: string | null = null;
    const last = blocks[signatureAt - 1];
    if (signed && last?.kind === 'text') {
      const lines = [...last.lines];
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const breakAt = lines.map((l) => l.trim()).lastIndexOf('');
      const tail = lines.slice(breakAt + 1);
      if (tail.length > 0 && tail.length <= 3) {
        closing = tail.join('\n');
        last.lines = lines.slice(0, breakAt + 1);
      }
    }

    const drawBlock = (block: Block) => {
      if (block.kind === 'break') {
        newPage();
        return;
      }
      if (block.kind === 'signature') return;
      if (block.kind === 'title') {
        if (bottomLimit - doc.y < BODY_SIZE * 6) newPage();
        doc.y += 4;
        drawTitle();
        return;
      }
      if (block.kind === 'heading') {
        // A heading never ends a page: it moves over with at least two lines of what it heads.
        if (bottomLimit - doc.y < BODY_SIZE * 4) newPage();
        doc.y += 4;
        doc
          .font(faces.bold)
          .fontSize(BODY_SIZE)
          .text(block.text, SAFE.left, doc.y, { width: CONTENT_WIDTH });
        doc.font(faces.regular);
        doc.y += 3;
        return;
      }
      if (block.kind === 'table') {
        doc.y += 4;
        drawTable(doc, block.rows, block.headed, newPage, bottomLimit, faces);
        doc.y += 8;
        return;
      }
      // pdfkit paginates prose itself, but only against its own margins — which are zero
      // here — so the bottom limit is given explicitly and `height` makes it break rather
      // than run over the footer artwork.
      let remaining = block.lines.join('\n');
      while (remaining.length > 0) {
        const available = bottomLimit - doc.y;
        if (available < BODY_SIZE * 2) {
          newPage();
          continue;
        }
        const before = doc.y;
        // Measured first, then exactly that much drawn (2026-10-15). It used to draw the whole
        // remainder clipped to `height` and measure afterwards — but pdfkit's clipping and
        // `heightOfString` disagree by a line at the edge, so the last line on a page was printed
        // there *and* again at the top of the next: the appointment letter's clause 33 appeared
        // twice. What is drawn is now what was measured.
        const consumed = measureConsumed(doc, remaining, before, available);
        const piece = remaining.slice(0, consumed);
        // A page's last piece loses its trailing break; a block's own trailing blank lines are
        // its spacing and stay.
        const drawn =
          consumed < remaining.length ? piece.replace(/\s+$/, '') : piece;
        doc.text(drawn, SAFE.left, before, {
          width: CONTENT_WIDTH,
          align: 'left',
          lineGap: LINE_GAP,
        });
        if (consumed >= remaining.length) break;
        remaining = remaining.slice(consumed).replace(/^\s+/, '');
        newPage();
      }
    };

    blocks.slice(0, signatureAt).forEach(drawBlock);

    if (closing !== null) {
      const height = doc.heightOfString(closing, {
        width: CONTENT_WIDTH,
        lineGap: LINE_GAP,
      });
      // The blank line that separated it from the paragraph above, which the split took away.
      let gap = doc.currentLineHeight(true) + LINE_GAP;
      // Half the gap rather than a page holding nothing but the closing and the signature
      // (2026-10-15): the blank line is spacing, and a few points of it are not worth a page.
      if (bottomLimit - doc.y < gap + height + signatureBlock) gap /= 2;
      if (bottomLimit - doc.y < gap + height + signatureBlock) {
        newPage();
      } else {
        doc.y += gap;
      }
      const closingTop = doc.y;
      doc.text(closing, SAFE.left, closingTop, {
        width: CONTENT_WIDTH,
        align: 'left',
        lineGap: LINE_GAP,
      });
      if (input.acceptanceLabel) {
        // Level with the closing's last line — the "For <company>" the company signs under.
        const after = doc.y;
        doc
          .font(faces.bold)
          .text(
            input.acceptanceLabel,
            SAFE.left,
            after - doc.currentLineHeight(true) - LINE_GAP,
            { width: CONTENT_WIDTH, align: 'right' },
          );
        doc.font(faces.regular);
        doc.y = after;
      }
    }

    if (signed) {
      if (bottomLimit - doc.y < signatureBlock) newPage();
      doc.y += 18;
      const top = doc.y;
      const image = input.signature?.image ?? null;
      if (!input.signature) {
        // Nobody signs it here: the space is left for a hand signature.
        doc.y = top + UNSIGNED_SPACE;
      } else if (!image) {
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
      if (input.signatureLines) {
        // The format's own caption — "Authorized Signatory" — in place of name and title.
        input.signatureLines.forEach((line, i) => {
          doc
            .fontSize(BODY_SIZE)
            .font(i === 0 ? faces.bold : faces.regular)
            .text(line, SAFE.left, doc.y, { width: CONTENT_WIDTH });
        });
        doc.font(faces.regular);
      } else if (input.signature) {
        doc
          .fontSize(BODY_SIZE)
          .font(faces.bold)
          .text(input.signature.name, SAFE.left, doc.y, {
            width: CONTENT_WIDTH,
          });
        doc
          .font(faces.regular)
          .fontSize(9)
          .text(input.signature.title, SAFE.left, doc.y, {
            width: CONTENT_WIDTH,
          });
      }
      doc.fontSize(BODY_SIZE);
      doc.y += 10;
    }

    // Whatever follows the signature — the vendor's acceptance, an annexure.
    blocks.slice(signatureAt + 1).forEach(drawBlock);

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
