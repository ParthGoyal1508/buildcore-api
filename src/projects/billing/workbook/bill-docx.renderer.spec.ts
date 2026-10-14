import { inflateRawSync } from 'zlib';

import { BillDocxRenderer } from './bill-docx.renderer';
import { BillPdfRenderer } from './bill-pdf.renderer';
import { party, subcontractor, view } from './bill-view.fixture';
import { headerPairs } from './header-pairs';

/** The bill as Word, and the client's Payment Abstract alone (2026-10-13). */

/**
 * The visible text of a .docx's body, read straight out of the zip (2026-10-14).
 *
 * A .docx is a zip whose `word/document.xml` holds the text in `<w:t>` runs. The local file header
 * carries the entry's compressed size, so the entry can be inflated without a zip library this
 * repository does not otherwise depend on.
 */
function docxText(bytes: Buffer): string {
  let offset = 0;
  while ((offset = bytes.indexOf('PK\x03\x04', offset, 'latin1')) !== -1) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString('latin1');
    const start = offset + 30 + nameLength + extraLength;
    if (name === 'word/document.xml') {
      const body = bytes.subarray(start, start + size);
      const xml = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
      return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map(([, text]) => text)
        .join(' ');
    }
    offset = start;
  }
  throw new Error('no word/document.xml in the .docx');
}

describe('the bill as a Word document', () => {
  const renderer = new BillDocxRenderer();

  it('writes a .docx', async () => {
    const bytes = await renderer.render(view());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
  });

  it('writes the abstract alone, smaller than the whole bill', async () => {
    const whole = await renderer.render(view());
    const abstract = await renderer.render(view(), { abstractOnly: true });
    expect(abstract.length).toBeLessThan(whole.length);
  });
});

describe('the abstract alone as a PDF', () => {
  it('is one page where the bill is several', async () => {
    const pdf = new BillPdfRenderer();
    const whole = (await pdf.render(view())).toString('latin1');
    const abstract = (
      await pdf.render(view(), { abstractOnly: true })
    ).toString('latin1');
    const pages = (text: string) =>
      (text.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages(abstract)).toBe(1);
    expect(pages(whole)).toBeGreaterThan(1);
  });
});

describe('the bill header, in the direction’s own words', () => {
  it('heads a bill to the client with the authority and the bidder', () => {
    const v = view();
    const [left] = headerPairs({ ...v.header, direction: 'to_client' });
    expect(left.map(([label]) => label)).toEqual([
      'Authority',
      'Name of Work',
      'Contract No.',
      'Bidder Name',
      'Bill Period',
    ]);
  });

  it('heads a subcontractor’s with the sub-contractor and vendor code', () => {
    const [left] = headerPairs(view().header);
    expect(left.map(([label]) => label)).toContain('Name of Sub-Contractor');
    expect(left.map(([label]) => label)).toContain('Vendor Code');
  });
});

describe('the sign-off under a Word abstract (2026-10-14)', () => {
  const renderer = new BillDocxRenderer();
  const textFor = async (header: Partial<ReturnType<typeof view>['header']>) =>
    docxText(
      await renderer.render(view({ header: { ...view().header, ...header } }), {
        abstractOnly: true,
      }),
    );

  it('prints the client’s block on a subcontractor’s bill, the subcontractor accepting', async () => {
    const text = await textFor({ direction: 'to_subcontractor' });
    const order = [
      'Prepared by',
      'Checked by',
      'Site Engineer',
      'Site In-charge',
      'Accepted by',
      'Approved by',
      subcontractor.name as string,
      'Project head',
    ];
    const tail = text.slice(text.indexOf('Prepared by'));
    let from = 0;
    for (const word of order) {
      const at = tail.indexOf(word, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at;
    }
  });

  it('falls back to "Sub-Contractor" where the receiver is unnamed', async () => {
    const text = await textFor({
      direction: 'to_subcontractor',
      receiver: party({ name: null }),
    });
    expect(text).toContain('Sub-Contractor');
  });

  it('leaves a bill to the client as it was — captions only', async () => {
    const text = await textFor({ direction: 'to_client' });
    expect(text).toContain('Prepared by');
    expect(text).toContain('Approved by');
    expect(text).not.toContain('Site Engineer');
    expect(text).not.toContain('Project head');
  });
});
