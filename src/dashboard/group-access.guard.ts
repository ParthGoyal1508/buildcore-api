import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/authenticated-user';

/** What a refused caller is told, when a route reuses this guard for something other than the Group Dashboard. */
export interface GroupAccessRefusal {
  code: string;
  message: string;
}

const GROUP_ACCESS_REFUSAL = 'groupAccessRefusal';

const GROUP_DASHBOARD_REFUSAL: GroupAccessRefusal = {
  code: 'GROUP_ACCESS_REQUIRED',
  message: 'The Group Dashboard is available to group administrators only.',
};

/** 058: the staff and labour refused-punch logs and their photos are for Super Admin only. */
export const REFUSED_PUNCH_LOG_REFUSAL: GroupAccessRefusal = {
  code: 'SUPER_ADMIN_REQUIRED',
  message: 'Only a Super Admin can see refused punches.',
};

/**
 * Words the 403 for a route that is Super Admin only for a reason of its own (058: the refused
 * punch logs). Without it the caller would be told about the Group Dashboard, which they never
 * asked for.
 */
export const GroupAccessRefusalMessage = (refusal: GroupAccessRefusal) =>
  SetMetadata(GROUP_ACCESS_REFUSAL, refusal);

/**
 * The Group Dashboard is for people who work across companies (2026-10-16 access-control audit,
 * H1).
 *
 * Its routes asked only for `DASHBOARD` (and `EMPLOYEES` for the cards), so a single-company
 * Project Manager could open it — and because `Company` carries no row-level security, the cards
 * named every active company in the group. A group view needs group access: `CROSS_COMPANY_ACCESS`,
 * on top of whatever each route already requires. A guard rather than another
 * `@RequirePermissions`, because that decorator is any-of and this is an all-of.
 *
 * 058 reuses it for the refused punch logs, which the client wants seen by Super Admin only — and
 * Super Admin is `CROSS_COMPANY_ACCESS` in this codebase. A holder of an all-companies role does
 * not hold the permission, so this guard refuses them too, which is the point.
 */
@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (user?.permissions.includes(Permission.CROSS_COMPANY_ACCESS))
      return true;
    const refusal =
      this.reflector.getAllAndOverride<GroupAccessRefusal | undefined>(
        GROUP_ACCESS_REFUSAL,
        [context.getHandler(), context.getClass()],
      ) ?? GROUP_DASHBOARD_REFUSAL;
    throw new ForbiddenException(refusal);
  }
}
