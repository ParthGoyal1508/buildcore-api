import { BadRequestException, ConflictException } from '@nestjs/common';

import { callerFor, createPrismaMock } from '../testing/prisma-mock';
import { AssetCategoriesService } from './asset-categories.service';
import { ConditionGradesService } from './condition-grades.service';

const caller = callerFor('co-1');
const auditLog = { record: jest.fn() };

const categoryRow = (over: Record<string, unknown> = {}) => ({
  id: 'cat-1',
  companyId: 'co-1',
  name: 'POWER TOOLS',
  trackingMode: 'serialised',
  depreciationRatePercent: 25,
  usefulLifeYears: 4,
  custodyRequired: true,
  inspectionRequired: false,
  inspectionIntervalDays: null,
  repairCostThresholdPercent: 50,
  active: true,
  createdAt: new Date(),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

/**
 * US1 scenario 2: an inspection requirement with no interval is a schedule nothing
 * can compute, so it is refused rather than stored half-configured.
 */
describe('AssetCategoriesService — the inspection pairing (US1 scenario 2)', () => {
  it('refuses inspectionRequired without an interval on create', async () => {
    const prisma = createPrismaMock({ assetCategory: { create: jest.fn() } });
    const service = new AssetCategoriesService(
      prisma as never,
      auditLog as never,
    );

    await expect(
      service.create(
        caller,
        {
          name: 'Ladders',
          trackingMode: 'bulk' as never,
          inspectionRequired: true,
        },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.assetCategory.create).not.toHaveBeenCalled();
  });

  it('accepts the pair when both halves are present', async () => {
    const created = categoryRow({
      name: 'LADDERS',
      trackingMode: 'bulk',
      inspectionRequired: true,
      inspectionIntervalDays: 90,
    });
    const prisma = createPrismaMock({
      assetCategory: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
    });
    const service = new AssetCategoriesService(
      prisma as never,
      auditLog as never,
    );

    const view = await service.create(
      caller,
      {
        name: 'Ladders',
        trackingMode: 'bulk' as never,
        inspectionRequired: true,
        inspectionIntervalDays: 90,
      },
      '127.0.0.1',
    );
    expect(view.inspectionIntervalDays).toBe(90);
    expect(view.name).toBe('LADDERS');
  });

  it('catches clearing the interval on an inspection-required category', async () => {
    const existing = categoryRow({
      inspectionRequired: true,
      inspectionIntervalDays: 180,
    });
    const prisma = createPrismaMock({
      assetCategory: {
        findUnique: jest.fn().mockResolvedValue(existing),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    const service = new AssetCategoriesService(
      prisma as never,
      auditLog as never,
    );

    await expect(
      service.update(
        caller,
        'cat-1',
        { inspectionIntervalDays: null as never },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.assetCategory.update).not.toHaveBeenCalled();
  });

  it('rejects a duplicate name in the same company', async () => {
    const prisma = createPrismaMock({
      assetCategory: {
        findFirst: jest.fn().mockResolvedValue(categoryRow()),
        create: jest.fn(),
      },
    });
    const service = new AssetCategoriesService(
      prisma as never,
      auditLog as never,
    );

    await expect(
      service.create(
        caller,
        { name: '  power tools  ', trackingMode: 'serialised' as never },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * FR-015 turns a grade into a status. A grade that claims both outcomes would give
 * that mapping two answers, so the master refuses to store one.
 */
describe('ConditionGradesService — outcome exclusivity (FR-015)', () => {
  it('refuses a grade that is both damaged and scrap', async () => {
    const prisma = createPrismaMock({ conditionGrade: { create: jest.fn() } });
    const service = new ConditionGradesService(
      prisma as never,
      auditLog as never,
    );

    await expect(
      service.create(
        caller,
        { name: 'Write-off', sequence: 7, isDamaged: true, isScrap: true },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.conditionGrade.create).not.toHaveBeenCalled();
  });

  it('catches the same collision assembled across two updates', async () => {
    const existing = {
      id: 'grade-1',
      companyId: 'co-1',
      name: 'DAMAGED',
      sequence: 5,
      isDamaged: true,
      isScrap: false,
      active: true,
      createdAt: new Date(),
    };
    const prisma = createPrismaMock({
      conditionGrade: {
        findUnique: jest.fn().mockResolvedValue(existing),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    const service = new ConditionGradesService(
      prisma as never,
      auditLog as never,
    );

    await expect(
      service.update(caller, 'grade-1', { isScrap: true }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.conditionGrade.update).not.toHaveBeenCalled();
  });
});
