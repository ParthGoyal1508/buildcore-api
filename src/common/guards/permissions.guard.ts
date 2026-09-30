import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { levelForMethod } from '../access-levels';
import { ACCESS_LEVEL_KEY } from '../decorators/access-level.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

/**
 * Reads `@RequirePermissions(...)` and compares it against the caller's grants — the
 * **area** and now also the **level** (019 FR-001, FR-003).
 *
 * The area comes from the decorator, as it always has. The level comes from the HTTP
 * method: `GET` needs `read`, `POST`/`PATCH`/`PUT`/`DELETE` need `write`, and
 * `@RequireLevel(...)` overrides that where the verb lies (a `POST` search). That is why
 * none of the 116 existing declarations had to change and why FR-003 covers every route
 * at once rather than the subset somebody annotated.
 *
 * **OR across areas is preserved.** A caller holding any one of the named areas at the
 * required level passes, exactly as before this change.
 *
 * An endpoint with no `@RequirePermissions(...)` is still admitted — matching today's
 * authenticated-only behaviour, which is correct for the `/my/*` self-service surfaces.
 * 019 Phase 3 replaces that with an explicit `@SelfService()` declaration and makes the
 * absence fail closed; until then the behaviour is unchanged on purpose, because changing
 * both the level model and the default in one step would make a failure impossible to
 * attribute.
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

    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      method?: string;
    }>();
    const user = request.user;
    if (!user) {
      return false;
    }

    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? levelForMethod(request.method ?? 'GET');

    // A caller whose grants have not been populated — an account whose roles predate
    // 019's backfill, or a hand-built test double — falls back to the area-only check.
    // Refusing instead would lock out every such caller on deploy, and the level model is
    // additive: `permissions` still means "holds this area at some level".
    if (user.grants === undefined || user.grants.length === 0) {
      return required.some((permission) =>
        user.permissions.includes(permission),
      );
    }

    const holdsAtLevel = required.some((permission) =>
      user.grants.some(
        (grant) => grant.permission === permission && grant.level === level,
      ),
    );
    if (holdsAtLevel) {
      return true;
    }

    // Refused — and *which* refusal it is matters. `PERMISSION_LEVEL_INSUFFICIENT` means
    // the caller holds the area but not at this level, which is an interface that offered
    // a control it should have hidden (FR-004's failure mode). `PERMISSION_AREA_DENIED`
    // means they hold nothing here, which is a security signal. A single opaque 403 makes
    // a bug report and an intrusion attempt look identical.
    const holdsArea = required.some((permission) =>
      user.grants.some((grant) => grant.permission === permission),
    );
    throw new ForbiddenException({
      statusCode: 403,
      code: holdsArea
        ? 'PERMISSION_LEVEL_INSUFFICIENT'
        : 'PERMISSION_AREA_DENIED',
      message: holdsArea
        ? `This action requires ${level} access to ${required.join(' or ')}.`
        : 'You do not have access to this area.',
      required: { permission: required, level },
    });
  }
}
