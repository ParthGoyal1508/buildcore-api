import { Permission, Role, User, UserRole } from '@prisma/client';

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
}

type UserWithRoles = User & { userRoles: (UserRole & { role: Role })[] };

export function toAuthenticatedUser(user: UserWithRoles): AuthenticatedUser {
  const permissionSet = new Set<Permission>();
  const roleNames: string[] = [];
  const roleIds: string[] = [];
  for (const userRole of user.userRoles) {
    roleNames.push(userRole.role.name);
    roleIds.push(userRole.role.id);
    for (const permission of userRole.role.permissions) {
      permissionSet.add(permission);
    }
  }
  const { userRoles: _userRoles, ...rest } = user;
  return { ...rest, permissions: [...permissionSet], roleNames, roleIds };
}
