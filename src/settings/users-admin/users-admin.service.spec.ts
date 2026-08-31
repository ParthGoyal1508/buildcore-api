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
  permissions: [Permission.USER_MANAGEMENT],
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
    updateRoleOrStatus: jest.fn().mockResolvedValue({ companyId: 'company-1' }),
    deleteAccount: jest.fn().mockResolvedValue(undefined),
    holdsProtectedRole: jest.fn().mockResolvedValue(false),
    countActiveSuperAdmins: jest.fn().mockResolvedValue(5),
    ...users,
  };
  const auditLog = { record: jest.fn() };
  const service = new UsersAdminService(
    usersService as never,
    auditLog as never,
  );
  return { service, usersService, auditLog };
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
});
