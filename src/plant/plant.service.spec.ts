import { Prisma } from '@prisma/client';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { PlantService } from './plant.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const range = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-30T00:00:00.000Z'),
};

const build = (options: {
  siteIds?: string[];
  equipment?: Record<string, unknown>[];
  hireBills?: { netPayable: Prisma.Decimal }[];
  movements?: { type: string; amount: Prisma.Decimal }[];
  serviceBills?: { netPayable: Prisma.Decimal }[];
  fuelTotal?: number;
  projectsThrows?: boolean;
}) => {
  const prisma = createPrismaMock({
    equipment: {
      findMany: jest.fn().mockResolvedValue(options.equipment ?? []),
    },
    hireBill: {
      findMany: jest.fn().mockResolvedValue(options.hireBills ?? []),
    },
    maintenanceJob: {
      findMany: jest.fn().mockResolvedValue([{ id: 'job-1' }]),
    },
    sparePartMovement: {
      findMany: jest.fn().mockResolvedValue(options.movements ?? []),
    },
    serviceBill: {
      findMany: jest.fn().mockResolvedValue(options.serviceBills ?? []),
    },
    fuelEntry: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: decimal(options.fuelTotal ?? 0) },
      }),
    },
  });
  const projects = {
    getSitesByProject: options.projectsThrows
      ? jest.fn().mockRejectedValue(new Error('projects is down'))
      : jest.fn().mockResolvedValue(options.siteIds ?? ['site-1']),
  };
  const service = new PlantService(
    prisma as never,
    projects as never,
    { registerMachinerySource: jest.fn() } as never,
  );
  return { service, projects };
};

describe('PlantService.getMachineryCostByProject (FR-008, FR-025)', () => {
  it('sums verified hire bills for hired machines', async () => {
    const { service } = build({
      equipment: [{ id: 'eq-1', ownership: 'hired' }],
      hireBills: [
        { netPayable: decimal(196000) },
        { netPayable: decimal(50000) },
      ],
    });

    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(246000);
  });

  it('apportions depreciation by month for owned machines', async () => {
    const { service } = build({
      equipment: [
        {
          id: 'eq-1',
          ownership: 'owned',
          purchaseCost: decimal(1200000),
          depreciationRate: decimal(12),
        },
      ],
    });

    // 1,200,000 × 12% = 144,000/yr = 12,000/month, over a single-month range.
    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(12000);
  });

  it('includes spare parts and verified service bills — the FR-025 correction', async () => {
    const { service } = build({
      equipment: [{ id: 'eq-1', ownership: 'hired' }],
      hireBills: [{ netPayable: decimal(100000) }],
      movements: [{ type: 'consumption', amount: decimal(4500) }],
      serviceBills: [{ netPayable: decimal(18000) }],
    });

    // Without the amendment this would report 100,000 and silently omit every
    // repair — a machine that cost a fortune to keep running would look identical
    // to one that never broke.
    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(122500);
  });

  it('nets a reversed consumption back out', async () => {
    const { service } = build({
      equipment: [{ id: 'eq-1', ownership: 'owned' }],
      movements: [
        { type: 'consumption', amount: decimal(4500) },
        { type: 'reversal', amount: decimal(4500) },
      ],
    });

    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });

  it('ignores receipts — buying a part is stock, not a project cost', async () => {
    const { service } = build({
      equipment: [{ id: 'eq-1', ownership: 'owned' }],
      movements: [{ type: 'receipt', amount: decimal(90000) }],
    });

    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });

  it('mixes hired and owned in one figure', async () => {
    const { service } = build({
      equipment: [
        { id: 'eq-1', ownership: 'hired' },
        {
          id: 'eq-2',
          ownership: 'owned',
          purchaseCost: decimal(600000),
          depreciationRate: decimal(10),
        },
      ],
      hireBills: [{ netPayable: decimal(80000) }],
    });

    // 80,000 hire + 5,000 depreciation for the month.
    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(85000);
  });

  it('returns 0 for a project with no sites, without querying equipment', async () => {
    const { service } = build({ siteIds: [] });

    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });

  it('returns 0 rather than throwing when Projects cannot answer', async () => {
    const { service } = build({ projectsThrows: true });

    // A P&L that renders every other cost line and shows zero machinery is more
    // useful than one that fails outright — the caller names the unavailable source.
    await expect(
      service.getMachineryCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });
});

describe('PlantService.getFuelCostByProject (FR-008)', () => {
  it('sums fuel for machines deployed at the project sites', async () => {
    const { service } = build({
      equipment: [{ id: 'eq-1' }],
      fuelTotal: 87450.5,
    });

    await expect(
      service.getFuelCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(87450.5);
  });

  it('scopes the site lookup to the company, never to the cross-company bypass', async () => {
    const { service, projects } = build({ equipment: [{ id: 'eq-1' }] });

    await service.getFuelCostByProject('project-1', 'co-1', range);

    expect(projects.getSitesByProject).toHaveBeenCalledWith('project-1', {
      isSuperAdmin: false,
      companyId: 'co-1',
    });
  });

  it('returns 0 rather than throwing when Projects cannot answer', async () => {
    const { service } = build({ projectsThrows: true });

    await expect(
      service.getFuelCostByProject('project-1', 'co-1', range),
    ).resolves.toBe(0);
  });
});

describe('PlantService.getMachineryByProject (008 project detail)', () => {
  it('lists the machines deployed at the project sites', async () => {
    const { service } = build({
      equipment: [
        {
          id: 'eq-1',
          code: 'BC-EQP-0001',
          name: 'JCB 3DX',
          status: 'active',
          deployedSiteId: 'site-1',
          utilizationPercent: decimal(72.5),
        },
      ],
    });

    await expect(
      service.getMachineryByProject('project-1', 'co-1'),
    ).resolves.toEqual([
      {
        id: 'eq-1',
        code: 'BC-EQP-0001',
        name: 'JCB 3DX',
        status: 'active',
        deployedSiteId: 'site-1',
        utilizationPercent: 72.5,
      },
    ]);
  });

  it('returns an empty list rather than throwing when Projects cannot answer', async () => {
    const { service } = build({ projectsThrows: true });

    await expect(
      service.getMachineryByProject('project-1', 'co-1'),
    ).resolves.toEqual([]);
  });
});
