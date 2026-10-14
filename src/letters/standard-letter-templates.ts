import { LetterFieldSource } from '@prisma/client';

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

/**
 * Who a project letter is addressed to, and for what. Typed: a work order, LOI or purchase
 * order goes to a vendor or subcontractor the project record does not name, for a scope only the
 * person issuing it can state.
 */
const AWARD_RECIPIENT_FIELDS = [
  manual('vendorName', 'Issued to (vendor / subcontractor)'),
  manual('vendorAddress', 'Their address', false),
  manual('scope', 'Scope of work / supply'),
];

/**
 * The company's standard terms for the document, as Settings → Terms holds them (2026-10-14).
 * Pre-filled into the composer, where they can be edited for one letter without changing the
 * standard set.
 */
const termsField = (sourcePath: string): StandardField =>
  company('termsAndConditions', 'Terms and conditions', sourcePath);

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
  // ─────────────────────────────────────────── project letters (2026-10-14) ──
  // Issued from a project's Letters tab, with the project as the subject. Until these shipped
  // the three kinds had no declared field at all, so the composer asked for nothing and every
  // one printed "Letter of intent for ." on the company's letterhead, signed.
  {
    kindKey: 'letter_loi',
    name: 'Letter of intent',
    body: [
      'To,',
      '{{vendorName}}',
      '{{vendorAddress}}',
      '',
      'Sub: Letter of intent for {{scope}} - {{projectName}}.',
      '',
      'Dear Sir / Madam,',
      '',
      'With reference to your offer and the discussions held, we are pleased to convey our ' +
        'intent to award you the work of {{scope}} at {{projectName}}, {{projectLocation}} ' +
        '(client: {{clientName}}), for an estimated value of {{orderValue}}.',
      '',
      'Kindly confirm your acceptance of this letter by return.',
      '',
      'Terms and conditions:',
      '{{termsAndConditions}}',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      ...AWARD_RECIPIENT_FIELDS,
      manual('orderValue', 'Estimated value'),
      ...PROJECT_FIELDS,
      termsField('terms.letterOfIntent'),
      COMPANY_FIELD,
    ],
  },
  {
    kindKey: 'letter_work_order',
    name: 'Work order',
    body: [
      'To,',
      '{{vendorName}}',
      '{{vendorAddress}}',
      '',
      'Sub: Work order for {{scope}} - {{projectName}}.',
      '',
      'Dear Sir / Madam,',
      '',
      'You are hereby awarded the work of {{scope}} at {{projectName}}, {{projectLocation}} ' +
        '(client: {{clientName}}), for a value of {{orderValue}}.',
      '',
      '| Particulars | Details |',
      '| --- | --- |',
      '| Work order value | {{orderValue}} |',
      '| Completion by | {{completionDate}} |',
      '| Payment terms | {{paymentTerms}} |',
      '',
      'Kindly sign and return a copy of this order as your acceptance.',
      '',
      'Terms and conditions:',
      '{{termsAndConditions}}',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      ...AWARD_RECIPIENT_FIELDS,
      manual('orderValue', 'Work order value'),
      manual('completionDate', 'Completion by'),
      manual('paymentTerms', 'Payment terms'),
      ...PROJECT_FIELDS,
      termsField('terms.workOrder'),
      COMPANY_FIELD,
    ],
  },
  {
    kindKey: 'letter_purchase_order',
    name: 'Purchase order',
    body: [
      'To,',
      '{{vendorName}}',
      '{{vendorAddress}}',
      '',
      'Sub: Purchase order for {{scope}} - {{projectName}}.',
      '',
      'Dear Sir / Madam,',
      '',
      'Please supply the following to our site at {{projectName}}, {{projectLocation}} ' +
        '(client: {{clientName}}):',
      '',
      '| Particulars | Details |',
      '| --- | --- |',
      '| Material / supply | {{scope}} |',
      '| Order value | {{orderValue}} |',
      '| Delivery by | {{completionDate}} |',
      '| Payment terms | {{paymentTerms}} |',
      '',
      'Kindly quote this order number on every invoice and delivery challan.',
      '',
      'Terms and conditions:',
      '{{termsAndConditions}}',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      ...AWARD_RECIPIENT_FIELDS,
      manual('orderValue', 'Order value'),
      manual('completionDate', 'Delivery by'),
      manual('paymentTerms', 'Payment terms'),
      ...PROJECT_FIELDS,
      termsField('terms.purchaseOrder'),
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

/** The standard template for a shipped kind, or undefined when this product ships none. */
export function standardTemplateFor(
  kindKey: string,
): StandardLetterTemplate | undefined {
  return STANDARD_LETTER_TEMPLATES.find((t) => t.kindKey === kindKey);
}
