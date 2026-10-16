import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * The Group Dashboard is for people who work across companies (2026-10-16 access-control audit,
 * H1).
 *
 * Its routes asked only for `DASHBOARD` (and `EMPLOYEES` for the cards), so a single-company
 * Project Manager could open it — and because `Company` carries no row-level security, the cards
 * named every active company in the group. A group view needs group access: `CROSS_COMPANY_ACCESS`,
 * on top of whatever each route already requires. A guard rather than another
 * `@RequirePermissions`, because that decorator is any-of and this is an all-of.
 */
@Injectable()
export class GroupAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (user?.permissions.includes(Permission.CROSS_COMPANY_ACCESS))
      return true;
    throw new ForbiddenException({
      code: 'GROUP_ACCESS_REQUIRED',
      message: 'The Group Dashboard is available to group administrators only.',
    });
  }
}
