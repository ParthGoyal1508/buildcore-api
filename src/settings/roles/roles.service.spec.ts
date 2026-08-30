import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Permission } from '@prisma/client';
import { RolesService } from './roles.service';
import { ASSIGNABLE_PERMISSIONS, CreateRoleDto } from './dto/create-role.dto';
import { callerFor } from '../testing/prisma-mock';

const protectedRole = { id: 'role-sa', name: 'Super Admin', isProtected: true };
const customRole = { id: 'role-x', name: 'Site Clerk', isProtected: false };

function build(
  roleDelegate: Record<string, jest.Mock>,
  users: Record<string, jest.Mock> = {},
) {
  const prisma = { role: roleDelegate };
  const auditLog = { record: jest.fn() };
  const usersService = {
    countByRoleId: jest.fn().mockResolvedValue(0),
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
        service.update(
          callerFor('company-1'),
          'role-sa',
          { name: 'Root' },
          '127.0.0.1',
        ),
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
        service.update(
          callerFor('company-1'),
          'role-x',
          { name: 'Viewer' },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
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
        callerFor('company-1'),
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
        service.remove(callerFor('company-1'), 'role-sa', '127.0.0.1'),
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

      const result = await service.remove(
        callerFor('company-1'),
        'role-x',
        '127.0.0.1',
      );

      expect(usersService.clearRoleAssignment).toHaveBeenCalledWith('role-x');
      expect(del).toHaveBeenCalledWith({ where: { id: 'role-x' } });
      expect(result).toEqual({ clearedAssignments: 4 });
    });

    it('404s on a role that does not exist', async () => {
      const { service } = build({
        findUnique: jest.fn().mockResolvedValue(null),
      });
      await expect(
        service.remove(callerFor('company-1'), 'nope', '127.0.0.1'),
      ).rejects.toBeInstanceOf(NotFoundException);
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

  it('does not let role editing grant CROSS_COMPANY_ACCESS', async () => {
    expect(ASSIGNABLE_PERMISSIONS).not.toContain(
      Permission.CROSS_COMPANY_ACCESS,
    );
    await expect(
      errorsFor([Permission.CROSS_COMPANY_ACCESS]),
    ).resolves.toContain('permissions');
  });
});
