/**
 * Account-creation constants (Constitution Principle III).
 *
 * Centralized rather than inlined because each is a policy value someone will want
 * to change without a code review — how long an invite stays usable, and what counts
 * as a strong enough password.
 */

/**
 * How long an invite link remains usable (data-model.md: `expiresAt = createdAt + 48h`).
 *
 * Two days covers a weekend without leaving a working credential-setting link alive
 * indefinitely in someone's inbox — which is what an invite effectively is until it
 * is consumed.
 */
export const INVITE_TOKEN_TTL_HOURS = 48;

/**
 * Minimum password strength for an invitee setting their own password
 * (contract: "min 8 chars, 1 uppercase, 1 number").
 *
 * Expressed as one regex so the DTO and any service-layer re-check cannot drift
 * apart into two subtly different rules.
 */
export const PASSWORD_COMPLEXITY = /^(?=.*[A-Z])(?=.*\d).{8,}$/;

export const PASSWORD_COMPLEXITY_MESSAGE =
  'Password must be at least 8 characters and include an uppercase letter and a number.';

/** Bytes of entropy behind an invite token before hex-encoding (research.md §2). */
export const INVITE_TOKEN_BYTES = 32;
