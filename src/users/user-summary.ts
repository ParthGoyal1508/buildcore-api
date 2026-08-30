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
