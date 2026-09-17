/**
 * Letter template token validation and substitution (011 FR-020, FR-022). Pure so it
 * is unit tested directly and shared with the client's unknown-token highlighter.
 *
 * Each letter kind documents the tokens it may reference. A template referencing a
 * token outside its set is rejected at save (FR-020); generation substitutes every
 * `{{token}}` with the resolved value.
 *
 * 017 replaced `enum LetterType` with the `LetterKind` table, so this map is now keyed
 * by the kind's **key** rather than by an enum value. The five keys below are
 * byte-identical to the enum values they replaced, so nothing here changed meaning.
 */

/** The documented token set per letter kind key. */
export const LETTER_TOKENS: Record<string, string[]> = {
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

/**
 * Tokens in the body that are not in the kind's documented set.
 *
 * **A kind with no documented set validates nothing**, which is a deliberate change from
 * the enum version. FR-011 lets an administrator define a letter kind without a code
 * change, and this file cannot know the tokens for a kind invented after it shipped —
 * rejecting every token for such a kind would make FR-011 unusable, and rejecting none
 * is the only other honest answer. The kinds that DO have documented sets are still
 * validated exactly as before.
 */
export function unknownTokens(body: string, letterKindKey: string): string[] {
  const allowed = LETTER_TOKENS[letterKindKey];
  if (!allowed) return [];
  const set = new Set(allowed);
  return extractTokens(body).filter((t) => !set.has(t));
}

/** Substitutes `{{token}}` with values; an unresolved token renders empty. */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(TOKEN_RE, (_, token: string) => values[token] ?? '');
}
