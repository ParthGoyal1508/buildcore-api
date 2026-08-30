import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { UsersAdminService } from './users-admin.service';
import { callerFor } from '../testing/prisma-mock';

const superAdmin = callerFor('company-1', { roleNames: ['Super Admin'] });
const hoUser = callerFor('company-1', { roleNames: ['HO User'] });
const siteEngineer = callerFor('company-1', { roleNames: ['Site Engineer'] });

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
  describe('access control (FR-014)', () => {
    it.each([
      ['Super Admin', superAdmin],
      ['HO User', hoUser],
    ])('allows a %s', async (_label, caller) => {
      const { service } = build();
      await expect(service.findAll(caller)).resolves.toEqual([]);
    });

    it('rejects any other role, even one holding USER_MANAGEMENT', async () => {
      const { service } = build();
      await expect(service.findAll(siteEngineer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
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
