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
    activeHolderCounts: jest.fn().mockResolvedValue(new Map()),
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

    it('adds the active holders in the caller’s company when there is a caller (036 C11)', async () => {
      const { service } = build(
        { findMany: jest.fn().mockResolvedValue([protectedRole, customRole]) },
        {
          activeHolderCounts: jest
            .fn()
            .mockResolvedValue(new Map([['role-sa', 2]])),
        },
      );
      const roles = await service.findAll({
        id: 'u',
        companyId: 'co',
        permissions: [],
      } as never);
      expect(roles.map((r) => r.activeHolderCount)).toEqual([2, 0]);
    });
  });

  describe('update', () => {
    it('refuses to edit the protected Super Admin role (FR-008)', async () => {
      const update = jest.fn();
      const { service } = build({
        findFirst: jest.fn().mockResolvedValue(protectedRole),
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
        findFirst: jest
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
        findFirst: jest.fn().mockResolvedValue(customRole),
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
        findFirst: jest.fn().mockResolvedValue(customRole),
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
        findFirst: jest.fn().mockResolvedValue(customRole),
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
        findFirst: jest.fn().mockResolvedValue(protectedRole),
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
        { findFirst: jest.fn().mockResolvedValue(customRole), delete: del },
        { clearRoleAssignment: jest.fn().mockResolvedValue(4) },
      );

      const result = await service.remove(admin, 'role-x', '127.0.0.1');

      expect(usersService.clearRoleAssignment).toHaveBeenCalledWith('role-x');
      expect(del).toHaveBeenCalledWith({ where: { id: 'role-x' } });
      expect(result).toEqual({ clearedAssignments: 4 });
    });

    it('404s on a role that does not exist', async () => {
      const { service } = build({
        findFirst: jest.fn().mockResolvedValue(null),
      });
      await expect(
        service.remove(admin, 'nope', '127.0.0.1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to delete the default role for new accounts (029 FR-001)', async () => {
      const del = jest.fn();
      const { service, usersService } = build({
        findFirst: jest.fn().mockResolvedValue({
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
        findFirst: jest.fn().mockResolvedValue(protectedRole),
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
        findFirst: jest.fn().mockResolvedValue(customRole),
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

describe('RolesService — company-scoped custom roles (036 C10)', () => {
  const companyAdmin = callerFor('company-1', {
    permissions: [Permission.USER_MANAGEMENT, Permission.DASHBOARD],
  });
  const groupAdmin = (selectedCompanyId: string | null) =>
    callerFor(null, {
      permissions: Object.values(Permission),
      selectedCompanyId,
    });
  const listDelegate = () => ({
    findMany: jest.fn().mockResolvedValue([]),
  });

  it('lists the global roles and the caller’s company’s own', async () => {
    const role = listDelegate();
    const { service } = build(role);
    await service.findAll(companyAdmin);
    expect(role.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ companyId: null }, { companyId: 'company-1' }],
    });
  });

  it('lists every company’s roles, with the company named, for a group admin with none selected', async () => {
    const role = {
      findMany: jest.fn().mockResolvedValue([
        {
          ...customRole,
          companyId: 'company-2',
          company: { name: 'Dummy Two Test Firm' },
          rolePermissions: [],
        },
      ]),
    };
    const { service } = build(role);
    const [listed] = await service.findAll(groupAdmin(null));
    expect(role.findMany.mock.calls[0][0].where).toEqual({});
    expect(listed.companyName).toBe('Dummy Two Test Firm');
  });

  it('scopes a group admin who has selected a company to it', async () => {
    const role = listDelegate();
    const { service } = build(role);
    await service.findAll(groupAdmin('company-2'));
    expect(role.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ companyId: null }, { companyId: 'company-2' }],
    });
  });

  it('creates the role in the caller’s company, checking names only there and globally', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockResolvedValue({ id: 'r-new' });
    const { service } = build({ findFirst, create });
    await service.create(
      companyAdmin,
      { name: 'Site Clerk', permissions: [Permission.DASHBOARD] },
      '127.0.0.1',
    );
    expect(findFirst.mock.calls[0][0].where).toEqual({
      name: 'Site Clerk',
      OR: [{ companyId: null }, { companyId: 'company-1' }],
    });
    expect(create.mock.calls[0][0].data.companyId).toBe('company-1');
  });

  it('creates a global role for a group admin with no company selected', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockResolvedValue({ id: 'r-new' });
    const { service } = build({ findFirst, create });
    await service.create(
      groupAdmin(null),
      { name: 'Group Auditor', permissions: [Permission.DASHBOARD] },
      '127.0.0.1',
    );
    // A global name must be free everywhere.
    expect(findFirst.mock.calls[0][0].where).toEqual({ name: 'Group Auditor' });
    expect(create.mock.calls[0][0].data.companyId).toBeNull();
  });

  it('refuses a duplicate with 409 ROLE_NAME_TAKEN', async () => {
    const { service } = build({
      findFirst: jest.fn().mockResolvedValue({ id: 'r-other' }),
      create: jest.fn(),
    });
    await expect(
      service.create(
        companyAdmin,
        { name: 'Viewer', permissions: [Permission.DASHBOARD] },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ROLE_NAME_TAKEN' }),
    });
  });

  it('treats another company’s role as not found', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = build({ findFirst, update: jest.fn() });
    await expect(
      service.update(companyAdmin, 'role-of-company-2', { name: 'X' }, 'ip'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'role-of-company-2',
      OR: [{ companyId: null }, { companyId: 'company-1' }],
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
        findFirst: jest.fn().mockResolvedValue(null),
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
          findFirst: jest.fn().mockResolvedValue(customRole),
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
