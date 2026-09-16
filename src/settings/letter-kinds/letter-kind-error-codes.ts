/**
 * Machine-readable refusals from the letter-kind surface (017 FR-011a, FR-022).
 *
 * Stable identifiers rather than prose, the contract 015 established and 016 extended.
 */

/**
 * A company tried to define a kind whose key the product already ships (FR-011a).
 *
 * Refused rather than allowed-and-shadowed. Two kinds answering to one key leave every
 * lookup with two candidate rows and no stated precedence between them — and the place
 * that ambiguity surfaces is a letter issued under the wrong template.
 */
export const LETTER_KIND_KEY_RESERVED = 'LETTER_KIND_KEY_RESERVED';

/**
 * A kind cannot be deleted while letters or templates reference it (FR-022).
 *
 * The `onDelete: Restrict` foreign key is the guarantee; this code exists so the caller
 * reads a sentence instead of a constraint name.
 */
export const LETTER_KIND_IN_USE = 'LETTER_KIND_IN_USE';

/** No kind of that key or id is visible to this company. */
export const LETTER_KIND_NOT_FOUND = 'LETTER_KIND_NOT_FOUND';

export type LetterKindErrorCode =
  | typeof LETTER_KIND_KEY_RESERVED
  | typeof LETTER_KIND_IN_USE
  | typeof LETTER_KIND_NOT_FOUND;
