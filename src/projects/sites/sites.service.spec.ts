import { NotFoundException } from '@nestjs/common';
import { Prisma, SiteStatus } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { SitesService } from './sites.service';

/** 058: the reads hr makes through this service for staff assignments and punch sites. */
const ctx = { isSuperAdmin: false, companyId: 'co-1' };
const dec = (n: number) => new Prisma.Decimal(n);

const build = (delegates: Record<string, unknown>) => {
  const prisma = createPrismaMock(delegates);
  const service = new SitesService(prisma as never, {} as never, {} as never);
  return { prisma, service };
};

describe('SitesService.geofencesFor (058)', () => {
  it('asks for active sites named directly or through a project, in one query', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 's1',
        name: 'Bundi – 2000',
        latitude: dec(25.4),
        longitude: dec(75.7),
        geofenceRadiusMeters: 200,
      },
    ]);
    const { service } = build({ site: { findMany } });

    const fences = await service.geofencesFor(ctx, {
      siteIds: ['s1'],
      projectIds: ['p1'],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: SiteStatus.active,
          OR: [{ id: { in: ['s1'] } }, { projectId: { in: ['p1'] } }],
        },
      }),
    );
    expect(fences).toEqual([
      {
        siteId: 's1',
        name: 'Bundi – 2000',
        latitude: 25.4,
        longitude: 75.7,
        geofenceRadiusMeters: 200,
        isActive: true,
      },
    ]);
  });

  it('asks nothing when the assignment names nothing', async () => {
    const findMany = jest.fn();
    const { service } = build({ site: { findMany } });
    expect(
      await service.geofencesFor(ctx, { siteIds: [], projectIds: [] }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('SitesService.namesFor (058)', () => {
  it('maps the ids it finds to names, asking once for each distinct id', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 's1', name: 'Uncha' }]);
    const { service } = build({ site: { findMany } });
    const names = await service.namesFor(ctx, ['s1', 's1', 'gone']);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 'gone'] } },
      select: { id: true, name: true },
    });
    expect([...names]).toEqual([['s1', 'Uncha']]);
  });
});

describe('SitesService.assertTargetsInCompany (058 FR-013)', () => {
  const build2 = (
    sites: { id: string; name: string }[],
    projects: { id: string; name: string; sites: { id: string }[] }[],
  ) =>
    build({
      site: { findMany: jest.fn().mockResolvedValue(sites) },
      project: { findMany: jest.fn().mockResolvedValue(projects) },
    });

  it('names every target and reports a project with no active site', async () => {
    const { service } = build2(
      [{ id: 's1', name: 'Uncha' }],
      [
        { id: 'p1', name: 'Bundi Ring Road', sites: [{ id: 's9' }] },
        { id: 'p2', name: 'New Tender', sites: [] },
      ],
    );
    const result = await service.assertTargetsInCompany(ctx, 'co-1', {
      siteIds: ['s1'],
      projectIds: ['p1', 'p2'],
    });
    expect(result.siteNames.get('s1')).toBe('Uncha');
    expect(result.projectNames.get('p2')).toBe('New Tender');
    expect(result.projectsWithoutActiveSite).toEqual(['p2']);
  });

  it('refuses a site of another company as not found', async () => {
    const { service } = build2([], []);
    await expect(
      service.assertTargetsInCompany(ctx, 'co-1', {
        siteIds: ['other-co-site'],
        projectIds: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a project of another company as not found', async () => {
    const { service } = build2([], []);
    await expect(
      service.assertTargetsInCompany(ctx, 'co-1', {
        siteIds: [],
        projectIds: ['other-co-project'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
