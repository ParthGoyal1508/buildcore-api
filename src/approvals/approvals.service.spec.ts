import {
  ApprovalDecisionAction,
  ApprovalState,
  Permission,
  Prisma,
} from '@prisma/client';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import {
  APPROVAL_ALREADY_DECIDED,
  APPROVAL_NOT_AUTHORISED,
  APPROVAL_NOT_PENDING,
  APPROVAL_REASON_REQUIRED,
  APPROVAL_REASSIGN_FORBIDDEN,
  APPROVAL_SLOT_UNMAPPED,
  APPROVAL_VIEW_FORBIDDEN,
} from './approval-error-codes';
import { SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR } from './approval-slots';
import { APPROVAL_COMPLETED_EVENT, ApprovalService } from './approvals.service';

const COMPANY = 'company-1';
const ROLE_FIRST = 'role-site';
const ROLE_HR = 'role-hr';
const ROLE_SUPER = 'role-super';

/** An authenticated caller carrying the role ids the spine checks authority against. */
const caller = (id: string, roleIds: string[]) =>
  ({
    id,
    companyId: COMPANY,
    permissions: [],
    roleNames: [],
    roleIds,
    displayName: null,
    firstname: 'Test',
    lastname: id,
    username: id,
    email: `${id}@example.test`,
  } as never);

const level = (
  position: number,
  slotKey: string,
  id = `level-${position}`,
) => ({
  id,
  chainId: 'chain-1',
  companyId: COMPANY,
  position,
  slotKey,
  isFinalAuthority: slotKey === SLOT_FINAL,
  label: null,
});

const THREE_LEVELS = [
  level(1, SLOT_FIRST_APPROVER),
  level(2, SLOT_HR),
  level(3, SLOT_FINAL),
];

type DecisionRow = {
  id: string;
  approvalInstanceId: string;
  companyId: string;
  round: number;
  position: number;
  actorUserId: string;
  action: ApprovalDecisionAction;
  reason: string | null;
  decidedAt: Date;
};

const instanceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'inst-1',
  companyId: COMPANY,
  chainId: 'chain-1',
  entityType: 'attendance_exception',
  entityId: 'punch-1',
  subject: 'Rajesh Kulkarni — 11 Sep, out of geofence',
  href: '/hr/attendance/punch-1',
  viewPermission: Permission.ATTENDANCE,
  currentPosition: 1,
  state: 'pending' as ApprovalState,
  originatorUserId: 'originator-1',
  round: 1,
  returnCount: 0,
  delegatedToUserId: null,
  delegationReason: null,
  createdAt: new Date('2026-09-11T04:00:00Z'),
  updatedAt: new Date('2026-09-11T04:00:00Z'),
  chain: {
    id: 'chain-1',
    companyId: COMPANY,
    actionType: 'attendance_exception',
    isFinalAuthorityRequired: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    levels: THREE_LEVELS,
  },
  decisions: [] as DecisionRow[],
  ...overrides,
});

/**
 * A stateful stand-in for the two spine tables.
 *
 * Stateful rather than fixed return values because every behaviour under test here is
 * about what a *second* call does given what the first one wrote — advance, then advance
 * again; decide, then try to decide twice. A stateless mock can only prove which queries
 * were issued, which is the one thing that does not matter.
 */
