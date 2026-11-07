import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import type { Observable } from 'rxjs';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { OWN_RECORDS_KEY } from '../own-records/own-records.decorator';
import { EDITOR_MAY_DELETE_KEY } from './editor-may-delete.decorator';

export const RECORD_DELETE_REFUSAL = {
  code: 'DELETE_SUPER_ADMIN_ONLY',
  message: 'Only a Super Admin can delete records.',
} as const;

/**
 * Deleting a record is Super Admin only (client, 2026-11-07).
 *
 * Every `DELETE` request is refused unless the caller holds `CROSS_COMPANY_ACCESS`, apart from
 * routes marked `@EditorMayDelete()` (removing a part of something being edited) and the caller's
 * own records (`@OwnRecords()`). Refusing by default means a delete route added later is Super
 * Admin only until somebody decides otherwise.
 *
 * An interceptor rather than a guard because authentication is per controller: interceptors run
 * after every guard, so the user is known and the route's own permission check has already run.
 */
@Injectable()
export class RecordDeleteInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<{ method?: string; user?: AuthenticatedUser }>();
    if (request.method !== 'DELETE') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    const exempt =
      this.reflector.getAllAndOverride<boolean>(
        EDITOR_MAY_DELETE_KEY,
        targets,
      ) || this.reflector.getAllAndOverride<boolean>(OWN_RECORDS_KEY, targets);
    if (exempt) return next.handle();
    if (request.user?.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
      return next.handle();
    }
    throw new ForbiddenException(RECORD_DELETE_REFUSAL);
  }
}
