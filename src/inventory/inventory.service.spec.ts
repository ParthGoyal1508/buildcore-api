import { InventoryService } from './inventory.service';

const range = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-30T00:00:00.000Z'),
};

describe('InventoryService.getMaterialCostByProject (FR-009)', () => {
  it('sums purchases across every site the project has', async () => {
    const purchases = {
      materialCostForSites: jest.fn().mockResolvedValue(125000),
    };
    const projects = {
      getSitesByProject: jest.fn().mockResolvedValue(['site-1', 'site-2']),
    };
    const service = new InventoryService(projects as never, purchases as never);

    await expect(
      service.getMaterialCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(125000);
    expect(purchases.materialCostForSites).toHaveBeenCalledWith(
      ['site-1', 'site-2'],
      'co-1',
      range,
    );
  });

  it('returns 0 for a project with no sites, without querying purchases', async () => {
    const purchases = { materialCostForSites: jest.fn() };
    const projects = { getSitesByProject: jest.fn().mockResolvedValue([]) };
    const service = new InventoryService(projects as never, purchases as never);

    await expect(
      service.getMaterialCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
    expect(purchases.materialCostForSites).not.toHaveBeenCalled();
  });

  it('degrades to 0 rather than failing the whole P&L when site lookup throws', async () => {
    const purchases = { materialCostForSites: jest.fn() };
    const projects = {
      getSitesByProject: jest
        .fn()
        .mockRejectedValue(new Error('projects down')),
    };
    const service = new InventoryService(projects as never, purchases as never);

    await expect(
      service.getMaterialCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });

  it('scopes the site lookup to the calling company, not to a superuser context', async () => {
    // The P&L runs for one company. Resolving sites under the cross-company bypass
    // would let a project id from another tenant return its sites.
    const purchases = { materialCostForSites: jest.fn().mockResolvedValue(0) };
    const projects = {
      getSitesByProject: jest.fn().mockResolvedValue(['site-1']),
    };
    const service = new InventoryService(projects as never, purchases as never);

    await service.getMaterialCostByProject('project-1', 'co-1', range);
    expect(projects.getSitesByProject).toHaveBeenCalledWith('project-1', {
      isSuperAdmin: false,
      companyId: 'co-1',
    });
  });

  it('reports itself available, so a P&L can tell zero cost from a missing module', () => {
    const service = new InventoryService({} as never, {} as never);
    expect(service.isAvailable()).toBe(true);
  });
});
