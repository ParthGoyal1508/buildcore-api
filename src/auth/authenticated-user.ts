import { Permission, Role, User, UserRole } from '@prisma/client';

/** A User row plus its effective permissions — the union of every role it holds
 * (2026-08-28 clarification: an account can hold multiple roles). This is the shape
 * `request.user` carries once authenticated (jwt.strategy.ts's `validate()` return
 * value), not a raw Prisma `User`. */
export interface AuthenticatedUser extends User {
  permissions: Permission[];
  roleNames: string[];
}

type UserWithRoles = User & { userRoles: (UserRole & { role: Role })[] };

export function toAuthenticatedUser(user: UserWithRoles): AuthenticatedUser {
  const permissionSet = new Set<Permission>();
  const roleNames: string[] = [];
  for (const userRole of user.userRoles) {
    roleNames.push(userRole.role.name);
    for (const permission of userRole.role.permissions) {
      permissionSet.add(permission);
    }
  }
  const { userRoles: _userRoles, ...rest } = user;
  return { ...rest, permissions: [...permissionSet], roleNames };
}
