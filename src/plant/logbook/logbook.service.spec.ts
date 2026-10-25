import { HireBillStatus, MeterType, Prisma } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LogbookService } from './logbook.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'lb-1',
  companyId: 'co-1',
  equipmentId: 'eq-1',
  date: new Date('2026-10-05T00:00:00.000Z'),
  openingReading: decimal(100),
  closingReading: decimal(108),
  totalHours: decimal(8),
  fuelConsumed: decimal(40),
  operatorId: null,
  projectId: 'p-1',
  remarks: 'Excavation',
  readingGapReason: null,
  createdAt: new Date('2026-10-05T10:00:00.000Z'),
  equipment: { code: 'EX-01', name: 'Excavator' },
  ...over,
});

const build = (opts: { bill?: unknown; previous?: unknown } = {}) => {
  const prisma = createPrismaMock({
    equipment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'eq-1',
        companyId: 'co-1',
        categoryId: 'cat-1',
        status: 'active',
        meterType: MeterType.hours,
      }),
      update: jest.fn(),
    },
    equipmentCategory: { findUnique: jest.fn().mockResolvedValue(null) },
    logbookEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(opts.previous ?? null),
      create: jest.fn(async ({ data }: never) =>
        entry(data as Record<string, unknown>),
      ),
      update: jest.fn(async () => entry()),
      delete: jest.fn(),
    },
    hireBill: { findFirst: jest.fn().mockResolvedValue(opts.bill ?? null) },
  });
  const refs = {
    parseDate: (value: string) =>
      new Date(`${value.slice(0, 10)}T00:00:00.000Z`),
    requireEmployee: jest.fn(),
    requireProject: jest.fn(),
    employeeNames: jest.fn().mockResolvedValue(new Map()),
  };
  const audit = { record: jest.fn() };
  const service = new LogbookService(
    prisma as never,
    audit as never,
    refs as never,
    { recomputeUtilisation: jest.fn() } as never,
  );
  return { service, prisma, refs, audit };
};

const create = {
  equipmentId: 'eq-1',
  date: '2026-10-06',
  openingReading: 108,
  closingReading: 116,
};

