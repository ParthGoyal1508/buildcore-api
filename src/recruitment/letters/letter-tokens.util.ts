import { LetterType } from '@prisma/client';

/**
 * Letter template token validation and substitution (011 FR-020, FR-022). Pure so it
 * is unit tested directly and shared with the client's unknown-token highlighter.
 *
 * Each letter type documents the tokens it may reference. A template referencing a
 * token outside its set is rejected at save (FR-020); generation substitutes every
 * `{{token}}` with the resolved value.
 */

/** The documented token set per letter type. */
export const LETTER_TOKENS: Record<LetterType, string[]> = {
  offer: [
    'candidateName',
    'designation',
    'department',
    'offeredCtc',
    'joiningDate',
    'probationMonths',
    'noticePeriodDays',
    'companyName',
    'issueDate',
  ],
  appointment: [
    'employeeName',
    'employeeCode',
    'designation',
    'department',
    'dateOfJoining',
    'reportingManager',
    'companyName',
    'issueDate',
  ],
  confirmation: [
    'employeeName',
    'employeeCode',
    'designation',
    'confirmationDate',
    'companyName',
    'issueDate',
  ],
  relieving: [
    'employeeName',
    'employeeCode',
    'designation',
    'dateOfJoining',
    'lastWorkingDay',
    'companyName',
    'issueDate',
  ],
  experience: [
    'employeeName',
    'employeeCode',
    'designation',
    'dateOfJoining',
    'lastWorkingDay',
    'tenure',
    'companyName',
    'issueDate',
  ],
};

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every distinct token referenced by a template body. */
export function extractTokens(body: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(body)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

/** Tokens in the body that are not in the letter type's documented set. */
export function unknownTokens(body: string, letterType: LetterType): string[] {
  const allowed = new Set(LETTER_TOKENS[letterType] ?? []);
  return extractTokens(body).filter((t) => !allowed.has(t));
}

/** Substitutes `{{token}}` with values; an unresolved token renders empty. */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(TOKEN_RE, (_, token: string) => values[token] ?? '');
}
