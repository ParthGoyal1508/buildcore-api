import { ForbiddenException } from '@nestjs/common';
import { AccessLevel, Permission, PrismaClient } from '@prisma/client';

import type { AuthenticatedUser, Grant } from '../../auth/authenticated-user';

/**
 * Nobody hands out more than they hold (2026-10-16 access-control audit, C1–C3).
 *
 * Before this, anyone with `USER_MANAGEMENT` — the seeded Site Admin and HO User roles — could
 * assign any role to any account, their own included, and the protected Super Admin role was one
 * id away: `Role` has no row-level security, so its id is readable by anyone. One request turned a
 * company administrator into a cross-company one. The same gap let a role editor grant
 * `COMPANY_SETTINGS` or `DATA_DELETE` they did not hold themselves.
 *
 * The rule is the ordinary one: a grant may be given only by someone who holds it at the same
 * level or higher. Write covers read, as it does everywhere else in the app. Super Admin holds
 * everything, so nothing changes for them.
 *
 * `MY_WORKSPACE` is exempt: the module is open to every signed-in user (its routes are authorised
 * by ownership), so granting it hands over nothing.
 */

const ALWAYS_GRANTABLE: ReadonlySet<Permission> = new Set([
  Permission.MY_WORKSPACE,
]);

/** Whether the caller holds `permission` at `level`, by the rule `PermissionsGuard` applies. */
export function holdsGrant(
  caller: Pick<AuthenticatedUser, 'permissions' | 'grants'>,
  permission: Permission,
  level: AccessLevel,
): boolean {
  const grants = caller.grants ?? [];
  const area = grants.filter((grant) => grant.permission === permission);
  // An area with no grant rows falls back to the legacy array at both levels — the guard's own
  // fallback, so this can never refuse what the guard would allow.
  if (area.length === 0) return caller.permissions.includes(permission);
  return area.some(
    (grant) =>
      grant.level === level ||
      (level === AccessLevel.read && grant.level === AccessLevel.write),
  );
}

/**
 * Whether the caller could hand out every one of `grants` — the boolean twin of
 * `assertMayGrant`, for list endpoints that offer roles rather than refuse them (042).
 */
export function mayGrantAll(
  caller: Pick<AuthenticatedUser, 'permissions' | 'grants'>,
  grants: readonly Grant[],
): boolean {
  return grants.every(
    ({ permission, level }) =>
      ALWAYS_GRANTABLE.has(permission) || holdsGrant(caller, permission, level),
  );
}

/** Refuses when any of `grants` is beyond what the caller holds, naming what is. */
export function assertMayGrant(
  caller: Pick<AuthenticatedUser, 'permissions' | 'grants'>,
  grants: readonly Grant[],
  what: string,
): void {
  const beyond = grants.filter(
    ({ permission, level }) =>
      !ALWAYS_GRANTABLE.has(permission) &&
      !holdsGrant(caller, permission, level),
  );
  if (beyond.length === 0) return;
  const names = [
    ...new Set(
      beyond.map(({ permission, level }) => `${permission} (${level})`),
    ),
  ].join(', ');
  throw new ForbiddenException({
    code: 'GRANT_EXCEEDS_CALLER',
    message: `You cannot ${what}: it grants ${names}, which your own role does not.`,
  });
}

/**
 * Everything a role grants, as area-and-level pairs: its grant rows, plus both levels of any
 * legacy array entry that has no rows (the same reading `toAuthenticatedUser` gives it).
 */
export function expandRoleGrants(
  permissions: readonly Permission[],
  rolePermissions: readonly Grant[],
): Grant[] {
  const grants: Grant[] = [...rolePermissions];
  const withRows = new Set(grants.map((grant) => grant.permission));
  for (const permission of permissions) {
    if (withRows.has(permission)) continue;
    grants.push(
      { permission, level: AccessLevel.read },
      { permission, level: AccessLevel.write },
    );
  }
  return grants;
}

/** `expandRoleGrants` for a role fetched by id; null for an unknown role. */
export async function roleGrants(
  tx: Pick<PrismaClient, 'role'>,
  roleId: string,
): Promise<Grant[] | null> {
  const role = await tx.role.findUnique({
    where: { id: roleId },
    select: {
      permissions: true,
      rolePermissions: { select: { permission: true, level: true } },
    },
  });
  if (!role) return null;
  return expandRoleGrants(role.permissions ?? [], role.rolePermissions ?? []);
}
