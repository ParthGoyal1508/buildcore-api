import { NotFoundException } from '@nestjs/common';
import { ApprovalDecisionAction, ExceptionResolution } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { ACTION_ATTENDANCE_EXCEPTION } from '../../approvals/default-chains';
import type { ApprovalInstanceView } from '../../approvals/approval.types';
import { AttendanceExceptionsService } from './attendance-exceptions.service';

const COMPANY = 'company-1';
const PUNCH = 'punch-1';

const caller = {
  userId: 'admin-1',
  companyId: COMPANY,
  ipAddress: '10.0.0.1',
  rls: { isSuperAdmin: false, companyId: COMPANY },
};

const viewer = {
  id: 'admin-1',
  companyId: COMPANY,
  roleIds: ['role-site'],
  permissions: [],
  roleNames: [],
} as never;

const view = (over: Partial<ApprovalInstanceView> = {}): ApprovalInstanceView =>
  ({
    instanceId: 'inst-1',
    companyId: COMPANY,
    actionType: ACTION_ATTENDANCE_EXCEPTION,
    entityType: ACTION_ATTENDANCE_EXCEPTION,
    entityId: PUNCH,
    subject: 'Rajesh Kulkarni — 11 Sep, outside the site geofence',
    href: null,
    state: 'pending',
    currentPosition: 1,
    totalLevels: 3,
    round: 1,
    returnCount: 0,
    originatorUserId: 'emp-1',
    originatorName: 'Rajesh Kulkarni',
    levelLabel: 'Site / Employer',
    awaitingRoleName: 'Site / Employer',
    awaitingUserName: null,
    awaitingHolderCount: 2,
    canActNow: true,
    inertReason: null,
    latestDecision: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ApprovalInstanceView);

/** A punch row that flips to resolved once something writes to it. */
function harness(punchResolution: ExceptionResolution | null = 'pending') {
  const punch = {
    id: PUNCH,
    employeeId: 'emp-row-1',
    exceptionResolution: punchResolution,
    resolvedByUserId: null as string | null,
    resolvedAt: null as Date | null,
  };

  const prisma = createPrismaMock({
    punchRecord: {
      findFirst: jest.fn(async () => ({ ...punch })),
      findMany: jest.fn(async () => [{ ...punch }]),
      // Mirrors `updateMany`: it writes only where the filter matches, which is where
      // this service's idempotency actually lives.
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (
            where.exceptionResolution &&
            punch.exceptionResolution !== where.exceptionResolution
          ) {
            return { count: 0 };
          }
          Object.assign(punch, data);
          return { count: 1 };
        },
      ),
    },
  });

  const approvals = {
    stateOf: jest.fn(async () => view()),
    statesOf: jest.fn(async () => new Map([[PUNCH, view()]])),
    decide: jest.fn(async () => view({ currentPosition: 2 })),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new AttendanceExceptionsService(
    prisma as never,
    approvals as never,
    auditLog as never,
  );

  return { service, prisma, approvals, auditLog, punch };
}

