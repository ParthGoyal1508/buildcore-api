import { SetMetadata } from '@nestjs/common';
import { Permission } from '@prisma/client';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Declares which permission(s) may call an endpoint, enforced by `PermissionsGuard`
 * before the handler runs (spec FR-010, redesigned 2026-08-28 from role-based to
 * permission-based — a caller is admitted if their effective permissions, the union
 * across every role they hold, include ANY of the ones listed here).
 *
 * An endpoint with no `@RequirePermissions(...)` is authenticated-only — unchanged
 * from today's `JwtAuthGuard`-only behavior.
 *
 * Example: `@UseGuards(JwtAuthGuard, PermissionsGuard)` on the controller, then
 * `@RequirePermissions(Permission.USER_MANAGEMENT)` on one method.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
