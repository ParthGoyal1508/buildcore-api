import { ExecutionContext, NotFoundException } from '@nestjs/common';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { HTTP_STATUS_LOCKED } from '../constants/projects.constants';
import { PROJECT_LOCK_SUBJECT, ProjectLockGuard } from './project-lock.guard';

/**
 * The 423 path, tested here rather than end-to-end.
 *
 * tasks.md T025 asks for it as `lock → POST /projects/dwr → 423`, but the DWR
 * endpoints are User Story 5 and do not exist, so there is no write endpoint for the
 * guard to sit on yet. Testing the guard directly covers the same rule and does not
 * pretend an endpoint exists; the e2e suite asserts the `isLocked` flag it reads.
 */
describe('ProjectLockGuard', () => {
  const contextFor = (params: Record<string, string>): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          params,
          user: { id: 'user-1', companyId: 'company-1', permissions: [] },
        }),
      }),
    } as unknown as ExecutionContext);

  const guardFor = (project: unknown) =>
    new ProjectLockGuard(
      createPrismaMock({
        project: { findFirst: jest.fn().mockResolvedValue(project) },
      }) as never,
    );

  it('admits a write to an unlocked project', async () => {
    await expect(
      guardFor({ isLocked: false }).canActivate(
        contextFor({ id: 'project-1' }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses a write to a locked project with 423, not 403', async () => {
    // 403 would say "you may not do this", which is false — the same caller may do
    // it the moment the project is unlocked.
    const attempt = guardFor({ isLocked: true }).canActivate(
      contextFor({ id: 'project-1' }),
    );
    await expect(attempt).rejects.toMatchObject({
      status: HTTP_STATUS_LOCKED,
    });
    await expect(attempt).rejects.toThrow(/Unlock it to make changes/);
  });

  it('reads the project from `:projectId` as well as `:id`', async () => {
    // Routes in this module name it both ways depending on whether the project is
    // the subject or a qualifier.
    await expect(
      guardFor({ isLocked: true }).canActivate(
        contextFor({ projectId: 'project-1' }),
      ),
    ).rejects.toMatchObject({ status: HTTP_STATUS_LOCKED });
  });

  it('admits a route with no project in it at all', async () => {
    // Nothing to lock against. The endpoint's own permission guard has already run,
    // and inventing a refusal here would break any future write that is not
    // project-scoped.
    await expect(guardFor(null).canActivate(contextFor({}))).resolves.toBe(
      true,
    );
  });

  it('reports a project the caller cannot see as not found', async () => {
    await expect(
      guardFor(null).canActivate(contextFor({ id: 'someone-elses-project' })),
    ).rejects.toThrow(NotFoundException);
  });

  describe('routes keyed by a record of the project, not the project (036 I1)', () => {
    // Before 036 every one of these was admitted as "no project in the route", so a
    // locked project still took DWR edits and issued bill packages.
    const handler = () => undefined;
    const contextWith = (
      params: Record<string, string>,
      extra: { body?: unknown; subject?: string } = {},
    ): ExecutionContext => {
      if (extra.subject) {
        Reflect.defineMetadata(PROJECT_LOCK_SUBJECT, extra.subject, handler);
      } else {
        Reflect.deleteMetadata(PROJECT_LOCK_SUBJECT, handler);
      }
      return {
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            params,
            body: extra.body,
            user: { id: 'user-1', companyId: 'company-1', permissions: [] },
          }),
        }),
      } as unknown as ExecutionContext;
    };
    const lockedVia = (delegate: string, isLocked = true) => {
      const findFirst = jest
        .fn()
        .mockResolvedValue({ project: { isLocked } });
      const prisma = createPrismaMock({
        [delegate]: { findFirst },
        project: { findFirst: jest.fn().mockResolvedValue({ isLocked }) },
      });
      return { guard: new ProjectLockGuard(prisma as never), findFirst };
    };

    it.each([
      ['dwrId', 'dailyWorkReport'],
      ['packageId', 'billPackage'],
      ['raBillId', 'rABill'],
      ['workOrderId', 'workOrder'],
      ['noteId', 'billPackageDebitNote'],
      ['debitId', 'billPackageDebit'],
    ])('refuses `:%s` on a locked project with 423', async (param, delegate) => {
      const { guard, findFirst } = lockedVia(delegate);
      await expect(
        guard.canActivate(contextWith({ [param]: 'row-1' })),
      ).rejects.toMatchObject({ status: HTTP_STATUS_LOCKED });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'row-1' } }),
      );
    });

    it('admits `:dwrId` on an unlocked project', async () => {
      const { guard } = lockedVia('dailyWorkReport', false);
      await expect(
        guard.canActivate(contextWith({ dwrId: 'dwr-1' })),
      ).resolves.toBe(true);
    });

    it('admits a record it cannot find, so the handler 404s in its own words', async () => {
      const prisma = createPrismaMock({
        dailyWorkReport: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      await expect(
        new ProjectLockGuard(prisma as never).canActivate(
          contextWith({ dwrId: 'missing' }),
        ),
      ).resolves.toBe(true);
    });

    it('reads `:id` as the declared record, never as a project', async () => {
      // `/projects/ra-bills/:id` names a bill. Looking it up as a project would 404 it.
      const { guard, findFirst } = lockedVia('rABill');
      await expect(
        guard.canActivate(contextWith({ id: 'bill-1' }, { subject: 'raBill' })),
      ).rejects.toMatchObject({ status: HTTP_STATUS_LOCKED });
      expect(findFirst).toHaveBeenCalled();
    });

    it('reads the project from the body on a create route', async () => {
      const { guard } = lockedVia('project');
      await expect(
        guard.canActivate(
          contextWith({}, { subject: 'body', body: { projectId: 'project-1' } }),
        ),
      ).rejects.toMatchObject({ status: HTTP_STATUS_LOCKED });
    });

    it('leaves a body with no projectId to the ValidationPipe', async () => {
      const { guard } = lockedVia('project');
      await expect(
        guard.canActivate(contextWith({}, { subject: 'body', body: {} })),
      ).resolves.toBe(true);
    });

    it('admits a body naming an unknown project, for the service to refuse', async () => {
      const prisma = createPrismaMock({
        project: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      await expect(
        new ProjectLockGuard(prisma as never).canActivate(
          contextWith({}, { subject: 'body', body: { projectId: 'nope' } }),
        ),
      ).resolves.toBe(true);
    });
  });
});
