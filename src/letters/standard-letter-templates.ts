import { LetterFieldSource } from '@prisma/client';

/**
 * The letters the client actually sends, as templates (2026-10-11).
 *
 * ## Where these came from
 *
 * Six Word documents the client supplied, transcribed: their offer letter, appointment
 * letter with Annexure I, relieving letter, increment letter and payment advice — plus an
 * experience letter drafted here, because the file named "Experience Letter.docx" is
 * headed *Relieving Letter* and the client confirmed it is the relieving one. The
 * experience letter is the only body in this file that is not their own wording, and it is
 * marked as such where it is defined so nobody mistakes it for a transcription.
 *
 * Names, salaries and addresses in the source documents belonged to real people. Every one
 * is a token here; none of them survive as text.
 *
 * ## Why the bodies live in code
 *
 * `LetterTemplate` rows are per company and editable — that is the point of the template
 * screen, and a company that rewrites its offer letter must keep the rewrite. So these are
 * **starting values**, installed once per company and never pushed again, exactly as
 * `ChainsService.seedDefaultsForCompany` treats the approval chains. The alternative, a
 * body read from code at render time, would silently discard an edit the first time
 * anybody made one.
 *
 * ## Tokens and their sources
 *
 * Every token is declared with where its value comes from, because a token with no
 * declaration renders blank, and a blank in a signed letter is indistinguishable from a
 * deliberate omission. `employee` and `candidate` fields are read off the record;
 * `manual` means typed at issue, which is the honest answer for a reporting manager's
 * mobile number or the particulars of a bank transfer.
 *
 * The salary annexure uses **the heads this system actually holds** — Basic, HRA,
 * Conveyance, Site Allowance, Special Allowance — not the Dearness and Medical rows the
 * client's Word document shows. Confirmed with them on 2026-10-11: the annexure then
 * agrees with what payroll pays, and a letter that promises a Dearness Allowance no payslip
 * ever shows is worse than one that omits it.
 */

export interface StandardField {
  token: string;
  label: string;
  sourceType: LetterFieldSource;
  /** Null only for `manual`, which the database enforces with a CHECK. */
  sourcePath: string | null;
  isRequired: boolean;
}

export interface StandardLetterTemplate {
  /** The shipped `LetterKind.key` this template is for. */
  kindKey: string;
  /** Shown in the template list; the company may rename its copy. */
  name: string;
  body: string;
  fields: StandardField[];
}

/** Shorthand for a field typed at issue time. */
const manual = (
  token: string,
  label: string,
  isRequired = true,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.manual,
  sourcePath: null,
  isRequired,
});

/** Shorthand for a field read off the employee record. */
const employee = (
  token: string,
  label: string,
  sourcePath: string,
  isRequired = true,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.employee,
  sourcePath,
  isRequired,
});

/** Shorthand for a field read off the candidate record. */
const candidate = (
  token: string,
  label: string,
  sourcePath: string,
  isRequired = true,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.candidate,
  sourcePath,
  isRequired,
});

/** Shorthand for a field read off the company. */
const company = (
  token: string,
  label: string,
  sourcePath: string,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.company,
  sourcePath,
  isRequired: true,
});

/**
 * Who the letter is about, in the third person.
 *
 * Two tokens rather than fixed wording, and rather than a guess. A relieving letter is
 * about one named person whose pronouns the HR office knows and this system does not —
 * the client's own draft says "he" throughout because it was written for one man. The
 * default offered is they/their, which is correct for anybody.
 */
const PRONOUN_FIELDS: StandardField[] = [
  manual('pronounSubject', 'Pronoun — they / he / she'),
  manual('pronounPossessive', 'Pronoun — their / his / her'),
];

/** The company block every letter closes with. */
const COMPANY_FIELD = company('companyName', 'Company name', 'name');

