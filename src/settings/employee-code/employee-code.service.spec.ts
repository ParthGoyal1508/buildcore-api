import { NotFoundException } from '@nestjs/common';
import { EmployeeCodeService } from './employee-code.service';
import { createPrismaMock } from '../testing/prisma-mock';

/** Stands in for the atomic `UPDATE ... RETURNING`: one shared counter that hands
 * every caller a distinct, monotonically increasing number, which is exactly the
 * guarantee Postgres gives that statement. */
function sequencedPrisma(shortCode: string | null, startAt = 0) {
  let lastNumber = startAt;
  return createPrismaMock({
    $queryRaw: jest.fn().mockImplementation(async () => {
      lastNumber += 1;
      return [{ lastNumber }];
    }),
    company: {
      findUnique: jest
        .fn()
        .mockResolvedValue(shortCode === null ? null : { shortCode }),
    },
    employeeCodeSequence: {
      findUnique: jest.fn().mockImplementation(async () => ({ lastNumber })),
    },
  });
}

describe('EmployeeCodeService', () => {
  it('formats the first code as {shortCode}-0001 (FR-023)', async () => {
    const service = new EmployeeCodeService(sequencedPrisma('DC') as never);
    await expect(service.getNextEmployeeCode('company-1')).resolves.toBe(
      'DC-0001',
    );
  });

  it('increments on each successive call', async () => {
    const service = new EmployeeCodeService(sequencedPrisma('DC') as never);
    const codes = [
      await service.getNextEmployeeCode('company-1'),
      await service.getNextEmployeeCode('company-1'),
      await service.getNextEmployeeCode('company-1'),
    ];
    expect(codes).toEqual(['DC-0001', 'DC-0002', 'DC-0003']);
  });

  it('re-prefixes with the new short code while the sequence runs on (FR-024)', async () => {
    // Sequence already at 41; renaming the company must not restart it.
    const service = new EmployeeCodeService(
      sequencedPrisma('NEW', 41) as never,
    );
    await expect(service.getNextEmployeeCode('company-1')).resolves.toBe(
      'NEW-0042',
    );
  });

  it('grows past the padding rather than truncating', async () => {
    const service = new EmployeeCodeService(
      sequencedPrisma('DC', 99999) as never,
    );
    await expect(service.getNextEmployeeCode('company-1')).resolves.toBe(
      'DC-100000',
    );
  });

  it('rejects a company with no sequence row', async () => {
    const prisma = createPrismaMock({
      $queryRaw: jest.fn().mockResolvedValue([]),
      company: { findUnique: jest.fn().mockResolvedValue({ shortCode: 'DC' }) },
    });
    const service = new EmployeeCodeService(prisma as never);
    await expect(service.getNextEmployeeCode('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('getCurrentState', () => {
    it('previews the next code without consuming it (User Story 7)', async () => {
      const prisma = sequencedPrisma('DC', 7);
      const service = new EmployeeCodeService(prisma as never);

      const state = await service.getCurrentState('company-1');

      expect(state).toEqual({
        companyId: 'company-1',
        shortCode: 'DC',
        lastNumber: 7,
        nextCode: 'DC-0008',
      });
      // The read path must never touch the incrementing statement.
      expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('reports an unused series as 0 / -0001', async () => {
      const prisma = createPrismaMock({
        company: {
          findUnique: jest.fn().mockResolvedValue({ shortCode: 'DC' }),
        },
        employeeCodeSequence: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new EmployeeCodeService(prisma as never);
      await expect(service.getCurrentState('company-1')).resolves.toMatchObject(
        {
          lastNumber: 0,
          nextCode: 'DC-0001',
        },
      );
    });
  });

  /**
   * SC-007. This exercises the service's own contract — that every concurrent
   * caller formats a distinct number and none is skipped — against a counter
   * standing in for the atomic statement. The atomicity itself is Postgres's
   * guarantee, not this code's, and is covered against a real database in
   * test/settings.e2e-spec.ts.
   */
  it('produces 1,000 unique, gapless codes under concurrent calls (SC-007)', async () => {
    const service = new EmployeeCodeService(sequencedPrisma('DC') as never);

    const codes = await Promise.all(
      Array.from({ length: 1000 }, () =>
        service.getNextEmployeeCode('company-1'),
      ),
    );

    expect(new Set(codes).size).toBe(1000);
    const numbers = codes
      .map((c) => Number(c.split('-')[1]))
      .sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers[999]).toBe(1000);
    expect(numbers.every((n, i) => n === i + 1)).toBe(true);
  });
});
