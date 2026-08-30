/**
 * The default document types seeded into every newly created company (FR-020).
 *
 * Seventeen entries, taken verbatim (code, name, flags, sort order) from the PRD's
 * pre-populated table in ERP-Demo docs/settings.md. 002's data-model.md summarizes
 * this list as "16 default document types" because its prose collapses the 10th and
 * 12th marksheets into one "Marksheets" item; the PRD's enumerated table is the
 * authoritative source and keeps them separate.
 *
 * The PRD's `Flags` column is the *derived* display flag — these three booleans are
 * the stored source of truth it is computed from (see document-type-flag.ts).
 */
export interface DefaultDocumentType {
  code: string;
  name: string;
  isMandatory: boolean;
  hasExpiry: boolean;
  needsNumber: boolean;
  sortOrder: number;
}

export const DEFAULT_DOCUMENT_TYPES: DefaultDocumentType[] = [
  // MandatoryNumber
  {
    code: 'AADHAAR',
    name: 'Aadhaar Card',
    isMandatory: true,
    hasExpiry: false,
    needsNumber: true,
    sortOrder: 10,
  },
  // Number
  {
    code: 'PAN',
    name: 'PAN Card',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: true,
    sortOrder: 20,
  },
  // Mandatory
  {
    code: 'BANK_PROOF',
    name: 'Bank Proof (passbook/cancelled cheque)',
    isMandatory: true,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 30,
  },
  {
    code: 'PHOTO',
    name: 'Photograph',
    isMandatory: true,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 40,
  },
  // ExpiryNumber
  {
    code: 'DRIVING_LICENCE',
    name: 'Driving Licence',
    isMandatory: false,
    hasExpiry: true,
    needsNumber: true,
    sortOrder: 50,
  },
  // Optional
  {
    code: 'MARKSHEET_10',
    name: '10th Marksheet',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 60,
  },
  {
    code: 'MARKSHEET_12',
    name: '12th Marksheet',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 70,
  },
  {
    code: 'DEGREE',
    name: 'Degree Certificate',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 80,
  },
  {
    code: 'EXPERIENCE_LETTER',
    name: 'Experience Letter',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 90,
  },
  // Expiry
  {
    code: 'MEDICAL_FITNESS',
    name: 'Medical Fitness Certificate',
    isMandatory: false,
    hasExpiry: true,
    needsNumber: false,
    sortOrder: 100,
  },
  // Optional
  {
    code: 'POLICE_VERIFICATION',
    name: 'Police Verification',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 110,
  },
  {
    code: 'OFFER_LETTER',
    name: 'Offer Letter',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 120,
  },
  {
    code: 'APPOINTMENT_LETTER',
    name: 'Appointment Letter',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 130,
  },
  {
    code: 'JOINING_LETTER_SIGNED',
    name: 'Signed Joining Letter',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 140,
  },
  {
    code: 'PF_FORM_11',
    name: 'PF Form 11',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 150,
  },
  {
    code: 'PF_FORM_2_NOMINATION',
    name: 'PF Form 2 (Nomination)',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 160,
  },
  {
    code: 'ESIC_FAMILY_DECLARATION',
    name: 'ESIC Family Declaration',
    isMandatory: false,
    hasExpiry: false,
    needsNumber: false,
    sortOrder: 170,
  },
];
