import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel, Permission } from '@prisma/client';
import { Observable } from 'rxjs';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { levelForMethod } from '../access-levels';
import { ACCESS_LEVEL_KEY } from '../decorators/access-level.decorator';
import { REQUIRES_CASH_ENTRY_KEY } from '../decorators/cash-entry.decorator';
import { PermissionRefusalService } from '../guards/permission-refusal.service';
import {
  CASH_MODE_FIELDS,
  UNCONDITIONAL_CASH_FIELDS,
  isCashMode,
} from './cash-surfaces';

/** The shape of a request this interceptor reads. Nothing else on it is any of its business. */
interface CashEntryRequest {
  user?: AuthenticatedUser;
  method?: string;
  body?: unknown;
  route?: { path?: string };
  url?: string;
}

/** Refused because the caller may not record a payment in cash (019 FR-017a). */
export const CASH_ENTRY_REFUSAL_CODE = 'CASH_ENTRY_DENIED';

/**
 * Refuses a write that records a payment **in cash** from a caller without `CASH_ENTRY`
 * (019 FR-017a, FR-017b).
 *
 * **Finds cash in the request rather than on a list of routes.** `CashVisibilityInterceptor`
 * already finds cash on the way out, using `CASH_MODE_FIELDS` and `isCashMode`; this uses the
 * same two constants on the way in. The alternative — annotating the routes that take cash —
 * was rejected because the failure mode is silent: a cash route added later and not annotated
 * is an unguarded way to enter cash, and no test anybody thinks to write will catch it. Here
 * the default is the other way round. A new route that accepts `paymentMode` is gated the day
 * it is written, by nobody's effort.
 *
 * **An interceptor, not a guard, for the reason `PasswordChangeInterceptor` is one.** Global
 * guards run before controller-level ones, and `JwtAuthGuard` is declared per controller here —
 * a global guard would see no `request.user` and admit everything. That failure would be
 * invisible: every request would pass, which is exactly what passing looks like.
 *
 * **Reads the raw body, before the validation pipe.** Pipes run after interceptors, so what is
 * inspected is what the client sent rather than what a DTO chose to keep. That is the stronger
 * position: a field a DTO silently strips can still reach a service through another path, and a
 * caller cannot evade the check by sending a shape the DTO does not declare.
 *
 * **A bank-mode write is untouched**, and that matters more than the refusal. This is a cash
 * permission, not a payments permission: if holding it became a condition of recording any
 * payment, every accounts clerk would need the right to take cash, and the control would have
 * made the company's cash handling broader rather than narrower.
 */
@Injectable()
export class CashEntryInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    /**
     * Optional for the reason `PermissionsGuard`'s is: a refusal must not depend on there being
     * somewhere to record it.
     */
    private readonly refusals?: PermissionRefusalService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<CashEntryRequest>();

    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? levelForMethod(request.method ?? 'GET');

    // A read is never cash entry. This is not an optimisation: `ListPaymentsDto` takes
    // `paymentMode` as a *filter*, so without this a read-only clerk would be refused the
    // list of cash payments they are explicitly allowed to see with the amounts hidden.
    if (level === AccessLevel.read) return next.handle();

    const declared = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_CASH_ENTRY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const trigger = declared
      ? 'route'
      : findCashInRequest(request.body ?? null);
    if (!trigger) return next.handle();

    const user = request.user;
    // No authenticated caller: `JwtAuthGuard` has already refused anything that needed one,
    // and a route that needs none cannot be recording a company's cash.
    if (!user) return next.handle();

    if (mayEnterCash(user)) return next.handle();

    try {
      this.refusals?.record({
        companyId: user.companyId,
        userId: user.id,
        method: request.method ?? 'POST',
        path: routePath(request),
        requiredPermission: Permission.CASH_ENTRY,
        requiredLevel: AccessLevel.write,
        heldLevel: null,
      });
    } catch {
      // The refusal below is the response and is unaffected.
    }

    throw new ForbiddenException({
      statusCode: 403,
      code: CASH_ENTRY_REFUSAL_CODE,
      // Names the field, because the caller's next question is always "which part of this was
      // cash" — most often a denomination breakup they did not realise they were sending.
      message:
        `Recording a payment in cash requires the Cash Entry permission ` +
        `(found at "${trigger}").`,
    });
  }
}

