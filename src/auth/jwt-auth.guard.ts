import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';

import {
  COMPANY_HEADER,
  servedCompanyId,
} from '../settings/company-selection/company-header.interceptor';
import { AuthenticatedUser } from './authenticated-user';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /**
   * Names the caller's company on the response the moment they are authenticated (036 B17), so
   * the header is present even when a later guard refuses the request — a 403 from
   * `PermissionsGuard` is still an authenticated response. `CompanyHeaderInterceptor` sets it
   * too, and owns the mismatch check.
   */
  handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    const result = super.handleRequest(err, user, info, context, status);
    if (result && context.getType() === 'http') {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader(
          COMPANY_HEADER,
          servedCompanyId(result as unknown as AuthenticatedUser),
        );
    }
    return result;
  }
}
