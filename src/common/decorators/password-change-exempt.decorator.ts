import { SetMetadata } from '@nestjs/common';

export const PASSWORD_CHANGE_EXEMPT_KEY = 'passwordChangeExempt';

/**
 * Marks a route as reachable while an account still owes a forced password change
 * (010 FR-017a).
 *
 * Opt-out rather than opt-in, deliberately. The guard is global, so a route that
 * forgets to think about this is refused — the safe direction. If exemption were the
 * default, every future controller would have to remember to opt *in*, and a rule
 * that fails open on forgetfulness is not a rule.
 *
 * Only four routes carry this: the change-password endpoint itself, the caller's own
 * profile read (so the shell can render who they are), token refresh, and logout.
 * That is the smallest set that lets someone finish the change or leave; anything
 * more keeps the admin's password useful for real work.
 */
export const PasswordChangeExempt = () =>
  SetMetadata(PASSWORD_CHANGE_EXEMPT_KEY, true);