describe('AttendanceExceptionsService', () => {
  describe('the completion handler is idempotent (T025, T029)', () => {
    it('applies the same event twice and writes once', async () => {
      const { service, prisma, punch } = harness();
      const event = {
        entityType: ACTION_ATTENDANCE_EXCEPTION,
        entityId: PUNCH,
        companyId: COMPANY,
        instanceId: 'inst-1',
      };

      await service.onApprovalCompleted(event);
      expect(punch.exceptionResolution).toBe(ExceptionResolution.confirmed);
      const firstWrite = punch.resolvedAt;

      // Redelivery. The event bus offers no once-only guarantee and research.md §8 makes
      // this an expectation rather than a hazard.
      await service.onApprovalCompleted(event);

      expect(punch.exceptionResolution).toBe(ExceptionResolution.confirmed);
      // Unchanged: the second delivery matched nothing, so it did not restamp the time.
      expect(punch.resolvedAt).toBe(firstWrite);
      expect(prisma.tx.punchRecord.updateMany).toHaveBeenCalledTimes(2);
      // Both calls carried the pending filter — that clause IS the idempotency.
      for (const call of prisma.tx.punchRecord.updateMany.mock.calls) {
        expect(call[0].where).toMatchObject({
          id: PUNCH,
          exceptionResolution: ExceptionResolution.pending,
        });
      }
    });

    it('ignores an event about another kind of item', async () => {
      const { service, prisma } = harness();
      await service.onApprovalCompleted({
        entityType: 'payroll_run',
        entityId: 'run-1',
        companyId: COMPANY,
        instanceId: 'inst-2',
      });
      expect(prisma.tx.punchRecord.updateMany).not.toHaveBeenCalled();
    });

    it('does not rethrow when the punch cannot be updated', async () => {
      // The decision is already committed and the spine is authoritative, so throwing
      // here would take nothing with it — the drift is for the reconciliation sweep.
      const { service, prisma } = harness();
      prisma.tx.punchRecord.updateMany = jest.fn(async () => {
        throw new Error('connection reset');
      });

      await expect(
        service.onApprovalCompleted({
          entityType: ACTION_ATTENDANCE_EXCEPTION,
          entityId: PUNCH,
          companyId: COMPANY,
          instanceId: 'inst-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('decide (T024)', () => {
    it.each([
      ['confirmed', ApprovalDecisionAction.approve],
      ['rejected', ApprovalDecisionAction.reject],
      ['returned', ApprovalDecisionAction.return],
    ] as const)(
      'maps the endpoint’s "%s" onto the chain’s "%s"',
      async (resolution, action) => {
        const { service, approvals } = harness();
        await service.decide(
          caller as never,
          viewer,
          PUNCH,
          resolution,
          'because',
        );
        expect(approvals.decide).toHaveBeenCalledWith(
          expect.objectContaining({ instanceId: 'inst-1', action }),
          viewer,
          '10.0.0.1',
        );
      },
    );

    it('leaves the punch pending when the chain has only advanced', async () => {
      // The whole point of the feature: confirming at level 1 of 3 is not a confirmation
      // of the punch, it is one person's agreement.
      const { service, punch, prisma } = harness();
      await service.decide(caller as never, viewer, PUNCH, 'confirmed', null);

      expect(punch.exceptionResolution).toBe('pending');
      expect(prisma.tx.punchRecord.updateMany).not.toHaveBeenCalled();
    });

    it('settles the punch when the chain completes', async () => {
      const { service, approvals, punch } = harness();
      approvals.decide = jest.fn(async () =>
        view({ state: 'approved', currentPosition: 3 }),
      );

      await service.decide(caller as never, viewer, PUNCH, 'confirmed', null);
      expect(punch.exceptionResolution).toBe(ExceptionResolution.confirmed);
      expect(punch.resolvedByUserId).toBe('admin-1');
    });

    it('settles the punch as rejected when the chain stops', async () => {
      const { service, approvals, punch } = harness();
      approvals.decide = jest.fn(async () => view({ state: 'rejected' }));

      await service.decide(
        caller as never,
        viewer,
        PUNCH,
        'rejected',
        'Photo does not match the enrolled face.',
      );
      expect(punch.exceptionResolution).toBe(ExceptionResolution.rejected);
    });

    it('leaves the punch alone when the item is returned for correction', async () => {
      const { service, approvals, punch } = harness();
      approvals.decide = jest.fn(async () => view({ state: 'returned' }));

      await service.decide(
        caller as never,
        viewer,
        PUNCH,
        'returned',
        'Attach the supervisor’s note.',
      );
      // Still awaiting correction — a returned item has not been judged.
      expect(punch.exceptionResolution).toBe('pending');
    });

    it('refuses a punch that never entered a chain, naming why', async () => {
      const { service, approvals } = harness();
      approvals.stateOf = jest.fn(async () => null);

      await expect(
        service.decide(caller as never, viewer, PUNCH, 'confirmed', null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listPending (T026)', () => {
    it('batches the approval states rather than asking per row', async () => {
      const { service, approvals } = harness();
      const rows = await service.listPending(caller as never, viewer);

      expect(rows).toHaveLength(1);
      expect(rows[0].approval?.levelLabel).toBe('Site / Employer');
      // `stateOf` in this loop is the N+1 the batch form exists to prevent.
      expect(approvals.statesOf).toHaveBeenCalledTimes(1);
      expect(approvals.stateOf).not.toHaveBeenCalled();
    });

    it('renders a punch with no chain rather than failing the list', async () => {
      // Pre-016 rows, and any punch whose submission failed, must still appear.
      const { service, approvals } = harness();
      approvals.statesOf = jest.fn(async () => new Map());

      const rows = await service.listPending(caller as never, viewer);
      expect(rows[0].approval).toBeNull();
    });

    it('asks the spine for nothing when there are no flagged punches', async () => {
      const { service, prisma, approvals } = harness();
      prisma.tx.punchRecord.findMany = jest.fn(async () => []);

      await expect(
        service.listPending(caller as never, viewer),
      ).resolves.toEqual([]);
      expect(approvals.statesOf).not.toHaveBeenCalled();
    });
  });
});
