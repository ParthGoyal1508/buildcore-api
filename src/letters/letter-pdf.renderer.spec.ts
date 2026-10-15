import { readFileSync } from 'fs';
import { join } from 'path';

import {
  columnWidths,
  formatLetterDate,
  parseBlocks,
  renderLetterPdf,
} from './letter-pdf.renderer';

/**
 * The letter renderer (2026-10-11).
 *
 * ## What these assert, and the vacuity each avoids
 *
 * **The letterhead.** Asserting that `renderLetterPdf` returned bytes passes against a
 * renderer that ignores the artwork entirely — the old one did exactly that, for a year,
 * while `letterheadAssetId` sat in the database being written and never read. So the test
 * compares two renders of the same letter and requires the one with stationery to be
 * materially larger, and separately requires the JPEG's own marker bytes to appear in the
 * output. A PDF embeds a JPEG by copying its compressed data in whole; if the image were
 * dropped, that run of bytes would not be there.
 *
 * **The table.** Asserting that a body containing pipes renders passes against a renderer
 * that prints the pipes as text. `parseBlocks` is tested directly on its structure, and the
 * rendered output is required *not* to contain the separator row, because the one thing a
 * literal renderer certainly would print is a row of dashes.
 *
 * **Pagination.** The appointment letter is fourteen thousand characters. A renderer that
 * silently truncated at one page would satisfy every other assertion here, so the long-body
 * test counts pages and requires more than one.
 */

/**
 * The stand-in letterhead these tests render with.
 *
 * **A fixture in the repository, not the client's artwork in `docs/`.** This read used to
 * reach `docs/Parth_Realcon.jpeg`, which is not committed — so the whole suite failed to
 * run on CI with `ENOENT`, and 2,053 passing tests reported as a red build. It passed
 * locally for the obvious reason: the file is on the machine it was written on.
 *
 * Skipping when the file is absent is the other convention here (`boq-import.service.spec.ts`
 * does exactly that) and is wrong for this one: these assertions exist because the renderer
 * ignored the artwork entirely for a year, and a test that stands down on CI is a test that
 * is absent from the only place a regression would be caught.
 *
 * Synthetic, and portrait at A4 proportions, which is what the three tests below need
 * between them: real bytes to find inside the PDF, enough of them that "the document grew
 * by the artwork" means something, and a graphic taller than it is wide for the signature
 * letterboxing. Generated once from seeded noise over a gradient — noise so the run taken
 * from its middle is distinctive rather than the quantisation tables every JPEG shares.
 */
const LETTERHEAD = join(__dirname, '__fixtures__', 'letterhead.jpg');

/** Pages, counted off the PDF's own page objects. */
const pageCount = (pdf: Buffer): number =>
  pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

