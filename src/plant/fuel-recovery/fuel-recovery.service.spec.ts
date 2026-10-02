import { BadRequestException } from '@nestjs/common';
import {
  FuelAttribution,
  FuelExceptionStatus,
  HireBillStatus,
  OperatorRecoveryStatus,
} from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { FuelRecoveryService } from './fuel-recovery.service';

/**
 * Recovering a confirmed fuel loss (020 FR-003 to FR-007, FR-010).
 *
 * The properties worth pinning are the ones where money moves the wrong way: a loss collected twice,
 * a paid bill rewritten, or a recovery raised against somebody the exception never named.
 */
describe('FuelRecoveryService', () => {
  const caller = callerFor('co-1');

  const build = (
    opts: {
      attribution?: FuelAttribution | null;
      status?: FuelExceptionStatus;
      operatorEmployeeId?: string | null;
      hireBillDeduction?: { id: string } | null;
      operatorRecovery?: {
        id: string;
        status: OperatorRecoveryStatus;
      } | null;
      billStatus?: HireBillStatus;
      /** The bill returned by the carry lookup — null means there is no later unpaid bill. */
      laterBill?: { id: string } | null;
      /** Litres the logbook recorded, against a 2 l/hr benchmark over 4 hours. */
      fuelConsumed?: number;
    } = {},
  ) => {
    const {
      attribution = FuelAttribution.hirer,
      status = FuelExceptionStatus.confirmed,
      operatorEmployeeId = 'emp-1',
      hireBillDeduction = null,
      operatorRecovery = null,
      billStatus = HireBillStatus.verified,
      laterBill = null,
      fuelConsumed = 11,
    } = opts;

    const prisma = createPrismaMock({
      fuelVarianceException: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'exc-1',
          companyId: 'co-1',
          status,
          attribution,
          operatorEmployeeId,
          hireBillDeduction,
          operatorRecovery,
          fuelEntry: {
            equipmentId: 'eq-1',
            date: new Date('2026-09-20'),
            quantity: 11,
            rate: 95,
            equipment: {
              id: 'eq-1',
              code: 'EX-01',
              ownership: 'hired',
              categoryId: 'cat-1',
            },
          },
        }),
      },
      logbookEntry: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ fuelConsumed, totalHours: 4 }),
      },
      hireBill: {
        findFirst: jest
          .fn()
          // First call resolves the period's bill; a second is the carry lookup.
          .mockResolvedValueOnce({
            id: 'bill-1',
            companyId: 'co-1',
            equipmentId: 'eq-1',
            vendorId: 'v-1',
            status: billStatus,
            billingPeriodFrom: new Date('2026-09-01'),
          })
          .mockResolvedValue(laterBill),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'bill-1',
          billedHours: 100,
          rate: 500,
          tdsRate: 2,
          status: billStatus,
          fuelDeductions: [],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      hireBillDeduction: {
        create: jest.fn().mockResolvedValue({ id: 'ded-1' }),
        delete: jest.fn().mockResolvedValue({}),
      },
      operatorFuelRecovery: {
        create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    });

    const approvals = {
      submit: jest
        .fn()
        .mockResolvedValue({ instanceId: 'inst-1', state: 'pending' }),
    };
    const service = new FuelRecoveryService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {
        categoriesByIds: jest
          .fn()
          .mockResolvedValue(new Map([['cat-1', { fuelBenchmark: 2 }]])),
      } as never,
      approvals as never,
    );
    return { service, prisma, approvals };
  };

  describe('exclusivity (FR-002, T063, T066)', () => {
    it('refuses an operator recovery on a hirer-attributed exception', async () => {
      const { service } = build({ attribution: FuelAttribution.hirer });
      await expect(
        service.raiseOperatorRecovery(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_WRONG_ATTRIBUTION' },
      });
    });

    it('refuses a hire-bill deduction on an operator-attributed exception', async () => {
      const { service } = build({ attribution: FuelAttribution.operator });
      await expect(
        service.deductFromHireBill(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_WRONG_ATTRIBUTION' },
      });
    });

    it('refuses a second recovery when the other party is already paying', async () => {
      // `both` means the loss is *shared*, never collected twice. Whichever destination is raised
      // first claims the exception — this is the test that stops one loss funding two recoveries.
      const { service } = build({
        attribution: FuelAttribution.both,
        operatorRecovery: {
          id: 'rec-9',
          status: OperatorRecoveryStatus.approved,
        },
      });
      await expect(
        service.deductFromHireBill(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_ALREADY_RECOVERED' },
      });
    });

    it('allows either destination under a shared attribution while neither has claimed it', async () => {
      const { service, prisma } = build({
        attribution: FuelAttribution.both,
      });
      await service.deductFromHireBill(caller, 'exc-1', '127.0.0.1');
      expect(prisma.tx.hireBillDeduction.create).toHaveBeenCalled();
    });

    it('does not count a reversed recovery as the other party paying', async () => {
      // A reversal must leave the loss recoverable from the other party, or correcting a mistake
      // means writing the loss off.
      const { service, prisma } = build({
        attribution: FuelAttribution.both,
        operatorRecovery: {
          id: 'rec-9',
          status: OperatorRecoveryStatus.reversed,
        },
      });
      await service.deductFromHireBill(caller, 'exc-1', '127.0.0.1');
      expect(prisma.tx.hireBillDeduction.create).toHaveBeenCalled();
    });

    it('refuses an unconfirmed exception outright', async () => {
      const { service } = build({ status: FuelExceptionStatus.open });
      await expect(
        service.deductFromHireBill(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_NOT_CONFIRMED' },
      });
    });

    it('refuses when the benchmark no longer shows a shortfall', async () => {
      const { service } = build({ fuelConsumed: 7 });
      await expect(
        service.deductFromHireBill(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_NOTHING_TO_RECOVER' },
      });
    });
  });

  describe('the paid bill (FR-003, T055, T057)', () => {
    it('carries the deduction to the next unpaid bill', async () => {
      const { service, prisma } = build({
        billStatus: HireBillStatus.paid,
        laterBill: { id: 'bill-2' },
      });
      const result = await service.deductFromHireBill(
        caller,
        'exc-1',
        '127.0.0.1',
      );
      expect(result.hireBillId).toBe('bill-2');
      expect(prisma.tx.hireBillDeduction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ hireBillId: 'bill-2' }),
        }),
      );
    });

    it('refuses when the bill is paid and there is no later one to carry to', async () => {
      // Named code, because the interface has to say something actionable: raise the next bill first.
      const { service, prisma } = build({
        billStatus: HireBillStatus.paid,
        laterBill: null,
      });
      await expect(
        service.deductFromHireBill(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_NO_UNPAID_BILL' },
      });
      expect(prisma.tx.hireBillDeduction.create).not.toHaveBeenCalled();
    });

    it('never touches a paid bill, even to reverse a deduction', async () => {
      const { service, prisma } = build({
        hireBillDeduction: { id: 'ded-1' },
        billStatus: HireBillStatus.paid,
      });
      await expect(
        service.reverse(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.hireBillDeduction.delete).not.toHaveBeenCalled();
    });
  });

  describe('raising an operator recovery (FR-005, FR-006)', () => {
    it('creates it pending and submits it to the chain', async () => {
      const { service, prisma, approvals } = build({
        attribution: FuelAttribution.operator,
      });
      const result = await service.raiseOperatorRecovery(
        caller,
        'exc-1',
        '127.0.0.1',
      );

      // 11 litres burned against 8 allowed = 3 litres × 95 = 285.
      expect(prisma.tx.operatorFuelRecovery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employeeId: 'emp-1' }),
        }),
      );
      expect(result.shortfall.shortfallAmount).toBe(285);
      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'operator_fuel_recovery' }),
      );
    });

    it('refuses when the exception names no operator', async () => {
      const { service, prisma } = build({
        attribution: FuelAttribution.operator,
        operatorEmployeeId: null,
      });
      await expect(
        service.raiseOperatorRecovery(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_OPERATOR_UNKNOWN' },
      });
      expect(prisma.tx.operatorFuelRecovery.create).not.toHaveBeenCalled();
    });
  });

  describe('the payroll boundary (FR-006, FR-007b, T064, T065)', () => {
    const boundary = () => {
      const prisma = createPrismaMock({
        operatorFuelRecovery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'rec-1',
              employeeId: 'emp-1',
              amount: 5000,
              recoveredAmount: 1500,
            },
            // Balance already cleared but the status has not caught up — possible if a write failed
            // between the two. Must not be collected again.
            {
              id: 'rec-2',
              employeeId: 'emp-1',
              amount: 2000,
              recoveredAmount: 2000,
            },
          ]),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ amount: 5000, recoveredAmount: 1500 }),
          update: jest.fn().mockResolvedValue({}),
        },
      });
      const service = new FuelRecoveryService(
        prisma as never,
        { record: jest.fn() } as never,
        { categoriesByIds: jest.fn() } as never,
        { submit: jest.fn() } as never,
      );
      return { service, prisma };
    };

    it('asks only for approved recoveries', async () => {
      /**
       * **This is where FR-006 actually lives.** "No payroll line until approved" is a property of
       * this `where` clause, not a check in the payroll engine — so the assertion is on the query.
       * A test on the engine's behaviour would pass while a second caller could still surface a
       * pending recovery.
       */
      const { service, prisma } = boundary();
      await service.dueForEmployees('co-1', ['emp-1']);

      expect(prisma.tx.operatorFuelRecovery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: OperatorRecoveryStatus.approved,
          }),
        }),
      );
    });

    it('returns the outstanding balance, not the original amount', async () => {
      const { service } = boundary();
      const due = await service.dueForEmployees('co-1', ['emp-1']);
      // 5,000 owed less 1,500 already taken. Returning the amount would re-collect what is paid.
      expect(due.get('emp-1')).toEqual([
        { recoveryId: 'rec-1', balance: 3500 },
      ]);
    });

    it('asks for nothing when there are no employees', async () => {
      const { service, prisma } = boundary();
      expect(await service.dueForEmployees('co-1', [])).toEqual(new Map());
      expect(prisma.tx.operatorFuelRecovery.findMany).not.toHaveBeenCalled();
    });

    it('leaves a partly recovered balance approved so it carries', async () => {
      // FR-007b. `applied` would remove it from `dueForEmployees` and the remainder would never be
      // collected — the balance silently written off, which FR-007c forbids.
      const { service, prisma } = boundary();
      await service.recordRecovered(
        prisma.tx as never,
        'rec-1',
        1000,
        'line-1',
      );
      const [[args]] = (prisma.tx.operatorFuelRecovery.update as jest.Mock).mock
        .calls;
      expect(args.data.status).toBeUndefined();
      expect(Number(args.data.recoveredAmount)).toBe(2500);
    });

    it('marks it applied only when the balance clears', async () => {
      const { service, prisma } = boundary();
      await service.recordRecovered(
        prisma.tx as never,
        'rec-1',
        3500,
        'line-1',
      );
      const [[args]] = (prisma.tx.operatorFuelRecovery.update as jest.Mock).mock
        .calls;
      expect(args.data.status).toBe(OperatorRecoveryStatus.applied);
    });
  });

  describe('reversal (FR-010, T067)', () => {
    it('deletes a hire-bill deduction and recomputes the net', async () => {
      const { service, prisma } = build({
        hireBillDeduction: { id: 'ded-1' },
      });
      await service.reverse(caller, 'exc-1', '127.0.0.1');
      expect(prisma.tx.hireBillDeduction.delete).toHaveBeenCalled();
      // Recomputed, not decremented — the update carries a net derived from the remaining set.
      expect(prisma.tx.hireBill.update).toHaveBeenCalled();
    });

    it('marks an operator recovery reversed rather than deleting it', async () => {
      // Asymmetric on purpose: a recovery may already have reduced somebody's pay, and a row deleted
      // from under a payslip makes that payslip unexplainable.
      const { service, prisma } = build({
        attribution: FuelAttribution.operator,
        operatorRecovery: {
          id: 'rec-1',
          status: OperatorRecoveryStatus.approved,
        },
      });
      await service.reverse(caller, 'exc-1', '127.0.0.1');
      expect(prisma.tx.operatorFuelRecovery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OperatorRecoveryStatus.reversed,
            reversedByUserId: 'caller-1',
          }),
        }),
      );
    });

    it('refuses to reverse the same recovery twice', async () => {
      const { service } = build({
        attribution: FuelAttribution.operator,
        operatorRecovery: {
          id: 'rec-1',
          status: OperatorRecoveryStatus.reversed,
        },
      });
      await expect(
        service.reverse(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_ALREADY_REVERSED' },
      });
    });

    it('refuses when nothing has been recovered', async () => {
      const { service } = build();
      await expect(
        service.reverse(caller, 'exc-1', '127.0.0.1'),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_RECOVERY_NOTHING_TO_REVERSE' },
      });
    });
  });
});
