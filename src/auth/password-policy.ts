import { applyDecorators } from '@nestjs/common';
import { randomInt } from 'crypto';
import { IsString, Matches, MaxLength } from 'class-validator';
import {
  PASSWORD_COMPLEXITY,
  PASSWORD_COMPLEXITY_MESSAGE,
} from '../account-creation/constants/account-creation.constants';

/**
 * The one rule for any password a person is about to start using (029 FR-005).
 *
 * Before 029 the invite and admin-create paths enforced the complexity rule and the self-service
 * change and admin reset checked only a length of 8 — so the strongest rule applied to the
 * passwords a user chose once, and the weakest to the ones they chose every time after.
 */

/**
 * Upper bound, in characters. Argon2 hashes whatever it is given, so without a ceiling a single
 * request carrying a megabyte "password" buys a megabyte of hashing on an unauthenticated route.
 * 128 is far past any passphrase a person types or a password manager generates.
 */
export const PASSWORD_MAX_LENGTH = 128;

/** Applies the complexity rule and the ceiling to a DTO field. */
export function IsNewPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(PASSWORD_MAX_LENGTH, {
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    }),
    Matches(PASSWORD_COMPLEXITY, { message: PASSWORD_COMPLEXITY_MESSAGE }),
  );
}

/** No 0/O, 1/l/I: the temporary password is read aloud or copied off a screen. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const ALL = UPPER + LOWER + DIGITS;

/** Long enough that it is not the weak point in its own short life (~70 bits). */
const TEMPORARY_PASSWORD_LENGTH = 12;

/**
 * A temporary password for an admin reset (029 FR-014). Always satisfies the complexity rule —
 * one of each class is placed first and the whole is then shuffled — and is drawn from
 * `crypto.randomInt`, never `Math.random`.
 */
export function generateTemporaryPassword(): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < TEMPORARY_PASSWORD_LENGTH) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
