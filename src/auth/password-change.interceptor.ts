import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { CredentialOrigin } from '@prisma/client';
import { AuthenticatedUser } from './authenticated-user';
import { PASSWORD_CHANGE_EXEMPT_KEY } from '../common/decorators/password-change-exempt.decorator';

/** Origins whose password an administrator knows, and so must be replaced (029 FR-016). */
const ADMIN_CHOSEN: ReadonlySet<CredentialOrigin | null | undefined> = new Set([
  CredentialOrigin.admin_direct,
  CredentialOrigin.admin_reset,
]);

/** The code clients branch on. Never the message — that is prose and may change. */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/**
 * Refuses an account that must replace an admin-set password before doing anything
 * (010 FR-017a).
 *
 * Scoped to passwords an admin chose: `admin_direct` (set at creation) and, since 029
 * FR-016, `admin_reset` — which 010 left advisory (FR-017a-ii), even though the admin knows
 * that value exactly as well. `mustChangePassword` alone still does not decide: it is the
 * origin that says an admin chose the value.
 *
 * An absent or unrecognised origin is never refused (FR-017a-i). Failing open is
 * confined to this one rule — the request still needs a valid session and its
 * permissions — and the alternative would lock a real user out of the entire
 * application over missing metadata.
 *
 * The decision reads `request.user`, which `JwtStrategy.validate()` re-reads from
 * the database on every request (001 FR-009). Reading the JWT claim instead would
 * keep refusing the user *after* they changed their password, until their token
 * expired — trapping them on the screen they had just completed.
 *
 * An interceptor, not a guard, for one reason that only shows up at runtime: Nest
 * runs *global* guards before *controller* guards, and `JwtAuthGuard` is applied per
 * controller here. A global guard would therefore run before authentication, see no
 * `request.user`, and wave every request through — which is exactly what it did
 * before this was changed. Interceptors run after all guards, so the account is
 * populated by the time this decides.
 */
@Injectable()
export class PasswordChangeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const exempt = this.reflector.getAllAndOverride<boolean>(
      PASSWORD_CHANGE_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) {
      return next.handle();
    }

    // Typed locally rather than by augmenting Express's Request: passport writes
    // `user` at runtime, and widening the global type for one guard would let every
    // other handler assume it is always present.
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    // No user means this route is unauthenticated (or the auth guard has not run
    // yet); there is no account to hold to this rule.
    if (!user) {
      return next.handle();
    }

    const mustChange =
      user.mustChangePassword === true &&
      ADMIN_CHOSEN.has(user.credentialOrigin);
    if (!mustChange) {
      return next.handle();
    }

    throw new ForbiddenException({
      code: PASSWORD_CHANGE_REQUIRED,
      message:
        'Your password was set by an administrator. Change it before continuing.',
    });
  }
}
