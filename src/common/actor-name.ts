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