/**
 * True when the caller may **record** a payment in cash (019 FR-017a).
 *
 * `CASH_ENTRY` is split across the two levels every other area in this enum uses, and the split
 * is not a formality: `write` is the right to record a cash payment, `read` is the right to see a
 * cash denomination breakup (FR-017d). A cashier needs both; a supervisor checking a payout sheet
 * against the notes needs only the second.
 *
 * Falls back to the area check for a caller with no grants at all, matching `PermissionsGuard`:
 * an account whose roles predate the level backfill must not be locked out by a model it has no
 * rows for.
 */
export function mayEnterCash(
  user: Pick<AuthenticatedUser, 'permissions' | 'grants'>,
): boolean {
  if (user.grants === undefined || user.grants.length === 0) {
    return user.permissions.includes(Permission.CASH_ENTRY);
  }
  return user.grants.some(
    (grant) =>
      grant.permission === Permission.CASH_ENTRY &&
      grant.level === AccessLevel.write,
  );
}

/**
 * True when the caller may **see** a cash denomination breakup (019 FR-017d).
 *
 * Either level, not `read` alone. `RolesService` refuses write-without-read, so a cash-entering
 * role holds both in practice — but a role backfilled by a migration or built by a test might
 * not, and hiding the breakup from somebody entitled to pay against it is the failure FR-017d
 * exists to fix. Erring the other way here costs nothing: a write holder is already trusted with
 * the notes themselves.
 */
export function maySeeCashBreakup(
  user: Pick<AuthenticatedUser, 'permissions' | 'grants'>,
): boolean {
  if (user.grants === undefined || user.grants.length === 0) {
    return user.permissions.includes(Permission.CASH_ENTRY);
  }
  return user.grants.some(
    (grant) => grant.permission === Permission.CASH_ENTRY,
  );
}

/**
 * Returns the path of the first thing in a request body that makes it a cash write, or `null`.
 *
 * Recurses, because a cash mode is as likely to arrive inside a line of a batch as at the top
 * level, and a check that only looked at the top level would be evaded by nesting — without
 * anybody intending to evade it.
 *
 * Returns the *path* rather than `true` so the refusal can say which field it found and the
 * test can assert on which one it found, not merely that it found something.
 */
export function findCashInRequest(body: unknown, prefix = ''): string | null {
  if (Array.isArray(body)) {
    for (const [index, item] of body.entries()) {
      const found = findCashInRequest(item, `${prefix}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (body === null || typeof body !== 'object') return null;
  // Same conservatism as the outbound walk: only literal objects. A `Date` or a `Buffer`
  // reached by this point has no cash in it and its own keys are not ours to read.
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return null;

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (CASH_MODE_FIELDS.includes(key) && isCashMode(value)) return path;
    // Cash by construction. A denomination breakup is a count of notes; sending one is
    // handling cash whatever the row's mode field says, and a breakup with no mode beside it
    // would otherwise pass.
    if (
      UNCONDITIONAL_CASH_FIELDS.includes(key) &&
      value !== null &&
      value !== undefined
    ) {
      return path;
    }
    const found = findCashInRequest(value, path);
    if (found) return found;
  }
  return null;
}

/**
 * The route template where the framework offers one, and never the resolved URL — a resolved
 * URL carries record ids, and a security log accumulating them becomes a store of personal
 * data nobody classified. Matches `PermissionsGuard`'s reasoning.
 */
function routePath(request: {
  route?: { path?: string };
  url?: string;
}): string {
  return request.route?.path ?? stripQuery(request.url ?? 'unknown');
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}
