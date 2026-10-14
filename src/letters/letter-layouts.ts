/**
 * How each commercial document is laid out, beyond its body (2026-10-14).
 *
 * The client's formats differ in their furniture, not only their words: the LOI is written on
 * the letterhead, while the work order and purchase order open with the logo and name instead;
 * the work order carries both parties' signing blocks at the foot of every page; and each calls
 * its reference by its own name. Kept in code beside the shipped wording rather than in a column
 * nobody edits, for the same reason the wording is locked.
 */
export const LETTER_LAYOUTS: Record<
  string,
  {
    title: string;
    referenceLabel: string;
    brandHeader: boolean;
    pageFooter?: (variables: Record<string, string>) => {
      left: string;
      right: string;
    };
  }
> = {
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
};
