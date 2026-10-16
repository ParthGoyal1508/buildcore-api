import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';

/**
 * Company administration reaches only the caller's own company unless they work across
 * companies (2026-10-16 access-control audit, C4).
 *
 * `COMPANY_SETTINGS` says *what* a caller may do to a company, never *which* one, and `Company`
 * has no row-level security — so a holder could read and change every company's details, billing
 * rates, numbering and punch settings. Every route on the controller names its company as `:id`,
 * so the check is one comparison here rather than one per handler. Creating a company is a group
 * act and needs `CROSS_COMPANY_ACCESS`; the list is narrowed in the handler.
 */
@Injectable()
export class OwnCompanyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      params?: Record<string, string>;
      method: string;
    }>();
    const user = request.user;
    if (!user) return false;
    if (user.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) return true;

    const id = request.params?.id;
    if (id === undefined) {
      if (request.method === 'GET') return true;
      throw new ForbiddenException({
        code: 'GROUP_ACCESS_REQUIRED',
        message: 'Only a group administrator can create a company.',
      });
    }
    if (id !== user.companyId) {
      throw new ForbiddenException({
        code: 'COMPANY_NOT_ACCESSIBLE',
        message: 'You can only manage your own company.',
      });
    }
    return true;
  }
}
