import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';
import { from, type Observable, switchMap } from 'rxjs';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';

/**
 * Responses name their company; a save from a tab on the wrong company is refused (036 B17).
 *
 * ## Why
 *
 * The selected company is stored per user, not per tab. Switching company in one tab silently
 * switches every other tab too — so a form left open on company A, saved after the user switched
 * to B elsewhere, landed in B. The decision was **detect and warn** rather than per-tab selection.
 *
 * ## The contract
 *
 * - **Every authenticated response** carries `X-Company-Id`: the company the request was scoped
 *   to, or empty for a cross-company caller who has selected none (they see every company).
 * - A client **may** send `X-Expected-Company-Id` — the company its tab believes it is in. On any
 *   request other than GET/HEAD/OPTIONS, if the header is present and differs from the caller's
 *   effective company, the request is refused before the handler runs:
 *
 *   ```json
 *   { "statusCode": 409, "code": "COMPANY_CHANGED",
 *     "message": "Company was changed to Beta Infra in another tab. Reload to continue.",
 *     "companyId": "<effective id or empty>", "companyName": "Beta Infra" }
 *   ```
 *
 *   An absent header is not checked, so older clients behave exactly as before.
 *
 * Exempt (`@CompanyCheckExempt()`): signing in and out, and switching company itself — the switch
 * is how a stale tab is *meant* to change company.
 *
 * Global, and an interceptor rather than a guard for the reason `PasswordChangeInterceptor`
 * gives: global guards run before the per-controller `JwtAuthGuard`, so a guard would see no user.
 */
export const COMPANY_CHANGED = 'COMPANY_CHANGED';
export const COMPANY_HEADER = 'X-Company-Id';
export const EXPECTED_COMPANY_HEADER = 'X-Expected-Company-Id';

export const COMPANY_CHECK_EXEMPT_KEY = 'companyCheckExempt';
export const CompanyCheckExempt = () =>
  SetMetadata(COMPANY_CHECK_EXEMPT_KEY, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The company the header's switcher shows as selected — what a tab compares against.
 *
 * The same rule as `selectableFor` (`selected ?? caller.companyId`), not the RLS context's. A
 * cross-company caller who has chosen nothing runs with the bypass, but the switcher still shows
 * their home company as selected and the tab asserts it; reporting '' ("all companies") here made
 * those two disagree on every request, so every save a Super Admin made before first picking a
 * company was refused as COMPANY_CHANGED (found 2026-10-18 on a freshly seeded database). The
 * header exists to detect *another tab switching*, and comparing the displayed selection with the
 * displayed selection is exactly that.
 */
export function servedCompanyId(user: AuthenticatedUser): string {
  if (user.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
    return user.selectedCompanyId ?? user.companyId ?? '';
  }
  return rlsContextFor(user).companyId ?? '';
}

@Injectable()
export class CompanyHeaderInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return next.handle();

    const companyId = servedCompanyId(user);
    http.getResponse<Response>().setHeader(COMPANY_HEADER, companyId);

    const expected = request.headers[EXPECTED_COMPANY_HEADER.toLowerCase()];
    if (
      expected === undefined ||
      SAFE_METHODS.has(request.method.toUpperCase()) ||
      this.reflector.getAllAndOverride<boolean>(COMPANY_CHECK_EXEMPT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }
    const claimed = (Array.isArray(expected) ? expected[0] : expected).trim();
    if (claimed === companyId) return next.handle();

    return from(this.refusal(companyId)).pipe(
      switchMap((error) => {
        throw error;
      }),
    );
  }

  private async refusal(companyId: string): Promise<ConflictException> {
    const companyName = companyId
      ? (
          await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
            tx.company.findUnique({
              where: { id: companyId },
              select: { name: true },
            }),
          )
        )?.name ?? 'another company'
      : 'all companies';
    return new ConflictException({
      statusCode: 409,
      code: COMPANY_CHANGED,
      message: `Company was changed to ${companyName} in another tab. Reload to continue.`,
      companyId,
      companyName,
    });
  }
}
