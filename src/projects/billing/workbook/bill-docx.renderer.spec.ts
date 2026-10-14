import { BillDocxRenderer } from './bill-docx.renderer';
import { BillPdfRenderer } from './bill-pdf.renderer';
import { view } from './bill-view.fixture';
import { headerPairs } from './header-pairs';

/** The bill as Word, and the client's Payment Abstract alone (2026-10-13). */

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
