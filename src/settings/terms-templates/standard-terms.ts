import { TermsDocumentKind } from '@prisma/client';

/**
 * The terms a company starts on, per kind of document (2026-10-11).
 *
 * **A real clause set, not an empty box.** "A fixed set of terms and conditions" was
 * the request, and a blank textarea is not one — it makes every company's first work
 * order carry whatever its author could remember, which is the state this replaces.
 *
 * Shipped in code rather than seeded into every company's rows, for the reason
 * `ReminderRule` and the shipped `LetterKind`s follow: a seeded default is a copy that
 * cannot be improved without a data migration, and a company that never edits it would
 * be stuck on whatever was right the day its account was opened. A company that does
 * edit gets a row, and from then on its own text wins — see `TermsTemplatesService`.
 *
 * These are ordinary construction-contract clauses, deliberately generic. They are a
 * starting point for a company's own legal text and are **not** advice about what any
 * particular contract should say.
 */
export const STANDARD_TERMS: Record<TermsDocumentKind, string> = {
  [TermsDocumentKind.work_order]: [
    '1. The work shall be executed strictly as per the approved drawings, specifications and the instructions of the Engineer-in-Charge.',
    '2. Quantities shown are provisional. Payment shall be made on the quantities actually executed and jointly measured and recorded.',
    '3. Rates are inclusive of all labour, tools, plant, scaffolding, lead, lift and incidental charges unless stated otherwise in the schedule above.',
    '4. Retention shall be withheld from each running account bill at the percentage stated in this order and released against the defect liability period.',
    '5. Running account bills shall be submitted with the measurement sheets signed on site. Payment shall follow certification.',
    '6. Material issued by the Company shall be accounted for and any excess consumption over the approved norm shall be recovered at the issue rate.',
    '7. The contractor shall comply with all statutory obligations in respect of their workmen, including wages, insurance and safety, and shall indemnify the Company against any claim arising from a failure to do so.',
    '8. Safety equipment is compulsory on site. Work may be stopped without compensation for a breach of safety requirements.',
    '9. The Company may terminate this order for persistent delay or defective work after written notice, and may complete the balance at the contractor’s risk and cost.',
    '10. Any dispute shall first be referred to the Company’s authorised representative, and failing settlement, to arbitration under the Arbitration and Conciliation Act, 1996.',
  ].join('\n'),

  [TermsDocumentKind.letter_of_intent]: [
    '1. This letter conveys the Company’s intent to award the work described above and does not by itself constitute a binding contract.',
    '2. A formal work order shall follow and shall supersede this letter in its entirety.',
    '3. The rates, quantities and programme stated here are subject to confirmation in the formal order.',
    '4. The recipient shall submit the required statutory documents, insurance cover and security deposit before the formal order is issued.',
    '5. Mobilisation undertaken on the strength of this letter is at the recipient’s own risk and cost unless the Company has confirmed it in writing.',
    '6. This letter lapses if not accepted in writing within the period stated above.',
  ].join('\n'),

  [TermsDocumentKind.purchase_order]: [
    '1. Materials shall conform to the specification and the approved sample. Material rejected on inspection shall be removed at the supplier’s cost.',
    '2. Delivery shall be made to the site named above within the delivery period stated. Time is of the essence.',
    '3. Rates are inclusive of packing, forwarding, freight, loading and unloading unless stated otherwise.',
    '4. Taxes shall be charged as applicable and shown separately on the invoice, with a valid GST invoice accompanying every delivery.',
    '5. Quantities are approximate. The Company may vary them to suit site requirement at the same rate.',
    '6. Payment shall be released against the invoice, the delivery challan and a goods receipt note raised on inspection at site.',
    '7. Short supply, damage in transit and any shortfall found on inspection shall be made good by the supplier at their own cost.',
    '8. The Company may cancel any undelivered portion of this order after written notice if delivery is delayed beyond the agreed period.',
  ].join('\n'),
};
