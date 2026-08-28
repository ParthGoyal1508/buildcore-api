import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../../auth/authenticated-user';

/**
 * Reads the `@RequirePermissions(...)` metadata and compares it against the
 * already-authenticated request's effective permissions (the union across every
 * role the caller holds — see authenticated-user.ts). Apply alongside
 * `JwtAuthGuard` — this guard only checks permissions, it doesn't itself establish
 * `request.user` (spec FR-010).
 *
 * An endpoint with no `@RequirePermissions(...)` declared is admitted
 * unconditionally (matches today's authenticated-only behavior).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    return !!user && required.some((p) => user.permissions.includes(p));
  }
}
