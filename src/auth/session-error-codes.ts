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

/**
 * No refresh cookie reached the server at all.
 *
 * Distinct from `SESSION_EXPIRED`, which means a credential was presented and refused.
 * This means none was presented — the browser either never stored the cookie or is not
 * sending it, which is nearly always a deployment fault rather than anything the user
 * did: a `Path` that does not match where the frontend's renewal request lands, a
 * `Secure` cookie on a plain-HTTP origin, or a `SameSite` the browser rejects.
 *
 * It exists because the absence of this distinction cost real debugging time. A
 * misconfigured cookie path produced a bare 401, the client defaulted to "your session
 * expired", and a configuration error was indistinguishable from ordinary behaviour in
 * both the UI and the logs. A deployment fault should announce itself.
 */
export const SESSION_COOKIE_MISSING = 'SESSION_COOKIE_MISSING';
