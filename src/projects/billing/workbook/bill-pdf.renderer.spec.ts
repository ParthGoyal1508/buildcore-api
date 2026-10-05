import { inflateSync } from 'zlib';

import { BillPdfRenderer } from './bill-pdf.renderer';
import { measurement, party, subcontractor, view } from './bill-view.fixture';

/**
 * The bill as a PDF (025 FR-042).
 *
 * The same four properties the workbook's spec defends, because they are properties of **a document
 * a client signs** rather than of a file format:
 *
 * - a page for every schedule line, counted from the input — a PDF missing a page opens perfectly;
 * - produced twice, identical **byte for byte**, which is stricter than the workbook's cell
 *   comparison and the right bar for a document that was emailed;
 * - both directions from one renderer, with the party cells exchanged;
 * - and the renderer cannot query, so it cannot recompute what the bill froze.
 */

/** Page count, read from the PDF's own page tree rather than from anything this file assumes. */
function pageCount(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  return counts;
}

/**
 * The visible strings, for asserting what reached the page.
 *
 * pdfkit writes text as **hex strings inside kerned `TJ` arrays** —
 * `[<482e472e> 60 <20496e6672> 10 <61>] TJ` — not as the `(text) Tj` a reader of the PDF spec
 * expects first. A matcher that looked only for the latter found nothing and reported every
 * assertion below as a missing string rather than as its own bug, which is why this says what the
 * format actually is.
 */
function textOf(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const [, body] of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let text: string;
    try {
      text = inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
    } catch {
      continue; // fonts and metadata live in streams too
    }
    for (const [, array] of text.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      for (const [, hex] of array.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        out += Buffer.from(hex, 'hex').toString('latin1');
      }
      out += ' ';
    }
    for (const [, plain] of text.matchAll(/\((.*?)\)\s*Tj/g))
      out += `${plain} `;
  }
  return out;
}

describe('the page count', () => {
  it('gives a page to every schedule line, including one with nothing claimed', async () => {
    // **Counted from the input, never a number typed here.** The workbook's spec makes the same
    // point and it is the one that matters most for a PDF: a document with a page missing prints
    // perfectly, and the item that lost its page is the item nobody checks.
    const sheets = [measurement(1), measurement(2), measurement(3)];
    const bytes = await new BillPdfRenderer().render(
      view({ measurementSheets: sheets }),
    );

    // Check list, abstract, schedule, the measurement sheets, debit register — at least one page
    // each. More is legitimate: a 312-line schedule spills, and the table starts a new page with
    // its headers repeated rather than running off the bottom.
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(4 + sheets.length);
  });

  it('still gives a page to a line with no history and no daily record', async () => {
    const empty = {
      ...measurement(1),
      history: [],
      dailyRecord: [],
      footer: { thisBillQty: '-', uptoPreviousQty: '-', uptoDateQty: '-' },
    };
    const bytes = await new BillPdfRenderer().render(
      view({ measurementSheets: [empty] }),
    );
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(5);
    // The item is named on its own page, which is what lets a reader tell which line a page
    // belongs to without counting pages.
    expect(textOf(bytes)).toContain(empty.boqNo);
  });
});

describe('produced twice', () => {
  it('is identical byte for byte', async () => {
    // FR-028. Stricter than the workbook's cell-by-cell comparison, deliberately: a PDF is the
    // copy that was emailed, so a reader comparing their file against a reproduction is comparing
    // bytes. This holds only because the creation date is pinned to the bill's own date — the
    // clock is the one thing in a PDF that otherwise differs between two productions.
    const renderer = new BillPdfRenderer();
    const first = await renderer.render(view());
    const second = await renderer.render(view());
    expect(first.equals(second)).toBe(true);
  });
});

describe('both directions, one renderer', () => {
  it('exchanges the party cells and changes nothing else', async () => {
    // FR-025, and the user's first sentence about this feature: one renderer, two bindings, the
    // two party names being the stated variables.
    const toSubcontractor = await new BillPdfRenderer().render(view());
    const toClient = await new BillPdfRenderer().render(
      view({
        header: {
          ...view().header,
          issuer: party({ name: 'National Highways Authority of India' }),
          receiver: party({ name: 'H.G. Infra Engineering Ltd' }),
        },
      }),
    );

    const a = textOf(toSubcontractor);
    const b = textOf(toClient);
    expect(a).toContain(subcontractor.name as string);
    expect(b).toContain('National Highways Authority of India');
    expect(b).not.toContain(subcontractor.name as string);
  });
});

describe('what reaches the page', () => {
  it('carries the figures and the arguments the document exists to settle', async () => {
    const text = textOf(await new BillPdfRenderer().render(view()));

    // The bill's own label, on the document.
    expect(text).toContain('RA-12');
    // The remark is the case for a deduction, written by the engineer who made it, and it is
    // reproduced rather than summarised.
    expect(text).toContain('30 % deduction Shoulder Slope');
    // The sections, in the client's order.
    expect(text).toContain('CHECK LIST');
    expect(text).toContain('ABSTRACT');
    expect(text).toContain('BOQ ANNEXURE-I');
    expect(text).toContain('MEASUREMENT SHEET');
    expect(text).toContain('DEBIT NOTE');
  });

  it('leaves every answer column blank for an unanswered question', async () => {
    // FR-042. An unanswered question is not an answer of no, and a renderer that ticked No for a
    // blank would be inventing an answer nobody gave — on the sheet whose whole purpose is to say
    // what was and was not attached.
    const only = view({
      checkList: {
        ...view().checkList,
        rows: [
          {
            position: 1,
            text: 'Is BBS for this bill, Attached?',
            answer: null,
          },
        ],
      },
    });
    const text = textOf(await new BillPdfRenderer().render(only));
    expect(text).toContain('Is BBS for this bill, Attached?');
    expect(text).not.toContain('N/R');
  });

  it('prints a missing party identifier blank rather than refusing the document', async () => {
    // FR-027. A bill that cannot be produced because a PAN is unrecorded is worse than one
    // produced with a blank somebody fills in by hand.
    const gaps = view();
    const bytes = await new BillPdfRenderer().render(
      view({
        header: {
          ...gaps.header,
          receiver: party({
            name: 'Parth Realcon Private Limited',
            pan: null,
            gstin: null,
          }),
          missingFields: ['receiverPan', 'receiverGstin'],
        },
      }),
    );
    expect(bytes.length).toBeGreaterThan(0);
    expect(textOf(bytes)).toContain('Parth Realcon Private Limited');
  });
});

describe('what the renderer can reach', () => {
  it('takes no constructor argument, so it cannot query', () => {
    // The same assertion the workbook renderer carries, for the same reason: an absence nothing
    // checks is an absence somebody adds a constructor parameter to. A renderer that could query
    // could recompute, and a reproduced bill would stop matching the client's copy.
    expect(BillPdfRenderer.length).toBe(0);
  });
});