export const STANDARD_LETTER_TEMPLATES: StandardLetterTemplate[] = [
  // ───────────────────────────────────────────────────────────── offer ──────
  {
    kindKey: 'offer',
    name: 'Offer letter',
    body: [
      'To,',
      '{{candidateName}}',
      'S/O: {{fatherName}}',
      '{{address}}',
      'Mobile: {{mobile}}',
      'Email: {{email}}',
      '',
      'Subject: Offer letter for the post of {{postOffered}}',
      '',
      'Dear {{candidateName}},',
      '',
      'With reference to your application and the subsequent interview held with us, we ' +
        'are pleased to inform you that you have been selected for the post of ' +
        '‘{{postOffered}}’ at {{placeOfPosting}} on the terms and conditions mutually ' +
        'agreed during the interview. You are expected to join on or before ' +
        '{{joiningDate}}. A detailed appointment letter shall be provided on joining the ' +
        'company. You will report to {{reportingManager}} ({{reportingManagerMobile}}).',
      '',
      'Remuneration',
      '',
      'Your offered salary structure will be provided in your joining letter, which will ' +
        'include your annual CTC and the other perquisites and allowances offered by the ' +
        'company, including statutory contributions on the employee’s behalf.',
      '',
      'Duty timing: your working hours will be from {{dutyStart}} to {{dutyEnd}}.',
      '',
      'Probation and confirmation',
      '',
      'Your probation period will be {{probationMonths}} months. Based on your ' +
        'performance your services will be confirmed, and the confirmation will be given ' +
        'in writing.',
      '',
      'Exit and separation',
      '',
      'During the probation period either party may terminate the employment by giving ' +
        '{{noticeDays}} days’ notice. The company reserves the right to terminate ' +
        'employment without notice in the case of misconduct, unsatisfactory performance ' +
        'or violation of company policies. Any absence for a continuous period of seven ' +
        'days without the prior approval of your reporting authority shall bring the ' +
        'employment to an end without further notice or intimation. An employee who ' +
        'wishes to resign is required to serve {{noticeDays}} days’ notice; if the ' +
        'notice period is not served, the company may recover an amount equivalent to ' +
        'one month’s salary, subject to the terms of the employment agreement and ' +
        'applicable law.',
      '',
      'General terms and conditions',
      '',
      'I. You shall not disclose organisational matters, whether confidential or not, to ' +
        'anyone outside the company, during your employment or afterwards.',
      'II. You shall perform all duties and functions assigned to you by the management. ' +
        'Your duties, authority and functions may be modified from time to time by the ' +
        'management at its sole discretion, keeping in view the overall interest of the ' +
        'company.',
      'III. During your employment you shall not undertake any other business or work, ' +
        'directly or indirectly, without the written permission of the management.',
      'IV. You shall discharge your responsibilities with discipline and efficiency.',
      'V. You must follow the rules and regulations of the company in force from time to ' +
        'time. If, in the opinion of the company, you are found guilty of dishonesty, ' +
        'misappropriation, disobedience, fraud, misbehaviour, negligence, indiscipline, ' +
        'absence from duty without permission or any other misconduct, your services may ' +
        'be terminated without notice or salary in lieu of notice.',
      'VI. You shall be responsible for safeguarding all company property in your use or ' +
        'under your charge.',
      '',
      'You are requested to forward the following documents and certificates within two ' +
        'days of accepting this offer:',
      '',
      '1. Educational certificates',
      '2. Address proof — Aadhaar card and PAN card',
      '3. Updated CV with three passport-size photographs',
      '4. Bank account details',
      '5. Experience certificate and relieving letter from your previous employer',
      '',
      'We look forward to welcoming you.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      candidate('candidateName', 'Candidate name', 'fullName'),
      candidate('fatherName', 'Father’s name', 'fatherName', false),
      candidate('address', 'Address', 'address', false),
      candidate('mobile', 'Mobile', 'phone', false),
      candidate('email', 'Email', 'email', false),
      manual('postOffered', 'Post offered'),
      manual('placeOfPosting', 'Place of posting'),
      manual('joiningDate', 'Expected joining date'),
      manual('reportingManager', 'Reporting manager'),
      manual('reportingManagerMobile', 'Reporting manager’s mobile', false),
      manual('dutyStart', 'Duty start time'),
      manual('dutyEnd', 'Duty end time'),
      manual('probationMonths', 'Probation period (months)'),
      manual('noticeDays', 'Notice period (days)'),
      COMPANY_FIELD,
    ],
  },

  // ─────────────────────────────────────────────────────── appointment ──────
  {
    kindKey: 'appointment',
    name: 'Appointment letter',
    body: [
      'To,',
      '{{employeeName}}',
      'S/O: {{fatherName}}',
      '{{address}}',
      'Contact No.: {{mobile}}',
      'Email ID: {{email}}',
      '',
      'Dear {{employeeName}},',
      '',
      'Based on our discussion, you had shown interest in working with us as a full-time ' +
        '{{designation}} in our organisation. With this letter we offer you a contract to ' +
        'provide your services exclusively to us on a full-time basis at ' +
        '{{placeOfPosting}}. By signing and accepting this offer you confirm that the ' +
        'information you have provided is correct.',
      '',
      'Area of responsibility',
      '',
      '{{responsibilities}}',
      '',
      'Compensation',
      '',
      'Your contract start date is {{contractStartDate}}. Your compensation will be a CTC ' +
        'of {{ctcAnnual}} per annum. The management reserves the right to revise your ' +
        'terms of employment, which inter alia includes salary bifurcation, merging or ' +
        'change in allowances. Your detailed salary structure is attached as Annexure I ' +
        'to this appointment letter.',
      '',
      'The terms and conditions applicable to your employment, with effect from your date ' +
        'of joining, are as follows.',
      '',
      'Probation and confirmation',
      '',
      'Your employment with us, beginning from the receipt of this appointment letter, is ' +
        'on a probationary basis for a period of {{probationMonths}} months from the date ' +
        'of your joining duties. After the successful completion of that period your ' +
        'employment will not be automatically confirmed unless a formal confirmation ' +
        'letter is issued by the company, or unless the probation period is extended by ' +
        'written notice. The management reserves the right to extend, at its sole ' +
        'discretion, the probationary period applicable to your employment.',
      '',
      'During the probation period, if your performance does not meet the criteria ' +
        'required for the purpose for which you were selected, or if you breach these ' +
        'terms, engage in misconduct or breach any rules of the company, your service is ' +
        'liable to be terminated with immediate effect. During your employment you shall ' +
        'not serve any other employer or engage in any other business or occupation.',
      '',
      'Notice period',
      '',
      'If you wish to end your employment with the company you may do so by giving the ' +
        'company {{noticeMonths}} month(s) written notice, during which you shall be ' +
        'required to be present and complete your handover.',
      '',
      'Absence',
      '',
      'Absence for a continuous period of ten days, including absence when leave has been ' +
        'applied for but not granted, or when overstayed by ten days, will make you lose ' +
        'your lien on the service and the employment shall come to an end without notice ' +
        'or intimation.',
      '',
      'Leave',
      '',
      'Leave benefits are as per company policy, being {{paidLeavesPerMonth}} paid leave ' +
        'days per month. Leave must be applied for in advance and sanctioned by the ' +
        'appropriate authority. Any leave beyond this limit is subject to prior approval ' +
        'and may be treated as unpaid.',
      '',
      'General conditions',
      '',
      'You will devote yourself entirely to the work of the company with honesty and ' +
        'loyalty, and will obey the lawful instructions of those in authority over you.',
      '',
      'Your appointment is made relying upon the information furnished by you. The ' +
        'company is entitled to conduct reference and background checks, and if any ' +
        'discrepancy is found in the statements or disclosures made by you, the company ' +
        'may terminate your services.',
      '',
      'You will not divulge any trade secret or confidential information gained during ' +
        'the course of your employment, either during your service or afterwards.',
      '',
      'Your increments, promotions and demotions are at the sole discretion of the ' +
        'management, depending on your efficiency, attendance, discipline, loyalty and ' +
        'conduct, and subject to the prosperity of the organisation.',
      '',
      'You will be responsible for the safe keeping and return, in good condition, of all ' +
        'company property, equipment, tools, instruments, books and files given to you ' +
        'for your use or custody.',
      '',
      'The company reserves the right to place you at any of its divisions, units, ' +
        'branches or offices, existing or opened in future, according to the exigencies ' +
        'of work. Upon such transfer the rules applicable at the place of transfer will ' +
        'apply to you.',
      '',
      'The address indicated above shall be deemed your correct address for all ' +
        'communication. Unless changed by written intimation, any communication sent to ' +
        'that address shall be deemed to have been served.',
      '',
      'You will retire without notice on reaching the age of {{retirementAge}} years.',
      '',
      'Besides the above, you will be required to abide by the service rules and ' +
        'regulations and any standing orders issued by the company in due course. The ' +
        'company reserves the right to amend, update or replace any of these terms, ' +
        'general conditions or policies.',
      '',
      'We at {{companyName}} wish you a happy and prosperous future with our organisation ' +
        'and heartily welcome you to excel with us.',
      '',
      'Thanking you,',
      '',
      'Yours faithfully,',
      'For {{companyName}}',
      '',
      '',
      'ANNEXURE I — Remuneration details',
      '',
      '| Earning component | Monthly | Annually |',
      '| --- | --- | --- |',
      '| Basic salary | {{basicMonthly}} | {{basicAnnual}} |',
      '| House rent allowance (HRA) | {{hraMonthly}} | {{hraAnnual}} |',
      '| Conveyance allowance | {{conveyanceMonthly}} | {{conveyanceAnnual}} |',
      '| Site allowance | {{siteAllowanceMonthly}} | {{siteAllowanceAnnual}} |',
      '| Special allowance | {{specialAllowanceMonthly}} | {{specialAllowanceAnnual}} |',
      '| Gross salary | {{grossMonthly}} | {{grossAnnual}} |',
      '',
      '| Employer contribution | Monthly | Annually |',
      '| --- | --- | --- |',
      '| Provident fund | {{pfEmployerMonthly}} | {{pfEmployerAnnual}} |',
      '| ESI | {{esicEmployerMonthly}} | {{esicEmployerAnnual}} |',
      '| Total CTC | {{ctcMonthly}} | {{ctcAnnual}} |',
      '',
      'I, {{employeeName}}, have read the above terms and conditions and the general ' +
        'policies of the company governing my employment with {{companyName}}. I agree ' +
        'to all of them and hereby accept the same.',
      '',
      'Signature: ______________________      Date: ______________',
      '',
      'Note: kindly sign every page of this letter, and a second copy of it, as a token ' +
        'of your acceptance.',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('fatherName', 'Father’s name', 'fatherName', false),
      employee('address', 'Address', 'permanentAddress', false),
      employee('mobile', 'Mobile', 'phone', false),
      employee('email', 'Email', 'email', false),
      employee('designation', 'Designation', 'designation.name'),
      manual('placeOfPosting', 'Place of posting'),
      manual('responsibilities', 'Area of responsibility'),
      manual('contractStartDate', 'Contract start date'),
      manual('probationMonths', 'Probation period (months)'),
      manual('noticeMonths', 'Notice period (months)'),
      manual('paidLeavesPerMonth', 'Paid leave days per month'),
      manual('retirementAge', 'Retirement age'),
      // The annexure, off the employee's own salary heads. Annual figures are the
      // monthly ones × 12, resolved alongside them rather than typed — see
      // `letter-prefill.ts`, which is also why these are `employee` and not `manual`.
      employee('basicMonthly', 'Basic — monthly', 'basic'),
      employee('basicAnnual', 'Basic — annually', 'basic.annual'),
      employee('hraMonthly', 'HRA — monthly', 'hra'),
      employee('hraAnnual', 'HRA — annually', 'hra.annual'),
      employee(
        'conveyanceMonthly',
        'Conveyance — monthly',
        'conveyanceAllowance',
      ),
      employee(
        'conveyanceAnnual',
        'Conveyance — annually',
        'conveyanceAllowance.annual',
      ),
      employee(
        'siteAllowanceMonthly',
        'Site allowance — monthly',
        'siteAllowance',
      ),
      employee(
        'siteAllowanceAnnual',
        'Site allowance — annually',
        'siteAllowance.annual',
      ),
      employee(
        'specialAllowanceMonthly',
        'Special allowance — monthly',
        'specialAllowance',
      ),
      employee(
        'specialAllowanceAnnual',
        'Special allowance — annually',
        'specialAllowance.annual',
      ),
      employee('grossMonthly', 'Gross — monthly', 'gross'),
      employee('grossAnnual', 'Gross — annually', 'gross.annual'),
      employee('pfEmployerMonthly', 'Employer PF — monthly', 'pfEmployer'),
      employee(
        'pfEmployerAnnual',
        'Employer PF — annually',
        'pfEmployer.annual',
      ),
      employee('esicEmployerMonthly', 'Employer ESI — monthly', 'esicEmployer'),
      employee(
        'esicEmployerAnnual',
        'Employer ESI — annually',
        'esicEmployer.annual',
      ),
      employee('ctcMonthly', 'Total CTC — monthly', 'ctc'),
      employee('ctcAnnual', 'Total CTC — annually', 'ctc.annual'),
      COMPANY_FIELD,
    ],
  },

  // ───────────────────────────────────────────────────────── relieving ──────
  {
    kindKey: 'relieving',
    name: 'Relieving letter',
    body: [
      'This is to certify that {{employeeName}}, S/O {{fatherName}}, worked as ' +
        '{{designation}} in our company from {{fromDate}} to {{toDate}}, posted at ' +
        '{{postingLocation}}, to our entire satisfaction.',
      '',
      'During {{pronounPossessive}} working period we found {{pronounSubject}} a sincere, ' +
        'honest, hardworking and dedicated employee with a professional attitude and very ' +
        'good job knowledge. {{pronounSubject}} is amiable in nature and character.',
      '',
      'We have no objection to {{pronounPossessive}} taking up any better position, and ' +
        'there are no liabilities outstanding against {{pronounPossessive}} name in our ' +
        'company.',
      '',
      'We wish {{pronounPossessive}} good luck for future assignments.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('fatherName', 'Father’s name', 'fatherName', false),
      employee('designation', 'Designation', 'designation.name'),
      manual('fromDate', 'Employed from'),
      manual('toDate', 'Employed to'),
      manual('postingLocation', 'Place of posting'),
      ...PRONOUN_FIELDS,
      COMPANY_FIELD,
    ],
  },

  // ──────────────────────────────────────────────────────── experience ──────
  {
    kindKey: 'experience',
    name: 'Experience certificate',
    // **Not a transcription.** The file the client named "Experience Letter.docx" is
    // headed *Relieving Letter* and they confirmed on 2026-10-11 that it is the relieving
    // one. This is drafted in the same register for review: it certifies the engagement
    // and the work, and deliberately carries no release of liability and no "no
    // objection" clause, because those belong to the relieving letter and an experience
    // certificate is often issued while somebody is still employed.
    body: [
      'TO WHOMSOEVER IT MAY CONCERN',
      '',
      'This is to certify that {{employeeName}}, S/O {{fatherName}}, has been associated ' +
        'with {{companyName}} as {{designation}} from {{fromDate}} to {{toDate}}, posted ' +
        'at {{postingLocation}}.',
      '',
      'During this period {{pronounSubject}} was responsible for {{responsibilities}}. We ' +
        'found {{pronounPossessive}} work sincere, diligent and of a consistently ' +
        'professional standard, and {{pronounPossessive}} conduct during the engagement ' +
        'was found to be good.',
      '',
      'This certificate is issued at the request of the employee.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('fatherName', 'Father’s name', 'fatherName', false),
      employee('designation', 'Designation', 'designation.name'),
      manual('fromDate', 'Associated from'),
      manual('toDate', 'Associated to'),
      manual('postingLocation', 'Place of posting'),
      manual('responsibilities', 'Responsibilities held'),
      ...PRONOUN_FIELDS,
      COMPANY_FIELD,
    ],
  },

  // ───────────────────────────────────────────────────────── increment ──────
  {
    kindKey: 'increment',
    name: 'Increment letter',
    body: [
      '{{employeeName}}',
      'Employee code: {{employeeCode}}',
      'Email: {{email}}',
      'Mobile: {{mobile}}',
      '',
      'Subject: Revision of compensation cum increment letter',
      '',
      'Dear {{employeeName}},',
      '',
      'With reference to your appointment letter, we are pleased to inform you that your ' +
        'salary has been revised with effect from {{effectiveDate}} for your services as ' +
        '{{designation}} at {{placeOfPosting}}.',
      '',
      'Your revised Cost to Company (CTC) will be {{revisedCtcMonthly}} ' +
        '({{revisedCtcWords}}) per month.',
      '',
      'All other terms and conditions of your employment, as specified in your ' +
        'appointment letter and subsequent communications, shall remain unchanged and ' +
        'continue in full force and effect.',
      '',
      'We appreciate your contribution to the organisation and look forward to your ' +
        'continued dedication and commitment.',
      '',
      'Note: applicable taxes and statutory deductions shall be made in accordance with ' +
        'the prevailing laws and regulations.',
      '',
      'With best wishes,',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('employeeCode', 'Employee code', 'employeeCode'),
      employee('email', 'Email', 'email', false),
      employee('mobile', 'Mobile', 'phone', false),
      employee('designation', 'Designation', 'designation.name'),
      manual('placeOfPosting', 'Place of posting'),
      manual('effectiveDate', 'Effective from'),
      manual('revisedCtcMonthly', 'Revised CTC (per month)'),
      manual('revisedCtcWords', 'Revised CTC in words'),
      COMPANY_FIELD,
    ],
  },

  // ───────────────────────────────────────────────────── payment advice ─────
  {
    kindKey: 'payment_advice',
    name: 'Payment advice',
    // Addressed to a vendor, not a person — so it is filed without the `HR` segment in
    // its reference, which falls out of `letter-reference.ts` on its own.
    //
    // The client's instruction on 2026-10-11: "once we initiate a payment we can generate
    // the payment advice by entering the transaction details; we just need to pre-capture
    // the static field". The static part is this body; the bank reference, amount and
    // particulars are typed when the transfer is made, which is the only moment they
    // exist.
    body: [
      '| Transaction date | {{transactionDate}} |',
      '| Bank name | {{bankName}} |',
      '| Bank reference no. | {{bankReferenceNo}} |',
      '| IFSC code | {{ifscCode}} |',
      '| Vendor code | {{vendorCode}} |',
      '| Account number | {{accountNumber}} |',
      '| Vendor name | {{vendorName}} |',
      '| Bank transaction no. | {{bankTransactionNo}} |',
      '',
      'Dear Sir / Madam,',
      '',
      'We have initiated a credit through NEFT / RTGS to your account for ' +
        '{{amount}} ({{amountInWords}}) against the particulars mentioned below.',
      '',
      '| S.No. | Particulars | Document date | Site name | Payment amount | TDS amount |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 | {{particulars}} | {{documentDate}} | {{siteName}} | {{paymentAmount}} | {{tdsAmount}} |',
      '| | TOTAL | | | {{paymentAmount}} | {{tdsAmount}} |',
      '',
      'This is a computer-generated advice and does not require a signature.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      manual('transactionDate', 'Transaction date'),
      manual('bankName', 'Bank name'),
      manual('bankReferenceNo', 'Bank reference no.'),
      manual('ifscCode', 'IFSC code'),
      manual('vendorCode', 'Vendor code'),
      manual('accountNumber', 'Account number'),
      manual('vendorName', 'Vendor name'),
      manual('bankTransactionNo', 'Bank transaction no.'),
      manual('amount', 'Amount'),
      manual('amountInWords', 'Amount in words'),
      manual('particulars', 'Particulars'),
      manual('documentDate', 'Document date'),
      manual('siteName', 'Site name'),
      manual('paymentAmount', 'Payment amount'),
      manual('tdsAmount', 'TDS amount', false),
      COMPANY_FIELD,
    ],
  },
];

/** `{{token}}`, matching `template-resolver.ts`. */
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Every token referenced by a body, deduplicated. */
export function tokensIn(body: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(body)) !== null) found.add(match[1]);
  return [...found];
}
