import type { WorkbookHeader } from './bill-workbook.types';

/**
 * One row of the signature block: two captions over a space left for a pen, and the two
 * designations printed under that space.
 */
export interface SignatureRow {
  left: { caption: string; signatory: string };
  right: { caption: string; signatory: string };
}

/**
 * The sign-off printed under a **subcontractor's** bill abstract (2026-10-14).
 *
 * Copied from the client's own format, the one a main contractor prints on the bills it raises on
 * us when *we* are the subcontractor:
 *
 *     Prepared by          Checked by
 *     (space to sign)
 *     Site Engineer        Site In-charge
 *     Accepted by          Approved by
 *     (space to sign)
 *     <subcontractor>      Project head
 *
 * "Accepted by" is the subcontractor accepting the measured bill, so the name under it is the
 * **receiver's** — the party in the "Name of Sub-Contractor" slot — and not a designation of ours.
 * Where that party's name is unrecorded it falls back to "Sub-Contractor" rather than printing a
 * blank: a blank under a signature line reads as "anyone", and the one person this line is for is
 * known by role even when their record is incomplete.
 *
 * A bill to the client gets the same four captions with no designations under them (2026-10-15).
 * An absent direction reads as a subcontractor's, the rule `WorkbookHeader.direction` already
 * states, so a view built before the field existed still gets its sign-off.
 *
 * One function, read by the PDF, the Word copy and the workbook, so the three cannot disagree on
 * who signs where — the same reason they share `headerPairs`.
 */
export function billSignatures(header: WorkbookHeader): SignatureRow[] {
  // The client's bill carries the same four captions (2026-10-15) — the client: "We need to give
  // these as well in the PDF". The Word copy always printed them; the PDF and the workbook printed
  // none. No designations under them: on the authority's bill the signatories are theirs to write.
  if (header.direction === 'to_client') {
    return [
      {
        left: { caption: 'Prepared by', signatory: '' },
        right: { caption: 'Checked by', signatory: '' },
      },
      {
        left: { caption: 'Accepted by', signatory: '' },
        right: { caption: 'Approved by', signatory: '' },
      },
    ];
  }
  const subcontractor = header.receiver.name?.trim() || 'Sub-Contractor';
  return [
    {
      left: { caption: 'Prepared by', signatory: 'Site Engineer' },
      right: { caption: 'Checked by', signatory: 'Site In-charge' },
    },
    {
      left: { caption: 'Accepted by', signatory: subcontractor },
      right: { caption: 'Approved by', signatory: 'Project head' },
    },
  ];
}