function harness(
  instance = instanceRow(),
  slots: Record<string, string | null> = {
    [SLOT_FIRST_APPROVER]: ROLE_FIRST,
    [SLOT_HR]: ROLE_HR,
    [SLOT_FINAL]: ROLE_SUPER,
  },
) {
  const state = { ...instance };
  let decisionSeq = 0;

  const prisma = createPrismaMock({
    approvalInstance: {
      findUnique: jest.fn(async () => ({ ...state })),
      findFirst: jest.fn(async () => ({ ...state })),
      findMany: jest.fn(async () => [{ ...state }]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data);
        return { ...state };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (
            value &&
            typeof value === 'object' &&
            'increment' in (value as Record<string, unknown>)
          ) {
            const current =
              (state as unknown as Record<string, number>)[key] ?? 0;
            (state as Record<string, unknown>)[key] =
              current + (value as { increment: number }).increment;
          } else {
            (state as Record<string, unknown>)[key] = value;
          }
        }
        return { ...state };
      }),
      count: jest.fn(async () => 1),
    },
    approvalDecision: {
      create: jest.fn(async ({ data }: { data: DecisionRow }) => {
        // The real uniques are (instance, round, actorUserId) and (instance, round,
        // position). Reproduced here so the service's P2002 handling is exercised by the
        // same rule the database enforces.
        const clashActor = state.decisions.some(
          (d) => d.round === data.round && d.actorUserId === data.actorUserId,
        );
        const clashPosition = state.decisions.some(
          (d) => d.round === data.round && d.position === data.position,
        );
        if (clashActor || clashPosition) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            {
              code: 'P2002',
              clientVersion: '5.22.0',
              meta: {
                target: clashActor
                  ? ['approvalInstanceId', 'round', 'actorUserId']
                  : ['approvalInstanceId', 'round', 'position'],
              },
            },
          );
        }
        const row: DecisionRow = {
          id: `dec-${++decisionSeq}`,
          decidedAt: new Date(`2026-09-12T0${decisionSeq}:00:00Z`),
          reason: null,
          ...data,
        };
        state.decisions = [...state.decisions, row];
        return row;
      }),
    },
    roleSlotMapping: { findMany: jest.fn(async () => []) },
    approvalLevel: { findMany: jest.fn(async () => []) },
    user: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({
            id,
            displayName: `Name ${id}`,
            firstname: null,
            lastname: null,
            username: id,
            email: `${id}@example.test`,
          })),
      ),
    },
  });

  const chains = {
    findActiveChain: jest.fn(async () => state.chain),
    resolveSlot: jest.fn(
      async (_ctx: unknown, _co: string, slotKey: string) =>
        slots[slotKey] ?? null,
    ),
  };
  const users = {
    findActiveHoldersOfRole: jest.fn(async (roleId: string) =>
      roleId === ROLE_HR
        ? [{ id: 'hr-1', name: 'Priya Sharma' }]
        : [
            { id: 'a', name: 'Holder A' },
            { id: 'b', name: 'Holder B' },
          ],
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn() };

  const service = new ApprovalService(
    prisma as never,
    chains as never,
    users as never,
    audit as never,
    events as never,
  );

  return { service, prisma, chains, users, audit, events, state };
}

const refusalCode = async (p: Promise<unknown>) =>
  p.then(
    () => 'RESOLVED — expected a refusal',
    (e) => e.response?.code ?? e.message,
  );

