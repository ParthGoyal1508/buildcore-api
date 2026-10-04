import { BadRequestException } from '@nestjs/common';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { APPROVAL_CHAIN_UNSATISFIABLE } from './approval-error-codes';
import { SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR } from './approval-slots';
import { DIRECTOR_FINAL_SEEDED_ACTIONS } from './default-chains';
import { ChainsService } from './chains.service';

const COMPANY = 'company-1';
const CTX = { isSuperAdmin: false, companyId: COMPANY };
const ACTOR = { userId: 'admin-1', ipAddress: '10.0.0.1' };

const level = (position: number, slotKey: string, label?: string) => ({
  id: `level-${position}`,
  chainId: 'chain-1',
  companyId: COMPANY,
  position,
  slotKey,
  isFinalAuthority: false,
  label: label ?? null,
});

/** A chain whose levels are already mapped, as the guard would read it. */
const chainRow = (levels: ReturnType<typeof level>[]) => ({
  id: 'chain-1',
  companyId: COMPANY,
  actionType: 'attendance_exception',
  isFinalAuthorityRequired: false,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  levels,
});

const auditMock = () => ({ record: jest.fn().mockResolvedValue(undefined) });

describe('ChainsService', () => {
  describe('chain definition (FR-001)', () => {
    it('refuses a chain whose positions have a gap', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findFirst: jest.fn(), create: jest.fn() },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      // 1, 2, 4 — the missing 3 would park every item there forever, because
      // `currentPosition` only ever advances by one.
      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'attendance_exception',
            levels: [
              { position: 1, slotKey: SLOT_FIRST_APPROVER },
              { position: 2, slotKey: SLOT_HR },
              { position: 4, slotKey: SLOT_FINAL },
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/no gaps/);

      expect(prisma.tx.approvalChain.create).not.toHaveBeenCalled();
    });

    it('refuses a chain that uses the same slot twice', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findFirst: jest.fn(), create: jest.fn() },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'payroll_run',
            levels: [
              { position: 1, slotKey: SLOT_HR },
              { position: 2, slotKey: SLOT_HR },
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/may not appear twice/);
    });

    it('refuses more than one final-authority level', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findFirst: jest.fn(), create: jest.fn() },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'payroll_run',
            levels: [
              { position: 1, slotKey: SLOT_HR, isFinalAuthority: true },
              { position: 2, slotKey: SLOT_FINAL, isFinalAuthority: true },
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/At most one level/);
    });

    it('refuses a director-final chain with no director level (FR-018, T049)', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findFirst: jest.fn(), create: jest.fn() },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      // The worst version of the failure: the chain completes with every level approved
      // and no director having seen it, and nothing looks wrong.
      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'payment_release',
            isFinalAuthorityRequired: true,
            levels: [{ position: 1, slotKey: SLOT_HR }],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/must have a level marked as the final authority/);
    });

    it('refuses a final authority that is not the last level', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findFirst: jest.fn(), create: jest.fn() },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      // A level below the director would decide after the final word had been given,
      // which is not what "final" means.
      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'payment_release',
            isFinalAuthorityRequired: true,
            levels: [
              { position: 1, slotKey: SLOT_FINAL, isFinalAuthority: true },
              { position: 2, slotKey: SLOT_HR },
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/must be the last level/);
    });

    it('accepts a well-formed director-final chain', async () => {
      const prisma = createPrismaMock({
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue(chainRow([level(1, SLOT_FINAL)])),
        },
        roleSlotMapping: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.upsertChain(
          CTX,
          {
            companyId: COMPANY,
            actionType: 'payment_release',
            isFinalAuthorityRequired: true,
            levels: [
              { position: 1, slotKey: SLOT_FINAL, isFinalAuthority: true },
            ],
          },
          ACTOR,
        ),
      ).resolves.toBeDefined();
    });

    it('deactivates the existing active chain instead of editing it', async () => {
      const existing = chainRow([level(1, SLOT_HR)]);
      const prisma = createPrismaMock({
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(existing),
          update: jest.fn().mockResolvedValue({ ...existing, isActive: false }),
          create: jest
            .fn()
            .mockResolvedValue(
              chainRow([level(1, SLOT_FIRST_APPROVER), level(2, SLOT_HR)]),
            ),
          findMany: jest.fn().mockResolvedValue([]),
        },
        roleSlotMapping: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await service.upsertChain(
        CTX,
        {
          companyId: COMPANY,
          actionType: 'attendance_exception',
          levels: [
            { position: 1, slotKey: SLOT_FIRST_APPROVER },
            { position: 2, slotKey: SLOT_HR },
          ],
        },
        ACTOR,
      );

      // An in-flight item keeps the chain it entered — so superseding means a new row,
      // never a mutation of the levels an item is already part-way through.
      expect(prisma.tx.approvalChain.update).toHaveBeenCalledWith({
        where: { id: 'chain-1' },
        data: { isActive: false },
      });
      expect(prisma.tx.approvalChain.create).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'APPROVAL_CHAIN_CONFIG' }),
      );
    });
  });

  describe('configuration changes are audited (T053)', () => {
    it('records what a slot mapping was changed FROM, not only to', async () => {
      const prisma = createPrismaMock({
        approvalChain: { findMany: jest.fn().mockResolvedValue([]) },
        roleSlotMapping: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'm1',
            companyId: COMPANY,
            slotKey: SLOT_HR,
            roleId: 'role-old',
          }),
          findMany: jest.fn().mockResolvedValue([]),
          upsert: jest.fn().mockResolvedValue({
            id: 'm1',
            companyId: COMPANY,
            slotKey: SLOT_HR,
            roleId: 'role-new',
          }),
        },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await service.putSlotMapping(
        CTX,
        { companyId: COMPANY, slotKey: SLOT_HR, roleId: 'role-new' },
        ACTOR,
      );

      // Moving "HR" from one role to another changes who may approve every item on
      // every chain using that slot. After the upsert nothing in the database records
      // what it used to be, so the audit entry is the only place that answer survives.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'APPROVAL_CHAIN_CONFIG',
          changes: expect.objectContaining({
            slotKey: SLOT_HR,
            roleId: 'role-new',
            previousRoleId: 'role-old',
          }),
        }),
      );
    });

    it('does not claim to have superseded a chain when defining a first one', async () => {
      const prisma = createPrismaMock({
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue(chainRow([level(1, SLOT_HR)])),
        },
        roleSlotMapping: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await service.upsertChain(
        CTX,
        {
          companyId: COMPANY,
          actionType: 'attendance_exception',
          levels: [{ position: 1, slotKey: SLOT_HR }],
        },
        ACTOR,
      );

      // Previously hardcoded `true`, which recorded a supersession that never happened —
      // an audit trail that invents events is worse than one that omits them.
      expect(audit.record.mock.calls[0][0].changes.supersededChain).toBeNull();
    });

    it('records the chain it replaced, with the levels it had', async () => {
      const existing = chainRow([level(1, SLOT_HR), level(2, SLOT_FINAL)]);
      const prisma = createPrismaMock({
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(existing),
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(existing),
          create: jest.fn().mockResolvedValue(chainRow([level(1, SLOT_HR)])),
        },
        roleSlotMapping: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await service.upsertChain(
        CTX,
        {
          companyId: COMPANY,
          actionType: 'attendance_exception',
          levels: [{ position: 1, slotKey: SLOT_HR }],
        },
        ACTOR,
      );

      expect(audit.record.mock.calls[0][0].changes.supersededChain).toEqual({
        id: 'chain-1',
        levels: [
          { position: 1, slotKey: SLOT_HR },
          { position: 2, slotKey: SLOT_FINAL },
        ],
      });
    });

    it('audits a deactivation, which is the change most worth recording', async () => {
      const prisma = createPrismaMock({
        approvalChain: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'chain-1',
            companyId: COMPANY,
            actionType: 'payroll_run',
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await service.deactivateChain(CTX, 'chain-1', ACTOR);

      // Once a chain is off nothing of that action type can enter an approval at all,
      // and the symptom a week later is a module refusing to submit with no record of
      // who turned it off.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'APPROVAL_CHAIN_CONFIG',
          action: 'DELETE',
          entityId: 'chain-1',
          changes: { actionType: 'payroll_run', deactivated: true },
          accountId: ACTOR.userId,
        }),
      );
    });
  });

  describe('the unsatisfiable-chain guard (FR-021b, T009)', () => {
    it('refuses a slot mapping that makes two levels of an active chain resolve to one role, naming both', async () => {
      const prisma = createPrismaMock({
        approvalChain: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              chainRow([level(1, SLOT_FIRST_APPROVER), level(2, SLOT_HR)]),
            ]),
        },
        roleSlotMapping: {
          // `first_approver` is already bound to role-A.
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'm1',
              companyId: COMPANY,
              slotKey: SLOT_FIRST_APPROVER,
              roleId: 'role-A',
            },
          ]),
          upsert: jest.fn(),
        },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      // Binding `hr` to the same role would leave level 2 decidable only by somebody who
      // already decided at level 1 — which FR-021a forbids. Nothing would error; payroll
      // would simply stop.
      const attempt = service.putSlotMapping(
        CTX,
        { companyId: COMPANY, slotKey: SLOT_HR, roleId: 'role-A' },
        ACTOR,
      );

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toMatchObject({
        response: { code: APPROVAL_CHAIN_UNSATISFIABLE },
      });

      // Both conflicting levels must be named: "this conflicts" without saying with what
      // leaves an administrator diffing chain definitions by hand.
      const error = await attempt.catch((e) => e);
      expect(error.response.message).toContain('level 1');
      expect(error.response.message).toContain('level 2');
      expect(error.response.message).toContain('First approver');
      expect(error.response.message).toContain('HR');

      // And nothing was written.
      expect(prisma.tx.roleSlotMapping.upsert).not.toHaveBeenCalled();
    });

    it('checks the mapping table as it WOULD be, not as it is', async () => {
      // The conflict only exists once the proposed write lands: `hr` is currently
      // unmapped, so reading the current table alone would find nothing wrong.
      const prisma = createPrismaMock({
        approvalChain: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              chainRow([level(1, SLOT_HR), level(2, SLOT_FINAL)]),
            ]),
        },
        roleSlotMapping: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'm1',
              companyId: COMPANY,
              slotKey: SLOT_FINAL,
              roleId: 'role-super',
            },
          ]),
          upsert: jest.fn(),
        },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.putSlotMapping(
          CTX,
          { companyId: COMPANY, slotKey: SLOT_HR, roleId: 'role-super' },
          ACTOR,
        ),
      ).rejects.toMatchObject({
        response: { code: APPROVAL_CHAIN_UNSATISFIABLE },
      });
    });

    it('ignores unmapped levels, which are a different fault', async () => {
      // `final` unmapped is FR-001b's configuration fault, surfaced when somebody tries
      // to decide — not a reason to refuse an unrelated mapping now.
      const prisma = createPrismaMock({
        approvalChain: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              chainRow([level(1, SLOT_HR), level(2, SLOT_FINAL)]),
            ]),
        },
        roleSlotMapping: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          upsert: jest.fn().mockResolvedValue({
            id: 'm-new',
            companyId: COMPANY,
            slotKey: SLOT_HR,
            roleId: 'role-hr',
          }),
        },
      });
      const audit = auditMock();
      const service = new ChainsService(prisma as never, audit as never);

      await expect(
        service.putSlotMapping(
          CTX,
          { companyId: COMPANY, slotKey: SLOT_HR, roleId: 'role-hr' },
          ACTOR,
        ),
      ).resolves.toMatchObject({ slotKey: SLOT_HR, roleId: 'role-hr' });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'APPROVAL_CHAIN_CONFIG' }),
      );
    });

    it('permits two levels on the same role when the chain is inactive', async () => {
      // Only *active* chains are read: an inactive chain accepts no new items, so it
      // cannot stall anything, and refusing on its account would block a legitimate
      // mapping for the chain that replaced it.
      const prisma = createPrismaMock({
        approvalChain: { findMany: jest.fn().mockResolvedValue([]) },
        roleSlotMapping: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'm1',
              companyId: COMPANY,
              slotKey: SLOT_FIRST_APPROVER,
              roleId: 'role-A',
            },
          ]),
          upsert: jest.fn().mockResolvedValue({
            id: 'm2',
            companyId: COMPANY,
            slotKey: SLOT_HR,
            roleId: 'role-A',
          }),
        },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.putSlotMapping(
          CTX,
          { companyId: COMPANY, slotKey: SLOT_HR, roleId: 'role-A' },
          ACTOR,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('seeding a new company (T022)', () => {
    /**
     * **These assertions were reversed on 2026-10-04, and the old ones were passing.**
     *
     * The test this replaces was named "maps ONLY the final slot" and asserted exactly one
     * mapping, with a comment arguing that the other two slots were not guessable. The
     * argument was sound; its consequence had never been measured. Five of the twelve seeded
     * chains name those slots, so every company was created unable to approve a payroll run,
     * an attendance correction, an attendance exception or a fuel recovery — and both live
     * companies were in that state three weeks after the spine shipped.
     *
     * The client chose the two mappings on 2026-10-04. Recorded here because the old test
     * would have kept passing after the behaviour changed: it supplied only
     * `superAdminRoleId`, so the other slots resolved to nothing and were skipped for a
     * reason that had nothing to do with the policy it claimed to assert. It passed for the
     * wrong reason, which is the only kind of green worth coming back for.
     */
    const seedTx = () => ({
      approvalChain: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'chain-new' }),
      },
      roleSlotMapping: { upsert: jest.fn().mockResolvedValue({}) },
    });

    it('seeds the three-level shape and maps all three slots', async () => {
      const tx: Record<string, any> = seedTx();
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      await service.seedDefaultsForCompany(COMPANY, tx as never, {
        superAdminRoleId: 'role-super',
        slotRoleIds: {
          [SLOT_FIRST_APPROVER]: 'role-site',
          [SLOT_HR]: 'role-ho',
          [SLOT_FINAL]: 'role-ignored',
        },
      });

      const created = tx.approvalChain.create.mock.calls[0][0].data;
      expect(created.actionType).toBe('attendance_exception');
      expect(created.levels.create).toHaveLength(3);
      expect(
        created.levels.create.map((l: { slotKey: string }) => l.slotKey),
      ).toEqual([SLOT_FIRST_APPROVER, SLOT_HR, SLOT_FINAL]);

      const mapped = new Map<string, string>(
        tx.roleSlotMapping.upsert.mock.calls.map(
          (c: [{ create: { slotKey: string; roleId: string } }]) =>
            [c[0].create.slotKey, c[0].create.roleId] as [string, string],
        ),
      );
      expect([...mapped.keys()].sort()).toEqual(
        [SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR].sort(),
      );
      expect(mapped.get(SLOT_FIRST_APPROVER)).toBe('role-site');
      expect(mapped.get(SLOT_HR)).toBe('role-ho');
      // `superAdminRoleId` wins for `final`: the caller resolves it by the protected flag,
      // which is more reliable than resolving it by a name an administrator may have changed.
      expect(mapped.get(SLOT_FINAL)).toBe('role-super');
    });

    it('never overwrites a mapping a company already chose', async () => {
      const tx: Record<string, any> = seedTx();
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      await service.seedDefaultsForCompany(COMPANY, tx as never, {
        superAdminRoleId: 'role-super',
        slotRoleIds: { [SLOT_HR]: 'role-ho' },
      });

      // Every upsert is `update: {}`. This seeder is idempotent and may reach a company
      // configured by hand; a default that overwrote a deliberate mapping would silently
      // re-route a live chain, and the symptom would be an approval arriving at the wrong
      // desk rather than an error.
      expect(tx.roleSlotMapping.upsert.mock.calls.length).toBeGreaterThan(0);
      for (const call of tx.roleSlotMapping.upsert.mock.calls) {
        expect(call[0].update).toEqual({});
      }
    });

    it('skips a slot whose role could not be resolved, rather than failing', async () => {
      const tx: Record<string, any> = seedTx();
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      // What the caller passes when a default role has been renamed or deleted.
      await service.seedDefaultsForCompany(COMPANY, tx as never, {
        superAdminRoleId: 'role-super',
        slotRoleIds: { [SLOT_FIRST_APPROVER]: null, [SLOT_HR]: 'role-ho' },
      });

      const mapped = tx.roleSlotMapping.upsert.mock.calls.map(
        (c: [{ create: { slotKey: string } }]) => c[0].create.slotKey,
      );
      // A company that could not be created because somebody renamed a role would be a
      // worse outcome than one slot left to settings — which is what
      // `APPROVAL_SLOT_UNMAPPED` reports, and what every slot relied on before today.
      expect(mapped).not.toContain(SLOT_FIRST_APPROVER);
      expect(mapped).toContain(SLOT_HR);
      expect(tx.approvalChain.create).toHaveBeenCalled();
    });

    it('seeds no mapping at all when no role could be resolved for any slot', async () => {
      const tx: Record<string, any> = {
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        roleSlotMapping: { upsert: jest.fn() },
      };
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      await service.seedDefaultsForCompany(COMPANY, tx as never, {});
      expect(tx.approvalChain.create).toHaveBeenCalled();
      expect(tx.roleSlotMapping.upsert).not.toHaveBeenCalled();
    });

    it('seeds a director-only chain for each remaining FR-018 action type (T048)', async () => {
      const tx: Record<string, any> = {
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'chain-new' }),
        },
        roleSlotMapping: { upsert: jest.fn().mockResolvedValue({}) },
      };
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      await service.seedDefaultsForCompany(COMPANY, tx as never, {
        superAdminRoleId: 'role-super',
      });

      const created: Record<string, any>[] =
        tx.approvalChain.create.mock.calls.map(
          (c: [{ data: Record<string, any> }]) => c[0].data,
        );
      const byAction = new Map<string, Record<string, any>>(
        created.map((d) => [d.actionType as string, d]),
      );

      // Seeded although no module submits into them yet: without the chain, feature
      // 017's first work order is a configuration fault in every company at once.
      for (const actionType of DIRECTOR_FINAL_SEEDED_ACTIONS) {
        const chain = byAction.get(actionType);
        expect(chain).toBeDefined();
        expect(chain.isFinalAuthorityRequired).toBe(true);
        expect(chain.levels.create).toHaveLength(1);
        expect(chain.levels.create[0]).toMatchObject({
          slotKey: SLOT_FINAL,
          isFinalAuthority: true,
        });
      }

      // Payroll keeps its three levels — a one-level payroll chain would drop the Site
      // Incharge and HR levels the client asked for (Note 7).
      expect(byAction.get('payroll_run').levels.create).toHaveLength(3);
    });

    it('is idempotent — a company that already has the chain is left alone', async () => {
      const tx: Record<string, any> = {
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue({ id: 'chain-existing' }),
          create: jest.fn(),
        },
        roleSlotMapping: { upsert: jest.fn() },
      };
      const service = new ChainsService(
        createPrismaMock() as never,
        auditMock() as never,
      );

      await service.seedDefaultsForCompany(COMPANY, tx as never, {
        superAdminRoleId: 'role-super',
      });
      expect(tx.approvalChain.create).not.toHaveBeenCalled();
    });
  });

  describe('slot resolution (FR-001a)', () => {
    it('returns null for an unmapped slot rather than throwing', async () => {
      const prisma = createPrismaMock({
        roleSlotMapping: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(
        service.resolveSlot(CTX, COMPANY, SLOT_HR),
      ).resolves.toBeNull();
    });

    it('returns the mapped role id', async () => {
      const prisma = createPrismaMock({
        roleSlotMapping: {
          findUnique: jest.fn().mockResolvedValue({ roleId: 'role-hr' }),
        },
      });
      const service = new ChainsService(prisma as never, auditMock() as never);

      await expect(service.resolveSlot(CTX, COMPANY, SLOT_HR)).resolves.toBe(
        'role-hr',
      );
    });
  });
});
