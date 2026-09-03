import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { HTTP_STATUS_LOCKED } from '../constants/projects.constants';

/**
 * Refuses any write to a locked project with `423 Locked` (spec FR-003,
 * research.md §6).
 *
 * One guard rather than an `if (project.isLocked) throw` at the top of every write
 * method. The rule spans BOQ, DWR, revenue, RA bills, work orders, budget and
 * documents — seven services and roughly two dozen write endpoints — and a rule
 * enforced in two dozen places is a rule that will eventually be enforced in
 * twenty-three.
 *
 * Deliberately NOT applied to `PATCH /projects/:id`: unlocking a project is itself a
 * write to it, so a guard covering that endpoint would make every lock permanent.
 * The portfolio service audits the `isLocked` transition instead.
 *
 * 423 rather than 403 or 409 because the distinction matters to the client: 403
 * would say "you may not do this", which is wrong — the same caller may do it the
 * moment the project is unlocked — and 409 would suggest a conflicting edit. 423 is
 * exactly "the resource is locked", which is what happened.
 */
@Injectable()
export class ProjectLockGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    // Routes in this module name the project either `:projectId` (when the project
    // is a qualifier, as in `/projects/dwr`) or `:id` (when it is the subject, as in
    // `/projects/:id/boq`). Checking both is what lets one guard cover both shapes.
    const params = request.params as Record<string, string | undefined>;
    const projectId = params.projectId ?? params.id;

    // No project in the route means nothing to lock against. Admitting the request
    // is right: the endpoint's own permission guard has already run, and inventing a
    // refusal here would break any future write that is not project-scoped.
    if (!projectId) {
      return true;
    }

    const { user } = request;
    if (!user) {
      // JwtAuthGuard runs first and would have refused already; this is defence
      // against a future misordering of the guard list, not an expected path.
      return false;
    }

    const project = await withRlsContext(
      this.prisma,
      rlsContextFor(user),
      (tx) =>
        tx.project.findFirst({
          where: { id: projectId },
          select: { isLocked: true },
        }),
    );

    // Reported as not-found rather than admitted, so a write against a project the
    // caller cannot see fails here instead of deeper in a service with a less
    // careful message.
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (project.isLocked) {
      throw new HttpException(
        'This project is locked. Unlock it to make changes.',
        HTTP_STATUS_LOCKED,
      );
    }

    return true;
  }
}
