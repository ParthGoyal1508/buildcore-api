import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import type { Caller } from './biometrics/face-enrolment.service';

/**
 * Builds the caller context every `/my/*` service method takes.
 *
 * Centralised so no controller can accidentally assemble a partial one — in
 * particular so the RLS context is always derived from the authenticated user
 * rather than from anything in the request body.
 */
export function callerFrom(user: AuthenticatedUser, request: Request): Caller {
  return {
    userId: user.id,
    companyId: user.companyId,
    ipAddress: clientIpOf(request),
    rls: rlsContextFor(user),
  };
}

/**
 * The client address recorded on audit entries.
 *
 * `req.ip` already honours Express's trust-proxy setting, which is the only correct
 * source behind the production reverse proxy; the fallbacks cover a direct
 * connection and the socket-less requests supertest issues in tests.
 */
export function clientIpOf(request: Request): string {
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
}
