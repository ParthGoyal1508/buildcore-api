import {
  AccessLevel,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '@prisma/client';

/** A User row plus its effective permissions — the union of every role it holds
 * (2026-08-28 clarification: an account can hold multiple roles). This is the shape
 * `request.user` carries once authenticated (jwt.strategy.ts's `validate()` return
 * value), not a raw Prisma `User`. */
export interface AuthenticatedUser extends User {
  permissions: Permission[];
  roleNames: string[];
  /**
   * The ids of the roles this account holds.
   *
   * Added by feature 016: an approval level resolves to a `roleId` through
   * `RoleSlotMapping`, and checking authority by id lets the approval spine answer "may
   * this caller decide?" without reading `settings.UserRole` — which, from a `shared`
   * table, would be the cross-schema query Principle I forbids. Names were already here
   * but are not the identity a mapping stores, and matching on a renameable string would
   * silently unmap every chain the day somebody tidies up a role name.
   */
  roleIds: string[];
  /**
   * The caller's grants as area-and-level pairs (019 FR-001).
   *
   * `permissions` above is **not** replaced, and that is the whole reason this change is
   * small. It keeps its existing meaning — the areas this caller holds *at some level* —
   * so all 116 `@RequirePermissions(...)` declarations, `rlsContextFor`'s
   * `CROSS_COMPANY_ACCESS` check and every service-level `permissions.includes(...)`
   * continue to mean what they meant. What is new is the level, which only the guard and
   * anything deliberately asking about a level needs to read.
   *
   * A `Permission` value that is not read/write-shaped — `CROSS_COMPANY_ACCESS`,
   * `DATA_EXPORT`, the four `_APPROVE` values — appears here at both levels, because the
   * migration doubled every array entry. Asking about the level of such a value is
   * meaningless rather than wrong, and `permissions` is the right field for them.
   */
  grants: Grant[];
  /**
   * The company this caller has chosen to work in, when they may work in more than one
   * (019 FR-008, FR-010).
   *
   * Resolved per request from `settings.UserCompanySelection` and **validated against the
   * caller's accessible companies every time** — not trusted because it is stored. The spec's
   * own edge case is cross-company access being revoked while the other company is selected,
   * and a selection trusted at read time is how that becomes a cross-tenant read.
   *
   * Null for a caller with one company: their own always wins, and FR-013 says such a caller
   * is offered no switcher. `rlsContextFor` reads this — see there for what it changes.
   */
  selectedCompanyId?: string | null;
}

/** One area the caller holds, at one level. */
export interface Grant {
  permission: Permission;
  level: AccessLevel;
}

type UserWithRoles = User & {
  userRoles: (UserRole & {
    role: Role & { rolePermissions?: RolePermission[] };
  })[];
};

export function toAuthenticatedUser(user: UserWithRoles): AuthenticatedUser {
  const permissionSet = new Set<Permission>();
  // Keyed `PERMISSION:level`, so the union across several roles de-duplicates without a
  // nested scan. Two roles granting `MACHINERY:read` is one grant, not two.
  const grantKeys = new Set<string>();
  const roleNames: string[] = [];
  const roleIds: string[] = [];
  for (const userRole of user.userRoles) {
    roleNames.push(userRole.role.name);
    roleIds.push(userRole.role.id);
    for (const permission of userRole.role.permissions) {
      permissionSet.add(permission);
    }
    for (const grant of userRole.role.rolePermissions ?? []) {
      grantKeys.add(`${grant.permission}:${grant.level}`);
      // Also into `permissions`: a caller holding an area at any level holds the area.
      // This is what lets `Role.permissions` be dropped later without every
      // `permissions.includes(...)` in the codebase changing at the same time.
      permissionSet.add(grant.permission);
    }
  }
  const { userRoles: _userRoles, ...rest } = user;
  return {
    ...rest,
    permissions: [...permissionSet],
    grants: [...grantKeys].map((key) => {
      const [permission, level] = key.split(':');
      return {
        permission: permission as Permission,
        level: level as AccessLevel,
      };
    }),
    roleNames,
    roleIds,
  };
}
