/**
 * How each commercial document is laid out, beyond its body (2026-10-14).
 *
 * The client's formats differ in their furniture, not only their words: the LOI is written on
 * the letterhead, while the work order and purchase order open with the logo and name instead;
 * the work order carries both parties' signing blocks at the foot of every page; and each calls
 * its reference by its own name. Kept in code beside the shipped wording rather than in a column
 * nobody edits, for the same reason the wording is locked.
 */
export interface LetterLayout {
  /** The heading. Empty for a format that has none — the increment and termination letters. */
  title: string;
  referenceLabel: string;
  brandHeader: boolean;
  pageFooter?: (variables: Record<string, string>) => {
    left: string;
    right: string;
  };
  /**
   * The heading above the reference and date rather than below them (2026-10-15). The offer,
   * appointment and transfer letters open with their title; the experience letter puts it under
   * the reference line. A body can also place it itself with `[[title]]` — the relieving letter
   * prints it under the employee's name and project.
   */
  titleFirst?: boolean;
  /**
   * A label printed opposite the company's closing line, for the recipient to sign over — the
   * offer letter's "Employee Signature" beside "For Parth Realcon Private Limited" (2026-10-15).
   */
  acceptanceLabel?: string;
  /**
   * The reference and date are cells of the body's own first table, not a line the renderer
   * prints (2026-10-15). The F&F sheet's header row is "F&F Ref. No. | Date | Project / Site |
   * Cost Centre"; printed twice as well, the sheet would carry two dates.
   */
  referenceInBody?: boolean;
}

export const LETTER_LAYOUTS: Record<string, LetterLayout> = {
  letter_loi: {
    title: 'LETTER OF INTENT (LOI)',
    referenceLabel: 'LOI No.',
    brandHeader: false,
  },
  letter_work_order: {
    title: 'WORK ORDER',
    referenceLabel: 'WO No.',
    brandHeader: true,
    pageFooter: (variables) => ({
      left: `For ${variables.companyName ?? ''}`.trim(),
      right: `For M/s ${variables.vendorName ?? ''}`.trim(),
    }),
  },
  letter_purchase_order: {
    title: 'PURCHASE ORDER',
    referenceLabel: 'PO No.',
    brandHeader: true,
  },

  // The HR documents (2026-10-15), each laid out as its own Word format in `docs/HR_DOCS/`. All but
  // the F&F sheet are written on the letterhead — the Word files carry the letterhead's header and
  // footer artwork; the sheet's header is "Company Logo … Company Name".
  offer: {
    title: 'OFFER LETTER',
    referenceLabel: 'REF No',
    brandHeader: false,
    titleFirst: true,
    acceptanceLabel: 'Employee Signature',
  },
  appointment: {
    title: 'APPOINTMENT LETTER',
    referenceLabel: 'Ref No.',
    brandHeader: false,
    titleFirst: true,
  },
  // "Experience Letter (1).docx" is headed *Relieving Letter* — the heading of the file it was
  // copied from. It is issued as the experience letter, and is titled as one.
  experience: {
    title: 'Experience Letter',
    referenceLabel: 'Ref. No.',
    brandHeader: false,
  },
  // Placed by the body's `[[title]]`, under the name and project lines, as the format has it.
  relieving: {
    title: 'Relieving Letter',
    referenceLabel: 'Ref. No.',
    brandHeader: false,
  },
  // Neither format has a heading: the subject line says what the letter is.
  increment: { title: '', referenceLabel: 'Ref', brandHeader: false },
  termination: { title: '', referenceLabel: 'Ref No.', brandHeader: false },
  transfer: {
    title: 'TRANSFER LETTER',
    referenceLabel: 'Ref No.',
    brandHeader: false,
    titleFirst: true,
  },
  fnf_settlement: {
    title: 'FULL & FINAL (F&F) SETTLEMENT SHEET',
    referenceLabel: 'F&F Ref. No.',
    brandHeader: true,
    titleFirst: true,
    referenceInBody: true,
  },
};