describe('LogbookService (036 K2, K4, K5)', () => {
  it("checks the project against the machine's company (K2)", async () => {
    const { service, refs, prisma } = build();
    refs.requireProject.mockRejectedValue(
      new Error('Project p-9 does not exist in this company'),
    );
    await expect(
      service.create(caller, { ...create, projectId: 'p-9' }, 'ip'),
    ).rejects.toThrow(/does not exist in this company/);
    expect(refs.requireProject).toHaveBeenCalledWith(caller, 'p-9', 'co-1');
    expect(prisma.tx.logbookEntry.create).not.toHaveBeenCalled();
  });

  it('refuses an opening reading that skips the previous closing one (K4)', async () => {
    const { service, prisma } = build({
      previous: { closingReading: decimal(100) },
    });
    await expect(service.create(caller, create, 'ip')).rejects.toThrow(
      /does not follow on/,
    );
    expect(prisma.tx.logbookEntry.create).not.toHaveBeenCalled();
  });

  it('stores the reason when a gap is explained (K4)', async () => {
    const { service, prisma } = build({
      previous: { closingReading: decimal(100) },
    });
    await service.create(
      caller,
      { ...create, readingGapReason: 'Moved on a trailer' },
      'ip',
    );
    expect(prisma.tx.logbookEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          readingGapReason: 'Moved on a trailer',
        }),
      }),
    );
  });

  it('refuses a future date (K4)', async () => {
    const { service } = build();
    await expect(
      service.create(caller, { ...create, date: '2062-10-06' }, 'ip'),
    ).rejects.toThrow(/in the future/);
  });

  it('syncs the meter from entries up to today only (K4)', async () => {
    const { service, prisma } = build({
      previous: { closingReading: decimal(108) },
    });
    await service.create(caller, create, 'ip');
    const syncQuery = prisma.tx.logbookEntry.findFirst.mock.calls.find(
      ([args]: [{ where: { date?: { lte?: Date } } }]) => args.where.date?.lte,
    );
    expect(syncQuery).toBeDefined();
  });

  const billed = {
    status: HireBillStatus.verified,
    invoiceNo: 'INV-7',
    billingPeriodFrom: new Date('2026-10-01T00:00:00.000Z'),
    billingPeriodTo: new Date('2026-10-31T00:00:00.000Z'),
  };

  it('refuses to delete an entry inside a verified hire bill (K5)', async () => {
    const { service, prisma } = build({ bill: billed });
    prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
    await expect(service.remove(caller, 'lb-1', 'ip')).rejects.toThrow(
      /verified hire bill \(INV-7\).*cannot be deleted/,
    );
    expect(prisma.tx.logbookEntry.delete).not.toHaveBeenCalled();
    expect(prisma.tx.hireBill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [HireBillStatus.verified, HireBillStatus.paid] },
        }),
      }),
    );
  });

  it('keeps the whole deleted row in the audit log (K5)', async () => {
    const { service, prisma, audit } = build();
    prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
    await service.remove(caller, 'lb-1', 'ip');
    expect(audit.record.mock.calls[0][0].changes.before).toMatchObject({
      date: '2026-10-05',
      openingReading: 100,
      closingReading: 108,
      totalHours: 8,
      fuelConsumed: 40,
      projectId: 'p-1',
      remarks: 'Excavation',
    });
  });

  it('refuses to add an entry inside a verified hire bill (review decision 9)', async () => {
    const { service, prisma } = build({ bill: billed });
    await expect(service.create(caller, create, 'ip')).rejects.toThrow(
      /2026-10-06 is inside a verified hire bill \(INV-7\).*cannot be added/,
    );
    expect(prisma.tx.logbookEntry.create).not.toHaveBeenCalled();
  });

  it('checks every sheet day against billed periods before writing (review decision 9)', async () => {
    const { service, prisma } = build({ bill: billed });
    await expect(
      service.assertDaysNotBilled(caller, 'eq-1', ['2026-10-06']),
    ).rejects.toThrow(/cannot be added/);
    expect(prisma.tx.logbookEntry.create).not.toHaveBeenCalled();
  });

  describe('correctReadings (K6)', () => {
    const correction = {
      openingReading: 100,
      closingReading: 106,
      reason: 'Closing reading misread from the meter',
    };

    it('changes the readings, re-derives the meter and audits before and after with the reason', async () => {
      const { service, prisma, audit } = build();
      prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
      prisma.tx.logbookEntry.update.mockResolvedValue(
        entry({
          closingReading: decimal(106),
          totalHours: decimal(6),
        }),
      );
      await service.correctReadings(caller, 'lb-1', correction, 'ip');
      expect(prisma.tx.logbookEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            openingReading: 100,
            closingReading: 106,
            totalHours: 6,
          }),
        }),
      );
      // The meter is re-derived from the logbook in the same transaction.
      expect(
        prisma.tx.logbookEntry.findFirst.mock.calls.some(
          ([args]: [{ where: { date?: { lte?: Date } } }]) =>
            args.where.date?.lte,
        ),
      ).toBe(true);
      const changes = audit.record.mock.calls[0][0].changes;
      expect(changes).toMatchObject({
        kind: 'readings_corrected',
        reason: correction.reason,
        before: { closingReading: 108, totalHours: 8 },
        after: { closingReading: 106, totalHours: 6 },
      });
    });

    it('requires a reason', async () => {
      const { service, prisma } = build();
      prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
      await expect(
        service.correctReadings(
          caller,
          'lb-1',
          { ...correction, reason: '   ' },
          'ip',
        ),
      ).rejects.toThrow(/reason/);
      expect(prisma.tx.logbookEntry.update).not.toHaveBeenCalled();
    });

    it('refuses more than 24 hours on an hour meter', async () => {
      const { service, prisma } = build();
      prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
      await expect(
        service.correctReadings(
          caller,
          'lb-1',
          { ...correction, closingReading: 130 },
          'ip',
        ),
      ).rejects.toThrow(/more than 24/);
    });

    // 042: a corrected closing figure can orphan the FOLLOWING day's opening reading,
    // which was accepted against the old one. The next entry is re-checked.
    const nextDayHarness = (next: Record<string, unknown> | null) => {
      const harness = build();
      harness.prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
      harness.prisma.tx.logbookEntry.findFirst.mockImplementation(
        async ({ where }: { where: { date?: { gt?: Date; lt?: Date } } }) => {
          if (where.date?.gt) return next;
          if (where.date?.lt) return null;
          return null; // The meter-sync query (lte).
        },
      );
      return harness;
    };

    it("refuses a correction the next day's opening no longer follows (042)", async () => {
      const { service, prisma } = nextDayHarness({
        date: new Date('2026-10-06T00:00:00.000Z'),
        openingReading: decimal(108),
        readingGapReason: null,
      });
      await expect(
        service.correctReadings(caller, 'lb-1', correction, 'ip'),
      ).rejects.toThrow(/2026-10-06.*would no longer follow/);
      expect(prisma.tx.logbookEntry.update).not.toHaveBeenCalled();
    });

    it('allows it when the next day carries a gap reason (042)', async () => {
      const { service, prisma } = nextDayHarness({
        date: new Date('2026-10-06T00:00:00.000Z'),
        openingReading: decimal(108),
        readingGapReason: 'Meter replaced',
      });
      prisma.tx.logbookEntry.update.mockResolvedValue(
        entry({ closingReading: decimal(106), totalHours: decimal(6) }),
      );
      await expect(
        service.correctReadings(caller, 'lb-1', correction, 'ip'),
      ).resolves.toBeDefined();
    });

    it("allows it when the next day's opening follows the corrected closing (042)", async () => {
      const { service, prisma } = nextDayHarness({
        date: new Date('2026-10-06T00:00:00.000Z'),
        openingReading: decimal(106),
        readingGapReason: null,
      });
      prisma.tx.logbookEntry.update.mockResolvedValue(
        entry({ closingReading: decimal(106), totalHours: decimal(6) }),
      );
      await expect(
        service.correctReadings(caller, 'lb-1', correction, 'ip'),
      ).resolves.toBeDefined();
    });

    it('refuses a correction inside a paid hire bill', async () => {
      const { service, prisma } = build({
        bill: { ...billed, status: HireBillStatus.paid },
      });
      prisma.tx.logbookEntry.findUnique.mockResolvedValue(entry());
      await expect(
        service.correctReadings(caller, 'lb-1', correction, 'ip'),
      ).rejects.toThrow(/cannot be edited/);
      expect(prisma.tx.logbookEntry.update).not.toHaveBeenCalled();
    });
  });
});
