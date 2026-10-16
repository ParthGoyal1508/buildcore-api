import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AccessLevel, Permission } from '@prisma/client';
import { RolesService } from './roles.service';
import { ASSIGNABLE_PERMISSIONS, CreateRoleDto } from './dto/create-role.dto';
import { callerFor } from '../testing/prisma-mock';

/** Holds everything, so the 2026-10-16 grant ceiling never refuses the behaviour under test. */
const admin = callerFor('company-1', {
  permissions: Object.values(Permission),
});

const protectedRole = { id: 'role-sa', name: 'Super Admin', isProtected: true };
const customRole = { id: 'role-x', name: 'Site Clerk', isProtected: false };

function build(
  roleDelegate: Record<string, jest.Mock>,
  users: Record<string, jest.Mock> = {},
) {
  const prisma = {
    role: roleDelegate,
    // 019 FR-017b: `update` reads the role's grants before replacing them, so the cash-entry
    // audit entry can say what changed. Empty by default — a role holding no cash entry before
    // or after produces no entry, which is what every existing test here expects.
    rolePermission: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const auditLog = { record: jest.fn() };
  const usersService = {
    countByRoleId: jest.fn().mockResolvedValue(0),
    countRoleHoldersOutside: jest.fn().mockResolvedValue(0),
    clearRoleAssignment: jest.fn().mockResolvedValue(0),
    ...users,
  };
  const service = new RolesService(
    prisma as never,
    auditLog as never,
    usersService as never,
  );
  return { service, prisma, auditLog, usersService };
}

describe('RolesService', () => {
  /**
   * The gap found 2026-10-03, and the reason a read-only role could not be created from the portal.
   *
   * The write side has accepted levels since Phase 1 and the guard has enforced them since — but no
   * read returned them, so the role screen had nothing to render and sent `permissions` alone,
   * which means read **and** write on everything. Item 19's own example — site staff who may enter
   * logbook readings and see nothing else of machinery — was unreachable through the interface.
   */
  describe('grants are readable, not only writable (019 FR-001)', () => {
    it('returns each area with the level it is granted at', async () => {
      const { service } = build({
        findMany: jest.fn().mockResolvedValue([
          {
            ...customRole,
            rolePermissions: [
              { permission: Permission.MACHINERY, level: AccessLevel.read },
              { permission: Permission.MACHINERY, level: AccessLevel.write },
              { permission: Permission.ATTENDANCE, level: AccessLevel.read },
            ],
          },
        ]),
      });

      const [role] = await service.findAll();

      expect(role.grants).toEqual([
        { permission: Permission.MACHINERY, level: AccessLevel.read },
        { permission: Permission.MACHINERY, level: AccessLevel.write },
        { permission: Permission.ATTENDANCE, level: AccessLevel.read },
      ]);
    });

    /**
     * Read-only on an area is the whole point, and it has to be *distinguishable* from read+write
     * in the response — otherwise a screen rendering the role has no way to show it, and saving
     * from that screen silently widens it back to write.
     */
    it('distinguishes a read-only area from one granted at both levels', async () => {
      const { service } = build({
        findMany: jest.fn().mockResolvedValue([
          {
            ...customRole,
            rolePermissions: [
              { permission: Permission.MACHINERY, level: AccessLevel.read },
            ],
          },
        ]),
      });

      const [role] = await service.findAll();

      expect(role.grants).toHaveLength(1);
      expect(
        role.grants.some((grant) => grant.level === AccessLevel.write),
      ).toBe(false);
    });

    it('does not leak the join rows themselves into the response', async () => {
      const { service } = build({
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...customRole, rolePermissions: [] }]),
      });

      const [role] = await service.findAll();

      expect(role).not.toHaveProperty('rolePermissions');
      expect(role.grants).toEqual([]);
    });
  });

  describe('findAll', () => {
    it("attaches each role's assigned-user count (FR-009)", async () => {
      const { service, usersService } = build(
        { findMany: jest.fn().mockResolvedValue([protectedRole, customRole]) },
        {
          countByRoleId: jest
            .fn()
            .mockImplementation(async (id: string) =>
              id === 'role-sa' ? 3 : 1,
            ),
        },
      );

      const roles = await service.findAll();

      expect(roles.map((r) => [r.name, r.assignedUserCount])).toEqual([
        ['Super Admin', 3],
        ['Site Clerk', 1],
      ]);
      // Counted through UsersService, never a cross-schema join (Principle I).
      expect(usersService.countByRoleId).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('refuses to edit the protected Super Admin role (FR-008)', async () => {
      const update = jest.fn();
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(protectedRole),
        update,
      });

      await expect(
        service.update(admin, 'role-sa', { name: 'Root' }, '127.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Rejected before touching the database, regardless of caller.
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects a rename onto an existing role name', async () => {
      const { service } = build({
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(customRole)
          .mockResolvedValueOnce({ id: 'other', name: 'Viewer' }),
        update: jest.fn(),
      });

      await expect(
        service.update(admin, 'role-x', { name: 'Viewer' }, '127.0.0.1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    /**
     * 019 FR-017b, task T080. Granting somebody the right to take cash is at least as
     * consequential as hiding the figures, and FR-012 requires an explicit record for the
     * second — so finding the first should not mean diffing two thirty-element permission
     * arrays across every role edit in the log.
     */
    it('records a separate audit entry when cash entry is granted', async () => {
      const { service, auditLog } = build({
        findUnique: jest.fn().mockResolvedValue(customRole),
        update: jest.fn().mockResolvedValue(customRole),
      });

      await service.update(
        admin,
        'role-x',
        {
          permissions: [Permission.CASH_ENTRY],
          grants: [
            { permission: Permission.CASH_ENTRY, level: AccessLevel.read },
            { permission: Permission.CASH_ENTRY, level: AccessLevel.write },
          ],
        },
        '127.0.0.1',
      );

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'role-x',
          accountId: 'caller-1',
          // Spelled out, because `write` and `read` are different rights here — recording cash
          // and seeing a denomination breakup — and "cash entry changed" would not say which.
          changes: { cashEntry: { before: null, after: 'read,write' } },
        }),
      );
    });

    it('records nothing extra when cash entry did not change', async () => {
      // An audit entry on every role edit that merely *mentions* cash entry would bury the
      // handful that changed it.
      const { service, auditLog } = build({
        findUnique: jest.fn().mockResolvedValue(customRole),
        update: jest.fn().mockResolvedValue(customRole),
      });

      await service.update(
        admin,
        'role-x',
        { permissions: [Permission.DASHBOARD] },
        '127.0.0.1',
      );

      const cashEntries = auditLog.record.mock.calls.filter(
        (call) =>
          (call[0] as { changes?: { cashEntry?: unknown } }).changes
            ?.cashEntry !== undefined,
      );
      expect(cashEntries).toEqual([]);
    });

    it('edits a non-protected role', async () => {
      const update = jest.fn().mockResolvedValue({
        ...customRole,
        permissions: [Permission.DASHBOARD],
      });
      const { service, auditLog } = build({
        findUnique: jest.fn().mockResolvedValue(customRole),
        update,
      });

      const result = await service.update(
        admin,
        'role-x',
        { permissions: [Permission.DASHBOARD] },
        '127.0.0.1',
      );

      expect(update).toHaveBeenCalled();
      expect(result.assignedUserCount).toBe(0);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'ROLE',
          action: 'UPDATE',
          entityId: 'role-x',
        }),
      );
    });
  });

  describe('remove', () => {
    it('refuses to delete the protected role (FR-008)', async () => {
      const del = jest.fn();
      const { service, usersService } = build({
        findUnique: jest.fn().mockResolvedValue(protectedRole),
        delete: del,
      });

      await expect(
        service.remove(admin, 'role-sa', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(del).not.toHaveBeenCalled();
      expect(usersService.clearRoleAssignment).not.toHaveBeenCalled();
    });

    it('clears the role from its holders before deleting it (FR-010)', async () => {
      const del = jest.fn();
      const { service, usersService } = build(
        { findUnique: jest.fn().mockResolvedValue(customRole), delete: del },
        { clearRoleAssignment: jest.fn().mockResolvedValue(4) },
      );

      const result = await service.remove(admin, 'role-x', '127.0.0.1');

      expect(usersService.clearRoleAssignment).toHaveBeenCalledWith('role-x');
      expect(del).toHaveBeenCalledWith({ where: { id: 'role-x' } });
      expect(result).toEqual({ clearedAssignments: 4 });
    });

    it('404s on a role that does not exist', async () => {
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(null),
      });
      await expect(
        service.remove(admin, 'nope', '127.0.0.1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to delete the default role for new accounts (029 FR-001)', async () => {
      const del = jest.fn();
      const { service, usersService } = build({
        findUnique: jest.fn().mockResolvedValue({
          ...customRole,
          name: 'General User',
          isDefault: true,
        }),
        delete: del,
      });
      await expect(
        service.remove(callerFor('company-1'), 'role-x', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(del).not.toHaveBeenCalled();
      expect(usersService.clearRoleAssignment).not.toHaveBeenCalled();
    });
  });

  describe('home page (029 FR-020)', () => {
    it('lets the protected role change its home page and nothing else', async () => {
      const update = jest
        .fn()
        .mockResolvedValue({ ...protectedRole, homeModule: 'dashboard' });
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(protectedRole),
        update,
      });
      await service.update(
        callerFor('company-1'),
        'role-sa',
        { homeModule: 'dashboard' },
        '127.0.0.1',
      );
      expect(update).toHaveBeenCalledWith({
        where: { id: 'role-sa' },
        data: { homeModule: 'dashboard' },
      });

      await expect(
        service.update(
          callerFor('company-1'),
          'role-sa',
          { homeModule: 'dashboard', name: 'Root' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('clears the home page when sent null', async () => {
      const update = jest.fn().mockResolvedValue(customRole);
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(customRole),
        update,
      });
      await service.update(
        callerFor('company-1'),
        'role-x',
        { homeModule: null },
        '127.0.0.1',
      );
      expect(update).toHaveBeenCalledWith({
        where: { id: 'role-x' },
        data: { homeModule: null },
      });
    });
  });
});

describe('CreateRoleDto validation (FR-007)', () => {
  const errorsFor = async (permissions: unknown[]) => {
    const dto = plainToInstance(CreateRoleDto, { name: 'Custom', permissions });
    return (await validate(dto)).map((e) => e.property);
  };

  it('accepts values from the enum', async () => {
    await expect(
      errorsFor([Permission.DASHBOARD, Permission.REPORTS]),
    ).resolves.toEqual([]);
  });

  it('rejects a value outside the enum', async () => {
    await expect(errorsFor(['NOT_A_PERMISSION'])).resolves.toContain(
      'permissions',
    );
  });

  it('rejects duplicates', async () => {
    await expect(
      errorsFor([Permission.DASHBOARD, Permission.DASHBOARD]),
    ).resolves.toContain('permissions');
  });

  it('accepts a known home module, null, or none — and nothing else (029 FR-020)', async () => {
    const errorsWith = async (homeModule: unknown) =>
      (
        await validate(
          plainToInstance(CreateRoleDto, {
            name: 'Custom',
            permissions: [],
            homeModule,
          }),
        )
      ).map((e) => e.property);
    await expect(errorsWith('my-workspace')).resolves.toEqual([]);
    await expect(errorsWith(null)).resolves.toEqual([]);
    await expect(errorsWith(undefined)).resolves.toEqual([]);
    await expect(errorsWith('https://evil.example')).resolves.toContain(
      'homeModule',
    );
  });

  it('does not let role editing grant CROSS_COMPANY_ACCESS', async () => {
    expect(ASSIGNABLE_PERMISSIONS).not.toContain(
      Permission.CROSS_COMPANY_ACCESS,
    );
    await expect(
      errorsFor([Permission.CROSS_COMPANY_ACCESS]),
    ).resolves.toContain('permissions');
  });

  // 2026-10-16 access-control audit, C3.
  describe('grant ceiling', () => {
    const companyAdmin = callerFor('company-1', {
      permissions: [Permission.USER_MANAGEMENT, Permission.DASHBOARD],
    });

    it('refuses to create a role granting more than its author holds', async () => {
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      });
      await expect(
        service.create(
          companyAdmin,
          { name: 'Escalator', permissions: [Permission.COMPANY_SETTINGS] },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a company administrator editing a role held in other companies', async () => {
      const { service } = build(
        {
          findUnique: jest.fn().mockResolvedValue(customRole),
          update: jest.fn(),
        },
        { countRoleHoldersOutside: jest.fn().mockResolvedValue(3) },
      );
      await expect(
        service.update(
          companyAdmin,
          'role-x',
          { name: 'Renamed' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