describe('letter PDF renderer', () => {
  describe('pipe tables in the body', () => {
    it('reads a table out of the body and drops the separator row', () => {
      const blocks = parseBlocks(
        'Dear Sir,\n\n| Head | Monthly |\n| --- | --- |\n| Basic | 20,000 |\n\nRegards.',
      );
      expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text']);
      const table = blocks[1];
      if (table.kind !== 'table') throw new Error('expected a table');
      // Two rows, not three: the `---` row says the first row is a heading, it is not
      // itself content, and a renderer that kept it prints a row of dashes.
      expect(table.rows).toEqual([
        ['Head', 'Monthly'],
        ['Basic', '20,000'],
      ]);
    });

    it('leaves a line that merely contains a pipe as prose', () => {
      // "Phone | Email" appears in the footer wording of the client's own offer letter.
      // Treating it as a table would silently restructure the sentence.
      const blocks = parseBlocks(
        'Contact us on 01434 294329 | info@example.com',
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe('text');
    });

    it('does not print the separator row into the document', async () => {
      const pdf = await renderLetterPdf({
        title: 'ANNEXURE',
        body: '| Head | Monthly |\n| --- | --- |\n| Basic | 20,000 |',
        letterhead: null,
      });
      // pdfkit writes text into a compressed stream, so the glyphs are not greppable.
      // What is checkable is that a second separator changes nothing: against a literal
      // renderer each one adds a line of dashes and the page grows. (Compared with a
      // second separator rather than none, because the first one also makes the first
      // row a bold heading, which legitimately changes the bytes.)
      const doubleSeparator = await renderLetterPdf({
        title: 'ANNEXURE',
        body: '| Head | Monthly |\n| --- | --- |\n| --- | --- |\n| Basic | 20,000 |',
        letterhead: null,
      });
      expect(pdf.length).toBe(doubleSeparator.length);
    });

    it('treats the first row as a heading only when a separator follows it', () => {
      // The F&F sheet and the payment advice are label / value grids with no heading
      // row; bolding their first label made one arbitrary row look like a heading.
      const [headed] = parseBlocks(
        '| Head | Monthly |\n| --- | --- |\n| Basic | 1 |',
      );
      const [plain] = parseBlocks('| Employee | Ravi |\n| Code | PR-1 |');
      expect(headed).toMatchObject({ kind: 'table', headed: true });
      expect(plain).toMatchObject({ kind: 'table', headed: false });
    });
  });

  describe('the company letterhead', () => {
    const artwork = readFileSync(LETTERHEAD);

    it('embeds the stationery in the document', async () => {
      const letter = {
        title: 'OFFER LETTER',
        body: 'Dear Sir,\n\nWe are pleased to offer you the post.',
      };
      const plain = await renderLetterPdf({ ...letter, letterhead: null });
      const headed = await renderLetterPdf({ ...letter, letterhead: artwork });

      // Measured against the artwork's own size rather than a fixed threshold: a renderer
      // that accepted the buffer and discarded it — the behaviour before this change —
      // produces a document the same size as the plain one, whatever the artwork weighs.
      // A hardcoded 50 KB was a statement about one particular file and silently became
      // wrong the moment the file did.
      expect(headed.length).toBeGreaterThan(
        plain.length + artwork.length * 0.8,
      );

      // And it is *this* image, not some image: a PDF stores a JPEG by copying its
      // compressed scan data verbatim, so a distinctive run from the middle of the file
      // appears in the output.
      const fingerprint = artwork.subarray(
        Math.floor(artwork.length / 2),
        Math.floor(artwork.length / 2) + 64,
      );
      expect(headed.includes(fingerprint)).toBe(true);
    });

    it('renders on plain paper rather than failing when the artwork will not decode', async () => {
      // Losing the letterhead file must not make a company's letters unissuable. The
      // words are the document; the stationery is how it is printed.
      const pdf = await renderLetterPdf({
        title: 'OFFER LETTER',
        body: 'Dear Sir,\n\nWe are pleased to offer you the post.',
        letterhead: Buffer.from('this is not an image'),
      });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pageCount(pdf)).toBe(1);
    });

    it('puts the stationery on every page, not only the first', async () => {
      const long = 'This clause governs your employment. '.repeat(400);
      const pdf = await renderLetterPdf({
        title: 'APPOINTMENT LETTER',
        body: long,
        letterhead: artwork,
      });
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThan(1);

      const raw = pdf.toString('latin1');
      // The artwork is embedded **once** — one JPEG stream — and each page's resource
      // dictionary names it. So the right count for "every page" is the references, not
      // the copies, and asserting one copy at the same time is what stops a regression
      // back to re-embedding it per page (the client's 71 KB letterhead × 5 pages was
      // most of the file before `openImage`).
      expect(raw.match(/\/DCTDecode/g)?.length).toBe(1);
      expect(raw.match(/\/I\d+/g)?.length).toBe(pages);
    });
  });

  describe('the signature block', () => {
    it('letterboxes a tall graphic instead of letting it run down the page', async () => {
      // The signature is drawn from whatever the signatory uploaded, and a portrait scan
      // used to be drawn at its own aspect ratio while the cursor advanced by a fixed
      // 46pt — so the name printed across the middle of the image and the graphic ran
      // into the footer. Capping the height is what prevents that, and the observable
      // consequence is that a tall graphic does not cost an extra page.
      const tall = readFileSync(LETTERHEAD); // 413 × 584 — taller than it is wide.
      const pdf = await renderLetterPdf({
        title: 'RELIEVING LETTER',
        body: 'This is to certify that he worked here.\n\nFor the company',
        letterhead: null,
        signature: {
          image: tall,
          name: 'S. V. K. Jain',
          title: 'Authorised Signatory',
        },
      });
      expect(pageCount(pdf)).toBe(1);
    });
  });

  describe('the long documents the client actually sends', () => {
    it('paginates a fourteen-thousand-character appointment letter instead of truncating', async () => {
      // Their appointment letter is 14,165 characters. A renderer that wrote one page and
      // dropped the rest would pass every other test in this file.
      const body = Array.from(
        { length: 60 },
        (_, i) =>
          `${
            i + 1
          }. You shall perform all duties assigned to you by the management, ` +
          'and shall not engage in any other business or occupation during your ' +
          'employment with the company.',
      ).join('\n\n');
      const pdf = await renderLetterPdf({
        title: 'APPOINTMENT LETTER',
        body,
        letterhead: null,
      });
      expect(pageCount(pdf)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('the heading', () => {
    it('reads a [[title]] marker as where the heading goes', () => {
      // The relieving letter prints its heading under the name and project lines (2026-10-15).
      const blocks = parseBlocks('Name: - A\nProject: - B\n[[title]]\nDear A');
      expect(blocks.map((b) => b.kind)).toEqual(['text', 'title', 'text']);
    });

    it('renders a format with no heading, and one with it above the reference', async () => {
      for (const input of [
        { title: '' },
        { title: 'TRANSFER LETTER', titleFirst: true },
      ]) {
        const pdf = await renderLetterPdf({
          ...input,
          body: 'Dear A,\n\nBody.',
          letterhead: null,
          referenceNo: 'PRPL/HR/2026-27/0001',
          issueDate: '15/10/2026',
        });
        expect(pageCount(pdf)).toBe(1);
      }
    });
  });

  describe('the date a letter bears', () => {
    it('writes the day first, as the client’s own documents do', () => {
      // 16/09/2026, not 09/16/2026. Their appointment letter carries the first form, and
      // a locale-formatted date reads as a different month on a machine set to en-US.
      expect(formatLetterDate(new Date(2026, 8, 16))).toBe('16/09/2026');
    });
  });

  describe('signing blocks and narrow columns (2026-10-15)', () => {
    it('closes with a signing block when the format has one and nobody signs it here', async () => {
      // The appointment, experience and relieving letters went out with no signing block at
      // all: their kinds were unsigned, and the renderer drew a block only for a signatory.
      const body = 'We wish you well.\n\nFor Dummy Test Firm';
      const bare = await renderLetterPdf({
        title: 'X',
        body,
        letterhead: null,
      });
      const withBlock = await renderLetterPdf({
        title: 'X',
        body,
        letterhead: null,
        signatureLines: ['Authorized Signatory'],
      });
      expect(withBlock.length).toBeGreaterThan(bare.length);
    });

    it('embeds a face with the rupee sign rather than falling back to Helvetica', async () => {
      const pdf = await renderLetterPdf({
        title: 'X',
        body: 'Your CTC will be ₹55,000/-.',
        letterhead: null,
      });
      expect(pdf.toString('latin1')).toMatch(
        /\/FontFile2|\/FontFile3|\/FontFile /,
      );
      expect(pdf.toString('latin1')).not.toContain('/BaseFont /Helvetica');
    });

    it('does not narrow a column below its longest word to make room for a long one', () => {
      // The F&F header broke its reference as "PRPL/" over "HR/2026-27/0009".
      const measure = (text: string) => text.length * 5;
      const rows = [
        [
          'F&F Ref. No.: PRPL/HR/2026-27/0009',
          'Date: 15/10/2026',
          'Project / Site: ' + 'Construction of New School Building '.repeat(4),
          'Cost Centre: CC-PRJ-DABLA',
        ],
      ];
      const widths = columnWidths(rows, measure);
      expect(widths[0] - 10).toBeGreaterThanOrEqual(
        measure('PRPL/HR/2026-27/0009'),
      );
      expect(widths[3] - 10).toBeGreaterThanOrEqual(measure('CC-PRJ-DABLA'));
      expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        595.28 - 112 + 0.01,
      );
    });
  });
});
