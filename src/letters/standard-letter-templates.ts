import { LetterFieldSource } from '@prisma/client';

import { LINE_ITEM_OUTPUTS } from './line-items';

/**
 * The letters the client actually sends, as templates (2026-10-11, extended 2026-10-13).
 *
 * ## Where these came from
 *
 * The Word documents the client supplied (`docs/HR_DOCS/`), transcribed: offer letter,
 * appointment letter with Annexure I, experience letter, relieving letter, increment
 * letter, transfer letter, termination letter and the full & final settlement sheet — plus
 * the payment advice. In every one of their files the variable text is highlighted yellow;
 * each highlighted run is a token here, and the unhighlighted wording is theirs.
 *
 * Two of their files are named after each other's contents, which is worth knowing before
 * anybody "corrects" a body against them: "Experience Letter (1).docx" carries the
 * certifying text ("worked as … from … to … posted at … with our entire satisfaction") but
 * is headed *Relieving Letter*, and "Reliving Letter.docx" carries the resignation-accepted
 * text. Each template takes the wording that fits its kind; the heading on the page is the
 * kind's label, which the renderer prints, not a line in the body.
 *
 * Names, salaries and addresses in the source documents belonged to real people. Every one
 * is a token here; none of them survive as text. So do the copy-paste slips: the transfer
 * letter's last sentence names a different project ("Jaipur Ring Road") from the one the
 * employee is being transferred to, and here both are the destination.
 *
 * ## Why the bodies live in code
 *
 * `LetterTemplate` rows are per company, because composing resolves the company's active row
 * for the kind. They used to be **starting values**, installed once and then the company's to
 * rewrite. Since 2026-10-14 they are not: the standard wording is the same for every company,
 * and `StandardTemplatesService` brings every company's copy of these kinds up to the body and
 * name below on every application start (creating it where missing). Editing the body or name
 * of one of these templates is refused (`LETTER_TEMPLATE_STANDARD_LOCKED`) — it would be
 * silently overwritten at the next start. A change to the wording is a change to this file.
 *
 * Company-defined kinds, and shipped kinds with no entry here, keep their own editable
 * templates.
 *
 * ## Tokens and their sources
 *
 * Every token is declared with where its value comes from, because a token with no
 * declaration renders blank, and a blank in a signed letter is indistinguishable from a
 * deliberate omission. `employee` and `candidate` fields are read off the record whose
 * keys the letters registry publishes (`fullName`, `designation`, `basicAnnual`,
 * `revision.ctc`, `fnf.net` …) and **pre-fill** the compose screen; HR can still overwrite
 * any of them before issuing. `manual` means typed at issue, which is the honest answer for
 * whom work is handed over to or the particulars of a bank transfer.
 *
 * `isRequired` is false where a blank is a legitimate outcome — a father's name the record
 * never held, a mobile number, every line of the F&F sheet nobody has a figure for yet —
 * and true for the facts a letter exists to state: whose it is, what post, which dates.
 * Those stay required even when the record may lack them, so the gap is typed rather than
 * printed.
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
  /** Shown in the template list. Managed like the body: a company copy is renamed back. */
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
  isRequired = true,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.company,
  sourcePath,
  isRequired,
});

/**
 * Who the letter is about, in the third person.
 *
 * Fields rather than fixed wording. An experience letter is about one named person — the
 * client's own draft says "he" throughout because it was written for one man. The record
 * derives the forms from the employee's gender (they/them/their when it is not recorded,
 * which is correct for anybody), and HR can overwrite them at issue like any other field.
 *
 * **Three forms, because English needs three.** Rendering the first draft of these
 * templates produced "we found *he* a sincere employee" and "we wish *his* good luck":
 * one subject-form token cannot stand where the object form belongs. The bodies are also
 * written so that **no pronoun begins a sentence** — a token cannot be capitalised by
 * substitution, and "he is amiable in nature" mid-paragraph is the other half of the same
 * bug.
 */
const PRONOUN_OBJECT = employee(
  'pronounObject',
  'Pronoun — them / him / her',
  'pronounObject',
);
const PRONOUN_POSSESSIVE = employee(
  'pronounPossessive',
  'Pronoun — their / his / her',
  'pronounPossessive',
);

/**
 * "Mr." / "Ms.", as the client's letters address people. Not required: the record leaves
 * it empty when neither a title nor a gender is held, and a letter reading "Dear Ravi
 * Sharma" is correct, where one reading "Dear Mr. Ravi Sharma" for a woman is not.
 */
const SALUTATION = employee(
  'salutation',
  'Salutation — Mr. / Ms.',
  'salutation',
  false,
);

/** The company block every letter closes with. */
const COMPANY_FIELD = company('companyName', 'Company name', 'name');

/** Shorthand for a field read off the project a letter is issued on (2026-10-14). */
const project = (
  token: string,
  label: string,
  sourcePath: string,
  isRequired = true,
): StandardField => ({
  token,
  label,
  sourceType: LetterFieldSource.project,
  sourcePath,
  isRequired,
});

