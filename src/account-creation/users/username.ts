import { Prisma } from '@prisma/client';

/**
 * Derives a username from an email address.
 *
 * `shared.User.username` is unique and is a second way to sign in, but the invite
 * form does not collect one — asking an admin to invent an identifier on someone
 * else's behalf adds a field, a format rule, and a collision error to the UI for a
 * value nobody has an opinion about (data-model.md, resolved 2026-08-30).
 */

const MAX_LENGTH = 30;
/** Long enough that a stripped-to-nothing local part still yields something usable. */
const MIN_LENGTH = 3;

/** Lowercased local part, restricted to a conservative character set. */
export function baseUsernameFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? '';
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    // Collapse runs of punctuation, and never lead or trail with it — "..a..b.."
    // is a legal email local part but a poor username.
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_LENGTH);

  // A local part of only stripped characters (e.g. "!!!@x.com") would otherwise
  // produce an empty username, which is unique exactly once and then collides
  // forever.
  return cleaned.length >= MIN_LENGTH ? cleaned : `user${cleaned}`;
}

/**
 * Finds a free username, appending a counter on collision.
 *
 * The uniqueness check is advisory, not a guarantee: two concurrent invites to
 * similar addresses can both see the same candidate as free. The unique index is the
 * real arbiter, so callers must still handle P2002 and retry — see
 * `isUsernameConflict`.
 */
export async function allocateUsername(
  tx: Prisma.TransactionClient,
  email: string,
  attempt = 0,
): Promise<string> {
  const base = baseUsernameFromEmail(email);
  const suffix = attempt === 0 ? '' : String(attempt + 1);
  const candidate = `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;

  const taken = await tx.user.findFirst({
    where: { username: candidate },
    select: { id: true },
  });
  if (!taken) {
    return candidate;
  }
  // Bounded so a pathological base cannot spin forever; past this, fall back to
  // something certain to be free rather than failing the invite.
  if (attempt >= 25) {
    return `${base.slice(0, MAX_LENGTH - 9)}${Date.now()
      .toString(36)
      .slice(-8)}`;
  }
  return allocateUsername(tx, email, attempt + 1);
}

/** True when an error is the unique-violation on `username` specifically. */
export function isUsernameConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('username')
  );
}
