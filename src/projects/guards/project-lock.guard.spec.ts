import { ExecutionContext, NotFoundException } from '@nestjs/common';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { HTTP_STATUS_LOCKED } from '../constants/projects.constants';
import { ProjectLockGuard } from './project-lock.guard';

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
});
