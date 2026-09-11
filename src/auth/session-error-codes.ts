/**
 * Machine-readable reasons a session refusal can carry (015 FR-008).
 *
 * Both are returned as `401` with the code in the body, following
 * `PASSWORD_CHANGE_REQUIRED`: clients branch on a stable identifier, never on prose, so
 * the wording above stays free to change.
 *
 * The distinction exists because the two mean different things to the person in front of
 * the screen. An expiry is ordinary and the honest message is "your session expired". A
 * revocation means replay protection destroyed the session, which is either a security
 * event or a false positive — and in both cases telling the user it merely "expired"
 * would be wrong.
 */

/** The credential is unknown, past its expiry, or already revoked. */
export const SESSION_EXPIRED = 'SESSION_EXPIRED';

/** Replay protection destroyed the family; the credential was presented too late. */
export const SESSION_REVOKED = 'SESSION_REVOKED';
