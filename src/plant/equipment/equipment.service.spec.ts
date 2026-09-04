import { BadRequestException, ConflictException } from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { EquipmentService } from './equipment.service';

const caller = callerFor('co-1');
const decimal = (n: number) => new Prisma.Decimal(n);

/** `n` days from today, as a date-only value the way a `@db.Date` column reads. */
const daysAway = (n: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + n);
  return date;
};

const equipmentRow = (
  documents: { docTypeId: string; expiresAt: Date | null }[],
) => ({
  id: 'eq-1',
  companyId: 'co-1',
  code: 'BC-EQP-0001',
  name: 'JCB 3DX',
  categoryId: 'cat-1',
  ownership: 'owned',
  vendorId: null,
  powerSource: 'diesel',
  meterType: 'hours',
  currentReading: decimal(1200),
  deployedSiteId: null,
  status: EquipmentStatus.active,
  utilizationPercent: decimal(80),
  purchaseDate: null,
  purchaseCost: null,
  depreciationRate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  documents: documents.map((doc, index) => ({
    id: `doc-${index}`,
    ...doc,
  })),
});

/**
 * Doc types with deliberately different alert windows. The whole correction
 * research.md §10 made was that this window is per type — a suite where every type
 * used 30 days would pass just as happily against the hardcoded literal it replaced.
 */
const docTypes = new Map([
  [
    'type-insurance',
    { id: 'type-insurance', name: 'Insurance', alertDays: 45 },
  ],
  [
    'type-pollution',
    { id: 'type-pollution', name: 'Pollution', alertDays: 15 },
  ],
]);

const build = (documents: { docTypeId: string; expiresAt: Date | null }[]) => {
  const row = equipmentRow(documents);
  const prisma = createPrismaMock({
    equipment: {
      findMany: jest.fn().mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
    },
  });
  const service = new EquipmentService(
    prisma as never,
    { record: jest.fn() } as never,
    {
      categoriesByIds: async () =>
        new Map([['cat-1', { id: 'cat-1', name: 'Excavator' }]]),
      siteNames: async () => new Map(),
      vendorNames: async () => new Map(),
      docTypesByIds: async () => docTypes,
    } as never,
    { next: jest.fn() } as never,
    {} as never,
  );
  return { service, prisma };
};

describe('EquipmentService document expiry alerting (FR-010, SC-001)', () => {
  it("flags a document inside its own type's alert window", async () => {
    const { service } = build([
      { docTypeId: 'type-insurance', expiresAt: daysAway(30) },
    ]);

    const page = await service.findAll(caller, {});

    expect(page.items[0].expiryAlert).toBe(true);
    expect(page.items[0].alertDocumentTypes).toEqual(['Insurance']);
  });

  it('does not flag a document outside its own window', async () => {
    const { service } = build([
      { docTypeId: 'type-insurance', expiresAt: daysAway(60) },
    ]);

    expect((await service.findAll(caller, {})).items[0].expiryAlert).toBe(
      false,
    );
  });

  it("uses each type's window rather than one shared number", async () => {
    // 30 days out: inside Insurance's 45-day window, outside Pollution's 15-day one.
    // If the window were a single literal these two would agree — which is exactly
    // the behaviour research.md §10 corrected.
    const insurance = build([
      { docTypeId: 'type-insurance', expiresAt: daysAway(30) },
    ]);
    const pollution = build([
      { docTypeId: 'type-pollution', expiresAt: daysAway(30) },
    ]);

    expect(
      (await insurance.service.findAll(caller, {})).items[0].expiryAlert,
    ).toBe(true);
    expect(
      (await pollution.service.findAll(caller, {})).items[0].expiryAlert,
    ).toBe(false);
  });

  it('flags a document that has already lapsed', async () => {
    // Past expiry needs more attention than approaching expiry, not less.
    const { service } = build([
      { docTypeId: 'type-pollution', expiresAt: daysAway(-10) },
    ]);

    expect((await service.findAll(caller, {})).items[0].expiryAlert).toBe(true);
  });

  it('never flags a document with no expiry date', async () => {
    const { service } = build([
      { docTypeId: 'type-insurance', expiresAt: null },
    ]);

    expect((await service.findAll(caller, {})).items[0].expiryAlert).toBe(
      false,
    );
  });

  it('lists each alerting type once, however many documents of it are expiring', async () => {
    const { service } = build([
      { docTypeId: 'type-insurance', expiresAt: daysAway(10) },
      { docTypeId: 'type-insurance', expiresAt: daysAway(20) },
      { docTypeId: 'type-pollution', expiresAt: daysAway(5) },
    ]);

    expect(
      (await service.findAll(caller, {})).items[0].alertDocumentTypes,
    ).toEqual(['Insurance', 'Pollution']);
  });
});

describe('EquipmentService.update status guard (FR-002)', () => {
  it('refuses to set under_maintenance directly', async () => {
    const { service } = build([]);

    await expect(
      service.update(
        caller,
        'eq-1',
        { status: EquipmentStatus.under_maintenance },
        '10.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to change the status of a machine already under maintenance', async () => {
    const { service, prisma } = build([]);
    (
      prisma.tx.equipment as { findUnique: jest.Mock }
    ).findUnique.mockResolvedValue({
      ...equipmentRow([]),
      status: EquipmentStatus.under_maintenance,
    });

    // Leaving `under_maintenance` by editing the row is refused for the same reason
    // entering it is: the job owns the transition, and a register that disagrees
    // with the job list is the failure FR-002 exists to prevent.
    await expect(
      service.update(
        caller,
        'eq-1',
        { status: EquipmentStatus.active },
        '10.0.0.1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('allows an ordinary field edit', async () => {
    const { service } = build([]);

    await expect(
      service.update(caller, 'eq-1', { name: 'JCB 3DX Super' }, '10.0.0.1'),
    ).resolves.toMatchObject({ id: 'eq-1' });
  });
});

describe('EquipmentService.recomputeUtilisation (FR-007)', () => {
  const runWith = async (hours: number, targetHours: number) => {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      logbookEntry: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalHours: decimal(hours) } }),
      },
      equipment: {
        update: jest.fn(async ({ data }: never) => {
          updates.push(data as Record<string, unknown>);
          return {};
        }),
      },
    };
    const { service } = build([]);
    const percent = await service.recomputeUtilisation(
      tx as never,
      caller,
      'eq-1',
      targetHours,
    );
    return { percent, updates };
  };

  it("divides the month's hours by the category target", async () => {
    const { percent, updates } = await runWith(88, 176);
    expect(percent).toBe(50);
    expect(updates[0]).toEqual({ utilizationPercent: 50 });
  });

  it('is 0 for a month with no entries', async () => {
    expect((await runWith(0, 176)).percent).toBe(0);
  });

  it('can exceed 100 — a machine worked overtime, and clamping would hide it', async () => {
    expect((await runWith(220, 176)).percent).toBe(125);
  });

  it('falls back to the standard month when a category sets no target', async () => {
    // 176 is the column default; a category row written before that default existed
    // would otherwise divide by zero and store Infinity.
    expect((await runWith(88, 0)).percent).toBe(50);
  });

  it('rounds to two decimals rather than storing float noise', async () => {
    const { percent } = await runWith(100, 176);
    expect(percent).toBe(56.82);
  });
});
