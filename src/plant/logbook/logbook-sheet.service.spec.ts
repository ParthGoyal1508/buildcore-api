import { MeterType } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LogbookSheetService } from './logbook-sheet.service';

const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;

/**
 * The sheet's save is ONE transaction (042). Before this, each row went through its own
 * `create`, so a refusal the pre-checks cannot see — a machine disposed mid-save, a fuel
 * rule, a database fault on row 19 — left the month half-written: some days saved, the
 * rest not, and audit entries already recorded for rows that stood. These tests pin the
 * two properties that make that impossible: every row is written against the same
 * transaction client, and no audit or variance event fires until the transaction has
 * committed.
 */
describe('LogbookSheetService.save (042 — atomic sheet)', () => {
  const build = () => {
    const prisma = createPrismaMock({
      equipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'eq-1',
          companyId: 'co-1',
          code: 'EX-01',
          name: 'Excavator',
          registrationNo: null,
          meterType: MeterType.hours,
        }),
      },
      logbookEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      fuelEntry: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const logbook = {
      assertDaysNotBilled: jest.fn().mockResolvedValue(undefined),
      createInTx: jest.fn(async (_caller: never, dto: { date: string }) => ({
        id: `lb-${dto.date}`,
        date: new Date(`${dto.date}T00:00:00.000Z`),
      })),
      auditCreated: jest.fn().mockResolvedValue(undefined),
    };
    const fuel = {
      createInTx: jest.fn().mockResolvedValue({
        created: { id: 'fuel-1' },
        variance: { variancePercent: null, varianceAlert: false },
        threshold: 15,
      }),
      recordCreated: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogbookSheetService(
      prisma as never,
      {} as never,
      logbook as never,
      fuel as never,
    );
    return { service, prisma, logbook, fuel };
  };

  const dto = {
    equipmentId: 'eq-1',
    month: '2026-10',
    rows: [
      { date: '2026-10-05', openingReading: 100, closingReading: 108 },
      {
        date: '2026-10-06',
        openingReading: 108,
        closingReading: 115,
        dieselQuantity: 40,
        dieselAmount: 3800,
      },
    ],
  };

  it('writes every row against one transaction client', async () => {
    const { service, prisma, logbook, fuel } = build();
    await service.save(caller, dto as never, 'ip');

    expect(logbook.createInTx).toHaveBeenCalledTimes(2);
    expect(fuel.createInTx).toHaveBeenCalledTimes(1);
    // The same client for every write — the mock's transaction hands out `prisma.tx`.
    for (const [, , tx] of [
      ...logbook.createInTx.mock.calls,
      ...fuel.createInTx.mock.calls,
    ]) {
      expect(tx).toBe(prisma.tx);
    }
  });

  it('records audits and variance events only after the transaction', async () => {
    const { service, logbook, fuel } = build();
    await service.save(caller, dto as never, 'ip');

    // One audit per written row, from the rows the transaction returned.
    expect(logbook.auditCreated).toHaveBeenCalledTimes(2);
    expect(fuel.recordCreated).toHaveBeenCalledTimes(1);
    const lastWrite = Math.max(
      ...logbook.createInTx.mock.invocationCallOrder,
      ...fuel.createInTx.mock.invocationCallOrder,
    );
    const firstAudit = Math.min(
      ...logbook.auditCreated.mock.invocationCallOrder,
      ...fuel.recordCreated.mock.invocationCallOrder,
    );
    expect(firstAudit).toBeGreaterThan(lastWrite);
  });

  it('audits nothing when any row fails — the whole sheet rolls back with it', async () => {
    const { service, logbook, fuel } = build();
    fuel.createInTx.mockRejectedValue(new Error('The fuel date cannot be in the future.'));

    await expect(service.save(caller, dto as never, 'ip')).rejects.toThrow(
      /future/,
    );

    // The logbook rows WERE attempted before the failing fill — the transaction takes
    // them down — and not a single audit entry or variance event describes them.
    expect(logbook.createInTx).toHaveBeenCalled();
    expect(logbook.auditCreated).not.toHaveBeenCalled();
    expect(fuel.recordCreated).not.toHaveBeenCalled();
  });
});
