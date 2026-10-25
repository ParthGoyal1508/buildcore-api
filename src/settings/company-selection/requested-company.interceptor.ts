import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from 'nestjs-prisma';
import { from, type Observable, switchMap } from 'rxjs';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';

export const UNKNOWN_COMPANY = 'UNKNOWN_COMPANY';

/** The `companyId` a request names, from its query or its body — the two places endpoints read it. */
function requestedCompanyIds(request: Request): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string') ids.add(value);
    if (Array.isArray(value)) value.forEach(add);
  };
  add(request.query?.companyId);
  const body: unknown = request.body;
  if (body && typeof body === 'object') {
    add((body as Record<string, unknown>).companyId);
  }
  return [...ids];
}

/**
 * Refuses a `companyId` that names no company (2026-10-25).
 *
 * A cross-company caller with no company selected is the one caller whose requested company is
 * taken as given: `companyScope`, `resolveCompanyId` and every module's `targetCompanyOf` hand it
 * straight to the query. Nothing checked it named a company, and `companyId` is a plain column
 * with no foreign key (Principle I), so `POST /projects/sites?companyId=undefined` saved a site in a
 * company called "undefined" — a row no company's screens would ever show.
 *
 * Checked once, here, for the 59 controllers and 84 DTOs that read the field, rather than in each.
 * Only for that caller: everyone else's requested company is ignored in favour of their own or
 * their selection, so checking theirs would refuse what was never going to be used.
 *
 * Global, and an interceptor rather than a guard, for the reason `PasswordChangeInterceptor`
 * records: a global guard runs before the per-controller `JwtAuthGuard` and would see no user.
 */
@Injectable()
export class RequestedCompanyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user || !rlsContextFor(user).isSuperAdmin) return next.handle();

    const requested = requestedCompanyIds(request);
    if (requested.length === 0) return next.handle();

    return from(this.unknownOf(requested)).pipe(
      switchMap((unknown) => {
        if (unknown.length > 0) {
          throw new BadRequestException({
            statusCode: 400,
            code: UNKNOWN_COMPANY,
            message: `No company has the id "${unknown[0]}".`,
          });
        }
        return next.handle();
      }),
    );
  }

  private async unknownOf(ids: string[]): Promise<string[]> {
    const found = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        }),
    );
    const known = new Set(found.map((company) => company.id));
    return ids.filter((id) => !known.has(id));
  }
}