describe('ApprovalService', () => {
  describe('decide — the five distinguishable refusals (FR-003, T019)', () => {
    it('refuses when the item is not pending', async () => {
      const { service, audit } = harness(instanceRow({ state: 'approved' }));

      expect(
        await refusalCode(
          service.decide(
            { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
            caller('u1', [ROLE_FIRST]),
            '10.0.0.1',
          ),
        ),
      ).toBe(APPROVAL_NOT_PENDING);

      // FR-003: refusals are recorded, not merely returned.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'APPROVAL_REFUSED' }),
      );
    });

    it('refuses an unmapped slot as a CONFIGURATION fault, not as forbidden', async () => {
      const { service } = harness(instanceRow(), {
        [SLOT_FIRST_APPROVER]: null,
      });

      const error = await service
        .decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('u1', [ROLE_FIRST]),
          '10.0.0.1',
        )
        .catch((e) => e);

      expect(error.response.code).toBe(APPROVAL_SLOT_UNMAPPED);
      // 409, not 403. Reporting a settings gap as "forbidden" sends an administrator to
      // audit permissions for a problem that lives in a configuration table.
      expect(error.response.statusCode).toBe(409);
      expect(error.response.message).toMatch(/settings problem/);
    });

    it('refuses a caller whose roles do not hold the current level', async () => {
      const { service } = harness();

      expect(
        await refusalCode(
          service.decide(
            { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
            caller('u1', [ROLE_HR]), // HR, but the item is at level 1
            '10.0.0.1',
          ),
        ),
      ).toBe(APPROVAL_NOT_AUTHORISED);
    });

    it('refuses a second decision by the same person, distinctly from a permissions failure (FR-021a)', async () => {
      // The Super Admin case, which is the common case rather than the edge case: this
      // caller holds every role, decided at level 1, and is now at level 2.
      const everyRole = [ROLE_FIRST, ROLE_HR, ROLE_SUPER];
      const { service } = harness(
        instanceRow({
          currentPosition: 2,
          decisions: [
            {
              id: 'dec-1',
              approvalInstanceId: 'inst-1',
              companyId: COMPANY,
              round: 1,
              position: 1,
              actorUserId: 'director-1',
              action: ApprovalDecisionAction.approve,
              reason: null,
              decidedAt: new Date('2026-09-11T05:00:00Z'),
            },
          ],
        }),
      );

      const error = await service
        .decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('director-1', everyRole),
          '10.0.0.1',
        )
        .catch((e) => e);

      // NOT "insufficient authority" — this caller has every permission in the system,
      // and saying otherwise would send them to change permissions that are not the
      // problem.
      expect(error.response.code).toBe(APPROVAL_ALREADY_DECIDED);
      expect(error.response.code).not.toBe(APPROVAL_NOT_AUTHORISED);
      expect(error.response.message).toMatch(/reassigned/);
    });

    it('requires a reason to reject and to return, but not to approve (FR-006)', async () => {
      for (const action of [
        ApprovalDecisionAction.reject,
        ApprovalDecisionAction.return,
      ]) {
        const { service } = harness();
        expect(
          await refusalCode(
            service.decide(
              { instanceId: 'inst-1', action, reason: '   ' },
              caller('u1', [ROLE_FIRST]),
              '10.0.0.1',
            ),
          ),
        ).toBe(APPROVAL_REASON_REQUIRED);
      }

      const { service } = harness();
      await expect(
        service.decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('u1', [ROLE_FIRST]),
          '10.0.0.1',
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('decide — advancing, terminating and returning (FR-004, FR-005, FR-020)', () => {
    it('advances to the next level and stays pending', async () => {
      const { service, state, events } = harness();

      const view = await service.decide(
        { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
        caller('site-1', [ROLE_FIRST]),
        '10.0.0.1',
      );

      expect(state.currentPosition).toBe(2);
      expect(state.state).toBe('pending');
      expect(view.levelLabel).toBe('HR');
      expect(view.totalLevels).toBe(3);
      // Not finished, so nothing is announced.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('completes at the final level and emits approval.completed with four identifiers only', async () => {
      const { service, state, events } = harness(
        instanceRow({ currentPosition: 3 }),
      );

      await service.decide(
        { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
        caller('director-1', [ROLE_SUPER]),
        '10.0.0.1',
      );

      expect(state.state).toBe('approved');
      expect(events.emit).toHaveBeenCalledWith(APPROVAL_COMPLETED_EVENT, {
        entityType: 'attendance_exception',
        entityId: 'punch-1',
        companyId: COMPANY,
        instanceId: 'inst-1',
      });
      // The payload carries identifiers and nothing else — the spine has never read the
      // item and has no relation through which to read it.
      const [, payload] = events.emit.mock.calls[0];
      expect(Object.keys(payload).sort()).toEqual([
        'companyId',
        'entityId',
        'entityType',
        'instanceId',
      ]);
    });

    it('stops the chain on rejection', async () => {
      const { service, state, events } = harness();

      await service.decide(
        {
          instanceId: 'inst-1',
          action: ApprovalDecisionAction.reject,
          reason: 'Photo does not match the enrolled face.',
        },
        caller('site-1', [ROLE_FIRST]),
        '10.0.0.1',
      );

      expect(state.state).toBe('rejected');
      expect(state.currentPosition).toBe(1);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns, then lets the originator resubmit into a fresh round with a visible count', async () => {
      const { service, state } = harness();

      await service.decide(
        {
          instanceId: 'inst-1',
          action: ApprovalDecisionAction.return,
          reason: 'Attach the site supervisor’s note.',
        },
        caller('site-1', [ROLE_FIRST]),
        '10.0.0.1',
      );
      expect(state.state).toBe('returned');

      const view = await service.resubmit(
        'attendance_exception',
        'punch-1',
        COMPANY,
        'originator-1',
      );

      expect(view.state).toBe('pending');
      expect(view.currentPosition).toBe(1);
      expect(view.round).toBe(2);
      // FR-020: repetition leaves a trace rather than quietly resetting.
      expect(view.returnCount).toBe(1);
      // Prior decisions are retained — the record must show the item went round.
      expect(state.decisions).toHaveLength(1);
    });

    it('lets the same person decide again in a NEW round, which is the point of rounds', async () => {
      const { service, state } = harness();

      await service.decide(
        {
          instanceId: 'inst-1',
          action: ApprovalDecisionAction.return,
          reason: 'Needs the supervisor’s note.',
        },
        caller('site-1', [ROLE_FIRST]),
        '10.0.0.1',
      );
      await service.resubmit(
        'attendance_exception',
        'punch-1',
        COMPANY,
        'originator-1',
      );

      // Same person, same level, round 2. Legitimate — and impossible if the uniques were
      // not scoped by round.
      await expect(
        service.decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('site-1', [ROLE_FIRST]),
          '10.0.0.1',
        ),
      ).resolves.toBeDefined();
      expect(state.currentPosition).toBe(2);
      expect(state.decisions).toHaveLength(2);
    });

    it('refuses resubmission by anybody but the originator', async () => {
      const { service } = harness(instanceRow({ state: 'returned' }));

      expect(
        await refusalCode(
          service.resubmit(
            'attendance_exception',
            'punch-1',
            COMPANY,
            'somebody-else',
          ),
        ),
      ).toBe(APPROVAL_NOT_AUTHORISED);
    });
  });

  describe('the unique index, not the service, is what holds FR-021a (T020 unit half)', () => {
    it('translates the actor unique violation into APPROVAL_ALREADY_DECIDED', async () => {
      // The service's own pre-check is bypassed here by handing it an instance whose
      // decisions array is empty while the mock's stored state already holds a decision
      // by this actor — exactly the shape of a lost race.
      const { service, prisma } = harness();
      prisma.tx.approvalDecision.create = jest.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target: ['approvalInstanceId', 'round', 'actorUserId'] },
          },
        );
      });

      const error = await service
        .decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('site-1', [ROLE_FIRST]),
          '10.0.0.1',
        )
        .catch((e) => e);

      expect(error.response.code).toBe(APPROVAL_ALREADY_DECIDED);
      expect(error.response.message).toMatch(/only the first was kept/);
    });

    it('translates the position unique violation into a lost same-level race', async () => {
      const { service, prisma } = harness();
      prisma.tx.approvalDecision.create = jest.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target: ['approvalInstanceId', 'round', 'position'] },
          },
        );
      });

      const error = await service
        .decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('site-1', [ROLE_FIRST]),
          '10.0.0.1',
        )
        .catch((e) => e);

      // FR-021: two approvers at one level, exactly one recorded. The loser is told the
      // item moved on, not that they lack authority.
      expect(error.response.code).toBe(APPROVAL_NOT_PENDING);
      expect(error.response.message).toMatch(/Another approver/);
    });
  });

  describe('the view the interface consumes (FR-010, FR-011, T013a)', () => {
    it('says the caller may act, with no inert reason', async () => {
      const { service } = harness();
      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('site-1', [ROLE_FIRST]),
      );

      expect(view).toMatchObject({
        canActNow: true,
        inertReason: null,
        levelLabel: 'First approver',
        currentPosition: 1,
        totalLevels: 3,
      });
    });

    it('reports already_decided rather than insufficient_authority for a Super Admin who acted', async () => {
      const { service } = harness(
        instanceRow({
          currentPosition: 2,
          decisions: [
            {
              id: 'dec-1',
              approvalInstanceId: 'inst-1',
              companyId: COMPANY,
              round: 1,
              position: 1,
              actorUserId: 'director-1',
              action: ApprovalDecisionAction.approve,
              reason: null,
              decidedAt: new Date('2026-09-11T05:00:00Z'),
            },
          ],
        }),
      );

      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('director-1', [ROLE_FIRST, ROLE_HR, ROLE_SUPER]),
      );

      expect(view).toMatchObject({
        canActNow: false,
        inertReason: 'already_decided',
      });
    });

    it('reports slot_unmapped, which no browser could compute', async () => {
      const { service } = harness(instanceRow(), {
        [SLOT_FIRST_APPROVER]: null,
      });
      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('site-1', [ROLE_FIRST]),
      );

      expect(view).toMatchObject({
        canActNow: false,
        inertReason: 'slot_unmapped',
        awaitingRoleName: null,
      });
    });

    it('names the awaiting person only when exactly one holds the role', async () => {
      // Level 2 maps to HR, held by one person — nameable.
      const hrItem = harness(instanceRow({ currentPosition: 2 }));
      const named = await hrItem.service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('onlooker', []),
      );
      expect(named).toMatchObject({
        awaitingUserName: 'Priya Sharma',
        awaitingHolderCount: 1,
        canActNow: false,
      });

      // Level 1 maps to a role two people hold — naming one of them would be a guess
      // presented as a fact, so only the role is given.
      const shared = harness();
      const unnamed = await shared.service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('onlooker', []),
      );
      expect(unnamed).toMatchObject({
        awaitingUserName: null,
        awaitingRoleName: 'First approver',
        awaitingHolderCount: 2,
      });
    });

    it('carries the latest action, its actor and its time on the record itself (FR-008)', async () => {
      const { service } = harness();
      await service.decide(
        {
          instanceId: 'inst-1',
          action: ApprovalDecisionAction.approve,
          reason: null,
        },
        caller('site-1', [ROLE_FIRST]),
        '10.0.0.1',
      );

      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('onlooker', []),
      );

      expect(view?.latestDecision).toMatchObject({
        action: 'approve',
        actorUserId: 'site-1',
        actorName: 'Name site-1',
        position: 1,
        levelLabel: 'First approver',
      });
    });

    it('implies no action on an item nobody has touched (US3 scenario 3)', async () => {
      const { service } = harness();
      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('onlooker', []),
      );
      expect(view?.latestDecision).toBeNull();
    });

    it('batches a list without one query per row (contract Part 1)', async () => {
      const { service, prisma } = harness();
      const states = await service.statesOf(
        'attendance_exception',
        ['punch-1', 'punch-2', 'punch-3'],
        caller('site-1', [ROLE_FIRST]),
      );

      expect(states.size).toBeGreaterThan(0);
      // One findMany for the instances, not three findFirsts.
      expect(prisma.tx.approvalInstance.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.tx.approvalInstance.findFirst).not.toHaveBeenCalled();
    });

    it('returns an empty map for an empty id list without touching the database', async () => {
      const { service, prisma } = harness();
      const states = await service.statesOf(
        'attendance_exception',
        [],
        caller('u', []),
      );
      expect(states.size).toBe(0);
      expect(prisma.tx.approvalInstance.findMany).not.toHaveBeenCalled();
    });
  });

  describe('abandon (T015)', () => {
    it('closes a live chain so a cancelled item stops waiting forever', async () => {
      const { service, state } = harness();
      await service.abandon(
        'attendance_exception',
        'punch-1',
        COMPANY,
        'Punch deleted by site admin',
      );
      expect(state.state).toBe('abandoned');
    });

    it('is idempotent, because the module calling it may be retrying', async () => {
      const { service, prisma } = harness(instanceRow({ state: 'approved' }));
      await service.abandon(
        'attendance_exception',
        'punch-1',
        COMPANY,
        'again',
      );
      expect(prisma.tx.approvalInstance.update).not.toHaveBeenCalled();
    });
  });

  describe('reassignment (FR-019, T015a, T015b)', () => {
    it('grants one named person authority at the current level', async () => {
      const { service, state, audit } = harness();

      await service.reassign(
        'inst-1',
        'stand-in-1',
        'Priya is on leave until the 20th',
        caller('admin-1', []), // holds none of the chain's roles
        '10.0.0.1',
      );

      expect(state.delegatedToUserId).toBe('stand-in-1');
      expect(state.delegationReason).toBe('Priya is on leave until the 20th');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({ reassignedTo: 'stand-in-1' }),
        }),
      );
    });

    it('lets the delegate then decide, which is the stall FR-019 exists to clear', async () => {
      const { service, state } = harness(
        instanceRow({ delegatedToUserId: 'stand-in-1' }),
      );

      await expect(
        service.decide(
          { instanceId: 'inst-1', action: ApprovalDecisionAction.approve },
          caller('stand-in-1', []), // no chain role at all
          '10.0.0.1',
        ),
      ).resolves.toBeDefined();
      expect(state.currentPosition).toBe(2);
      // A grant is for one level; advancing clears it.
      expect(state.delegatedToUserId).toBeNull();
    });

    it('refuses reassignment by the very person the item awaits (T015b)', async () => {
      const { service, audit } = harness();

      const error = await service
        .reassign(
          'inst-1',
          'somebody-else',
          'I would rather not',
          caller('site-1', [ROLE_FIRST]), // holds the current level
          '10.0.0.1',
        )
        .catch((e) => e);

      expect(error.response.code).toBe(APPROVAL_REASSIGN_FORBIDDEN);
      expect(error.response.message).toMatch(/awaiting you/);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'APPROVAL_REFUSED' }),
      );
    });

    it('refuses reassignment by the current delegate, for the same reason', async () => {
      const { service } = harness(
        instanceRow({ delegatedToUserId: 'stand-in-1' }),
      );

      expect(
        await refusalCode(
          service.reassign(
            'inst-1',
            'yet-another',
            'passing it on',
            caller('stand-in-1', []),
            '10.0.0.1',
          ),
        ),
      ).toBe(APPROVAL_REASSIGN_FORBIDDEN);
    });

    it('requires a reason', async () => {
      const { service } = harness();
      expect(
        await refusalCode(
          service.reassign(
            'inst-1',
            'stand-in-1',
            '  ',
            caller('admin-1', []),
            '10.0.0.1',
          ),
        ),
      ).toBe(APPROVAL_REASON_REQUIRED);
    });

    it('refuses to reassign something that is not pending', async () => {
      const { service } = harness(instanceRow({ state: 'rejected' }));
      expect(
        await refusalCode(
          service.reassign(
            'inst-1',
            'x',
            'because',
            caller('admin-1', []),
            '10.0.0.1',
          ),
        ),
      ).toBe(APPROVAL_NOT_PENDING);
    });
  });

  describe('the queue (T016, T021)', () => {
    it('excludes items the caller has already decided on', async () => {
      const { service, prisma } = harness();
      prisma.tx.roleSlotMapping.findMany = jest
        .fn()
        .mockResolvedValue([{ slotKey: SLOT_HR }]);
      prisma.tx.approvalLevel.findMany = jest
        .fn()
        .mockResolvedValue([{ chainId: 'chain-1', position: 2 }]);

      await service.queueFor(caller('hr-1', [ROLE_HR]));

      const where = prisma.tx.approvalInstance.findMany.mock.calls[0][0].where;
      // A queue that lists work you are forbidden to action teaches people to ignore the
      // queue — so the exclusion is in the query, not applied afterwards.
      expect(where.decisions).toEqual({ none: { actorUserId: 'hr-1' } });
      expect(where.state).toBe('pending');
    });

    it('resolves the caller’s roles to slots without reading settings.UserRole', async () => {
      const { service, prisma } = harness();
      prisma.tx.roleSlotMapping.findMany = jest
        .fn()
        .mockResolvedValue([{ slotKey: SLOT_HR }]);
      prisma.tx.approvalLevel.findMany = jest
        .fn()
        .mockResolvedValue([{ chainId: 'chain-1', position: 2 }]);

      await service.queueFor(caller('hr-1', [ROLE_HR]));

      // Principle I: the role ids arrived with the authenticated caller.
      expect(prisma.tx.roleSlotMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: COMPANY, roleId: { in: [ROLE_HR] } },
        }),
      );
      expect(prisma.tx.userRole).toBeUndefined();
    });

    it('still reaches a delegate who holds none of the chain’s roles', async () => {
      const { service, prisma } = harness();
      prisma.tx.roleSlotMapping.findMany = jest.fn().mockResolvedValue([]);
      prisma.tx.approvalLevel.findMany = jest.fn().mockResolvedValue([]);

      await service.queueFor(caller('stand-in-1', []));

      const where = prisma.tx.approvalInstance.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ delegatedToUserId: 'stand-in-1' }]);
    });

    it('pages, reporting a cursor only when there is more', async () => {
      const { service, prisma } = harness();
      prisma.tx.roleSlotMapping.findMany = jest
        .fn()
        .mockResolvedValue([{ slotKey: SLOT_FIRST_APPROVER }]);
      prisma.tx.approvalLevel.findMany = jest
        .fn()
        .mockResolvedValue([{ chainId: 'chain-1', position: 1 }]);

      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...instanceRow({ id: `inst-${i + 1}` }),
      }));
      prisma.tx.approvalInstance.findMany = jest.fn().mockResolvedValue(rows);

      const page = await service.queueFor(caller('site-1', [ROLE_FIRST]), {
        limit: 2,
      });

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe('inst-2');
      expect(page.items[0]).toMatchObject({
        subject: 'Rajesh Kulkarni — 11 Sep, out of geofence',
        levelLabel: 'First approver',
        requestedByName: 'Name originator-1',
      });
      expect(typeof page.items[0].ageHours).toBe('number');
    });

    it('returns nothing for a caller with no company rather than everything', async () => {
      const { service } = harness();
      const page = await service.queueFor({
        id: 'u',
        companyId: null,
        roleIds: [],
      } as never);
      expect(page).toEqual({ items: [], nextCursor: null });
      await expect(
        service.queueCountFor({
          id: 'u',
          companyId: null,
          roleIds: [],
        } as never),
      ).resolves.toBe(0);
    });
  });

  describe('attribution on the record itself (FR-008, T042)', () => {
    const decided = () =>
      instanceRow({
        currentPosition: 2,
        decisions: [
          {
            id: 'dec-1',
            approvalInstanceId: 'inst-1',
            companyId: COMPANY,
            round: 1,
            position: 1,
            actorUserId: 'departed-1',
            action: ApprovalDecisionAction.approve,
            reason: null,
            decidedAt: new Date('2026-09-12T05:00:00Z'),
          },
        ],
      });

    it('carries the latest action, its actor and its time', async () => {
      const { service } = harness(decided());

      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('viewer-1', []),
      );

      expect(view.latestDecision).toMatchObject({
        action: ApprovalDecisionAction.approve,
        actorUserId: 'departed-1',
        actorName: 'Name departed-1',
        position: 1,
        levelLabel: 'First approver',
        decidedAt: new Date('2026-09-12T05:00:00Z'),
      });
    });

    it('names a deactivated actor rather than reporting "Unknown user"', async () => {
      const { service, prisma } = harness(decided());

      await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('viewer-1', []),
      );

      // FR-008: history that cannot say who acted is not history. The lookup must not
      // filter on isActive — somebody who has since left still did the thing.
      const where = prisma.tx.user.findMany.mock.calls[0][0].where;
      expect(where.id.in).toContain('departed-1');
      expect(where.isActive).toBeUndefined();
      expect(where.deletedAt).toBeUndefined();
    });

    it('reads a never-decided item as awaiting its first decision', async () => {
      const { service } = harness();

      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('viewer-1', []),
      );

      // US3 scenario 3: no action must be implied where none was taken.
      expect(view.latestDecision).toBeNull();
      expect(view.state).toBe('pending');
      expect(view.currentPosition).toBe(1);
    });

    it('attributes a scheduled item to the system, not to a missing person', async () => {
      const { service, prisma } = harness(
        instanceRow({ originatorUserId: null }),
      );
      prisma.tx.roleSlotMapping.findMany = jest
        .fn()
        .mockResolvedValue([{ slotKey: SLOT_FIRST_APPROVER }]);
      prisma.tx.approvalLevel.findMany = jest
        .fn()
        .mockResolvedValue([{ chainId: 'chain-1', position: 1 }]);

      const view = await service.stateOf(
        'attendance_exception',
        'punch-1',
        caller('viewer-1', []),
      );
      const page = await service.queueFor(caller('site-1', [ROLE_FIRST]));

      // "Unknown user" would read as data we lost. Nobody raised a scheduled run, and
      // that is a fact, not a gap.
      expect(view.originatorName).toBe('The system');
      expect(page.items[0].requestedByName).toBe('The system');
      expect(page.items[0].requestedById).toBeNull();
    });
  });

  describe('history and who may read it (FR-009, US3 scenario 4, T043)', () => {
    const withTwoDecisions = () =>
      instanceRow({
        currentPosition: 3,
        decisions: [
          {
            id: 'dec-2',
            approvalInstanceId: 'inst-1',
            companyId: COMPANY,
            round: 1,
            position: 2,
            actorUserId: 'hr-1',
            action: ApprovalDecisionAction.approve,
            reason: null,
            decidedAt: new Date('2026-09-12T09:00:00Z'),
          },
          {
            id: 'dec-1',
            approvalInstanceId: 'inst-1',
            companyId: COMPANY,
            round: 1,
            position: 1,
            actorUserId: 'site-1',
            action: ApprovalDecisionAction.approve,
            reason: 'Checked the site register.',
            decidedAt: new Date('2026-09-12T05:00:00Z'),
          },
        ],
      });

    const holder = (id: string, permissions: Permission[]) =>
      ({
        id,
        companyId: COMPANY,
        permissions,
        roleNames: [],
        roleIds: [],
      } as never);

    it('returns the full sequence oldest first, with reasons', async () => {
      const { service } = harness(withTwoDecisions());

      const history = await service.historyOf(
        'attendance_exception',
        'punch-1',
        holder('viewer-1', [Permission.ATTENDANCE]),
      );

      expect(history.map((d) => d.position)).toEqual([1, 2]);
      expect(history[0]).toMatchObject({
        levelLabel: 'First approver',
        actorName: 'Name site-1',
        reason: 'Checked the site register.',
      });
      expect(history[1].levelLabel).toBe('HR');
    });

    it('refuses a caller who may not view the item', async () => {
      const { service } = harness(withTwoDecisions());

      expect(
        await refusalCode(
          service.historyOf(
            'attendance_exception',
            'punch-1',
            holder('storekeeper-1', [Permission.INVENTORY]),
          ),
        ),
      ).toBe(APPROVAL_VIEW_FORBIDDEN);
    });

    it('lets the person who raised the item read it without the permission', async () => {
      const { service } = harness(withTwoDecisions());

      // Whoever raised a correction must be able to find out why it was rejected, and
      // the reason lives behind a permission they were never going to hold.
      await expect(
        service.historyOf(
          'attendance_exception',
          'punch-1',
          holder('originator-1', []),
        ),
      ).resolves.toHaveLength(2);
    });

    it('lets somebody who decided in the chain read it back', async () => {
      const { service } = harness(withTwoDecisions());

      await expect(
        service.historyOf(
          'attendance_exception',
          'punch-1',
          holder('hr-1', []),
        ),
      ).resolves.toHaveLength(2);
    });

    it('returns an empty history for an item never in a chain, without refusing', async () => {
      const { service, prisma } = harness();
      prisma.tx.approvalInstance.findFirst = jest.fn(async () => null);

      // Checked before authorisation deliberately: "never submitted" is not a secret,
      // and 403-vs-empty on an id the caller already holds tells them nothing new.
      await expect(
        service.historyOf(
          'attendance_exception',
          'punch-1',
          holder('storekeeper-1', [Permission.INVENTORY]),
        ),
      ).resolves.toEqual([]);
    });
  });

  describe('submit (T010)', () => {
    it('refuses as a configuration fault when no chain is defined (FR-001b)', async () => {
      const { service, chains } = harness();
      chains.findActiveChain = jest.fn(async () => null);

      const error = await service
        .submit({
          companyId: COMPANY,
          actionType: 'material_indent',
          entityType: 'material_indent',
          entityId: 'ind-1',
          originatorUserId: 'u1',
          subject: 'Indent 42',
          viewPermission: Permission.INVENTORY,
        })
        .catch((e) => e);

      expect(error.response.code).toBe('APPROVAL_CHAIN_NOT_CONFIGURED');
      expect(error.response.message).toMatch(
        /configuration gap, not a permissions/,
      );
    });

    it('turns the live-instance index violation into a double-submit refusal', async () => {
      const { service, prisma } = harness();
      prisma.tx.approvalInstance.create = jest.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target: ['entityType', 'entityId'] },
          },
        );
      });

      expect(
        await refusalCode(
          service.submit({
            companyId: COMPANY,
            actionType: 'attendance_exception',
            entityType: 'attendance_exception',
            entityId: 'punch-1',
            originatorUserId: 'u1',
            subject: 'A punch',
            viewPermission: Permission.ATTENDANCE,
          }),
        ),
      ).toBe('APPROVAL_ALREADY_SUBMITTED');
    });
  });
});
