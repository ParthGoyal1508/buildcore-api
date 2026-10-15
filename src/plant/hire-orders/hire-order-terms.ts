import type { FormClauseSection } from '../../common/form-document';

/**
 * PART-C, "General Terms of this Work Order", of the client's work/hire order (2026-10-15) —
 * transcribed from "wo final Hiring Vehicle.docx". Static: the client's rule is that only the text
 * highlighted in their format is entered per order, and none of the terms is. Two words are not
 * fixed: the company the terms speak for (`{company}`) and the court they submit to
 * (`{jurisdiction}`), so a Tirupati order does not name Parth Realcon as the Company.
 *
 * Generated from the source document's paragraphs; edit the wording here, not in the renderer.
 */
export const HIRE_ORDER_TERMS: FormClauseSection[] = [
  {
    title: 'Definitions',
    clauses: [
      {
        text: '"Company" means "{company}" which expression shall unless repugnant to the context or contrary to the meaning thereof, include its employees, Officers, representatives and permitted assigns.',
        level: 1,
      },
      {
        text: '"Contract" as defined in Clause 2.1 hereto.',
        level: 1,
      },
      {
        text: '"Unit Price" means the total Price payable by the Company to the Supplier for the Supplies made in pursuance of this Order including any amendments thereto.',
        level: 1,
      },
      {
        text: '"Equipment(s)" shall mean the equipment or equipment(s) and/or services specified in this Order, with the description, make, quality, technical specifications, quantities, rates, etc., as the case may be, specified in this Order.',
        level: 1,
      },
      {
        text: '"Point of Delivery" means any premises or location, as stated in this Order or as may be separately informed by the Company to the Supplier, where the Supplier is required to deliver the Equipment(s) and provide Manpower to operate the Equipment(s).',
        level: 1,
      },
      {
        text: '"Supplier" shall mean the Company or, firm, individual or any person to whom this Order is addressed which expression shall unless repugnant to the context or contrary to the meaning thereof, include its employees and all persons engaged by the Supplier, authorized representatives, heirs, executors, successors and assigns.',
        level: 1,
      },
      {
        text: '"Supplies" means the Equipment(s) with Manpower, made by the Supplier to the Company pursuant to this Order.',
        level: 1,
      },
      {
        text: '"Manpower" means individual person having requisite skills/ experience to operate the equipment(s) supplied by the Supplier to the Company pursuant to this Order.',
        level: 1,
      },
      {
        text: '"GST" means the Goods and Service Tax as levied in India as per applicable law, and as applicable from time to time along with all rules and regulations framed in this regard.',
        level: 1,
      },
    ],
    intro:
      'The terms used herein shall have the following meaning unless otherwise expressly mentioned:',
  },
  {
    title: 'Scope',
    clauses: [
      {
        text: "This Order together with these Terms and Conditions, Schedules and any other documents specifically incorporated into the Order by the Company or separately agreed to in writing, etc. are collectively a \"Contract\". All Supplies by the Supplier to the Company are conditional on Supplier's assent to the terms of the Contract exclusively and without regard for any Supplier proffered terms or conditions. The Terms and Conditions of this Contract shall be valid and binding and shall supersede any other terms, conditions and agreements arrived at between the parties. Supplier's confirmation or acknowledgement of this Order, these Terms or the Contract, Supplier's commencement of performance, or Supplier's tendering of Equipment(s) under this Order will constitute the Supplier's acceptance of these Terms, and of the Contract, exclusively.",
        level: 1,
      },
      {
        text: 'The Company may accept and deal with documents proffered by the Supplier, but any such acceptance or use will be solely as an administrative convenience and administrative accommodation and no such acceptance or use will limit or concede anything stated in Clause 2.1 above.',
        level: 1,
      },
      {
        text: 'No verbal agreements amending the terms and conditions of this Contract are valid unless the Parties herein confirm the same in writing.',
        level: 1,
      },
    ],
  },
  {
    title: 'Packaging',
    clauses: [
      {
        text: 'Equipment(s) if supplied against this Order must be properly/ adequately packaged and dispatched, and /or shall confirm to specific instructions given by the Company for the safe transport of the Equipment(s) to the Point of Delivery by the Supplier.',
        level: 1,
      },
    ],
  },
  {
    title: 'Quality and Inspection',
    clauses: [
      {
        text: 'The Equipment(s) supplied under this Order shall strictly conform to the technical specifications provided by the Company.',
        level: 1,
      },
      {
        text: 'All Equipment(s) supplied under this Order should conform to the latest Indian Standards/other applicable Standards (for Imported Equipment(s) / Machinery), it should be new, unused, and free from any defect, unless specifically agreed upon in writing, merchantable quality, fit for their intended purpose by the Company, and should be in line with the quality parameters acceptable to the Company. All such Equipment(s) or parts thereof may be subject to inspection and approval by the Company, at its discretion, either at the Supplier\'s premises or at the Point of Delivery, as may be indicated by the Company. The Company shall reject the equipment(s) for hiring if found defective or not in conformity with the technical specifications provided by the Company or the quality parameters acceptable to the Company or not fit for their intended purpose without invalidating the remainder of the Order, if so desired by the Company ("Rejected Equipment(s)").',
        level: 1,
      },
      {
        text: 'The Company shall have the sole and exclusive discretion to test, verify, confirm and reject / accept the Equipment(s) or part thereof on the ground of its non-conformity with the quality parameters of the Company and technical specifications stipulated in this Order. Any rejection of any Equipment(s) or any part thereof, by the Company, shall be at the sole risk and cost of the Supplier, to the exclusion of the Company.',
        level: 1,
      },
      {
        text: 'All Rejected Equipment(s) shall be removed by the Supplier at its own costs immediately from the date of rejection informed by the Company to the Supplier. In case of any failure to remove such Rejected Equipment(s), the Company shall have the right to remove the same from its premises, without further notice to the Supplier. The Company shall charge storage charges at rate of 1% of the Unit Price in relation to the Rejected Equipment(s), per week and subject to maximum 10% of the same. The Company, under no circumstances will be liable or held accountable for any damage, loss, deterioration of Rejected Equipment(s) for discarding the same or for any value of it.',
        level: 1,
      },
    ],
  },
  {
    title: 'Bills, Challans and Documents',
    clauses: [
      {
        text: 'The Supplier must submit the Valid GST compliant "Tax Invoice" duly bearing the Supplier\'s GST registration numbers, supported with the required forms as specified in the Order and showing the description of Equipment(s), quantity, reference of Order No., Challan No. and date and value wherever applicable, in accordance with the provision of GST Act.',
        level: 1,
      },
      {
        text: "The bill must be accompanied by the Supplier's challan duly receipted by the Company or its nominee. Challan accompanying the Equipment(s) should indicate the Order No., and date, gate pass number and date, value, etc. wherever applicable.",
        level: 1,
      },
      {
        text: 'The Supplier shall provide all documents, catalogues, drawings, test certificates, Fitness Certificate, RC, Pollution Certificate, Permit and any other RTO Related Documents and all supporting technical data and details as may be required by the Company, in relation to the Equipment(s) supplied under this Order.',
        level: 1,
      },
    ],
  },
  {
    title: 'Indemnification',
    clauses: [
      {
        text: 'The Supplier shall ensure to comply with all laws, regulations and orders relating to the possession, operation and use of the Equipment(s) and assumes all risks and liabilities arising from or pertaining to the possession, operation or use of the equipment.',
        level: 1,
      },
      {
        text: "Without limiting any other remedy of the Company, the Supplier shall at its own expense, defend, indemnify and hold harmless the Company and its directors, employees, nominees, agents, representatives and customers/clients, from and against any and all losses, damages, costs, expenses, claims, proceedings, actions, demands or liability, including legal counsel fees and expenses, incurred or suffered by the Company resulting from bodily injury, sickness, disease or death of persons, or damage to property arising out of or in connection with the Supplier's performance of this Order including but not limited to:-",
        level: 1,
      },
      {
        text: "Non-compliance with the Company's requirements;",
        level: 2,
      },
      {
        text: 'Negligence or willful misconduct of the Supplier, its employees, contractors, Suppliers or agents, Manpower;',
        level: 2,
      },
      {
        text: 'Defects in the Equipment(s) supplied, services or work performed by the Supplier;',
        level: 2,
      },
      {
        text: 'Loss of equipment due to seizure by any person other than the Supplier for any reason whatsoever, or resulting from any form of legal process initiated by any person other than the Supplier.',
        level: 2,
      },
      {
        text: 'Failure to comply with central, state or local laws; or',
        level: 2,
      },
      {
        text: 'Breach of the terms and conditions of this Order.',
        level: 2,
      },
      {
        text: 'The Supplier does hereby agree to indemnify and keep indemnified and hold safe and harmless the Company from and against any loss or damage caused to or suffered by the Company on account of any action taken by any Bank or Financial Institution for non-satisfaction or breach of the conditions of any financing facility granted by the such Bank or Financial Institution to the Supplier. The Supplier hereby agrees to inform its Bank or Financial Institution about this arrangement and obtain their confirmation to the same.',
        level: 1,
      },
      {
        text: 'The Supplier further agrees to indemnify and keep indemnified and held safe and harmless the Company from and against any loss or damage caused to or suffered by the Company on account of any act of the Supplier in relation to the Equipment or the Manpower, provided by the Supplier.',
        level: 1,
      },
      {
        text: 'The indemnity in the clause is a continuing indemnity and survives termination or expiration of this Order.',
        level: 1,
      },
    ],
  },
  {
    title: 'Confidentiality and Secrecy',
    clauses: [
      {
        text: 'The Supplier will maintain utmost and strict confidentiality of proprietary rights and interests, and confidential information of the Company including but not limited to any privileged information, bank details, name of the employees, Suppliers, customers, business associates, affiliates which Supplier may have come to know while dealing with the Company. The Supplier shall not use confidential information of Company for personal gain or otherwise.',
        level: 1,
      },
      {
        text: 'During the course of execution of this Order and for abiding by the prevailing law the Company may collect necessary data of the promoters, directors, employees etc. of the Supplier, which may be required to be submitted to statutory authorities and the Supplier consents to provide such information.',
        level: 1,
      },
    ],
  },
  {
    title: 'Use & Inspection',
    clauses: [
      {
        text: 'Supplier will cause the Equipment to be operated in accordance with the instructions provided by the Company and/or its officers, representatives and by competent and duly qualified personnel and in accordance with applicable Government regulations, if any, and for purposes as stipulated in this Order and communicated from time to time by the Company.',
        level: 1,
      },
      {
        text: "Supplier shall have the right from time to time during the normal business hours on any working day to enter upon the Company's premises or elsewhere after prior notice for the purpose of maintenance of the Equipment(s) in accordance with the requirements of the Company.",
        level: 1,
      },
    ],
  },
  {
    title: 'Insurance',
    clauses: [
      {
        text: 'Supplier shall obtain and maintain for the entire term of this Order at its own expense, comprehensive insurance against loss or destruction or damage to the Equipment(s) including without limitations destruction or loss by fire, theft and such other risks or loss as are customarily insured against on the type of Equipment leased hereunder and in such amounts as shall be satisfactory to the Company, provided however that the amount of insurance against loss or destruction or damage to the Equipment(s) shall not be less than the full replacement value of the Equipment(s).',
        level: 1,
      },
      {
        text: "Each insurance policy will name Supplier as insured and note Supplier's (and its Bankers') interests as loss payee. Supplier shall furnish to Company a certificate of insurance or other satisfactory evidence that such insurance coverage is in effect.",
        level: 1,
      },
      {
        text: 'Upon expiration or earlier termination of the Lease the Company shall intimate to the Supplier to remove all its Equipment(s) from the premises of the Company and shall also call back its Manpower immediately as and when intimate by the Company.',
        level: 1,
      },
    ],
  },
  {
    title: 'Waiver',
    clauses: [
      {
        text: 'Any expressed or implied waiver by the Supplier or by Company of any default shall not constitute a waiver of any other default by either Supplier or Company or a waiver of any of the Parties right.',
        level: 1,
      },
      {
        text: 'All original rights and powers of the Supplier and Company under this Agreement will remain in full force, notwithstanding any neglect, forbearance or delay in the enforcement thereof, by the either Parties to this Agreement shall not be deemed as waiver of any continuing or recurring breach by the either Parties to this Agreement.',
        level: 1,
      },
    ],
  },
  {
    title: 'Termination',
    clauses: [
      {
        text: "In addition to the other rights and remedies available to the Company, the Company may terminate this Order in case of breach of any terms and conditions by the Supplier by giving 7 days' notice to the Supplier.",
        level: 1,
      },
      {
        text: "However, provided that Supplier's breach is capable of remedy, the Company at its sole discretion may grant a period of seven (7) days' notice to the Supplier to make good of any breach or default committed by Supplier and if the Supplier fails to make such good of breach or default within such notice period, the Order shall stand terminated on expiry of such notice period. No further reference shall be made by the Company.",
        level: 1,
      },
      {
        text: 'The Company may at any time, instruct the Supplier to suspend this Order in whole or in part. During the suspension period the Supplier shall not demand any amount or damages towards the balance supply.',
        level: 1,
      },
      {
        text: 'It is further agreed between the Parties that breach of this order shall, at the option of the Company, constitute breach of the other order/s with the Supplier, which will confer a right on the Company to terminate the other order/s also at the risk and costs of the Supplier.',
        level: 1,
      },
    ],
  },
  {
    title: 'Force Majeure',
    clauses: [
      {
        text: 'In event that the Parties are delayed or restricted in performing any of its respective obligations and such delay is caused by Force Majeure situations which shall mean circumstances beyond control of either or both Parties such as but not limited to war, civil insurrection, fires, floods then the term of the Order for duration of existence of such Force Majeure situation shall be suspended and such duration shall be added in term of Order at sole discretion of the Company.',
        level: 1,
      },
      {
        text: "If a Force Majeure situation arises at the Supplier's end, the Supplier shall promptly notify to the Company in writing with evidence acceptable to Company of such condition and cause thereof. Unless otherwise directed by Company in writing, the Supplier shall continue to perform its obligations under the Order as far as it is reasonably practical.",
        level: 1,
      },
      {
        text: 'Notwithstanding anything contained under Order, if Force Majeure situation last for a period of more than fifteen (15) days in continuance the Company has right to terminate Order prematurely and on such termination, the Parties shall settle and honor any pending obligation provided that Supplier shall refund amount paid for the unexpired/unexecuted part of the Order within two (2) days of termination of the Order. The Company can at its sole option grant extension of period of Order. Under no circumstances, the Supplier shall be entitled for liquidated or consequential damages on Force Majeure situations or termination of Order.',
        level: 1,
      },
    ],
  },
  {
    title: 'Authorized Persons',
    clauses: [
      {
        text: 'The signatories to this agreement shall be the Authorized Person responsible for signing any document under this Order. Either party may change its Authorized Person under formal intimation to the other Party signed by its above referred Authorized Person or any other person as may be authorized by respective parties to this Order.',
        level: 1,
      },
      {
        text: 'The Parties may communicate with each other and deliver the notice (if the context so require) through authorized electronic mail, authorized and registered post or courier services or such mode of communication as the Parties may decide mutually.',
        level: 1,
      },
    ],
  },
  {
    title: 'Taxation',
    clauses: [
      {
        text: 'The Supplier shall take all necessary steps for uploading GST Compliant Tax invoice in GSTR 1, payment of the tax liability on the said invoices and filing of Returns etc. within due course of time and comply with all the requirements of applicable laws including GST laws for the time being in force to enable the Company to avail tax credit/s including input tax credit.',
        level: 1,
      },
      {
        text: 'In case of any loss or non-availability of input tax credit by the Company due to non-compliance of applicable GST laws in force, on the part of Supplier, an amount equivalent to any tax liability accruing to the Company and/or to the extent of any loss accrued to the Company due to the non-availability of input tax credit or any liability accrued to the Company shall either stand cancelled or deducted from the payment due to the Supplier or shall be reimbursed by the Supplier as the case may be till such default is either rectified or made Equipment(s) by the Supplier and the Company is satisfied that it is in a position to claim valid input tax credit within the time-lines as per applicable laws.',
        level: 1,
      },
      {
        text: 'Any cost, liability, dues, penalty, fees, interest as the case may be which accrues to the Company at any point of time on account of non-compliance of applicable tax laws or rules or regulations thereof or otherwise due to default on the part of Supplier shall be borne by the Supplier. An amount equivalent to such cost, liability, dues, penalty, fees, and interest as the case may be shall be reimbursed by the Supplier within 30 days. Any GST as may be applicable on such recovery of amount shall also be borne by Supplier."',
        level: 1,
      },
      {
        text: 'The above claim is without prejudice to the Company rights to sue Supplier against the said claim before the court of law for reimbursement of non-payment of above mentioned taxes including interest, penalty and any incidental expenses incurred on account of that.',
        level: 1,
      },
      {
        text: 'Except as otherwise specifically provided in the order, Supplier is responsible for the payment of all taxes including GST on advances or any other taxes in the state concerned and other tax (es) or duty (ies) and levy (ies) which may be specified by local/state/central government from time to time and amended, as applicable on all Equipment(s) & Services which may be supplied under this Order whatsoever in nature.',
        level: 1,
      },
      {
        text: 'Further, Supplier is bound to submit to the Company all GST returns and/or any other statutory return filed for the relevant period(s) along with copy of challans evidencing payment of GST and other applicable taxes.',
        level: 1,
      },
      {
        text: 'If any amount is paid as advance by the Company in respect of Equipment(s) or Services to be supplied later, the Supplier is liable to deposit GST on advances so made and provide an Advance Receipt Voucher to Company in accordance with the GST Act and the rules made there under. In no case Company/ Lessee is liable to pay GST on advances paid to the Supplier.',
        level: 1,
      },
    ],
  },
  {
    title: 'Other Terms',
    clauses: [
      {
        text: "The Supplier's Equipment Operator shall ensure that all Equipment(s), machines, tools, etc. shall be safely kept at the place provided by the Company and also ensure that it is used for the purpose, as mentioned in this Order. In case of reduction/ destruction or damage to such Equipment(s), machines, tools, etc., the Supplier shall provide replacements at its own cost.",
        level: 1,
      },
      {
        text: 'The Supplier, except with the prior written approval of the Company, shall not in any manner encumber or create any lien on the Equipment(s), which are the subject matter of this Order.',
        level: 1,
      },
      {
        text: 'The Supplies made under this Order shall strictly conform to the requirements of the Company as specified in this Order. -.',
        level: 1,
      },
      {
        text: 'Upon expiration or earlier termination of the Order, the Supplier shall remove the Equipment(s) from the premises of the Company at its own cost and expense.',
        level: 1,
      },
    ],
  },
  {
    title: 'Modification in Order',
    clauses: [
      {
        text: 'The Company may at any time before delivery, by notice to Supplier request for changes in Order.',
        level: 1,
      },
      {
        text: "The Supplier shall submit required information, documents, clarifications, explanations and estimates within 2 working days from receipt of notice and during Company's business hours.",
        level: 1,
      },
      {
        text: 'The Supplier shall perform changes for which Parties have mutually agreed for all effects of the change in writing.',
        level: 1,
      },
    ],
  },
  {
    title: 'Relationship',
    clauses: [
      {
        text: 'The Supplier acknowledges and agrees that relationship with the Company is that of an independent person and on principal to principal basis.',
        level: 1,
      },
      {
        text: 'This Order shall inure to the benefits to the permitted assign and successors of the Parties.',
        level: 1,
      },
    ],
  },
  {
    title: 'Assignment',
    clauses: [
      {
        text: 'The Supplier will not assign, transfer or part with this Order in whole or in part, to any third person without prior written consent of the Company.',
        level: 1,
      },
      {
        text: 'This Order shall inure to the benefits to the permitted assign and successors of the Parties.',
        level: 1,
      },
    ],
  },
  {
    title: 'Entire Understanding',
    clauses: [
      {
        text: 'This Order is binding legal contract within the meaning of applicable law and sets forth entire understanding between the Parties as to subject matter hereof and merges and supersedes all previous discussions, negotiations and correspondence, if any, whether written or oral, pertaining to this Order.',
        level: 1,
      },
      {
        text: 'In the event there is any difference or conflict or inconsistency in any of the terms of Part B and Part C, the terms and conditions as stipulated in Part B shall prevail.',
        level: 1,
      },
    ],
  },
  {
    title: 'Severability',
    clauses: [
      {
        text: 'If any of the provision of this Order is invalid or becomes invalid by any law or order of court or statutory authority, then such invalid provision shall become inoperative and remaining provisions of the Order shall remain effective.',
        level: 1,
      },
    ],
  },
  {
    title: 'Amendment',
    clauses: [
      {
        text: 'No change in, addition to, or waiver of the provisions of this Order shall be binding upon the Company or the Supplier, unless made in writing and signed by the Authorized Person of each of the Party.',
        level: 1,
      },
    ],
  },
  {
    title: 'Non-waiver',
    clauses: [
      {
        text: 'No failure, forbearance or delay of the Supplier in exercising its obligations hereunder shall be deemed to be a waiver of such obligation unless expressly made in writing or approved by the Company for waiving such obligation.',
        level: 1,
      },
      {
        text: 'The failure, forbearance, negligence or delay of the Company in exercising its obligations hereunder shall be deemed to be a waiver of such obligation unless otherwise expressly made in writing.',
        level: 1,
      },
    ],
  },
  {
    title: 'Guidelines, Standing Operating Procedure, and Statutory Laws',
    clauses: [
      {
        text: 'The Supplier represents that it is validly and lawfully conducting and carrying out its business and it will keep complying with all applicable laws from time to time;',
        level: 1,
      },
      {
        text: 'The Supplier has valid and lawful authority to enter into this Order and the signatory is duly authorized to execute this Order.',
        level: 1,
      },
      {
        text: 'The Supplier has and will maintain in place throughout the term of this Order its own policies and procedures to ensure compliance with the requirements of this Order and will enforce them where appropriate.',
        level: 1,
      },
      {
        text: 'The Supplier represents that it will not engage in practice of solicit, undue inducement with agents, staffs or employees of the Company or the Government Authorities and proposes them any bribe or gifts or personal gain of any kind while dealing with them. If any time, the Supplier or its agents, staffs or employees found to violate this condition, the Company reserves right, at its sole discretion, to file a criminal complaint against accused and further, to claim fine / penalty from Supplier which shall be equivalent to the amount involved in such dealing. This clause however may not take the right of the Company to claim appropriate damages.',
        level: 1,
      },
      {
        text: 'The Supplier shall also ensure that it does not violate basic human rights, or engages in child labour, complies with all Statutory laws and uses its best efforts to adhere to the applicable law time to time.',
        level: 1,
      },
    ],
  },
  {
    title: 'Applicable Law, Jurisdiction and Dispute Resolution',
    clauses: [
      {
        text: 'Laws in India, as may be applicable from time to time, shall govern the terms of this Order.',
        level: 1,
      },
      {
        text: 'All disputes arising out of or in connection with this Order including any question regarding its existence, validity or termination, shall unless amicably settled between the parties, be finally settled by Arbitration.',
        level: 1,
      },
      {
        text: 'When any Dispute is referred to arbitration, except for the matters under dispute, the Parties shall continue to exercise their remaining respective rights and fulfill their remaining respective obligations under this Order.',
        level: 1,
      },
      {
        text: 'The dispute/differences arising out of this Order is subject to the jurisdiction of the Court of Law at {jurisdiction} exclusively.',
        level: 1,
      },
    ],
  },
];

/** The terms with this order's company and court written in. */
export function hireOrderTerms(
  company: string,
  jurisdiction: string,
): FormClauseSection[] {
  const fill = (text: string) =>
    text
      .replace(/\{company\}/g, company)
      .replace(/\{jurisdiction\}/g, jurisdiction);
  return HIRE_ORDER_TERMS.map((section) => ({
    ...section,
    intro: section.intro ? fill(section.intro) : undefined,
    clauses: section.clauses.map((c) => ({ ...c, text: fill(c.text) })),
  }));
}
