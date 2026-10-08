import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from './prisma/rls-context';

/**
 * The one way this product turns a user row into a name a person reads.
 *
 * Extracted when 016's attendance-modification view (FR-012c) needed the same fallback
 * chain `ApprovalsService.namesFor` already used. Two implementations of "what do we call
 * this user" drift, and the drift shows up as the same actor appearing under two different
 * names on two screens — which is exactly the confusion an audit trail exists to prevent.
 *
 * The order is deliberate: an explicit display name first, then a real name, then the
 * handle, then the email as a last resort. Email last because it is an identifier that
 * happens to be legible, not a name — but it is never absent, so the chain always
 * terminates and a caller never has to render a blank.
 */
export interface NameableUser {
  displayName?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  username?: string | null;
  email: string;
}

export function actorNameOf(user: NameableUser): string {
  return (
    user.displayName?.trim() ||
    [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
    user.username ||
    user.email
  );
}

/** The columns `actorNameOf` needs, as a Prisma `select`. */
export const ACTOR_NAME_SELECT = {
  id: true,
  displayName: true,
  firstname: true,
  lastname: true,
  username: true,
  email: true,
} as const;

/**
 * User ids to display names, in **one** query.
 *
 * Lifted out of `ProjectDocumentsService`'s private `actorNames` when 028 FR-024 needed exactly it
 * for a daily report's two identities. That method now delegates here, so there is still one
 * implementation — the alternative was a second copy, and this file exists because two answers to
 * "what do we call this user" show up as one actor under two names on two screens.
 *
 * One query for the distinct ids, never one per row: a list of thirty reports resolving its authors
 * row by row is thirty round trips for a column.
 *
 * Read under the cross-company context, like every other name resolution here: `shared.User` is not
 * company-scoped, and a name is not a tenant's data to hide — hiding it would print an id instead,
 * which is the defect this exists to fix.
 */
export async function actorNamesFor(
  prisma: PrismaService,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const users = await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
    tx.user.findMany({
      where: { id: { in: wanted } },
      select: ACTOR_NAME_SELECT,
    }),
  );
  return new Map(users.map((user) => [user.id, actorNameOf(user)]));
}
