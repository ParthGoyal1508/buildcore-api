import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
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
/**
 * The records a project write can be keyed by instead of the project itself, and
 * how each one reaches its project.
 *
 * 036 I1: the guard used to read only `:projectId`/`:id`, and admitted everything
 * else as "not project-scoped". But `PATCH /projects/dwr/:dwrId` and
 * `POST /projects/bill-packages/:packageId/issue` *are* project writes — the project
 * is just one hop away — so every DWR and bill-package write on a locked project
 * went through. The guard was mounted on them, which made it look covered.
 */
export type ProjectLockSubject =
  | 'dwr'
  | 'billPackage'
  | 'raBill'
  | 'clientBill'
  | 'workOrder'
  | 'debitNote'
  | 'packageDebit';

type ProjectLookup = (
  tx: Prisma.TransactionClient,
  id: string,
) => Promise<{ project: { isLocked: boolean } } | null>;

const viaProject = { project: { select: { isLocked: true } } } as const;

const LOOKUPS: Record<ProjectLockSubject, ProjectLookup> = {
  dwr: (tx, id) =>
    tx.dailyWorkReport.findFirst({ where: { id }, select: viaProject }),
  billPackage: (tx, id) =>
    tx.billPackage.findFirst({ where: { id }, select: viaProject }),
  raBill: (tx, id) =>
    tx.rABill.findFirst({ where: { id }, select: viaProject }),
  clientBill: (tx, id) =>
    tx.clientBill.findFirst({ where: { id }, select: viaProject }),
  workOrder: (tx, id) =>
    tx.workOrder.findFirst({ where: { id }, select: viaProject }),
  debitNote: (tx, id) =>
    tx.billPackageDebitNote.findFirst({ where: { id }, select: viaProject }),
  packageDebit: (tx, id) =>
    tx.billPackageDebit.findFirst({ where: { id }, select: viaProject }),
};

/**
 * Route parameters whose name alone says which record they key. Checked only when
 * the route names no project directly, and in this order — `apply/:packageId` on a
 * debit note carries two, and both lead to the same project.
 */
const PARAM_SUBJECTS: ReadonlyArray<[string, ProjectLockSubject]> = [
  ['dwrId', 'dwr'],
  ['packageId', 'billPackage'],
  ['raBillId', 'raBill'],
  ['workOrderId', 'workOrder'],
  ['noteId', 'debitNote'],
  ['debitId', 'packageDebit'],
];

export const PROJECT_LOCK_SUBJECT = 'projectLockSubject';

/**
 * Says what this route's `:id` is when it is *not* a project — `/projects/ra-bills/:id`
 * names a bill — or, with `'body'`, that the project arrives as `body.projectId` (the
 * create routes, whose project is in the payload rather than the path).
 *
 * A decorator rather than guessing from the controller path: `:id` means a project on
 * `/projects/:id/boq` and a bill on `/projects/ra-bills/:id`, and a guard that guessed
 * wrong would look the bill's id up as a project, find nothing, and 404 a real bill.
 */
export const ProjectLockFrom = (subject: ProjectLockSubject | 'body') =>
  SetMetadata(PROJECT_LOCK_SUBJECT, subject);

@Injectable()
export class ProjectLockGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const params = request.params as Record<string, string | undefined>;
    const declared = this.reflector.get<
      ProjectLockSubject | 'body' | undefined
    >(PROJECT_LOCK_SUBJECT, context.getHandler());

    const { user } = request;
    if (!user) {
      // JwtAuthGuard runs first and would have refused already; this is defence
      // against a future misordering of the guard list, not an expected path.
      return false;
    }
    const ctx = rlsContextFor(user);

    if (declared === 'body') {
      // The guard runs before the ValidationPipe, so the body is still raw JSON. A
      // missing or non-string projectId is left for the DTO to refuse with its own
      // 400 — refusing it here would answer a validation error with a lock error.
      const bodyProjectId = (
        request.body as { projectId?: unknown } | undefined
      )?.projectId;
      return typeof bodyProjectId === 'string' && bodyProjectId
        ? this.checkProject(ctx, bodyProjectId, { admitUnknown: true })
        : true;
    }

    if (declared) {
      return params.id ? this.checkVia(ctx, declared, params.id) : true;
    }

    // Routes in this module name the project either `:projectId` (when the project
    // is a qualifier, as in `/projects/dwr`) or `:id` (when it is the subject, as in
    // `/projects/:id/boq`). Checking both is what lets one guard cover both shapes.
    const projectId = params.projectId ?? params.id;
    if (projectId) {
      return this.checkProject(ctx, projectId);
    }

    for (const [param, subject] of PARAM_SUBJECTS) {
      const id = params[param];
      if (id) {
        return this.checkVia(ctx, subject, id);
      }
    }

    // No project in the route means nothing to lock against. Admitting the request
    // is right: the endpoint's own permission guard has already run, and inventing a
    // refusal here would break any future write that is not project-scoped.
    return true;
  }

  /**
   * A record the caller cannot see, or that does not exist, is **admitted** rather
   * than refused: the handler then answers with its own 404 and its own wording, as
   * it did before this guard knew about the record. Only a project positively seen
   * to be locked is refused.
   */
  private async checkVia(
    ctx: ReturnType<typeof rlsContextFor>,
    subject: ProjectLockSubject,
    id: string,
  ): Promise<boolean> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      LOOKUPS[subject](tx, id),
    );
    if (row?.project.isLocked) {
      this.refuse();
    }
    return true;
  }

  private async checkProject(
    ctx: ReturnType<typeof rlsContextFor>,
    projectId: string,
    { admitUnknown = false }: { admitUnknown?: boolean } = {},
  ): Promise<boolean> {
    const project = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.project.findFirst({
        where: { id: projectId },
        select: { isLocked: true },
      }),
    );

    // Reported as not-found rather than admitted, so a write against a project the
    // caller cannot see fails here instead of deeper in a service with a less
    // careful message. A project named in a create payload is the exception: the
    // service already answers an unknown one in its own words, and a body the
    // ValidationPipe has not yet seen is not this guard's to judge.
    if (!project) {
      if (admitUnknown) {
        return true;
      }
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (project.isLocked) {
      this.refuse();
    }

    return true;
  }

  private refuse(): never {
    throw new HttpException(
      'This project is locked. Unlock it to make changes.',
      HTTP_STATUS_LOCKED,
    );
  }
}
