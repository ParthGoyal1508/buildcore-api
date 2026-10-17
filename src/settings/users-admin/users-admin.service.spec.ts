import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UserStatus, Permission } from '@prisma/client';
import { UsersAdminService } from './users-admin.service';
import { callerFor } from '../testing/prisma-mock';

// Account administration is gated on the USER_MANAGEMENT permission rather than on
// role names (FR-014, amended 2026-08-31), so these fixtures carry the permission
// their real seeded counterparts hold. `roleNames` stays because FR-016's
// last-Super-Admin guard still reasons about which role an account holds.
const superAdmin = callerFor('company-1', {
  roleNames: ['Super Admin'],
  // A real Super Admin holds cross-company access, which is what lets them act on another
  // protected-role holder (036 C3).
  permissions: [Permission.USER_MANAGEMENT, Permission.CROSS_COMPANY_ACCESS],
});
const hoUser = callerFor('company-1', {
  roleNames: ['HO User'],
  permissions: [Permission.USER_MANAGEMENT],
});
/** Holds neither the permission nor an administrative role. */
const siteEngineer = callerFor('company-1', {
  roleNames: ['Site Engineer'],
  permissions: [Permission.MY_WORKSPACE],
});
/** The case the old role-name check wrongly refused: a custom role created through
 * this very feature and granted the permission. */
const customAdmin = callerFor('company-1', {
  roleNames: ['Regional Administrator'],
  permissions: [Permission.USER_MANAGEMENT],
});

function build(users: Record<string, jest.Mock> = {}) {
  const usersService = {
    findAllForCompany: jest.fn().mockResolvedValue([]),
    listForCompany: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    updateRoleOrStatus: jest.fn().mockResolvedValue({ companyId: 'company-1' }),
    deleteAccount: jest.fn().mockResolvedValue(undefined),
    holdsProtectedRole: jest.fn().mockResolvedValue(false),
    countActiveSuperAdmins: jest.fn().mockResolvedValue(5),
    accountStatus: jest.fn().mockResolvedValue({
      status: UserStatus.active,
      email: 'u@example.test',
    }),
    // The viewer role these fixtures assign grants nothing beyond what every caller holds.
    grantsOfRole: jest.fn().mockResolvedValue([]),
    // 036 C1: the account's current roles, diffed against the requested set. None by default,
    // so a `roleId` adds and removes nothing.
    roleIdsOf: jest.fn().mockResolvedValue([]),
    protectedRoleIds: jest.fn(async (ids: string[]) =>
      ids.filter((id) => id.startsWith('role-super')),
    ),
    ...users,
  };
  const auditLog = { record: jest.fn() };
  const deactivation = { afterDeactivation: jest.fn() };
  const service = new UsersAdminService(
    usersService as never,
    auditLog as never,
    deactivation as never,
  );
  return { service, usersService, auditLog, deactivation };
}

