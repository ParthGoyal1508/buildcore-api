import { createHash } from 'crypto';

import { LETTER_LAYOUTS } from '../../letters/letter-layouts';
import { renderLetterPdf } from '../../letters/letter-pdf.renderer';
import { presentLetterValues } from '../../letters/letter-values';
import { expandLineItems } from '../../letters/line-items';
import { standardTemplateFor } from '../../letters/standard-letter-templates';
import { renderTemplate } from '../../letters/template-resolver';

/**
 * The purchase order, exactly as it prints today (036 M9, 2026-10-17).
 *
 * The client's decision on structured POs: "We want to keep the same format which is there as of
 * now, just make it structured so that we can trace everything. DO NOT CHANGE the PO format." So
 * the structure (PO lines in `inventory`, purchases linked to them, the ordered / received / billed
 * / paid trace) is built *behind* the letter, and this test is the fence around the letter itself.
 *
 * **Captured before any M9 change, and never re-recorded for M9.** It renders the shipped purchase
 * order template the way `LettersService.renderDocument` does — the body through the same token
 * substitution, value presentation and line-item expansion, the layout's title and reference label,
 * then the PDF through the same renderer — from a fixed composition shaped like the one the
 * composer sends (lines `CODE - Name | Unit | Qty | Rate`, as `line-items-editor.tsx` serialises an
 * item-master row). If any of the three snapshots below changes, the printed PO changed: that is a
 * product decision, not a snapshot to update.
 *
 * The PDF is compared by a hash of its bytes with pdfkit's two per-run fields — the creation date
 * and the document id — blanked, so the hash moves only when something drawn on the page does.
 */
const COMPOSITION: Record<string, string> = {
  vendorName: 'Dummy Cement Supplier Test Firm',
  vendorAddress: '12 Industrial Area, Jaipur, Rajasthan - 302001',
  vendorCode: 'VEN-0007',
  vendorAttention: 'R. Sharma, 9800000000',
  buyerName: 'Dummy Buyer',
  buyerMobile: '9811111111',
  buyerEmail: 'buyer@example.com',
  companyGstin: '08ABCDE1234F1Z5',
  deliveryAddress: 'Site store, Plot 4, Sitapura, Jaipur',
  paymentTerms: '30 days from receipt of material',
  deliveryTerms: 'FOR site',
  poProject: 'Dummy Tower Project',
  warrantyFromDispatch: '18 months',
  warrantyFromCommissioning: '12 months',
  lineItems: [
    'CEM-001 - Cement OPC 53 | BAG | 100 | 410',
    'STL-012 - TMT Bar 12 mm | KG | 2500.5 | 62.75',
    'SND-001 - River sand | CUM | 12 | 1850',
  ].join('\n'),
  gstRate: '18',
  companyName: 'Dummy Builders Test Firm',
};

const KIND = 'letter_purchase_order';
const ISSUE_DATE = '17-10-2026';
const REFERENCE = 'DBT/2026-27/0042';

function body(): string {
  const template = standardTemplateFor(KIND);
  if (!template) throw new Error('the purchase order template is not shipped');
  return renderTemplate(template.body, {
    issueDate: ISSUE_DATE,
    referenceNo: REFERENCE,
    ...presentLetterValues(KIND, COMPOSITION),
    ...expandLineItems(KIND, COMPOSITION),
  });
}

/** The PDF with pdfkit's per-run creation date and document id blanked. */
function stableBytes(pdf: Buffer): string {
  return pdf
    .toString('latin1')
    .replace(/\(D:\d{14}Z\)/g, '(D:)')
    .replace(/\/ID \[[^\]]*\]/g, '/ID []');
}

describe('purchase order document (036 M9 format fence)', () => {
  it('prints the same body', () => {
    expect(body()).toMatchSnapshot();
  });

  it('prints under the same layout', () => {
    const layout = LETTER_LAYOUTS[KIND];
    expect({
      title: layout.title,
      referenceLabel: layout.referenceLabel,
      brandHeader: layout.brandHeader,
      titleFirst: layout.titleFirst ?? null,
      referenceInBody: layout.referenceInBody ?? null,
      pageFooter: layout.pageFooter?.(COMPOSITION) ?? null,
      signatureLines: layout.signatureLines?.(null) ?? null,
      acceptanceLabel: layout.acceptanceLabel ?? null,
    }).toMatchSnapshot();
  });

  it('renders the same PDF', async () => {
    const layout = LETTER_LAYOUTS[KIND];
    const render = () =>
      renderLetterPdf({
        title: layout.title,
        body: body(),
        letterhead: null,
        brandHeader: {
          logo: null,
          name: 'Dummy Builders Test Firm',
          lines: ['1 Test Road, Jaipur', 'info@example.com'],
        },
        referenceLabel: layout.referenceLabel,
        referenceNo: REFERENCE,
        issueDate: ISSUE_DATE,
        signature: { image: null, name: 'Dummy Signatory', title: 'Director' },
      });
    const first = stableBytes(await render());
    // Deterministic once the per-run fields are blanked — otherwise the hash below proves nothing.
    expect(stableBytes(await render())).toBe(first);
    expect(
      createHash('sha256').update(first, 'latin1').digest('hex'),
    ).toMatchSnapshot();
  });
});
