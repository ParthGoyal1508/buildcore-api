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
 * `unknownTokens()` lived here and was removed on 2026-10-03.
 *
 * It answered "is this token in the kind's documented set" from `LETTER_TOKENS` above, and it was
 * deliberately **permissive**: a kind with no documented set validated nothing, because this file
 * cannot know the tokens for a kind an administrator invented after it shipped. That was the only
 * honest answer available at the time and it is why the feature did not work — a kind defined
 * through 017's screen got an empty set, every token passed validation, and the letter rendered a
 * page of blanks. Signed.
 *
 * The answer now comes from the fields a kind **declares**
 * (`LetterKindFieldsService.assertTemplateFieldsDeclared`), which can answer for any kind and
 * refuses a kind with no fields rather than admitting everything. `LETTER_TOKENS` survives as the
 * source the 2026-10-02 migration backfilled the five shipped kinds' fields from, and as the
 * fixture `letter-kind-field.spec.ts` checks that backfill against.
 */

/** Substitutes `{{token}}` with values; an unresolved token renders empty. */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(TOKEN_RE, (_, token: string) => values[token] ?? '');
}