describe('UsersAdminService', () => {
  describe('access control (FR-014, amended 2026-08-31)', () => {
    it.each([
      ['Super Admin', superAdmin],
      ['HO User', hoUser],
    ])(
      'allows the seeded %s, which carries USER_MANAGEMENT',
      async (_l, caller) => {
        const { service } = build();
        await expect(service.findAll(caller)).resolves.toEqual([]);
      },
    );

    it('allows a custom role granted USER_MANAGEMENT', async () => {
      // The case the previous role-name check refused. This feature lets an
      // administrator create such a role, so refusing it meant the controller's
      // permission guard and this service disagreed about the same request.
      const { service } = build();
      await expect(service.findAll(customAdmin)).resolves.toEqual([]);
    });

    it('rejects a caller without USER_MANAGEMENT', async () => {
      const { service } = build();
      await expect(service.findAll(siteEngineer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('does not depend on the role being named a particular thing', async () => {
      // `HO User` is not a protected role, so 002's own role editor can rename it.
      // Under the old check that silently stripped account administration from
      // every holder while their permissions were untouched.
      const renamed = callerFor('company-1', {
        roleNames: ['Head Office Staff'],
        permissions: [Permission.USER_MANAGEMENT],
      });
      const { service } = build();
      await expect(service.findAll(renamed)).resolves.toEqual([]);
    });
  });

  describe('last-Super-Admin-standing guard (FR-016)', () => {
    it('refuses to deactivate the last active Super Admin', async () => {
      const { service, usersService } = build({
        holdsProtectedRole: jest.fn().mockResolvedValue(true),
        countActiveSuperAdmins: jest.fn().mockResolvedValue(1),
      });

      await expect(
        service.update(
          superAdmin,
          'user-1',
          { status: UserStatus.deactivated },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.updateRoleOrStatus).not.toHaveBeenCalled();
    });

    it('refuses to reassign the last active Super Admin away', async () => {
      const { service, usersService } = build({
        holdsProtectedRole: jest.fn().mockResolvedValue(true),
        countActiveSuperAdmins: jest.fn().mockResolvedValue(1),
        roleIdsOf: jest.fn().mockResolvedValue(['role-super']),
      });

      await expect(
        service.update(
          superAdmin,
          'user-1',
          { roleId: 'role-viewer' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.updateRoleOrStatus).not.toHaveBeenCalled();
    });

    it('refuses to delete the last active Super Admin', async () => {
      const { service, usersService } = build({
        holdsProtectedRole: jest.fn().mockResolvedValue(true),
        countActiveSuperAdmins: jest.fn().mockResolvedValue(1),
      });

      await expect(
        service.remove(superAdmin, 'user-1', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.deleteAccount).not.toHaveBeenCalled();
    });

    it('allows the same operations while another active Super Admin remains', async () => {
      const { service, usersService } = build({
        holdsProtectedRole: jest.fn().mockResolvedValue(true),
        countActiveSuperAdmins: jest.fn().mockResolvedValue(2),
      });

      await service.update(
        superAdmin,
        'user-1',
        { status: UserStatus.deactivated },
        '127.0.0.1',
      );
      await service.remove(superAdmin, 'user-1', '127.0.0.1');

      expect(usersService.updateRoleOrStatus).toHaveBeenCalled();
      expect(usersService.deleteAccount).toHaveBeenCalled();
    });

    it('does not consult the count for an account holding no protected role', async () => {
      const { service, usersService } = build({
        holdsProtectedRole: jest.fn().mockResolvedValue(false),
      });

      await service.remove(superAdmin, 'user-2', '127.0.0.1');

      expect(usersService.countActiveSuperAdmins).not.toHaveBeenCalled();
      expect(usersService.deleteAccount).toHaveBeenCalled();
    });

    it('leaves a plain status activation unguarded', async () => {
      const { service, usersService } = build();
      await service.update(
        superAdmin,
        'user-2',
        { status: UserStatus.active },
        '127.0.0.1',
      );
      expect(usersService.holdsProtectedRole).not.toHaveBeenCalled();
      expect(usersService.updateRoleOrStatus).toHaveBeenCalled();
    });
  });

  it('audits updates and deletes under the shared USER_ACCOUNT entity type', async () => {
    const { service, auditLog } = build();

    await service.update(
      superAdmin,
      'user-2',
      { roleId: 'role-viewer' },
      '10.0.0.1',
    );
    await service.remove(superAdmin, 'user-3', '10.0.0.1');

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'USER_ACCOUNT', action: 'UPDATE' }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'USER_ACCOUNT', action: 'DELETE' }),
    );
  });

  describe('deactivation follow-up (029 FR-030)', () => {
    it('revokes sessions and notifies the holder when an active account is deactivated', async () => {
      const { service, deactivation } = build();
      await service.update(
        superAdmin,
        'user-1',
        { status: UserStatus.deactivated },
        '127.0.0.1',
      );
      expect(deactivation.afterDeactivation).toHaveBeenCalledWith({
        id: 'user-1',
        email: 'u@example.test',
      });
    });

    it('does nothing more when the account was already deactivated', async () => {
      const { service, deactivation } = build({
        accountStatus: jest.fn().mockResolvedValue({
          status: UserStatus.deactivated,
          email: 'u@example.test',
        }),
      });
      await service.update(
        superAdmin,
        'user-1',
        { status: UserStatus.deactivated },
        '127.0.0.1',
      );
      expect(deactivation.afterDeactivation).not.toHaveBeenCalled();
    });

    it('does nothing more on a role-only change', async () => {
      const { service, deactivation, usersService } = build();
      await service.update(
        superAdmin,
        'user-1',
        { roleId: 'role-x' },
        '127.0.0.1',
      );
      expect(usersService.accountStatus).not.toHaveBeenCalled();
      expect(deactivation.afterDeactivation).not.toHaveBeenCalled();
    });
  });

  // 2026-10-16 access-control audit, C1.
  describe('role assignment ceiling', () => {
    it('refuses a role carrying a permission the caller does not hold', async () => {
      const { service, usersService } = build({
        grantsOfRole: jest
          .fn()
          .mockResolvedValue([
            { permission: Permission.CROSS_COMPANY_ACCESS, level: 'read' },
          ]),
      });
      await expect(
        service.update(hoUser, 'user-2', { roleId: 'role-super' }, '127.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(usersService.updateRoleOrStatus).not.toHaveBeenCalled();
    });

    it('refuses a change to the caller’s own role', async () => {
      const { service, usersService } = build();
      await expect(
        service.update(
          hoUser,
          'caller-1', // hoUser's own id (callerFor)
          { roleId: 'role-viewer' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(usersService.updateRoleOrStatus).not.toHaveBeenCalled();
    });

    it('allows a role within what the caller holds', async () => {
      const { service, usersService } = build({
        grantsOfRole: jest.fn().mockResolvedValue([
          { permission: Permission.USER_MANAGEMENT, level: 'write' },
          { permission: Permission.MY_WORKSPACE, level: 'read' },
        ]),
      });
      await service.update(
        hoUser,
        'user-2',
        { roleId: 'role-admin' },
        '127.0.0.1',
      );
      expect(usersService.updateRoleOrStatus).toHaveBeenCalled();
    });
  });
});

describe('who an administrator may act on (036 C3)', () => {
  it.each([
    ['delete', (s: UsersAdminService) => s.remove(hoUser, 'caller-1', 'ip')],
    [
      'deactivate',
      (s: UsersAdminService) =>
        s.update(hoUser, 'caller-1', { status: UserStatus.deactivated }, 'ip'),
    ],
  ])(
    'refuses to let an administrator %s their own account',
    async (_l, act) => {
      const { service, usersService } = build();
      const error = await act(service).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.response.code).toBe('OWN_ACCOUNT');
      expect(usersService.deleteAccount).not.toHaveBeenCalled();
      expect(usersService.updateRoleOrStatus).not.toHaveBeenCalled();
    },
  );

  it('refuses a company administrator acting on a Super Admin', async () => {
    const { service, usersService } = build({
      holdsProtectedRole: jest.fn().mockResolvedValue(true),
    });
    const error = await service.remove(hoUser, 'super-1', 'ip').catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.response.code).toBe('PROTECTED_ACCOUNT');
    expect(usersService.deleteAccount).not.toHaveBeenCalled();
  });

  it('lets a group administrator act on another Super Admin', async () => {
    const { service, usersService } = build({
      holdsProtectedRole: jest.fn().mockResolvedValue(true),
    });
    await service.remove(superAdmin, 'super-2', 'ip');
    expect(usersService.deleteAccount).toHaveBeenCalled();
  });
});

// 036 C1/C2: the Users form edits the whole role set, and the server diffs it.
describe('role set changes (036 C1)', () => {
  it('adds a role without removing the ones already held', async () => {
    const { service, usersService, auditLog } = build({
      roleIdsOf: jest.fn().mockResolvedValue(['role-a']),
    });
    await service.update(
      hoUser,
      'user-2',
      { roleIds: ['role-a', 'role-b'] },
      'ip',
    );
    expect(usersService.updateRoleOrStatus).toHaveBeenCalledWith(
      'user-2',
      { roleIds: ['role-a', 'role-b'], status: undefined },
      expect.anything(),
    );
    // Only the added role is checked against the caller's ceiling.
    expect(usersService.grantsOfRole).toHaveBeenCalledTimes(1);
    expect(usersService.grantsOfRole).toHaveBeenCalledWith('role-b');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          rolesAdded: ['role-b'],
          rolesRemoved: [],
        }),
      }),
    );
  });

  it('does not re-check a wide role the account already holds', async () => {
    const { service, usersService } = build({
      roleIdsOf: jest.fn().mockResolvedValue(['role-wide']),
      grantsOfRole: jest.fn(async (id: string) =>
        id === 'role-wide'
          ? [{ permission: Permission.CROSS_COMPANY_ACCESS, level: 'read' }]
          : [],
      ),
    });
    await service.update(
      hoUser,
      'user-2',
      { roleIds: ['role-wide', 'role-small'] },
      'ip',
    );
    expect(usersService.updateRoleOrStatus).toHaveBeenCalled();
  });

  it('writes nothing about roles when the set is unchanged, even for the caller', async () => {
    const { service, usersService } = build({
      roleIdsOf: jest.fn().mockResolvedValue(['role-a']),
    });
    await service.update(
      hoUser,
      'caller-1',
      { roleIds: ['role-a'], status: UserStatus.active },
      'ip',
    );
    expect(usersService.updateRoleOrStatus).toHaveBeenCalledWith(
      'caller-1',
      { roleIds: undefined, status: UserStatus.active },
      expect.anything(),
    );
  });

  it('keeps a Super Admin who gains a second role out of the last-admin guard', async () => {
    const { service, usersService } = build({
      roleIdsOf: jest.fn().mockResolvedValue(['role-super']),
      holdsProtectedRole: jest.fn().mockResolvedValue(true),
      countActiveSuperAdmins: jest.fn().mockResolvedValue(1),
    });
    await service.update(
      superAdmin,
      'user-1',
      { roleIds: ['role-super', 'role-a'] },
      'ip',
    );
    expect(usersService.countActiveSuperAdmins).not.toHaveBeenCalled();
    expect(usersService.updateRoleOrStatus).toHaveBeenCalled();
  });
});

describe('listing accounts (036 C5)', () => {
  it('answers the bare array when no page is asked for', async () => {
    const { service, usersService } = build();
    await expect(service.findAll(hoUser, { q: 'ravi' })).resolves.toEqual([]);
    expect(usersService.listForCompany).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ take: expect.anything() }),
    );
  });

  it('answers a page with its total when one is asked for', async () => {
    const { service, usersService } = build({
      listForCompany: jest.fn().mockResolvedValue({ items: [], total: 42 }),
    });
    await expect(
      service.findAll(hoUser, { page: 2, pageSize: 10, sort: 'name:desc' }),
    ).resolves.toEqual({ items: [], total: 42, page: 2, pageSize: 10 });
    expect(usersService.listForCompany).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        skip: 10,
        take: 10,
        sort: { key: 'name', dir: 'desc' },
      }),
    );
  });
});
