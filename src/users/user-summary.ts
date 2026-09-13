import { Role, User, UserRole } from '@prisma/client';

/**
 * The account shape SettingsModule's Users list renders (002 FR-013).
 *
 * `roles` is an array, not the single `role` object 002's contracts/settings-api.md
 * describes: that contract predates the 2026-08-28 clarification that an account can
 * hold several roles at once, which feature 001 shipped as `settings.UserRole`.
 *
 * `inviteExpiresAt` and `employeeId` from that same contract are absent because they
 * belong to feature 010 (account creation / invite lifecycle), which is not built —
 * `UserStatus` likewise has no `pending` member yet.
 */
export interface UserSummary {
  id: string;
  /** Composed from firstname/lastname; falls back to the username when both are unset. */
  name: string;
  email: string;
  username: string;
  roles: { id: string; name: string }[];
  status: User['status'];
  companyId: string | null;
  lastLoginAt: Date | null;
}

type UserWithRoles = User & { userRoles: (UserRole & { role: Role })[] };

export function toUserSummary(user: UserWithRoles): UserSummary {
  const name =
    [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
    user.username;

  return {
    id: user.id,
    name,
    email: user.email,
    username: user.username,
    roles: user.userRoles.map(({ role }) => ({ id: role.id, name: role.name })),
    status: user.status,
    companyId: user.companyId,
    lastLoginAt: user.lastLoginAt,
    // Deliberately omits `password` — same boundary UserResponseDto enforces.
  };
}

/**
 * A user's name for display beside a record they acted on (feature 016 FR-008).
 *
 * Deliberately a different composition from `toUserSummary` above, which must keep its
 * exact current rule because it is what the Users list (002 FR-013) already renders and
 * this feature does not change existing screens.
 *
 * The difference is `displayName`, preferred here and unused there. An approval history
 * has to name a person: a Super Admin or a vendor-facing login has no `hr.Employee` to
 * take a name from and may have neither firstname nor lastname, and "approved by
 * (blank)" is worse than any of the fallbacks below. `email` is the last resort for the
 * same reason — ugly, but it identifies somebody.
 */
export function displayNameOf(
  user: Pick<
    User,
    'displayName' | 'firstname' | 'lastname' | 'username' | 'email'
  >,
): string {
  return (
    user.displayName?.trim() ||
    [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
    user.username ||
    user.email
  );
}