/** The project the letter is issued on, read from its record. */
const PROJECT_FIELDS = [
  project('projectName', 'Project', 'name'),
  project('projectLocation', 'Project location', 'location', false),
  project('clientName', 'Client', 'clientName', false),
];

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
      // The terms come off the candidate's latest offer, which is where Recruitment
      // recorded them; HR still sees and can change each one before the letter is issued.
      candidate('postOffered', 'Post offered', 'offer.designation'),
      candidate('placeOfPosting', 'Place of posting', 'offer.placeOfPosting'),
      candidate('joiningDate', 'Expected joining date', 'offer.joiningDate'),
      candidate(
        'reportingManager',
        'Reporting manager',
        'offer.reportingManager',
      ),
      candidate(
        'reportingManagerMobile',
        'Reporting manager’s mobile',
        'offer.reportingManagerMobile',
        false,
      ),
      manual('dutyStart', 'Duty start time'),
      manual('dutyEnd', 'Duty end time'),
      candidate(
        'probationMonths',
        'Probation period (months)',
        'offer.probationMonths',
      ),
      candidate('noticeDays', 'Notice period (days)', 'offer.noticeDays'),
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
      employee('address', 'Address', 'address', false),
      employee('mobile', 'Mobile', 'phone', false),
      employee('email', 'Email', 'email', false),
      employee('designation', 'Designation', 'designation'),
      employee('placeOfPosting', 'Place of posting', 'placeOfPosting'),
      manual('responsibilities', 'Area of responsibility'),
      employee('contractStartDate', 'Contract start date', 'dateOfJoining'),
      manual('probationMonths', 'Probation period (months)'),
      manual('noticeMonths', 'Notice period (months)'),
      manual('paidLeavesPerMonth', 'Paid leave days per month'),
      manual('retirementAge', 'Retirement age'),
      // The annexure, off the employee's own salary heads. Annual figures are the
      // monthly ones × 12, resolved by the employee record alongside them (`basicAnnual`
      // beside `basic`) rather than typed, which is why these are `employee` and not
      // `manual`.
      employee('basicMonthly', 'Basic — monthly', 'basic'),
      employee('basicAnnual', 'Basic — annually', 'basicAnnual'),
      employee('hraMonthly', 'HRA — monthly', 'hra'),
      employee('hraAnnual', 'HRA — annually', 'hraAnnual'),
      employee('conveyanceMonthly', 'Conveyance — monthly', 'conveyance'),
      employee('conveyanceAnnual', 'Conveyance — annually', 'conveyanceAnnual'),
      employee(
        'siteAllowanceMonthly',
        'Site allowance — monthly',
        'siteAllowance',
      ),
      employee(
        'siteAllowanceAnnual',
        'Site allowance — annually',
        'siteAllowanceAnnual',
      ),
      employee(
        'specialAllowanceMonthly',
        'Special allowance — monthly',
        'specialAllowance',
      ),
      employee(
        'specialAllowanceAnnual',
        'Special allowance — annually',
        'specialAllowanceAnnual',
      ),
      employee('grossMonthly', 'Gross — monthly', 'gross'),
      employee('grossAnnual', 'Gross — annually', 'grossAnnual'),
      employee('pfEmployerMonthly', 'Employer PF — monthly', 'pfEmployer'),
      employee(
        'pfEmployerAnnual',
        'Employer PF — annually',
        'pfEmployerAnnual',
      ),
      employee('esicEmployerMonthly', 'Employer ESI — monthly', 'esicEmployer'),
      employee(
        'esicEmployerAnnual',
        'Employer ESI — annually',
        'esicEmployerAnnual',
      ),
      employee('ctcMonthly', 'Total CTC — monthly', 'ctc'),
      employee('ctcAnnual', 'Total CTC — annually', 'ctcAnnual'),
      COMPANY_FIELD,
    ],
  },

  // ──────────────────────────────────────────────────────── experience ──────
  {
    kindKey: 'experience',
    name: 'Experience letter',
    // "Experience Letter (1).docx". The file is headed *Relieving Letter*, but this is the
    // certifying text, and the client asked for it to be issued as the experience letter;
    // the page heading is the kind's label. Their "Mr. … S/o-Mr. …" and "him" are tokens,
    // and their "no objection to all him in any better position" is put into English.
    body: [
      'This is to certify that {{salutation}} {{employeeName}}, S/o {{fatherName}}, ' +
        'worked as {{designation}} in our company from {{fromDate}} to {{toDate}}, ' +
        'posted at {{postingLocation}}, with our entire satisfaction. During ' +
        '{{pronounPossessive}} working period we found {{pronounObject}} to be a sincere, ' +
        'honest, hardworking and dedicated employee with a professional attitude and very ' +
        'good job knowledge, and amiable in nature and character as well.',
      '',
      'We have no objection to {{pronounPossessive}} taking up any better position, and ' +
        'there are no liabilities outstanding against {{pronounObject}} in our company.',
      '',
      'We wish {{pronounObject}} good luck for future assignments.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      SALUTATION,
      employee('employeeName', 'Employee name', 'fullName'),
      employee('fatherName', 'Father’s name', 'fatherName', false),
      employee('designation', 'Designation', 'designation'),
      employee('fromDate', 'Worked from', 'dateOfJoining'),
      // The exit record's last working day. Required although the record may not hold it
      // yet: the dates are what the next employer reads this letter for.
      employee('toDate', 'Worked to', 'exit.lastWorkingDay'),
      employee('postingLocation', 'Place of posting', 'placeOfPosting'),
      // Object and possessive only. The body never needs the subject form, and a field
      // declared but unused is a box somebody fills in whose answer goes nowhere.
      PRONOUN_OBJECT,
      PRONOUN_POSSESSIVE,
      COMPANY_FIELD,
    ],
  },

  // ───────────────────────────────────────────────────────── relieving ──────
  {
    kindKey: 'relieving',
    name: 'Relieving letter',
    // "Reliving Letter.docx": the resignation accepted, the relieving date, and the
    // experience letter held back until the full and final settlement — which is why the
    // two are separate kinds and issued at different times.
    body: [
      'Name: {{salutation}} {{employeeName}}',
      'Project: {{projectName}}',
      '',
      'Dear {{salutation}} {{employeeName}},',
      '',
      'In reference to your resignation dated {{resignationDate}} stating your intention ' +
        'to resign from the position of {{designation}} held at {{companyName}}, we would ' +
        'like to inform you that your resignation from the services of the organisation ' +
        'has been accepted.',
      '',
      'You have been relieved from all your duties and responsibilities at the close of ' +
        'office hours of {{relievingDate}}. You have submitted all the company documents, ' +
        'technical equipment and all other company properties to your Project Manager / ' +
        'Department Head.',
      '',
      'Your experience letter shall be issued to you subject to the full and final ' +
        'settlement of dues, if any.',
      '',
      'We thank you for your services in {{companyName}} and wish you success in your ' +
        'future endeavours.',
      '',
      'With best regards,',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      SALUTATION,
      employee('employeeName', 'Employee name', 'fullName'),
      employee('projectName', 'Project', 'projectName', false),
      employee('resignationDate', 'Resignation dated', 'resignation.date'),
      employee('designation', 'Position held', 'designation'),
      // The exit record's date. Where only the accepted resignation carries one, HR types
      // it — this letter states when somebody stopped being responsible for a site.
      employee('relievingDate', 'Relieved at close of', 'exit.lastWorkingDay'),
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
      employee('designation', 'Designation', 'designation'),
      employee('placeOfPosting', 'Place of posting', 'placeOfPosting'),
      // Off the employee's latest salary revision — the record of the increment this
      // letter announces. An employee with no revision yet leaves these for HR to type.
      employee('effectiveDate', 'Effective from', 'revision.effectiveFrom'),
      employee('revisedCtcMonthly', 'Revised CTC (per month)', 'revision.ctc'),
      employee(
        'revisedCtcWords',
        'Revised CTC in words',
        'revision.ctcInWords',
      ),
      COMPANY_FIELD,
    ],
  },

  // ────────────────────────────────────────────────────────── transfer ──────
  {
    kindKey: 'transfer',
    name: 'Transfer letter',
    // "Transfer letter.docx". Its closing sentence names "Jaipur Ring Road" while the
    // letter transfers the employee to a different project — a copy-paste leftover — so
    // both mentions are the destination here.
    //
    // The acceptance lines come before the sign-off rather than after it, as they do in the
    // source: the renderer draws the company's signature after the body, and an
    // employee's "Signature: ___" printed under the director's reads as if it were his.
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
      'We hope this letter finds you well. This is to inform you that, due to the ' +
        'operational requirements of the company, you are being transferred to ' +
        '{{toProject}}. You are required to report to the {{reportingSite}} site on ' +
        '{{reportingDate}}. Your duties and responsibilities will remain consistent with ' +
        'your current role as {{designation}}, and we are confident that your skills and ' +
        'experience will greatly contribute to the {{toProject}} project during this ' +
        'period.',
      '',
      'Should you need any further information, please feel free to contact the HR ' +
        'department.',
      '',
      'Please confirm your acceptance by signing and returning this letter.',
      '',
      'Signature: ______________________      Date: ______________',
      '',
      'Regards,',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('fatherName', 'Father’s name', 'fatherName', false),
      employee('address', 'Address', 'address', false),
      employee('mobile', 'Contact no.', 'phone', false),
      employee('email', 'Email', 'email', false),
      // The latest location assignment is the transfer. Required: an assignment may not
      // have been recorded yet, and then HR types where the person is going.
      employee('toProject', 'Transferred to (project)', 'transfer.toProject'),
      employee('reportingSite', 'Report at (site)', 'transfer.toSite'),
      employee('reportingDate', 'Report on', 'transfer.effectiveFrom'),
      employee('designation', 'Current role', 'designation'),
      COMPANY_FIELD,
    ],
  },

  // ─────────────────────────────────────────────────────── termination ──────
  {
    kindKey: 'termination',
    name: 'Termination letter',
    // "Terminataion letter.docx". The reasons are deliberately not stated — the client's
    // letter says only that they are specific — and nothing here adds a field for them.
    body: [
      'To,',
      '{{employeeName}}',
      '{{designation}}',
      'Project Name: {{projectName}}',
      '',
      'Sub: Termination of employment from the company',
      '',
      'This letter is to inform you that your employment with {{companyName}} as ' +
        '{{designation}} is terminated, effective from {{effectiveDate}}. This decision ' +
        'has been reached after careful consideration and is based on some specific ' +
        'reasons.',
      '',
      'Your final settlement will include all pending salary, accrued leave and other ' +
        'dues as per company policy.',
      '',
      'Please return all company property, company documents and all other documents on ' +
        'or before your last working day.',
      '',
      'You are requested to complete a handover of site-related work to your reporting ' +
        'authority, {{handoverTo}}.',
      '',
      'Regards,',
      'For {{companyName}}',
      'HR Department',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      employee('designation', 'Designation', 'designation'),
      employee('projectName', 'Project name', 'projectName', false),
      employee(
        'effectiveDate',
        'Terminated with effect from',
        'exit.lastWorkingDay',
      ),
      // Typed: the person a site is handed to is decided on the day, and is not always
      // the reporting manager on record.
      manual('handoverTo', 'Hand over to (name and site)'),
      COMPANY_FIELD,
    ],
  },

  // ──────────────────────────────────────────────────── F&F settlement ──────
  {
    kindKey: 'fnf_settlement',
    name: 'Full & final settlement sheet',
    // "Full_and_Final_Settlement_Format.docx", sections A–H, as pipe tables. A sheet, not a
    // letter: no signature from the renderer, and the sign-offs are the rows of section F
    // and G, completed by hand.
    //
    // Figures come from the exit computation (`fnf.*`) where it has them. Everything the
    // records do not hold — reference numbers, overtime, asset recoveries, who prepared and
    // approved it — is a field HR may leave empty, because a blank cell on this sheet is
    // what the client's own form has until somebody writes in it.
    //
    // Three deliberate departures from the Word file. Amounts carry "(Rs.)" in the
    // heading rather than "₹" in the cell, and tick boxes are "[ ]" rather than "☐": the
    // renderer's built-in font has neither glyph, and both printed as garbage. The "PAN /
    // UAN" row asks for the UAN only — a letter never carries a PAN. The ref. no. and date
    // in the form's header are the letter's own, printed by the renderer.
    body: [
      'HR & ADMINISTRATION DEPARTMENT – CONFIDENTIAL',
      '',
      '| Project / Site | {{placeOfPosting}} | Cost Centre | {{costCentre}} |',
      '',
      'A. EMPLOYEE & EXIT DETAILS',
      '',
      '| Employee Name | {{employeeName}} | Employee Code | {{employeeCode}} |',
      '| Designation | {{designation}} | Department | {{department}} |',
      '| Project / Site / Location | {{placeOfPosting}} | Reporting Manager | {{reportingManager}} |',
      '| Date of Joining | {{dateOfJoining}} | Employment Type | {{employmentType}} |',
      '| Resignation Date | {{resignationDate}} | Resignation Accepted On | {{resignationAcceptedOn}} |',
      '| Notice Period Required | {{noticeRequiredDays}} days | Notice Period Served | {{noticeServedDays}} days |',
      '| Last Working Day | {{lastWorkingDay}} | Exit Reason | {{exitReason}} |',
      '| Monthly Gross Salary (Rs.) | {{monthlyGross}} | Payroll Month / Period | {{payrollPeriod}} |',
      '| Bank Account (last 4 digits only) | {{bankLast4}} | UAN (if needed) | {{uan}} |',
      '',
      'B. EARNINGS / AMOUNTS PAYABLE',
      '',
      '| Sr. No. | Particulars | Basis / Period | Amount (Rs.) |',
      '| --- | --- | --- | --- |',
      '| 1 | Salary payable up to Last Working Day | Days: {{salaryDays}} | {{salaryPayable}} |',
      '| 2 | Overtime / approved extra duty (if applicable) | Period: {{overtimePeriod}} | {{overtimeAmount}} |',
      '| 3 | Leave encashment (if eligible) | Days: {{leaveEncashmentDays}} | {{leaveEncashment}} |',
      '| 4 | Approved reimbursement / expenses | Claim Ref.: {{reimbursementRef}} | {{reimbursements}} |',
      '| 5 | Incentive / bonus / variable pay (if payable) | Period: {{bonusPeriod}} | {{bonus}} |',
      '| 6 | Gratuity (if eligible; separate verification) | As applicable | {{gratuity}} |',
      '| 7 | Other payable amount (specify) | {{otherPayableDetail}} | {{otherPayable}} |',
      '| | TOTAL GROSS AMOUNTS PAYABLE (A) | | {{totalPayable}} |',
      '',
      'C. DEDUCTIONS / RECOVERIES (ONLY WHERE LAWFUL AND VERIFIED)',
      '',
      '| Sr. No. | Particulars | Reference / Calculation | Amount (Rs.) |',
      '| --- | --- | --- | --- |',
      '| 1 | Applicable statutory deductions (e.g., TDS / employee contributions) | Payroll working: {{statutoryRef}} | {{statutoryDeductions}} |',
      '| 2 | Salary advance / employee loan balance | Ledger Ref.: {{loanRef}} | {{loanRecovery}} |',
      '| 3 | Notice-period adjustment (if contractually and legally permissible) | Days / basis: {{noticeBasis}} | {{noticeRecovery}} |',
      '| 4 | Unreturned company asset / verified loss (only if legally recoverable) | Asset / approval: {{assetRef}} | {{assetRecovery}} |',
      '| 5 | Other authorised and lawful deduction (specify) | Basis / approval: {{otherDeductionBasis}} | {{otherDeductions}} |',
      '| | TOTAL DEDUCTIONS (B) | | {{totalDeductions}} |',
      '',
      'D. NET SETTLEMENT',
      '',
      '| Total Gross Amounts Payable (A), Rs. | {{totalPayable}} |',
      '| Less: Total Deductions (B), Rs. | {{totalDeductions}} |',
      '| NET AMOUNT PAYABLE TO EMPLOYEE (A - B), Rs. | {{netPayable}} |',
      '| Amount in Words | {{netInWords}} |',
      '',
      'E. DEPARTMENTAL NO-DUES / HANDOVER CLEARANCE',
      '',
      '| Department / In-charge | Clearance Status | Remarks / Pending Items | Name, Signature & Date |',
      '| --- | --- | --- | --- |',
      '| Reporting Manager / Project Manager | [ ] Clear  [ ] Pending | | |',
      '| Store / Materials / PPE | [ ] Clear  [ ] Pending  [ ] N/A | | |',
      '| Plant & Machinery / Transport | [ ] Clear  [ ] Pending  [ ] N/A | | |',
      '| Accounts / Cash Advance / Imprest | [ ] Clear  [ ] Pending  [ ] N/A | | |',
      '| IT / Admin / ID Card / SIM | [ ] Clear  [ ] Pending  [ ] N/A | | |',
      '| HR & Attendance / Leave | [ ] Clear  [ ] Pending | | |',
      '',
      'Note: A pending departmental clearance must be recorded with details and escalated ' +
        'for review. It does not by itself authorise withholding statutory wages or making ' +
        'an unverified deduction.',
      '',
      'F. PAYMENT & APPROVAL DETAILS',
      '',
      '| Payment Mode | [ ] Bank Transfer  [ ] Cheque | Payment / UTR Ref. | {{paymentRef}} |',
      '| Payment Date | {{paymentDate}} | Payment Status | [ ] Paid  [ ] Part-paid  [ ] Pending |',
      '| Prepared By (HR) | {{preparedBy}} | Checked / Approved By | {{approvedBy}} |',
      '',
      'G. EMPLOYEE ACKNOWLEDGEMENT',
      '',
      'I acknowledge receipt of the F&F statement and confirm that I have had an ' +
        'opportunity to review the calculations. My signature confirms receipt/review of ' +
        'this statement and does not waive any statutory right or prevent me from raising ' +
        'a genuine discrepancy or claim permitted by law. Any amount shown as pending or ' +
        'disputed is to be recorded separately.',
      '',
      '| Employee Name | {{employeeName}} | Signature | |',
      '| Date | | HR Witness | |',
      '',
      'H. HR FILE CLOSURE CHECKLIST',
      '',
      '[ ] Resignation and acceptance filed',
      '[ ] Handover / departmental clearance filed',
      '[ ] Attendance and leave balance verified',
      '[ ] F&F calculation and approval filed',
      '[ ] Payment proof / UTR filed',
      '[ ] Relieving / experience letter issued, where applicable',
      '[ ] Statutory records / benefits updated, where applicable',
    ].join('\n'),
    fields: [
      // A — who and when, off the employee and exit records.
      employee('employeeName', 'Employee name', 'fullName'),
      employee('employeeCode', 'Employee code', 'employeeCode'),
      employee('designation', 'Designation', 'designation'),
      employee('department', 'Department', 'department', false),
      employee('placeOfPosting', 'Project / site', 'placeOfPosting', false),
      manual('costCentre', 'Cost centre', false),
      employee(
        'reportingManager',
        'Reporting manager',
        'reportingManager',
        false,
      ),
      employee('dateOfJoining', 'Date of joining', 'dateOfJoining', false),
      employee(
        'employmentType',
        'Employment type',
        'fnf.employmentType',
        false,
      ),
      employee(
        'resignationDate',
        'Resignation date',
        'resignation.date',
        false,
      ),
      manual('resignationAcceptedOn', 'Resignation accepted on', false),
      employee(
        'noticeRequiredDays',
        'Notice period required (days)',
        'fnf.noticeRequiredDays',
        false,
      ),
      employee(
        'noticeServedDays',
        'Notice period served (days)',
        'fnf.noticeServedDays',
        false,
      ),
      employee(
        'lastWorkingDay',
        'Last working day',
        'exit.lastWorkingDay',
        false,
      ),
      employee('exitReason', 'Exit reason', 'exit.reason', false),
      employee('monthlyGross', 'Monthly gross salary', 'gross', false),
      employee(
        'payrollPeriod',
        'Payroll month / period',
        'fnf.payrollPeriod',
        false,
      ),
      employee(
        'bankLast4',
        'Bank account (last 4 digits)',
        'fnf.bankLast4',
        false,
      ),
      employee('uan', 'UAN', 'fnf.uan', false),
      // B — amounts payable.
      employee('salaryDays', 'Salary days', 'fnf.salaryDays', false),
      employee('salaryPayable', 'Salary payable', 'fnf.salaryPayable', false),
      manual('overtimePeriod', 'Overtime period', false),
      manual('overtimeAmount', 'Overtime amount', false),
      employee(
        'leaveEncashmentDays',
        'Leave encashment days',
        'fnf.leaveEncashmentDays',
        false,
      ),
      employee(
        'leaveEncashment',
        'Leave encashment',
        'fnf.leaveEncashment',
        false,
      ),
      manual('reimbursementRef', 'Reimbursement claim ref.', false),
      employee('reimbursements', 'Reimbursements', 'fnf.reimbursements', false),
      manual('bonusPeriod', 'Incentive / bonus period', false),
      employee('bonus', 'Incentive / bonus', 'fnf.bonus', false),
      employee('gratuity', 'Gratuity', 'fnf.gratuity', false),
      manual('otherPayableDetail', 'Other payable — details', false),
      employee('otherPayable', 'Other payable', 'fnf.otherPayable', false),
      employee(
        'totalPayable',
        'Total gross payable (A)',
        'fnf.totalPayable',
        false,
      ),
      // C — deductions, each with the reference that justifies it.
      manual('statutoryRef', 'Statutory deductions — payroll working', false),
      employee(
        'statutoryDeductions',
        'Statutory deductions',
        'fnf.statutoryDeductions',
        false,
      ),
      manual('loanRef', 'Loan / advance — ledger ref.', false),
      employee(
        'loanRecovery',
        'Loan / advance recovery',
        'fnf.loanRecovery',
        false,
      ),
      manual('noticeBasis', 'Notice adjustment — days / basis', false),
      employee(
        'noticeRecovery',
        'Notice-period adjustment',
        'fnf.noticeRecovery',
        false,
      ),
      manual('assetRef', 'Asset / loss — approval', false),
      manual('assetRecovery', 'Asset / loss recovery', false),
      manual('otherDeductionBasis', 'Other deduction — basis', false),
      employee(
        'otherDeductions',
        'Other deductions',
        'fnf.otherDeductions',
        false,
      ),
      employee(
        'totalDeductions',
        'Total deductions (B)',
        'fnf.totalDeductions',
        false,
      ),
      // D — the net.
      employee('netPayable', 'Net payable (A − B)', 'fnf.net', false),
      employee('netInWords', 'Net payable in words', 'fnf.netInWords', false),
      // F — payment and approval, completed when the money moves.
      manual('paymentRef', 'Payment / UTR ref.', false),
      manual('paymentDate', 'Payment date', false),
      manual('preparedBy', 'Prepared by (HR)', false),
      manual('approvedBy', 'Checked / approved by', false),
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
  // ─────────────────────────────── commercial letters, the client's formats (2026-10-14) ──
  // The LOI, work order and purchase order as the client issues them — their wording verbatim,
  // with what their files highlight as changing per order made into fields and everything else
  // fixed. The item table and its totals are worked out from the lines typed into one box
  // (`line-items.ts`); the layout around the body — letterhead or logo band, the work order's
  // per-page signing blocks — is in `LETTER_LAYOUTS`.
  //
  // The company's Settings → Terms text is no longer appended to these three: each format
  // carries its own conditions in full, and appending a second set would print two.
  {
    kindKey: 'letter_loi',
    name: 'Letter of intent',
    body: [
      'To,',
      '{{vendorName}}',
      '{{?vendorAddress}}',
      '',
      'Project Name: {{projectName}}',
      'Project Location: {{?projectLocation}}',
      '',
      'Subject: Letter of Intent for Execution of {{scope}}',
      '',
      'Dear Sir,',
      '',
      'With reference to your proposal dated {{proposalDate}} and subsequent discussions, {{companyName}} is pleased to issue this Letter of Intent (LOI) to {{vendorName}} for the work described below at the above-mentioned project.',
      '',
      '## 1. Scope of Work',
      "The scope shall include {{scopeDetail}}, in accordance with approved drawings, specifications, BOQ, and written instructions issued by the Company's authorized representative.",
      '',
      '## 2. Contract Value',
      'The estimated/accepted contract value shall be {{contractValue}} ({{contractValueInWords}}), {{gstInclusion}} of applicable GST, as agreed. The final value shall be determined in accordance with the agreed pricing method, approved rates, measured quantities, and actual work executed, as applicable.',
      '',
      '## 3. Project Duration',
      'The work shall commence on {{startDate}} and be completed by {{completionDate}}, subject to the agreed project schedule and applicable contractual conditions.',
      '',
      '## 4. Rates and Payment Terms',
      'RA bills shall be submitted at {{billingInterval}}. Payments shall be processed after measurement, verification, and certification by the authorized site engineer/project manager. Retention, taxes, advances, and other deductions shall be as specified in the final work order or written commercial agreement. Final payment shall be subject to completion and submission of required documents.',
      '',
      '## 5. Quality and Technical Specifications',
      'All works and materials shall comply with approved drawings, specifications, applicable codes and standards, and project quality requirements. Defective or non-conforming work shall be rectified in accordance with the agreed contractual terms.',
      '',
      '## 6. Safety and Statutory Compliance',
      "The contractor shall comply with applicable safety regulations, labour laws, environmental requirements, and statutory provisions. Appropriate PPE and safe working practices shall be maintained for all personnel under the contractor's control.",
      '',
      '## 7. Materials, Tools and Equipment',
      'Responsibility for materials, tools, tackles, machinery, scaffolding, labour, utilities, and storage shall be as recorded in the BOQ or final work order. Material responsibility: {{materialResponsibility}}.',
      '',
      '## 8. Taxes and Statutory Deductions',
      'GST, TDS, labour-related statutory obligations, and other applicable taxes or deductions shall be handled in accordance with applicable law and the agreed commercial terms.',
      '',
      '## 9. Validity and Authorization to Proceed',
      "This LOI records the Company's present intention to proceed with the above work, subject to the terms stated herein. The detailed work order/formal contract shall set out the final scope, rates, payment terms, timelines, and other conditions. This LOI does not authorize commencement of site work, procurement, or mobilization unless expressly confirmed in writing by the Company. The parties should identify in writing which provisions, if any, are binding before the formal contract is executed.",
      '',
      '## 10. Acceptance',
      'Please sign and return a copy of this LOI to confirm acceptance of the terms expressly agreed herein.',
      '',
      'We look forward to your cooperation and successful completion of the project.',
      '',
      'Yours faithfully,',
      'For {{companyName}}',
      '[[signature]]',
      'Company Seal:',
      '',
      '## ACCEPTANCE BY CONTRACTOR',
      'We acknowledge and accept this Letter of Intent, subject to the terms expressly agreed herein.',
      '',
      'For {{vendorName}}',
      '',
      '',
      'Authorized Signatory:',
      'Company Seal:',
      '[[pagebreak]]',
      '## Annexure-01: BILL OF QUANTITIES (BOQ)',
      '',
      '| Company / Contractor: | {{vendorName}} | Date: | {{issueDate}} |',
      '| Project Name: | {{projectName}} | Work Location: | {{projectLocation}} |',
      '| Client: | {{clientName}} | Work Order / Tender No.: | {{orderNumber}} |',
      '',
      '{{lineItemsTable}}',
    ].join('\n'),
    fields: [
      manual('vendorName', 'Issued to (contractor / subcontractor / supplier)'),
      manual('vendorAddress', 'Their address', false),
      manual('scope', 'Name of work / package'),
      manual('proposalDate', 'Their proposal dated'),
      manual('scopeDetail', 'Scope of work (brief description)'),
      manual('lineItems', 'BOQ items'),
      manual('gstRate', 'GST rate (%)'),
      manual(
        'gstInclusion',
        'Contract value is … of GST (exclusive / inclusive)',
      ),
      manual('startDate', 'Work commences on'),
      manual('completionDate', 'To be completed by'),
      manual(
        'billingInterval',
        'RA bills submitted at (e.g. monthly intervals)',
      ),
      manual(
        'materialResponsibility',
        'Material responsibility (Company / Contractor / As agreed)',
      ),
      ...PROJECT_FIELDS,
      project('orderNumber', 'Work order / tender no.', 'orderNumber', false),
      COMPANY_FIELD,
    ],
  },
  {
    kindKey: 'letter_work_order',
    name: 'Work order',
    body: [
      '| Vendor Code | {{vendorCode}} | LOI No. / Date | {{loiReference}} |',
      '| Vendor Name | M/s {{vendorName}} | Project | {{projectName}} |',
      '| Address | {{vendorAddress}} | Buyer Name | {{buyerName}} |',
      '| Mob. No. | {{vendorMobile}} | Buyer Mob. | {{buyerMobile}} |',
      '| Email | {{vendorEmail}} | Buyer Email | {{buyerEmail}} |',
      '| PAN No. | {{vendorPan}} | GSTN No. | {{vendorGstin}} |',
      '| Revised Date | {{?revisedDate}} | | |',
      '',
      '| Billing Address | Delivery Address |',
      '| --- | --- |',
      '| {{companyName}}, {{companyAddress}}. GSTN No.: {{companyGstin}} | {{deliveryAddress}} |',
      '',
      'Dear Sir,',
      'We are pleased to place our order on you for the following services subject to terms & conditions and instructions specified here.',
      '',
      '{{lineItemsTable}}',
      '',
      'Amount in words: {{totalAmountInWords}}',
      '',
      '## TERMS & CONDITIONS: (As mentioned below)',
      '## SPECIAL CONDITIONS OF CONTRACT (SCC)',
      'Following commercial conditions shall be applicable to the contract:',
      '',
      '## Scope of work',
      'Brief scope of work under this sub-contract shall be as mentioned in the Bill of Quantities for {{scopeBrief}}.',
      'The work for aforesaid job shall be carried out as per the attached BOQ, approved drawings, specification, methodology & quality plan and instruction of company Project Manager and / or its authorized representative.',
      '',
      '## Location of work',
      '{{workLocation}}.',
      '',
      '## Items of work',
      'As mentioned in the detailed Bill of Quantities. Please note that the description of items mentioned in the bill of quantities is a short description of items. The individual items are to be executed as per respective detailed specification of items referred in this Sub-contract/main Contract.',
      '',
      '## Commencement Date',
      'Commencement date of this Subcontract shall be {{commencementDate}}.',
      '',
      '## Time for completion',
      '{{completionDate}} shall be the completion date for all the works as mentioned in BOQ from the declaration of commencement date.',
      'The Sub-Contractor shall execute the work in accordance with the work programme duly approved by company and during construction period, the Sub-Contractor shall comply with the following requirements set forth for each of work / milestones and scheduled completion date. Within 15 days of the date of each work milestones, the Sub-Contractor shall notify the company of such compliance along with necessary particulars thereof.',
      '- Completion of each Quarter after commencement date with respect to financial progress as per approved work programme.',
      '- Completion of work: Completion of work means completion of entire scope of work. If there is reduction in scope of work or additional scope of work then if entire scope of work is completed then only it would be treated as Completion of all work. Any abandoned work carried out by other agency for any reason whatsoever that may be due to non-performance or quality issues shall be considered as incomplete works.',
      'Company will prepare final bill and assess additional cost for completion of balance work/ work left incomplete, redoing work which shall be completed by company at risk and cost of the sub-contractor and if carried out at the same rate then damages @5% of balance left out work shall be recovered from the defaulting contractor. No hold only debit to be done.',
      '',
      '## Sub-Contract Agreement Price',
      'In consideration of the execution of the works and fulfilment of its obligations by the Sub Contractor the Company shall pay to the Sub Contractor the "Agreement Price" viz., {{basicAmount}} ({{basicAmountInWords}}) Excluding GST and adjustments thereof, if any, in accordance with this Agreement as under-',
      '- The Sub-Contract Price is the unit rates agreed in the Bill of Quantities (BOQ) of this Work order, agreed by and payable to the Sub-Contractor for the works that shall be executed by the Sub-Contractor as stated herein.',
      '- The unit rates stipulated in Bill of quantity shall be firm and fixed for the entire duration of the Sub-Contractor and binding on the Sub-Contractor.',
      '- The Sub-Contract Price shall be subject to adjustment variations/change in quantities /omissions and/or other relevant provisions of this Agreement or mentioned in the SSC.',
      '- The unit rates payable for items of works as stipulated in BOQ table, are inclusive of all applicable taxes, duties, levies, cess, royalties & seigniorage, Labour cess, excluding GST etc.',
      '- The Sub Contractor shall be paid for the quantities measured/arrived from the Approved drawings duly certified by Company.',
      '- Recovery of advance payment and debit note (if any), and to the extent of advance availed by the Sub-Contractor together thereof and statutory deductions and other recoveries.',
      '- Recovery of any material provided for the execution of the Works from the Bill as provided in SSC.',
      '- For payment, the quantity will be derived by measurement taken from certified by Engineer-In-Charge.',
      '',
      '## Mobilization',
      'Not Applicable',
      '',
      '## Payment Terms',
      'Running Account Bill (RA Bill) Payment',
      '- RA Bills shall be submitted monthly for the works done from 01st of previous month to 30th of the current month.',
      '- Sub-Contractor shall submit its RA Bill latest by 5th of every month. In case if bill is not submitted by 5th, or the bill contains work done beyond 30th, then payment shall be done as per next billing cycle.',
      '- Company shall check and certify the RA Bill Within 30 days from the actual date of submission or within 15 days of certification of RA bill by company whichever is later.',
      '- 75% payment shall be paid on receipt of RA Bills and preliminary certification and balance payment shall be made within 30 days of actual certification of RA Bill by company',
      'OR',
      '- Within 30 days of certification of RA Bill by company.',
      '8.2 Final Bill',
      '- Sub-Contractor shall submit its final bill Within 30 days after issuance of completion certificate by company.',
      '- Company shall check and certify the final Bill Within 15 days from the date of submission.',
      '- Payment of certified amount of Final Bill shall be paid Within 60 days of certification of Final Bill.',
      '- Mode of release of payment: Payment will be released by us within 15 days of the bill being certified.',
      'In case of abandoning of work, all retention / security shall be forfeited.',
      '',
      '## Taxes & Duties',
      'Income Tax and any other tax applicable shall be deducted from RA bills as per prevailing applicable rules / laws. All statutory deduction will be made as per prevailing laws. Nothing in this award shall relieve the Sub-Contractor from its responsibility to pay any tax including any tax that may be levied in India on profits made by it in respect of this award. If applicable',
      'For GST & other tax compliances refer GCC.',
      '',
      '## Retention Money',
      '{{retention}}',
      '',
      '## Defects Liability Period',
      '{{defectsLiability}}',
      '',
      '## 11.2. Satisfactory completion of work',
      'Satisfactory completion of work means completion of work duly accepted by Company/ Client and rectification of all identified defects. Post satisfactory completion of work, if defects are not there, and DLP is over, we may release retention money. In case of abandoning of work, all retention / security money shall be forfeited.',
      '',
      '## Liquidated Damages',
      '{{liquidatedDamages}}',
      '',
      '## Performance Guarantee',
      '{{performanceGuarantee}}',
      '',
      '## Escalation',
      '{{escalation}}',
      '',
      'Note of Approval, Scope Matrix and LOI is the integral part of this WO and should be adhered strictly.',
      '',
      '## Additional clauses',
      'Following additional clauses have been added to General Conditions of Contract (GCC): Brief scope of work under this sub-contract is as mentioned in Detailed Bill of Quantity.',
      '',
      '## 16.A. SCOPE OF WORK AND TECHNICAL SPECIFICATION',
      "Sub Contractor's Scope: -",
      '{{subcontractorScope}}',
      '',
      'Company Scope: {{?companyScope}}',
      '',
      '## 16.B. TERMS AND CONDITIONS',
      '- The Rate mentioned in above is exclusive of GST and inclusive of IT, Duties and other statutory charges etc.',
      "- Cleaning of all surplus materials and scraps from the site before handing it to the company is in sub-contractor's scope.",
      "- Watch & Ward of materials shall be in sub-contractor's scope. Entire Inventory (Joint measurement with Company & Sub Contractor) of project will be handed over to Sub Contractor and the same will be return after completion of O & M period.",
      '- Subcontractor shall not further assign/subcontract the work to anybody else except prior written permission of Company.',
      '- Subcontractor will be responsible, and shall maintain all documentation as required and shall submit Daily report on progress of work to "Company" project site management.',
      '- Security & Safety of Each Labour should be the priority of Subcontractor and if any incident that took place during the course of work, Company will not be liable in any case.',
      '- Regarding any query/complaints made by the client, subcontractor has to make prompt reply within seven working days by letter/Mail to satisfaction of Company, failing which Company have the power to impose the penalty which shall be binding on the subcontractor.',
      '- No Idling charge in any case shall be provided to the subcontractor.',
      '- The subcontractor shall not claim compensation arising out of delay in receipt payment from the employer.',
      '',
      '## 16.C. PROGRESS OF WORK & DLP PERIOD',
      '- Time is the essence of the Subcontract Work and Subcontractor shall put in all efforts to achieve overall completion of the project within the stipulated time period. If the rate of progress is found unsatisfactory, Company reserves the right to get the work executed by other agencies at the risk and cost of Subcontractor.',
      '- The time period for the completion of all works is {{completionPeriod}} from the starting date of the O & M work.',
      '- In case of any delays due to reasons attributable to "Company"; appropriate written extension of LOI shall be granted by "Company". There shall not be any additional cost payable in such an event.',
      '- The Subcontractor shall mobilize adequate labour, material, and other additional resources as directed by Company to complete the Subcontracted Work within the stipulated period of time limit as per the contract.',
      '- Defect Liability Period: - N.A.',
      '',
      '## 16.D. PAYMENT TERMS',
      'Terms of Payment: - No Advance Payment.',
      '- Billing shall be done on monthly basis and after getting certified by the Company.',
      '- The Subcontractor shall submit its monthly progress bills during first week of succeeding month for the works executed duly supported by all quantity calculations and verification in a format approved by Company. The decision of the Company in respect of quantity executed and accepted in any bill is final and binding. The Payment shall be in accordance with BOQ. Payment shall be done after certification of RA Bill.',
      '- Recovery of an amount on account of materials supplied by Company.',
      '- Tax Deduction at Source if any as per prevailing laws of State/Central Government.',
      "- In case, if any amount will be deducted from Company O&M bill due to negligence in the Subcontractor's ({{vendorName}}) scope of work, the same amount shall be deducted from the RA Bills of the Sub-contractor. And if such amount will be refunded to Company by NHAI/ Gov Department in future then the same amount shall be refunded to the Sub-contractor without any interest.",
      '- Any other recovery on account of works executed/expenditure incurred by the Company on behalf of the subcontractor.',
      'Applicable GST is excluding in unit rate mentioned in above BOQ and will be Credited subjected to following conditions if Subcontractor liable to register under the GST Law: If applicable',
      '- Provide GST Registration Certificate as per GST Act 2017. If Applicable',
      '- Tax Invoice (Rule 46)/Debit Note & Credit Note (Rule 53) to be issued as per GST Rules. Tax Invoice/Debit Note/Credit Note must contain all the fields which are required to be mentioned as per rules.',
      '- If Any Material/Services issued/Provided by Company to Subcontractor, then Company will raise the Tax Invoice as per Rules and it should be duly accounted in Subcontractors books before closure of respective tax periods.',
      '',
      '## 16.E. STATUTORY APPROVALS, COMPLIANCES WITH LOCAL LAW, INDEMNITY & LIQUIDATED DAMAGES',
      '- Subcontractor confirms that in case of any breach and/or failure and/or negligence on its part in executed allotted work, Company reserves the right to take over the pending/balance work and to carry out the same by any other agency at the risk, cost and consequences of the Subcontractor.',
      '- The Subcontractor shall indemnify and keep indemnified company against all losses and claims for injuries or damages to any persons or any property what-so-ever it may arise out of or inconsequence of the construction and maintenance of the works and against all claims demands proceedings damaged cost charges and expenses what so ever in respect of in relation thereto.',
      '- In case the Subcontractor fails to make payment either to its suppliers, labours or to any other persons, agencies firms etc. who have done work or supplied material, services etc. to Subcontractor for the Project, Company shall have right to make payment directly to such persons, agencies, firm etc. after verifying the amount payable and same will be recovered from the amount payable to the Subcontractor.',
      '- It is agreed and understood that, as between the Company and the Subcontractor, the legal relationship is strictly on a principal-to-principal basis. Nothing is deemed to constitute or imply any other legal relationship such as principal-agent, master-servant or otherwise. It is expressly agreed that there shall be no principal-agent, master-servant or any other relationship between the Company and the Subcontractor under this LOI and no representation to any such effect would be made by the Subcontractor to anyone. The Subcontractor shall indemnify Company against any claims, expenses, liabilities and losses and for any third-party claims regarding and/or arising under or in connection with the relationship and/or misrepresentation thereby by the Subcontractor.',
      '- At all times during the execution of Works, the Subcontractor shall, at its costs, keep the site reasonably free from all unnecessary obstruction and shall arrange storage of materials at site in orderly manner or dispose of any unwanted materials. On substantial completion of works and upon completion of works or earlier determination, the Subcontractor shall, at its costs, clear away and remove from site all surplus materials, rubbish, debris etc. and leave the whole of the site and works clean to the complete satisfaction of Company. If the Subcontractor fails to remove the surplus materials, rubbish, debris etc. Company shall engage additional manpower to clean the same and the amount so incurred shall, without prejudice to any other method of recovery, be deducted by Company from any amount due or which may become due to the Subcontractor or shall be recovered as a debt.',
      '- All matters related to this LOI, the Works and all other documents shall be regarded by the Subcontractor as being highly confidential and shall not be disclosed to any party, person or entity. The Subcontractor shall at no time hereinafter use any technical information or intellectual property, in relation to this Subcontract and the Main Contract. The Subcontractor shall not have the right to advertise or otherwise permit the dissemination of publicity concerning this Subcontract. This Confidentiality obligation shall survive {{confidentialityPeriod}} after expiry or termination of this LOI.',
      '- The Subcontractor represents, warrants and confirms to Company that:',
      '  a) It is duly organized and validly existing under the Laws of India and has full power and authority to execute and perform its obligations under this LOI and to carry out the transactions contemplated hereby;',
      '  b) It has taken all necessary corporate and other action under the Applicable Laws and its constitutional documents to authorize the execution, delivery and performance of this LOI;',
      '  c) It has the financial standing and capacity to undertake the execution of Works subcontracted to it under this LOI;',
      '  d) There are no actions, suits, proceedings, or investigations pending or, to the Subcontractor knowledge, threatened against it under the Applicable Laws or in equity before any court or before any other judicial, quasi-judicial or other authority, the outcome of which may result in the breach of or constitute a default of the Subcontractor under this LOI or which may result in any material impairment of its ability to perform any of its obligations, duties, responsibilities or liabilities under this LOI;',
      '  e) It has no knowledge of any violation or default with respect to any order, writ, injunction or decree of any court or any legally binding order of any Government or Government Instrumentalities which may result in any material adverse effect on its ability to perform its obligations, duties, responsibilities or liabilities under this LOI and no fact or circumstance exists which may give rise to such proceedings that would adversely affect the performance of its obligations, duties, responsibilities or liabilities under this LOI;',
      '  f) It has complied with the Applicable Laws in all material respects and has not been subject to any fines, penalties, injunctive relief or any other civil or criminal liabilities which in the aggregate have or may have a material adverse effect on its ability to perform its obligations, duties, responsibilities or liabilities under this LOI.',
      '  g) No representation or warranty by the Subcontractor contained herein contain any untrue statement of material fact or omits or will omit to state a material fact necessary to make such representation or warranty not misleading',
      '',
      '## 16.F. SAFETY & INSURANCE',
      "- Subcontractor shall be fully responsible for the security of its manpower, material, equipment's and entry in or around the project site.",
      "- Insurance of personnel and material of the Subcontractor shall be taken by the Subcontractor at its own cost. Subcontractor's labours should be responsible for work with maintaining safety of their own, of other Staff as well as of other Road users while working at site. Any Damages occurred due to Accident while working at Site by Subcontractor, same should be compensated/repaired/ restored by Subcontractor at their risk & cost.",
      "- PPE's will be provided by the Subcontractor to its all the staff and used by them by while working at site.",
      "- In-case the Subcontractor fail to provide PPE's the same will be provide by the Company and cost plus 10% will be deduct from the Subcontractor.",
      "- If any safety violation has to be found by Company or our client, penalty will be imposing which shall be Rs.5000/- per occurrence: and in that case Company supply PPE's and cost will be deducted 10% extra over the landed cost to Company.",
      '  Step 1 Warning Memo (2 Times).',
      '  Step 2 Rs. 5000/- per occurrence.',
      '  Step 3 1% Bill deduct of that day',
      '- EHS Code of Practice for subcontractor',
      '  Subcontractor shall strictly adhere to all the EHS Norms or instructed by Company in all areas of working.',
      '  EHS Code of practice to be followed strictly & understand all the requirements',
      '  EHS Code shall be integral part of workorder and shall be adhered strictly.',
      '',
      '## 16.G. DISPUTE RESOLUTION',
      'All disputes arising between the parties as to the interpretation, operation, or effect of any clause in this LOI or any other difference arising between the parties, which cannot be mutually resolved, shall be referred to the arbitration. The arbitrator shall be sole arbitrator as nominated by Chairman/Managing Director of Company. The decision of such an arbitrator shall be binding on the parties.',
      'If the Concession Agreement between Authority and Concessionaire will terminate, the Company shall terminate this LOI by giving 10 (ten) days Termination Notice to the Subcontractor. If Subcontractor fails to fulfil its obligations stipulated in this LOI, in that case the Company shall be free to terminate this LOI by giving 10 (ten) days termination notice to the Subcontractor.',
      '',
      '## 17. Base Camp',
      'Sub-Contractor will be responsible to set up its base camp at its own cost. Sub-Contractor will make a detailed layout of its camp including its office, workshop, store, plants to be installed there and open storage area for various materials and plants and submit the same for approval of Company.',
      '',
      '## Supply of Material by Sub-Contractor',
      'All material such as HSD, Equipment, Tools & Tackles etc. required for execution of various items in the scope of work of the Sub-Contractor and shall be arranged by Sub-Contractor at its own cost. The Sub-Contractor must show (test results) that all material brought onto site complies with the Specifications and as per source approval.',
      'All incidental work required to complete the scope of work shall be treated as integral part of BOQ to be executed by the sub-contractor at its own cost.',
      '',
      '## Key Equipment from Sub-Contractor',
      'The Sub-Contractor shall make its own assessment and mobilize sufficient number of plant and machinery apart from what is mentioned in the minimum key equipment so as to complete the entire work in the specified time schedule.',
      'All cost towards procurement/mobilization of plant and machinery required for execution works including spares, operation cost, etc. will be deemed to be included in the prices quoted by the Sub-Contractor or unless specified in the subcontract. Company will not entertain any revision in price quoted by the Sub-Contractor for any additional mobilization of machinery required for timely completion of all items in the scope of work in the contract. If Gov, RTO, and other Gov Department have give Legal Notice, Penalty, Challan and any other Recovery taken of Plant and Machinery working at Site of the Sub Contractor then Sub Contractor is totally liable for Paying the Same amount to fulfill Government Procedure. If, in any Situation Sub Contractor Fails to Complete all this Government Procedure and government taking any Legal action and charges against these Criminal Laws then the Amount has been totally recovered from the Subcontractor from its Total Bill at its own risk and cost.',
      'If the Subcontractor fails to maintain valid and proper documents for any vehicle, plant, or machinery deployed at the project site, including a valid Registration Certificate (RC), Pollution Under Control (PUC) Certificate, Fitness Certificate, Permit, and any other applicable RTO documents, the Company shall not be liable to pay any additional amount in this regard. Any fines, penalties, recoveries, or other charges imposed by the Government or any competent authority due to such non-compliance shall be borne entirely by the Subcontractor at its own cost and risk.',
      "Any violation of prevailing laws, rules, regulations, environmental requirements, or Government requirements arising from the Contractor's activities shall be the sole responsibility of Sub Contractor.",
      '',
      '## Work to be as per Specifications',
      "All items of works to be executed in the Sub-Contractor's scope of work shall be done as per detailed specifications mentioned in the sub-contract and any instructions issued by site in-charge/AE/IE/ Authority/Company Engineer from time to time. In case any work is not approved/accepted by site in-charge/Team Leader/AE/IE/Authority, the Sub-Contractor will be required to take remedial measures including removal, replacement at its own cost. Only the works certified and accepted by AE/IE/ Authority shall be measured and paid.",
      '',
      '## Environment Protection',
      'Sub-Contractor will be required to take all reasonable steps to protect the environment on and off the site and to avoid damage or nuisance to persons or to property from air, noise and water way pollution as per the detailed environment management plan approved by Engineer/Independent Engineer.',
      '',
      '## Bonus for Early Completion',
      'Not applicable',
      '',
      '## De-Scope',
      'If Subcontractor fails to perform in achieving the program in time, then "Company" shall be right to limit the Subcontractor scope of work. The de-scoped portion of work shall be executed by "Company" through other agencies at the risk and cost of Subcontractor. The cost incurred by "Company" in such event shall be recovered from account of Subcontractor.',
      '',
      '## Communications',
      'a) Any notice or other communication given or made under or in connection with the matters contemplated by this Sub-Contract shall be in writing.',
      'b) Any such notice or other communication shall be addressed as provided in paragraph (c) and, if so addressed, shall be deemed to have been duly given or made (unless it is obvious that it has not been) as follows:',
      '- If sent by personal delivery, upon delivery at the address of the relevant Party (or, as the case may be, the Company Representative);',
      '- If sent by Registered post, (5) days after dispatch; and',
      "- If sent by facsimile transmission, when dispatched, but only if the sender's transmission report shows the entire facsimile to have been received by the recipient and only if the transmission was received in legible form.",
      'c) The relevant addressee, address and facsimile numbers of the Parties and the Company Representative for the purposes of this paragraph (c), subject to paragraph (d) are:',
      '',
      'Company',
      'Attention: {{buyerName}}',
      'Mob: {{buyerMobile}}',
      'Address: {{companyAddress}}',
      '',
      'Sub-Contractor:',
      'Attention: {{subcontractorAttention}}',
      'Addressee: M/s {{vendorName}}',
      'Address: {{vendorAddress}}',
      'Tel. No.: {{vendorMobile}}',
      'E-Mail ID: {{vendorEmail}}',
      'PF No: {{?vendorPfNo}}',
      'ESIC No: {{?vendorEsicNo}}',
      '',
      'd) A Party and the Company Representative may notify the other Party (and, where applicable, the Company Representative) of a change to its name, addressee, address and facsimile number for the purposes of paragraph (c) provided that such notification shall only be effective on:',
      '- the date specified in the notification as the date on which the change is to take place; or',
      '- If no date is specified or the date specified is less than five days after the date on which notice is given, the date falling five days after notice of any such change has been given.',
      '',
      'IN WITNESS whereof the Parties have pursuant to Power of Attorney/authorizations of the respective companies through them authorized representatives executed and delivered this sub-Contract as of the date and place first above written.',
      '',
      '## Enclosures:',
      '- Scope Matrix as mentioned in LOI - attached in the respective PR line item',
      '- General Conditions of the Contract - GCC',
      '- Environment Health & Safety Code # EHS Code',
      '',
      '## Important Notes:',
      '- Agency/Sub-Contractor has to submit the work program of the awarded work within 7 days from the issuance of work order. In case of non-submission of work program timely release of payment may be delayed.',
      '- Agency/Sub-Contractor is requested to submit physical copies of all invoices to concerned personnel of Company as per current practice at site. But simultaneously you should e-mail copy of invoice to {{companyEmail}}. It will help us to serve you better. Kindly mention Project Name, Work Order or Purchase Order Number, Invoice Number, Invoice Date in the subject of the mail. We value your relationship with Company.',
      '- Grievances, if any, may also be reported to {{companyEmail}}.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      manual('vendorCode', 'Vendor code', false),
      manual('vendorName', 'Subcontractor name'),
      manual('vendorAddress', 'Subcontractor address'),
      manual('vendorMobile', 'Subcontractor mobile'),
      manual('vendorEmail', 'Subcontractor email'),
      manual('vendorPan', 'Subcontractor PAN', false),
      manual('vendorGstin', 'Subcontractor GSTN', false),
      manual('loiReference', 'LOI no. / date', false),
      manual('revisedDate', 'Revised date', false),
      manual('buyerName', 'Our contact person'),
      manual('buyerMobile', 'Our contact mobile'),
      manual('buyerEmail', 'Our contact email'),
      manual('deliveryAddress', 'Delivery address (site)'),
      manual('lineItems', 'Work order items'),
      manual('gstRate', 'GST rate (%)'),
      project('gstOnBills', 'GST on bills', 'gstOnBills'),
      manual('scopeBrief', 'Brief scope (as in the BOQ)'),
      manual('workLocation', 'Location of work'),
      manual('commencementDate', 'Commencement date'),
      manual('completionDate', 'Completion date'),
      manual('completionPeriod', 'Time period for completion (e.g. 36 months)'),
      manual('retention', 'Retention money'),
      manual('defectsLiability', 'Defects liability period'),
      manual('liquidatedDamages', 'Liquidated damages'),
      manual('performanceGuarantee', 'Performance guarantee'),
      manual('escalation', 'Escalation'),
      manual('subcontractorScope', "Sub-contractor's scope"),
      manual('companyScope', 'Company scope', false),
      manual(
        'confidentialityPeriod',
        'Confidentiality survives (e.g. 3 years)',
      ),
      manual('subcontractorAttention', 'Subcontractor contact person'),
      manual('vendorPfNo', 'Subcontractor PF no.', false),
      manual('vendorEsicNo', 'Subcontractor ESIC no.', false),
      project('projectName', 'Project', 'name'),
      company('companyAddress', 'Company address', 'address'),
      company('companyGstin', 'Company GSTN', 'gstin', false),
      company('companyEmail', 'Company email', 'email'),
      COMPANY_FIELD,
    ],
  },
  {
    kindKey: 'letter_purchase_order',
    name: 'Purchase order',
    body: [
      "| Vendor's Name & Address | {{vendorName}}, {{vendorAddress}} |",
      '| Vendor Code | {{?vendorCode}} |',
      '| Kind Attn. | {{?vendorAttention}} |',
      '| PO Number / Date | {{referenceNo}} / {{issueDate}} |',
      '| Contact | {{buyerName}} / {{buyerMobile}} |',
      '| E-mail | {{buyerEmail}} |',
      '| GST No. | {{companyGstin}} |',
      '',
      'Please deliver to: {{deliveryAddress}}',
      '',
      'Please arrange to supply the following item(s)/services against this PO in accordance with the terms and conditions stipulated in this order and the "GENERAL TERMS & CONDITIONS OF PURCHASE" appearing below.',
      'Please do not round off discounted "Net Rate" while creating the invoice.',
      'Please mention your PAN on the invoice.',
      '',
      'Payment Terms: {{paymentTerms}}',
      'Terms of Delivery: {{deliveryTerms}}',
      '',
      '## Project / Delivery Notes',
      'Project: {{?poProject}}',
      'Delivery: Within 1–2 weeks of order confirmation. Any earlier delivery to meet the project schedule shall be mutually discussed and agreed.',
      'Documents & software tools: {{?documentsAndTools}}',
      'Training: {{?training}}',
      'Site support: {{?siteSupport}}',
      'Inventory / emergency support: {{?inventorySupport}}',
      '',
      "Product Warranty: Products are warranted for {{warrantyFromDispatch}} from dispatch or {{warrantyFromCommissioning}} from commissioning, whichever comes earlier, against manufacturing defects, faulty workmanship or sub-standard material. Faulty equipment will be repaired/replaced at the supplier's discretion. Prompt after-sales service is also provided during the post-warranty period as required.",
      'Please attach a tag carrying material-code number and quantity on each container.',
      '',
      '{{lineItemsTable}}',
      '',
      'Amount in words: {{totalAmountInWords}}',
      '',
      '## GENERAL TERMS & CONDITIONS OF PURCHASE',
      '1. Any special conditions issued under this Purchase Order shall be read together with the General Terms & Conditions of Purchase (GTC). In case of conflict, the PO terms shall prevail.',
      '2. The Supplier shall acknowledge the PO within seven (7) days of mailing and confirm acceptance in its entirety. Failure to acknowledge within seven days shall be deemed unequivocal acceptance.',
      '3. The PO terms constitute the entire agreement between the parties. Changes are binding only when made in writing and signed by authorized representatives of company and the Supplier.',
      '4. DELIVERY TERMS:',
      '4.1 Delivery Date: Time of delivery stated in the PO is essential to the contract. Variations are not permitted without prior written authorization from buyer.',
      '4.2 Place of Delivery: Goods shall be delivered/despatched strictly according to PO instructions or written modifications by company, at the designated delivery place and within the time stipulated by receiving stores.',
      "4.3 Delayed Delivery: The delivery date is essential. If delivery is delayed, buyer may (i) accept delayed deliveries at a reduced price by the percentage stated in the PO for each week or part thereof, or (ii) cancel the order in part or full and purchase cancelled quantities elsewhere at the Supplier's risk and cost, without prejudice to buyer other rights.",
      "4.4 Force Majeure: Where force majeure occurs within the agreed delivery terms, buyer may extend the delivery date on the Supplier's request and subject to conditions decided by company. Qualifying events include natural calamities, civil wars and national strikes lasting more than seven consecutive calendar days. The Supplier must promptly advise buyer by registered letter certified by the local Chamber of Commerce or statutory authorities, no later than four days from the beginning/end of each cause.",
      "4.5 Quality / Inspection: Goods must match the description, samples and specifications and be delivered within the stipulated time. Otherwise, buyer may purchase goods from another source at the Supplier's cost and recover the difference or claim damages for non-delivery.",
      '4.6 Packing: Goods must be suitably and properly packed. Package declarations must comply with the Legal Metrology Act and Legal Metrology (Packaged Commodities) Rules and any special PO requirements, to ensure safe transport by road or rail.',
      '5. Examination of Goods: All goods are subject to detailed inspection upon receipt at buyer Works or another destination specified in the PO. Until acceptance, buyer is not deemed to have accepted the goods. Rejected goods will be treated as not delivered in accordance with the PO.',
      "6. Rejection / Removal / Replacement: Buyer may inspect goods at any stage of manufacture and reject goods within 15 days of receipt if they do not conform to PO specifications. The Supplier must remove rejected goods at its own cost within 15 days of notification. The goods remain entirely at the Supplier's risk; reasonable storage charges may apply after 15 days.",
      '7. Supplier Stock Reconciliation: For subcontracted POs or where buyer supplies input material free of charge, the Supplier must maintain stock and consumption records as required by the operating procedure. Stock variance shall be reconciled for each transacted PO.',
      "Stock Reconciliation (continued): (a) Surplus shall be returned to buyer. (b) Shortage shall be recovered by buyer at the Supplier's cost.",
      '8. Bill & Invoice: Challan/invoice/tax invoice shall be in triplicate and include: (1) Vendor Code, (2) PAN, (3) GST No., (4) PO No. and date, (5) PO line item number, (6) material code and description, (7) quantity, (8) rate, (9) excise duty and education cess, if applicable, calculated separately and rounded off at each line item, (10) manufacturing/shelf-life date, (11) job-worker challan number where applicable, (12) ECC number, and (13) indication of return of COMPANY material, non-invoiceable goods, defective goods or rejection.',
      'Invoice Copies: On receipt of goods, buyer will retain two copies and return the third copy to the Supplier duly endorsed. If the challan and invoice differ, the Supplier shall submit the invoice to the concerned Accounts Department for verification; a duplicate excise invoice should accompany the materials to stores.',
      '9. Taxation — 9.1: For products under this Agreement/PO, the Supplier is solely responsible for payment/discharge of all State service tax, central excise/customs duties, cesses, surcharges and other taxes, duties and new levies if applicable including GST as applicable from time to time is must Compulsory.',
      '9.2 Changes in Tax Law: If amendments to Central/State law or tax-authority interpretations affect taxes or duties, the Supplier shall study and understand the new tax regime and its responsibilities/liabilities and indemnify and keep buyer indemnified against related liabilities.',
      '9.3 Tax Claims: If the Supplier receives a notice or assessment claiming that the Supplier or buyer is liable for a tax the Supplier agreed to pay, the Supplier must notify buyer in writing within ten (10) days. If the Supplier contests the tax in good faith, at its own expense. If Supplier has Fail to Return their GST of Purchasing Goods of Buyer on timely Basis and Government have taken recovery from that then Supplier has totally liable for clear this liability at their own cost and risk.',
      "10. Warranty: The Supplier warrants that materials and workmanship are first-class quality and suitable for the intended purpose, and comply with agreed specifications. Defective materials/goods shall be repaired or replaced at the Supplier's expense within 12 months after being put into use or 20 months from buyer acceptance, whichever is earlier.",
      '11. Right of Buyer to Set Off: buyer may recover sums due for damages or otherwise relating to supplies under any PO by deducting such sums from amounts due to the Supplier under earlier or subsequent POs.',
      '12. Cancellation: Company may cancel the PO in whole or part by written notice if the Supplier fails to comply with PO terms, becomes bankrupt or goes into liquidation, fails to deliver on time or replace rejected goods promptly, or makes a general assignment of its property. buyer may also cancel the order as permitted by the PO terms.',
      '',
      'For {{companyName}}',
      '[[signature]]',
      '',
      'We acknowledge and accept this Purchase Order, subject to the terms expressly agreed herein.',
      '',
      'For {{vendorName}}',
      '',
      '',
      'Authorized Signatory:',
    ].join('\n'),
    fields: [
      manual('vendorName', 'Vendor name'),
      manual('vendorAddress', 'Vendor address'),
      manual('vendorCode', 'Vendor code', false),
      manual('vendorAttention', 'Kind attention (vendor contact)', false),
      manual('buyerName', 'Our contact person'),
      manual('buyerMobile', 'Our contact mobile'),
      manual('buyerEmail', 'Our contact email'),
      company('companyGstin', 'Company GST no.', 'gstin', false),
      manual('deliveryAddress', 'Please deliver to'),
      manual('paymentTerms', 'Payment terms'),
      manual('deliveryTerms', 'Terms of delivery'),
      manual('poProject', 'Project', false),
      manual('documentsAndTools', 'Documents & software tools', false),
      manual('training', 'Training', false),
      manual('siteSupport', 'Site support', false),
      manual('inventorySupport', 'Inventory / emergency support', false),
      manual('warrantyFromDispatch', 'Warranty from dispatch (e.g. 66 months)'),
      manual(
        'warrantyFromCommissioning',
        'Warranty from commissioning (e.g. 60 months)',
      ),
      manual('lineItems', 'Purchase order items'),
      manual('gstRate', 'GST rate (%)'),
      COMPANY_FIELD,
    ],
  },
];

/**
 * Tokens a body may use that no field declares, because the render supplies them: the date and
 * reference the letter bears, and the item table and totals worked out from its lines.
 */
export const SUPPLIED_TOKENS: ReadonlySet<string> = new Set([
  'issueDate',
  'referenceNo',
  ...LINE_ITEM_OUTPUTS,
]);

/** `{{token}}` or `{{?token}}`, matching `template-resolver.ts`. */
const TOKEN_RE = /\{\{\s*\??\s*([\w.]+)\s*\}\}/g;

/** Every token referenced by a body, deduplicated. */
export function tokensIn(body: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(body)) !== null) found.add(match[1]);
  return [...found];
}

/** The standard template for a shipped kind, or undefined when this product ships none. */
export function standardTemplateFor(
  kindKey: string,
): StandardLetterTemplate | undefined {
  return STANDARD_LETTER_TEMPLATES.find((t) => t.kindKey === kindKey);
}
