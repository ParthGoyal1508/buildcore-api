import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { OWN_RECORDS_KEY } from './own-records.decorator';

/**
 * On an `@OwnRecords()` route, an all-companies user works in their **home** company (058).
 *
 * `JwtStrategy` swaps such a user's `companyId` to the company they selected; their own employee
 * record, leave balance and payslips stay where they were hired. This undoes the swap for the
 * routes that read those, so `rlsContextFor(user)` and every `user.companyId` below resolve to the
 * home company — still exactly one company, never wider.
 *
 * Registered **after** `CompanyHeaderInterceptor`, so the tab-consistency check and the
 * `X-Company-Id` header still speak of the company the person is working in: punching in while
 * TE is selected is not "the company changed in another tab".
 */
@Injectable()
export class OwnRecordsInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const own = this.reflector.getAllAndOverride<boolean>(OWN_RECORDS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!own) return next.handle();
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (user?.multiCompany && user.homeCompanyId) {
      user.companyId = user.homeCompanyId;
    }
    return next.handle();
  }
}
