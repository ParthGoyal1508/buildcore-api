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
 * ## Strictly the client's formats (2026-10-15)
 *
 * The HR bodies were paraphrases of the Word files until 2026-10-15, when the client asked for
 * their formats to be followed strictly: what is highlighted yellow is filled at issue, and
 * everything else is fixed. So the wording here is theirs, word for word — their capitals, their
 * slips of grammar and all — with these exceptions only: "Mr." / "he" / "his" are the salutation
 * and pronoun tokens, "S/O" / "S/o" is the relation token, "₹" is "Rs." and "☐" is "[ ]" (the PDF
 * font has neither glyph), and names in the fixed text that belonged to the sample (the company's
 * own name and "PRPL", "Jaipur Ring Road", a signatory's name) are tokens. Where they put the
 * heading, the reference line and the employee's acceptance is `LETTER_LAYOUTS`'s and the body's
 * `[[title]]` / `[[signature]]` markers' business.
 *
 * The appointment letter's Annexure I has the client's rows — Dearness and Medical Allowance and
 * a Meal Voucher among them, which the salary structure does not hold and the record states as
 * nil. (This replaces the 2026-10-11 decision to show only the system's own heads.) Site
 * Allowance, which the system pays and their annexure lacks, is a row only for those paid one.
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

/**
 * "S/o" / "D/o" before the parent's name, from the employee's gender (2026-10-15) — the client's
 * letters print "S/O: Mr. …" and "S/o-Mr. …". Not required, for the reason the salutation is not.
 */
const RELATION = employee(
  'relation',
  'Relation — S/o, D/o or W/o',
  'relation',
  false,
);

/**
 * A run of numbered clauses, "12. …", a blank line between each (2026-10-15). The appointment
 * letter's clauses are one numbered list across its three sections, as in the client's document,
 * so each section says where its numbers start.
 */
function numbered(from: number, clauses: string[]): string[] {
  return clauses.flatMap((clause, i) =>
    i === 0 ? [`${from}. ${clause}`] : ['', `${from + i}. ${clause}`],
  );
}

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
    // "New offer letter format (1).docx", issued from Recruitment to a candidate. The heading,
    // "REF No:" and "Date:" open it (`LETTER_LAYOUTS.offer`); "Employee Signature" faces the
    // company's closing line. The probation, duty hours and notice are the format's own fixed
    // words — only the highlighted runs vary.
    body: [
      'To',
      '{{candidateName}}',
      '{{relation}} : {{?fatherName}}',
      '{{address}}',
      'Mobile:- {{mobile}}',
      'Email: {{email}}',
      '',
      '## Subject: Offer Letter for The Post of {{postOffered}}',
      'Dear {{candidateName}},',
      '',
      'With reference to your application and subsequent interview held with us, we are ' +
        'pleased to inform you that you have been selected for the post of ' +
        '‘{{postOffered}}’ at {{placeOfPosting}} with the terms & conditions mutually ' +
        'agreed during the Interview. You are expected to join on or before ' +
        '{{joiningDate}}. Detailed appointment letter shall be provided on joining the ' +
        'company. Where you will report to {{reportingManager}} Mo. No. ' +
        '{{reportingManagerMobile}}.',
      '## Remuneration',
      'Your offered salary structure will be provided in your joining letter which will ' +
        'include your annual CTC and other perquisites and allowances offered by the company ' +
        'including statutory contribution on employee’s behalf.',
      '',
      'Duty Timing: Your working hours will be from 8:00 AM to 6:00 PM.',
      '## Probation/Confirmation',
      'Your probation period will be six months. Based on your performance your services ' +
        'will be confirmed and will be given in the writing.',
      '## Exit/Separation',
      'During the probation period, either party may terminate the employment by giving 30 ' +
        'days’ notice or may be on immediate effect upon the condition without giving Proper ' +
        'Justification. The company reserves the right to terminate employment without notice ' +
        'in case of misconduct, unsatisfactory performance, or violation of company policies. ' +
        'Any absence for a continuous period of seven days without prior approval of your ' +
        'reporting authority, the same shall automatically appear to an end without any ' +
        'notice or intimation. Employees who wish to resign from the company are required to ' +
        'serve a 30-day notice period. If the notice period is not served, the company may ' +
        'recover an amount equivalent to one month’s salary, subject to the terms of the ' +
        'employment agreement and applicable laws.',
      '## General Terms & Conditions: -',
      'I. You shall not disclose organizational matters, whether confidential or not with ' +
        'anyone outside the company while in employment or afterwards.',
      'II. You shall perform all your duties and functions as may be assigned to you by the ' +
        'management. Your duties, authorities and functions can be modified from time to time ' +
        'by the Management at its sole discretion keeping in view the overall interest of the ' +
        'company.',
      'III. During the Employment with the Company, you shall not undertake any business or ' +
        'work, either directly or indirectly without the written permission of the Top ' +
        'Management.',
      'IV. You shall discharge your responsibilities with discipline and efficiency during ' +
        'your tenure with the Company.',
      'V. You must follow the rules and regulations of the Company as may be in force from ' +
        'time to time. Any time, in the opinion of the Company which shall be final & ' +
        'binding, you are found guilty of dishonesty, mis-appropriation, dis-obedience, any ' +
        'fraud, mis-behavior, negligence, indiscipline; absence from duty without permission ' +
        'or any other mis-conduct, your services may be terminated without giving any notice ' +
        'or salary in lieu of the notice.',
      'VI. You shall be responsible for safeguarding all the Company’s property which may be ' +
        'in your use or under your charge.',
      'You are requested to forward the following documents and certificates within two days ' +
        'after accepting the offer.',
      '1. Educational Certificates',
      '2. Address Proof-Aadhar cards/Pan cards.',
      '3. Update CV with 3 Passport size Photographs.',
      '4. Bank Account Details.',
      '5. Experience certificates',
      '6. Resignation Letter Acceptance/Relieving Letter on Joining.',
      '7. Police Verification',
      'Please sign and return the duplicate copy of this letter as a token of acceptance of ' +
        'this offer. We welcome you on board at {{companyShortCode}} and wish you to have long ' +
        'and truthful association with us for your continuous professional growth.',
      '',
      'Thanks & Regards.',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      candidate('candidateName', 'Candidate name', 'fullName'),
      // The candidate record holds no gender to derive it from, and "S/O" for a woman is wrong
      // in a signed letter; typed, like the rest of the address block it belongs to.
      manual('relation', 'Relation — S/O, D/O or W/O'),
      candidate('fatherName', 'Father’s / spouse’s name', 'fatherName', false),
      candidate('address', 'Address', 'address', false),
      candidate('mobile', 'Mobile', 'phone', false),
      candidate('email', 'Email', 'email', false),
      // The terms come off the candidate's latest offer, which is where Recruitment
      // recorded them; HR still sees and can change each one before the letter is issued.
      candidate('postOffered', 'Post offered', 'offer.designation'),
      candidate('placeOfPosting', 'Place of posting', 'offer.placeOfPosting'),
      candidate('joiningDate', 'Join on or before', 'offer.joiningDate'),
      candidate(
        'reportingManager',
        'Reports to (designation and name)',
        'offer.reportingManager',
      ),
      candidate(
        'reportingManagerMobile',
        'Reporting manager’s mobile',
        'offer.reportingManagerMobile',
        false,
      ),
      // The format's "PRPL" — the company's own short name, which is its reference prefix too.
      company('companyShortCode', 'Company short name', 'shortCode'),
      COMPANY_FIELD,
    ],
  },

  // ─────────────────────────────────────────────────────── appointment ──────
  {
    kindKey: 'appointment',
    name: 'Appointment letter',
    // "APPOINTMENT OFFER_LETTER_OF_Mr_… PROJECT MANAGER.docx", every clause of it, issued from
    // HR & Payroll to the employee (2026-10-15). The company signs after "Yours Faithfully"; the
    // employee's acceptance follows the signature, and Annexure I starts a page of its own.
    //
    // The annexure's rows are the client's: Basic, HRA, Dearness, Conveyance, Medical and Special,
    // then PF, ESI and Meal Voucher, Total CTC and Net Take-Home — figures off the employee's
    // salary structure, nil where the structure holds no such head. A Site Allowance row, which
    // their document does not have, appears only for somebody paid one.
    body: [
      'To',
      '{{salutation}} {{employeeName}}',
      '{{relation}}: {{?fatherName}},',
      'Address – {{address}}',
      'Contact. No.: {{mobile}}',
      'Email ID: {{email}}',
      '',
      'Dear {{employeeName}},',
      '',
      'Based on the Telephonic Discussion, you had shown interest in working with us as ' +
        'full-time {{designation}} in our organisation. With this letter, we would like to ' +
        'offer you a contract to provide your services exclusively to us on a full-time ' +
        'basis, at {{placeOfPosting}}. By signing and accepting this offer, you are ' +
        'confirming that:',
      '',
      '• The information you have provided in submitted information are 100% correct.',
      '',
      '## Area of responsibilities:',
      '• {{responsibilities}}',
      '',
      '## Compensation:',
      'Your compensation package will be calculated as shown below.',
      '',
      '• Contract start date: {{contractStartDate}}.',
      '• Compensation will be CTC {{ctcAnnualLakh}} Annual {{extraBenefits}}',
      '• In this regard, it is highlighted that the management reserves the right to revise ' +
        'your terms of employment,',
      '• which Inter alia includes salary bifurcation, merging or change in allowances, etc. ' +
        'In this regard, please find your detailed Salary Structure, attached as Annexure - I ' +
        'to this Appointment Letter.',
      '',
      'The Terms & Conditions applicable to your employment starting with effect from your ' +
        'date of joining Are as follows:',
      '',
      '## Probation & Confirmation',
      ...numbered(1, [
        'Your employment with us, beginning from the receipt of this is Appointment Letter is ' +
          'on a probationary basis for a period of 6 Months from the date of your joining ' +
          'duties.',
        'After the successful completion of the aforesaid period of 6 Months, your employment ' +
          'Will not be automatically confirmed, unless a Formal Confirmation Letter is not ' +
          'issued by the Company either unless the probation period is extended, through a ' +
          'written notice.',
        'The management reserves the right to extend, at their sole discretion, the ' +
          'probationary period, that is applicable to your employment.',
        'During the probation period, if your job performance is sub-par or does not meet the ' +
          'criteria required for the purpose Of Which you were selected, or if you have ' +
          'breached these employment terms and conditions, engaged in any misconduct, or ' +
          'breached any rules and regulations of the company your service is liable to be ' +
          'terminated with immediate effect without assigning any reason. Further, the ' +
          'decision of the management in this regard shall be final and binding.',
        'During your term of employment with the company, you shall not serve any other ' +
          'employer or engage yourself in any other business or occupation. If we found that ' +
          'we have right to Hold your Salary & Terminate with Immediate Effect.',
      ]),
      '',
      '## Notice Period',
      ...numbered(6, [
        'If you Wish to end your employment with the company, then you may do so, by issuing ' +
          'to the company a minimum One-Month Written Letter, pursuant to which you shall be ' +
          'required to be present and complete your employment with the company for a period ' +
          'of 1 Month, which can be extended by the company, solely at their discretion. It is ' +
          'hereby clarified that you are not entitled to resign during your probation period ' +
          'and shall continue to dutifully discharge your obligations, Without demur.',
        'In case of your failure in complying with aforementioned requirements pertaining to ' +
          'the Notice Period, then the company reserves its right to forfeited any payment(s) ' +
          'to you.',
        'As such, you are also required to intimate the company about your intention to leave ' +
          'the employment of the company, by giving a written One Month or forfeiting your ' +
          'salary, in lieu of the Notice.',
        'The company, therefore within their rights to withhold your payments, in lieu Of ' +
          'Inter alia, your salary and any other due(s), unilaterally and without issuing a ' +
          'formal or informal notice to you, for your noncompliance With the Terms & ' +
          'Conditions applicable to your employment.',
        'The Company reserves the right to terminate employment of any employee for just cause ' +
          'at any time without notice and without payment in lieu of notice. The Company will ' +
          'be entitled to terminate your employment for any reason other than for just cause, ' +
          'upon providing to you such minimum notice as required by law.',
        'Upon the Termination or Resignation of your employment, you will return all Papers, ' +
          'Mobile, ID Card and other Company Related Documents or Things which has been ' +
          'Provided by the company at your employment time and you will not retain any copies ' +
          'of extracts therefore. If the Company has found any obligation in these then Company ' +
          'has liable to take any Legal Action or Forfeited your Salary.',
      ]),
      '',
      '## General Policies of the Company',
      'That the following are the General Policies of the Company, which are also applicable ' +
        'to you for the entire duration of your employment with the company:',
      '',
      ...numbered(12, [
        'You will be responsible for executing your assigned duties with the utmost ' +
          'professionalism, dedication and adherence to quality of standards. It is expected ' +
          'that you will perform your job / tasks diligently to ensure the quality of the work ' +
          'performed. Any structural work or work done related to you damages during the ' +
          'working period of time caused by negligence or lack of adherence to quality ' +
          'standards will be your sole responsibility.',
        'In the event that work executed by you is found to be damaged in the future, ' +
          'resulting in charges imposed by the government authorities, you will be held ' +
          'accountable for such charges. It is imperative that you exercise caution and carry ' +
          'out your tasks in accordance with established regulations and standards to avoid any ' +
          'liability in this regard.',
        'If you have done offensive/Criminal work during your tenure against Law then the ' +
          'company can take legal action against you and all the work have you done that has ' +
          'been your Responsibility. Company have not liable and involved in anything you have ' +
          'done on the Project Site.',
        'During the Service If you have Drink or Drive the Vehicle, Misbehave with Other Staff ' +
          'and Breach of the Law and Order of the Gov. regulations as per Policy and Conduct any ' +
          'Work against law and order then company cannot be responsible for anything and the ' +
          'company can take the legal action against you at that time.',
        'No bonus & other Benefits will be given on any occasion.',
        'Absence for a continuing period of 10 (Ten) days including absence when leave though ' +
          'applied for but not granted and when over- stayed for a period of 10 days would make ' +
          'you to lose your lien on the service and the same shall automatically come to an end ' +
          'without any notice or even intimation. In such an eventuality, the management Will ' +
          'draw an irresistible presumption that by remaining absent continuously and ' +
          'unauthorized by, you have abandoned your job you have not liable for any claim and ' +
          'Outstanding Amount Pending from the Company. The Company will be forfeited all the ' +
          'Pending Amount.',
        'You will devote yourself entirely to the work of the company with honesty and ' +
          'loyalty. You will Obey all orders and instructions of all persons in authority over ' +
          'you.',
        'Your appointment is made relying upon the information furnished and representation ' +
          'made by you from time to time. The company and any of its employees/representatives ' +
          'and/or officials shall be entitled to conduct reference and background check from ' +
          'all the requisite sources including all your previous employer’s or reference given ' +
          'by you and if not found suitable or any discrepancy is regards to you or any of the ' +
          'statements, declarations or disclosures made by you the company shall have full ' +
          'right and authority to terminate your services and take such further action as ' +
          'deemed necessary in the interest of the company.',
        'New adjusted compensation: will be decided depending on your performance and a new ' +
          'increment from the date of joining after one year will be considered.',
        'Leave benefits as per company policy of 2 Days as Paid Leaves monthly. Before ' +
          'proceeding leave, you will have to apply for leave 09 days in advance to the ' +
          'appropriate authority and seek the prior sanction of leave. Any additional leave ' +
          'beyond this limit shall be subject to prior approval and may be treated as unpaid ' +
          'leave, as per company policy.',
        'You will be bound by rules and regulations enforced by the management, from time to ' +
          'time in relation to conduct, discipline, leave, holidays or any matter relating to ' +
          'service conditions which will be deemed as rules, regulations and orders in the part ' +
          'of these terms of employment. The management reserves the right to modify, alter or ' +
          'delete the existing service rules or to introduce fresh service rules which will be ' +
          'binding upon you.',
        'You Will undertake to do not divert any trade secret or any knowledge of ' +
          'valued/confidential information gained by you during the course of employment with ' +
          'us to any individual or institution while in your service.',
        'Your increments/promotion and demotions will depend at the sole discretion of the ' +
          'management depending upon your efficiency, intelligence, regular attendance, sense ' +
          'of discipline, loyalty, and good behavior and also subject to the prosperity of the ' +
          'organization.',
        'In case, you are found guilty of insubordination, misconduct, drunkenness, theft, ' +
          'dishonesty or at any Stage it is found that information pertaining to your ' +
          'employment furnished to the company incorrect or if you commit breach of any of the ' +
          'conditions or rules mentioned herein, it is expressly agreed that the appointment ' +
          'shall at the option of the management be terminated forthwith without any notice or ' +
          'payment in lieu thereof.',
        'In case, the company provides you residential accommodation, you will be responsible ' +
          'for its proper maintenance. If your employments with the company cease for any ' +
          'reason whatsoever you will immediately, vacate the accommodation and handover all ' +
          'furniture and fixtures belonging to the company, Without delay and Without question.',
        'Your address indicated above, shall be deemed to be correct address for sending you ' +
          'any communication and unless changed by written information, the communication sent ' +
          'to you at the above address shall be deemed to have been correctly served.',
        'You will automatically retire without any notice on your reaching the age of 60 ' +
          'years.',
        'You will be responsible for safe keeping and return in good condition and order of ' +
          'the company’s all properties, equipment’s, tools, instruments, books and files which ' +
          'may be given to you for your use, custody, care or charges. The company have the ' +
          'right to deduct the value of all such things from your dues and take such action as ' +
          'the company may deem fit in the event of your failure to account for such company’s ' +
          'property, to its satisfaction.',
        'The Company reserves the right to place you in any of its division’s/units / ' +
          'branches/ offices / associate companies, either existing or to be opened in future ' +
          'in the country, according to exigencies of work at the sole discretion of the ' +
          'Management. Upon such transfer/placement, the rules and regulations of service ' +
          'applicable to your category personnel at the place of transfer will become ' +
          'applicable to you.',
        'During the period of your employment with the Company or thereafter, you will not ' +
          'divulge to any other person, orally or in writing or in any manner whatsoever, any ' +
          'information, data, knowledge, skills, trade secrets relating to the affairs of the ' +
          'organization or its allied / associated / subsidiary companies, which you have ' +
          'acquired by reason of employment with the organization.',
        'Besides above stated conditions, you Will be required to abide by the Service Rules & ' +
          'Regulation(s) and any Standing Order(s), as and when issued by the Company in due ' +
          'course, either specifically to you or to the entire organization.',
        'The company also reserves the right to amend, update or replace any of the Terms & ' +
          'Conditions, General Conditions, General Policy(ies) Of the Company or any Service ' +
          'Rule or Regulations With a specific Standing Order(s), which shall be applicable to ' +
          'you.',
      ]),
      '',
      'We, at {{companyName}} wish you a happy and prosperous future with our organization and ' +
        'heartily welcome you to excel with us.',
      '',
      'Thanking you,',
      'Yours Faithfully',
      'For {{companyName}}',
      '[[signature]]',
      'I, {{salutation}} {{employeeName}} have read the abovementioned Terms & Conditions and ' +
        'General Policies of the Company governing my employment With {{companyName}}.',
      'I am agreeable to all of the abovementioned Terms and Conditions and hereby accept the ' +
        'same.',
      '',
      'Signature:',
      '',
      'Date:',
      '',
      'Note: Kindly sign every page of this Letter and another copy of this as a token of your ' +
        'acceptance.',
      '[[pagebreak]]',
      '## ANNEXURE I',
      '## Remuneration Details',
      '## Earning Components (A)',
      '| Heads | Monthly | Annually |',
      '| --- | --- | --- |',
      '| Basic Salary | Rs. {{basicMonthly}} | Rs. {{basicAnnual}} |',
      '| House Rent Allowance (HRA) | Rs. {{hraMonthly}} | Rs. {{hraAnnual}} |',
      '| Dearness Allowance | Rs. {{daMonthly}} | Rs. {{daAnnual}} |',
      '| Conveyance Allowance | Rs. {{conveyanceMonthly}} | Rs. {{conveyanceAnnual}} |',
      '| Medical Allowance | Rs. {{medicalMonthly}} | Rs. {{medicalAnnual}} |',
      '| Site Allowance | Rs. {{?siteAllowanceMonthly}} | Rs. {{siteAllowanceAnnual}} |',
      '| Special Allowance | Rs. {{specialAllowanceMonthly}} | Rs. {{specialAllowanceAnnual}} |',
      '| Gross Salary | Rs. {{grossMonthly}} | Rs. {{grossAnnual}} |',
      '## Employer Contributions (B)',
      '| Heads | Monthly | Annually |',
      '| --- | --- | --- |',
      '| PF Employer | Rs. {{pfEmployerMonthly}} | Rs. {{pfEmployerAnnual}} |',
      '| ESI Employer | Rs. {{esicEmployerMonthly}} | Rs. {{esicEmployerAnnual}} |',
      '| Meal Voucher | Rs. {{mealVoucherMonthly}} | Rs. {{mealVoucherAnnual}} |',
      '| Total CTC (A+B) | Rs. {{ctcMonthly}} | Rs. {{ctcAnnual}} |',
      '| Net Take-Home | Rs. {{netTakeHomeMonthly}} | Rs. {{netTakeHomeAnnual}} |',
    ].join('\n'),
    fields: [
      SALUTATION,
      employee('employeeName', 'Employee name', 'fullName'),
      RELATION,
      employee('fatherName', 'Father’s / spouse’s name', 'fatherName', false),
      employee('address', 'Address', 'address', false),
      employee('mobile', 'Contact no.', 'phone', false),
      employee('email', 'Email ID', 'email', false),
      employee('designation', 'Designation', 'designation'),
      employee('placeOfPosting', 'Place of posting', 'placeOfPosting'),
      manual('responsibilities', 'Area of responsibilities'),
      employee('contractStartDate', 'Contract start date', 'dateOfJoining'),
      // "6.00 Lakh", from the same CTC the annexure totals.
      employee('ctcAnnualLakh', 'CTC (lakh per annum)', 'ctcAnnualLakh'),
      manual(
        'extraBenefits',
        'Extra benefits — e.g. "and extra benefits food & accommodation provided by the company."',
        false,
      ),
      // The annexure, off the employee's own salary heads. Annual figures are the
      // monthly ones × 12, resolved by the employee record alongside them (`basicAnnual`
      // beside `basic`) rather than typed, which is why these are `employee` and not
      // `manual`.
      employee('basicMonthly', 'Basic — monthly', 'basic'),
      employee('basicAnnual', 'Basic — annually', 'basicAnnual'),
      employee('hraMonthly', 'HRA — monthly', 'hra'),
      employee('hraAnnual', 'HRA — annually', 'hraAnnual'),
      employee(
        'daMonthly',
        'Dearness allowance — monthly',
        'dearnessAllowance',
      ),
      employee(
        'daAnnual',
        'Dearness allowance — annually',
        'dearnessAllowanceAnnual',
      ),
      employee('conveyanceMonthly', 'Conveyance — monthly', 'conveyance'),
      employee('conveyanceAnnual', 'Conveyance — annually', 'conveyanceAnnual'),
      employee(
        'medicalMonthly',
        'Medical allowance — monthly',
        'medicalAllowance',
      ),
      employee(
        'medicalAnnual',
        'Medical allowance — annually',
        'medicalAllowanceAnnual',
      ),
      employee(
        'siteAllowanceMonthly',
        'Site allowance — monthly (row printed only when paid)',
        'siteAllowanceIfAny',
        false,
      ),
      employee(
        'siteAllowanceAnnual',
        'Site allowance — annually',
        'siteAllowanceIfAnyAnnual',
        false,
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
      employee('mealVoucherMonthly', 'Meal voucher — monthly', 'mealVoucher'),
      employee(
        'mealVoucherAnnual',
        'Meal voucher — annually',
        'mealVoucherAnnual',
      ),
      employee('ctcMonthly', 'Total CTC — monthly', 'ctc'),
      employee('ctcAnnual', 'Total CTC — annually', 'ctcAnnual'),
      employee('netTakeHomeMonthly', 'Net take-home — monthly', 'netTakeHome'),
      employee(
        'netTakeHomeAnnual',
        'Net take-home — annually',
        'netTakeHomeAnnual',
      ),
      COMPANY_FIELD,
    ],
  },

  // ──────────────────────────────────────────────────────── experience ──────
  {
    kindKey: 'experience',
    name: 'Experience letter',
    // "Experience Letter (1).docx", word for word but for three things: "Mr." is the salutation
    // token and "S/o" the relation token; "him" / "his" are pronoun tokens; and "He is amiable"
    // names the employee instead, because a pronoun token cannot start a sentence (it cannot be
    // capitalised by substitution, and "they is" is not English).
    body: [
      'This is to certify that {{salutation}} {{employeeName}} {{relation}}-{{fatherName}} ' +
        'worked as a post {{designation}} in our company from {{fromDate}} to {{toDate}} ' +
        'posted at {{postingLocation}} with our entire satisfaction. During ' +
        '{{pronounPossessive}} working period, we found {{pronounObject}} a sincere, honest, ' +
        'hardworking, dedicated employee with a professional attitude and very good job ' +
        'knowledge.',
      '',
      '{{salutation}} {{employeeName}} is amiable in nature and character as well. We have no ' +
        'objection to all {{pronounObject}} in any better position and have no liabilities in ' +
        'our company.',
      '',
      'We wish {{pronounObject}} good luck for future assignments.',
      '',
      'For {{companyName}}',
    ].join('\n'),
    fields: [
      SALUTATION,
      employee('employeeName', 'Employee name', 'fullName'),
      RELATION,
      employee('fatherName', 'Father’s / spouse’s name', 'fatherName', false),
      employee('designation', 'Post', 'designation'),
      employee('fromDate', 'Worked from', 'dateOfJoining'),
      // The exit record's last working day. Required although the record may not hold it
      // yet: the dates are what the next employer reads this letter for.
      employee('toDate', 'Worked to', 'exit.lastWorkingDay'),
      employee('postingLocation', 'Posted at', 'placeOfPosting'),
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
    // two are separate kinds and issued at different times. Its "Company name" placeholders
    // and the blank after "Name: -", "Project: -" and "Dear Mr…" are the fields; the heading
    // sits under the name and project, where `[[title]]` puts it.
    body: [
      'Name: - {{employeeName}}',
      '',
      'Project: - {{projectName}}',
      '[[title]]',
      'Dear {{salutation}} {{employeeName}}',
      '',
      'In reference to your resignation dated {{resignationDate}} stating your intention to ' +
        'resign from Position of {{designation}} held at {{companyName}}, we would like to ' +
        'inform you that your resignation from the services of the Organisation has been ' +
        'accepted.',
      '',
      'You have been relieved from all your duties and responsibilities at the Close of ' +
        'Office Hours of {{relievingDate}}. You have Submitted all the Company Documents, ' +
        'Technical Equipment’s and all Other Company Properties to your Project Manager/ ' +
        'Department Head.',
      '',
      'Your Experience letter shall be issued to you subject to the Full and Final Settlement ' +
        'of dues, if any.',
      '',
      'We thank you for your Services in {{companyName}} and wish you success in your future ' +
        'endeavours.',
      '',
      'With Best Regards,',
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
    // "Increment Letter (1).docx". No heading — "Ref:" and "Date:" open it — and no "For …"
    // line: the signatory signs under "With best wishes,".
    body: [
      '{{employeeName}}',
      'Employee Code: {{employeeCode}}',
      'E-mail: {{email}}',
      'Mobile No.: {{mobile}}',
      '',
      'Subject: Revision of Compensation cum Increment Letter.',
      '',
      'Dear {{salutation}} {{employeeName}},',
      '',
      'With reference to your appointment letter, we are pleased to inform you that your ' +
        'salary has been revised with effect from {{effectiveDate}} for your services as an ' +
        '{{designation}} at {{placeOfPosting}}.',
      '',
      'Your revised Cost to Company (CTC) will be Rs.{{revisedCtcMonthly}}/- ' +
        '({{revisedCtcWords}}) per month.',
      '',
      'All other terms and conditions of your employment, as specified in your appointment ' +
        'letter and subsequent communications, shall remain unchanged and continue in full ' +
        'force and effect.',
      'We appreciate your contributions to the organization and look forward to your ' +
        'continued dedication and commitment.',
      '',
      'Notes:',
      '• Applicable taxes and statutory deductions shall be made in accordance with the ' +
        'prevailing laws and regulations.',
      '',
      'With best wishes,',
    ].join('\n'),
    fields: [
      SALUTATION,
      employee('employeeName', 'Employee name', 'fullName'),
      employee('employeeCode', 'Employee code', 'employeeCode'),
      employee('email', 'E-mail', 'email', false),
      employee('mobile', 'Mobile no.', 'phone', false),
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
    ],
  },

  // ────────────────────────────────────────────────────────── transfer ──────
  {
    kindKey: 'transfer',
    name: 'Transfer letter',
    // "Transfer letter.docx". Its closing sentence names "Jaipur Ring Road" while the
    // letter transfers the employee to a different project — a copy-paste leftover — so
    // both mentions are the destination here. The company signs after "Regards,"; the
    // employee's acceptance follows the signature, as in the format.
    body: [
      'To',
      '{{employeeName}}',
      '{{relation}} {{?fatherName}}',
      '{{address}}',
      'Contact No.: -{{mobile}}',
      'Email Id.: {{email}}',
      '',
      'Dear {{employeeName}},',
      'We hope this letter finds you well. This is to inform you that, due to the operational ' +
        'requirements of the company, you are being transferred to {{toProject}} You are ' +
        'required to report to the {{reportingSite}} site on {{reportingDate}}. Your duties ' +
        'and responsibilities will remain consistent with your current role as ' +
        '{{designation}}, and we are confident that your skills and experience will greatly ' +
        'contribute to the {{toProject}} project during this period.',
      '',
      'Should you need any further information, please feel free to contact the HR ' +
        'department.',
      '',
      'Regards,',
      'For {{companyName}}',
      '[[signature]]',
      'Please confirm your acceptance by signing and returning this letter',
      '',
      '',
      'Signature: ______________________                    Date: ______________',
    ].join('\n'),
    fields: [
      employee('employeeName', 'Employee name', 'fullName'),
      RELATION,
      employee('fatherName', 'Father’s / spouse’s name', 'fatherName', false),
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
    // letter says only that they are specific — and nothing here adds a field for them. Its
    // red "Company Name" placeholders are the company field; "HR Department" closes it under
    // the signature.
    body: [
      'To',
      '{{employeeName}}',
      '{{designation}}',
      'Project Name: {{projectName}}',
      '',
      '## Sub: - Termination of Employment from the company',
      '',
      'This letter is to inform you that your employment with {{companyName}} as ' +
        '{{designation}} is terminated, effective from {{effectiveDate}}. This decision has ' +
        'been reached after careful consideration and is based on some specific reasons.',
      'Your final settlement will be including all pending salary, accrued leave, and other ' +
        'dues as per company policy.',
      'Please return all company property, Company Documents and all other documents on ' +
        'before your last working day.',
      'You are requested to complete a handover of site-related work to your reporting ' +
        '{{handoverTo}}.',
      '',
      'Regards',
      'For {{companyName}}',
      '[[signature]]',
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
    // "Full_and_Final_Settlement_Format.docx", sections A–H, as pipe tables, under the logo and
    // company name the form's header carries. A sheet, not a letter: no signature from the
    // renderer, and the sign-offs are the rows of section F and G, completed by hand. Its
    // reference and date are the cells of its own first row (`LETTER_LAYOUTS.fnf_settlement`).
    //
    // Figures come from the exit computation (`fnf.*`) where it has them. Everything the
    // records do not hold — reference numbers, overtime, asset recoveries, who prepared and
    // approved it — is a field HR may leave empty, because a blank cell on this sheet is
    // what the client's own form has until somebody writes in it.
    //
    // Three deliberate departures from the Word file. Amounts carry "Rs." rather than "₹",
    // tick boxes are "[ ]" rather than "☐", and "A − B" has a hyphen: the renderer's built-in
    // font has none of those glyphs, and they printed as garbage. The "PAN / UAN" row is
    // filled with the UAN only — a letter never carries a PAN.
    body: [
      'HR & ADMINISTRATION DEPARTMENT | CONFIDENTIAL',
      '',
      '| F&F Ref. No.: {{referenceNo}} | Date: {{issueDate}} | Project / Site: {{placeOfPosting}} | Cost Centre: {{costCentre}} |',
      '',
      '## A. EMPLOYEE & EXIT DETAILS',
      '| Employee Name | {{employeeName}} | Employee Code | {{employeeCode}} |',
      '| Designation | {{designation}} | Department | {{department}} |',
      '| Project / Site / Location | {{placeOfPosting}} | Reporting Manager | {{reportingManager}} |',
      '| Date of Joining | {{dateOfJoining}} | Employment Type | {{employmentType}} |',
      '| Resignation Date | {{resignationDate}} | Resignation Accepted On | {{resignationAcceptedOn}} |',
      '| Notice Period Required | {{noticeRequiredDays}} days | Notice Period Served | {{noticeServedDays}} days |',
      '| Last Working Day | {{lastWorkingDay}} | Exit Reason | {{exitReason}} |',
      '| Monthly Gross Salary (Rs.) | {{monthlyGross}} | Payroll Month / Period | {{payrollPeriod}} |',
      '| Bank Account (last 4 digits only) | {{bankLast4}} | PAN / UAN (if needed) | {{uan}} |',
      '',
      '## B. EARNINGS / AMOUNTS PAYABLE',
      '| Sr. No. | Particulars | Basis / Period | Amount (Rs.) |',
      '| --- | --- | --- | --- |',
      '| 1 | Salary payable up to Last Working Day | Days: {{salaryDays}} | {{salaryPayable}} |',
      '| 2 | Overtime / approved extra duty (if applicable) | Period: {{overtimePeriod}} | {{overtimeAmount}} |',
      '| 3 | Leave encashment (if eligible) | Days: {{leaveEncashmentDays}} | {{leaveEncashment}} |',
      '| 4 | Approved reimbursement / expenses | Claim Ref.: {{reimbursementRef}} | {{reimbursements}} |',
      '| 5 | Incentive / bonus / variable pay (if payable) | Period: {{bonusPeriod}} | {{bonus}} |',
      '| 6 | Gratuity (if eligible; separate verification) | As applicable | {{gratuity}} |',
      '| 7 | Other payable amount (specify) | {{otherPayableDetail}} | {{otherPayable}} |',
      '| | TOTAL GROSS AMOUNTS PAYABLE (A) | | Rs. {{totalPayable}} |',
      '',
      '## C. DEDUCTIONS / RECOVERIES (ONLY WHERE LAWFUL AND VERIFIED)',
      '| Sr. No. | Particulars | Reference / Calculation | Amount (Rs.) |',
      '| --- | --- | --- | --- |',
      '| 1 | Applicable statutory deductions (e.g., TDS / employee contributions) | Payroll working: {{statutoryRef}} | {{statutoryDeductions}} |',
      '| 2 | Salary advance / employee loan balance | Ledger Ref.: {{loanRef}} | {{loanRecovery}} |',
      '| 3 | Notice-period adjustment (if contractually and legally permissible) | Days / basis: {{noticeBasis}} | {{noticeRecovery}} |',
      '| 4 | Unreturned company asset / verified loss (only if legally recoverable) | Asset / approval: {{assetRef}} | {{assetRecovery}} |',
      '| 5 | Other authorised and lawful deduction (specify) | Basis / approval: {{otherDeductionBasis}} | {{otherDeductions}} |',
      '| | TOTAL DEDUCTIONS (B) | | Rs. {{totalDeductions}} |',
      '',
      '## D. NET SETTLEMENT',
      '| Total Gross Amounts Payable (A) | Rs. {{totalPayable}} |',
      '| Less: Total Deductions (B) | Rs. {{totalDeductions}} |',
      '| NET AMOUNT PAYABLE TO EMPLOYEE (A - B) | Rs. {{netPayable}} |',
      '| Amount in Words | {{netInWords}} |',
      '',
      '## E. DEPARTMENTAL NO-DUES / HANDOVER CLEARANCE',
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
      '## F. PAYMENT & APPROVAL DETAILS',
      '| Payment Mode | [ ] Bank Transfer  [ ] Cheque | Payment / UTR Ref. | {{paymentRef}} |',
      '| Payment Date | {{paymentDate}} | Payment Status | [ ] Paid  [ ] Part-paid  [ ] Pending |',
      '| Prepared By (HR) | {{preparedBy}} | Checked / Approved By | {{approvedBy}} |',
      '',
      '## G. EMPLOYEE ACKNOWLEDGEMENT',
      'I acknowledge receipt of the F&F statement and confirm that I have had an ' +
        'opportunity to review the calculations. My signature confirms receipt/review of ' +
        'this statement and does not waive any statutory right or prevent me from raising ' +
        'a genuine discrepancy or claim permitted by law. Any amount shown as pending or ' +
        'disputed is to be recorded separately.',
      '',
      '| Employee Name | {{employeeName}} | Signature | |',
      '| Date | | HR Witness | |',
      '',
      '## H. HR FILE CLOSURE CHECKLIST',
      '[ ] Resignation and acceptance filed     [ ] Handover / departmental clearance filed     ' +
        '[ ] Attendance and leave balance verified',
      '[ ] F&F calculation and approval filed     [ ] Payment proof / UTR filed     ' +
        '[ ] Relieving / experience letter issued, where applicable     ' +
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
      // The form's three tick boxes, with the one that applies ticked.
      employee(
        'employmentType',
        'Employment type',
        'employmentTypeBoxes',
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
