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
import { PermissionRefusalService } from './permission-refusal.service';
import {
  PUBLIC_KEY,
  SELF_SERVICE_KEY,
} from '../decorators/route-access.decorator';

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
  constructor(
    private readonly reflector: Reflector,
    /**
     * Optional, so a hand-built guard in a unit test needs no recorder. FR-003 asks that
     * refusals be recorded; it does not ask that the guard refuse to work without somewhere
     * to record them.
     */
    private readonly refusals?: PermissionRefusalService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      // 019 FR-005, Phase 3. An undeclared route now **fails closed**.
      //
      // Before this, no decorator meant "authenticated only", which is correct for the
      // `/my/*` surfaces and indistinguishable from an oversight everywhere else. Those
      // surfaces now say so with `@SelfService()`, the health check says so with
      // `@PublicRoute()`, and anything declaring neither is refused — so a controller added
      // next year is protected because the guard defaults to refusing, not because somebody
      // remembered.
      const declared =
        this.reflector.getAllAndOverride<boolean>(SELF_SERVICE_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ||
        this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
          context.getHandler(),
          context.getClass(),
        ]);

      if (declared) return true;

      throw new ForbiddenException({
        statusCode: 403,
        code: 'ROUTE_ACCESS_UNDECLARED',
        message:
          'This route declares no access requirement. It must carry ' +
          '@RequirePermissions(...), @SelfService() or @PublicRoute().',
      });
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

    // A caller whose grants have not been populated — an account whose roles predate 019's
    // backfill — falls back to the area-only check. Refusing instead would lock out every such
    // caller on deploy, and the level model is additive: `permissions` still means "holds this
    // area at some level".
    //
    // **The fallback is per AREA, not per caller. Changed 2026-10-04, and the distinction is
    // the whole of it.** It used to apply only when the caller had *no* grants at all, so an
    // account holding one backfilled role and one role whose permissions live only in the array
    // lost the second role's areas entirely — the backfilled role's grants made the list
    // non-empty, and the un-backfilled area then had no level to match. Silent, and in the
    // direction of refusing something the caller holds. Found by `settings.e2e-spec.ts`, where
    // deleting a role was supposed to revoke access and the access had never been granted.
    //
    // Narrowing it to the area is strictly safer than widening, which is why it is safe at all:
    // the fallback now applies only where the caller has **zero** grant rows for that area, so
    // a role deliberately held at `read` cannot be lifted to `write` by it. A read-only role
    // has a `read` row for the area, which means the area is backfilled, which means no
    // fallback. That case is asserted in this guard's spec.
    const areaHasGrants = (permission: Permission): boolean =>
      (user.grants ?? []).some((grant) => grant.permission === permission);

    const holdsAtLevel = required.some((permission) =>
      areaHasGrants(permission)
        ? (user.grants ?? []).some(
            (grant) => grant.permission === permission && grant.level === level,
          )
        : user.permissions.includes(permission),
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
    // FR-003. Fire-and-forget: the decision is already made, and a 403 must not become a 500
    // because a log write failed.
    //
    // Wrapped, and not because `record` is expected to throw — it swallows its own write
    // failures. The guard must not *depend* on that: a recorder that threw synchronously
    // (a bad injection, a future refactor) would turn every refusal into a 500, which is the
    // difference between a working system and an apparently broken one. Caught by the unit
    // test rather than by review.
    try {
      this.refusals?.record({
        companyId: user.companyId,
        userId: user.id,
        method: request.method ?? 'GET',
        // The route template, never the resolved URL — a resolved URL carries record ids,
        // and a security log accumulating them becomes a store of personal data nobody
        // classified.
        path: routeTemplate(context),
        requiredPermission: required[0],
        requiredLevel: level,
        heldLevel: holdsArea
          ? user.grants.find((g) => required.includes(g.permission))?.level ??
            null
          : null,
      });
    } catch {
      // Nothing to do: the refusal below is the response, and it is unaffected.
    }

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

/**
 * The route's declared path, assembled from controller and handler metadata.
 *
 * Nest does not hand a guard the matched route pattern, so it is rebuilt from the same
 * metadata the router used. Falling back to class and handler **names** rather than to the
 * request URL is deliberate: the fallback must never be the thing this function exists to
 * avoid recording.
 */
function routeTemplate(context: ExecutionContext): string {
  const controllerPath =
    Reflect.getMetadata('path', context.getClass()) ?? context.getClass().name;
  const handlerPath =
    Reflect.getMetadata('path', context.getHandler()) ??
    context.getHandler().name;
  const suffix =
    typeof handlerPath === 'string' && handlerPath !== '/'
      ? `/${handlerPath}`
      : '';
  return `/${String(controllerPath).replace(/^\/+/, '')}${suffix}`.replace(
    /\/+$/,
    '',
  );
}
