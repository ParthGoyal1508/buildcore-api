import { BadRequestException, NotFoundException } from '@nestjs/common';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { assignInputFrom } from './dto/location-assignment.dto';
import { LocationAssignmentsService } from './location-assignments.service';

/** 058: an assignment covers a set of sites and projects, or is mobile. */
const ctx = { isSuperAdmin: false, companyId: 'co-1' };
const actor = { userId: 'hr-1', ipAddress: '127.0.0.1' };

const build = (
  checked: Partial<{
    siteNames: Map<string, string>;
    projectNames: Map<string, string>;
    projectsWithoutActiveSite: string[];
  }> = {},
  assertTargets?: jest.Mock,
) => {
  const create = jest.fn(async ({ data }: { data: any }) => ({
    id: 'a-1',
    employeeId: data.employeeId,
    isMobile: data.isMobile,
    effectiveFrom: data.effectiveFrom,
    assignedByUserId: data.assignedByUserId,
    reason: data.reason,
    createdAt: new Date(),
    targets: data.targets.create.map((t: any) => ({
      siteId: t.siteId ?? null,
      projectId: t.projectId ?? null,
    })),
  }));
  const prisma = createPrismaMock({
    employee: {
      findFirst: jest.fn().mockResolvedValue({ companyId: 'co-1' }),
    },
    employeeLocationAssignment: { create },
  });
  const sites = {
    assertTargetsInCompany:
      assertTargets ??
      jest.fn().mockResolvedValue({
        siteNames: new Map(),
        projectNames: new Map(),
        projectsWithoutActiveSite: [],
        ...checked,
      }),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new LocationAssignmentsService(
    prisma as never,
    sites as never,
    auditLog as never,
  );
  return { service, create, sites, auditLog };
};

describe('LocationAssignmentsService.assign (058)', () => {
  it('refuses an assignment that names nothing and is not mobile', async () => {
    const { service, create } = build();
    await expect(
      service.assign(ctx, 'emp-1', { effectiveFrom: '2026-11-10' }, actor),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ASSIGNMENT_EMPTY' }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses mobile together with sites', async () => {
    const { service } = build();
    await expect(
      service.assign(
        ctx,
        'emp-1',
        { isMobile: true, siteIds: ['s1'], effectiveFrom: '2026-11-10' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a site or project outside the employee’s company', async () => {
    const { service, create } = build(
      {},
      jest.fn().mockRejectedValue(new NotFoundException('Site s9 not found')),
    );
    await expect(
      service.assign(
        ctx,
        'emp-1',
        { siteIds: ['s9'], effectiveFrom: '2026-11-10' },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(create).not.toHaveBeenCalled();
  });

  it('saves sites and projects as targets, names them, and audits the change', async () => {
    const { service, create, auditLog } = build({
      siteNames: new Map([['s1', 'Uncha']]),
      projectNames: new Map([['p1', 'Bundi Ring Road']]),
    });
    const saved = await service.assign(
      ctx,
      'emp-1',
      {
        siteIds: ['s1', 's1'],
        projectIds: ['p1'],
        effectiveFrom: '2026-11-10',
      },
      actor,
    );
    // Duplicates collapse, and the company comes from the employee on every target.
    expect(create.mock.calls[0][0].data.targets.create).toEqual([
      { companyId: 'co-1', siteId: 's1' },
      { companyId: 'co-1', projectId: 'p1' },
    ]);
    expect(saved.targets).toEqual([
      { siteId: 's1', projectId: null, name: 'Uncha' },
      { siteId: null, projectId: 'p1', name: 'Bundi Ring Road' },
    ]);
    expect(saved.warnings).toEqual([]);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'EMPLOYEE',
        action: 'UPDATE',
        entityId: 'emp-1',
        accountId: 'hr-1',
        changes: {
          locationAssignment: expect.objectContaining({
            siteIds: ['s1'],
            projectIds: ['p1'],
          }),
        },
      }),
    );
  });

  it('saves a project with no active site, with a warning', async () => {
    const { service } = build({ projectsWithoutActiveSite: ['p2'] });
    const saved = await service.assign(
      ctx,
      'emp-1',
      { projectIds: ['p2'], effectiveFrom: '2026-11-10' },
      actor,
    );
    expect(saved.warnings).toEqual(['PROJECT_HAS_NO_ACTIVE_SITE']);
  });

  it('saves a mobile assignment with no targets', async () => {
    const { service, create } = build();
    const saved = await service.assign(
      ctx,
      'emp-1',
      { isMobile: true, effectiveFrom: '2026-11-10' },
      actor,
    );
    expect(create.mock.calls[0][0].data.targets.create).toEqual([]);
    expect(saved.isMobile).toBe(true);
  });
});

describe('assignInputFrom (058)', () => {
  it('reads the deprecated single siteId as one site target', () => {
    expect(
      assignInputFrom({ siteId: 's1', effectiveFrom: '2026-11-10' }),
    ).toMatchObject({ siteIds: ['s1'], projectIds: [] });
  });
});
