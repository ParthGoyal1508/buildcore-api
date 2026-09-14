import { BadRequestException } from '@nestjs/common';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { APPROVAL_CHAIN_UNSATISFIABLE } from './approval-error-codes';
import { SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR } from './approval-slots';
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
    it('seeds the three-level shape but maps ONLY the final slot', async () => {
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

      const created = tx.approvalChain.create.mock.calls[0][0].data;
      expect(created.actionType).toBe('attendance_exception');
      expect(created.levels.create).toHaveLength(3);
      expect(
        created.levels.create.map((l: { slotKey: string }) => l.slotKey),
      ).toEqual([SLOT_FIRST_APPROVER, SLOT_HR, SLOT_FINAL]);

      // Exactly one mapping, and it is `final`. The other two are NOT guessable —
      // neither "HR Office" nor "Site Incharge" exists as a role, which is the whole
      // reason slots exist. Inventing a mapping would hand the right to approve
      // attendance to whichever role sounded closest.
      expect(tx.roleSlotMapping.upsert).toHaveBeenCalledTimes(1);
      expect(tx.roleSlotMapping.upsert.mock.calls[0][0].create).toMatchObject({
        slotKey: SLOT_FINAL,
        roleId: 'role-super',
      });
    });

    it('seeds no mapping at all when there is no Super Admin role to point at', async () => {
      const tx: Record<string, any> = {
        approvalChain: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'chain-new' }),
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
