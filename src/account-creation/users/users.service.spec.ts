import { BadRequestException, ConflictException } from '@nestjs/common';
import { Permission, UserStatus } from '@prisma/client';
import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { TokenService } from '../invites/token.service';
import { AdminCaller, UsersService } from './users.service';

interface TestRole {
  id: string;
  name: string;
  permissions: Permission[];
}

const CROSS_COMPANY_ROLE: TestRole = {
  id: 'role-sa',
  name: 'Super Admin',
  permissions: [Permission.CROSS_COMPANY_ACCESS],
};
const SCOPED_ROLE: TestRole = {
  id: 'role-eng',
  name: 'Site Engineer',
  permissions: [Permission.MY_WORKSPACE],
};

describe('UsersService', () => {
  const caller: AdminCaller = {
    userId: 'admin-1',
    companyId: 'co-1',
    ipAddress: '127.0.0.1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
  };

  let email: { sendInviteEmail: jest.Mock; sendAccountLockedEmail: jest.Mock };
  let employees: { linkEmployeeToUser: jest.Mock; getByUserIds: jest.Mock };

  const build = (
    opts: {
      role?: TestRole | null;
      existingUser?: { status: UserStatus } | null;
      userById?: { id: string; status: UserStatus; companyId: string } | null;
    } = {},
  ) => {
    const { role = SCOPED_ROLE, existingUser = null, userById = null } = opts;

    email = {
      sendInviteEmail: jest.fn().mockResolvedValue(undefined),
      sendAccountLockedEmail: jest.fn().mockResolvedValue(undefined),
    };
    employees = {
      linkEmployeeToUser: jest.fn().mockResolvedValue(undefined),
      getByUserIds: jest.fn().mockResolvedValue(new Map()),
    };

    const prisma = createPrismaMock({
      role: { findUnique: jest.fn().mockResolvedValue(role) },
      user: {
        findUnique: jest.fn().mockResolvedValue(existingUser),
        findFirst: jest.fn().mockResolvedValue(userById),
        create: jest.fn().mockImplementation(({ data }: never) => ({
          id: 'user-new',
          email: (data as Record<string, string>).email,
          status: UserStatus.pending,
        })),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      userRole: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      inviteToken: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      company: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new UsersService(
      prisma as never,
      new TokenService(),
      email as never,
      employees as never,
      auditLog as never,
      // Hashing is argon2's job and is covered by its own tests; here the identity
      // transform keeps the assertion about *what* is stored, not how.
      { hashPassword: jest.fn(async (p: string) => `hashed:${p}`) } as never,
      { get: () => ({ appBaseUrl: 'http://localhost:3001' }) } as never,
    );
    return { service, prisma, auditLog };
  };

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      email: 'new.person@example.com',
      roleId: SCOPED_ROLE.id,
      companyId: 'co-1',
      displayName: 'New Person',
      ...over,
    } as never);

  describe('create — role/company rules', () => {
    it('creates a pending account and sends an invite', async () => {
      const { service } = build();
      const result = await service.create(caller, dto());

      expect(result.status).toBe(UserStatus.pending);
      expect(result.emailDispatchFailed).toBe(false);
      expect(email.sendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it('rejects a scoped role with no companyId', async () => {
      const { service } = build();
      await expect(
        service.create(caller, dto({ companyId: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cross-company role that was given a companyId', async () => {
      const { service } = build({ role: CROSS_COMPANY_ROLE });
      await expect(service.create(caller, dto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a cross-company role with no companyId', async () => {
      const { service } = build({ role: CROSS_COMPANY_ROLE });
      const result = await service.create(
        caller,
        dto({ companyId: undefined }),
      );
      expect(result.status).toBe(UserStatus.pending);
    });

    it('rejects an unknown role', async () => {
      const { service } = build({ role: null as never });
      await expect(service.create(caller, dto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('create — name source', () => {
    it('rejects both employeeId and displayName', async () => {
      const { service } = build();
      await expect(
        service.create(caller, dto({ employeeId: 'emp-1' })),
      ).rejects.toThrow(/not both/);
    });

    it('rejects neither employeeId nor displayName', async () => {
      const { service } = build();
      await expect(
        service.create(caller, dto({ displayName: undefined })),
      ).rejects.toThrow(/either employeeId/);
    });

    it('links the employee inside the same transaction when given', async () => {
      const { service } = build();
      await service.create(
        caller,
        dto({ displayName: undefined, employeeId: 'emp-1' }),
      );
      // The 4th argument is the transaction client — passing it is what makes a
      // failed link roll the account back.
      expect(employees.linkEmployeeToUser).toHaveBeenCalledWith(
        caller.rls,
        'emp-1',
        'user-new',
        expect.anything(),
      );
    });
  });

  describe('create — email uniqueness gives distinct messages (US1 AC6)', () => {
    it('reports an active collision plainly', async () => {
      const { service } = build({
        existingUser: { status: UserStatus.active },
      });
      await expect(service.create(caller, dto())).rejects.toThrow(
        /already exists/,
      );
    });

    it('tells the admin to reactivate a deactivated account', async () => {
      const { service } = build({
        existingUser: { status: UserStatus.deactivated },
      });
      await expect(service.create(caller, dto())).rejects.toThrow(
        /deactivated\. Reactivate/,
      );
    });

    it('tells the admin to resend when an invite is already pending', async () => {
      const { service } = build({
        existingUser: { status: UserStatus.pending },
      });
      await expect(service.create(caller, dto())).rejects.toThrow(
        /Resend the invite/,
      );
    });
  });

  describe('create — email dispatch failure does not lose the account', () => {
    it('reports emailDispatchFailed instead of rolling back', async () => {
      // The account is recoverable by resending; a rolled-back account whose email
      // did go out is not.
      const { service } = build();
      email.sendInviteEmail.mockRejectedValueOnce(new Error('provider down'));

      const result = await service.create(caller, dto());
      expect(result.id).toBe('user-new');
      expect(result.emailDispatchFailed).toBe(true);
    });
  });

  // The status-transition guard moved to src/users/users.service.ts — the
  // implementation 002's PATCH /settings/users/:id actually calls. It is covered
  // end to end through that endpoint in test/account-creation.e2e-spec.ts, which
  // exercises the path FR-008 names rather than a service nothing invokes.

  describe('resendInvite', () => {
    it('issues a new token for a pending account', async () => {
      const { service, prisma } = build({
        userById: { id: 'u1', status: UserStatus.pending, companyId: 'co-1' },
      });
      const result = await service.resendInvite(caller, 'u1');

      expect(result.emailDispatchFailed).toBe(false);
      expect(prisma.tx.inviteToken.create).toHaveBeenCalledTimes(1);
      expect(email.sendInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({ isResend: true }),
      );
    });

    it('409s on an already-active account', async () => {
      const { service } = build({
        userById: { id: 'u1', status: UserStatus.active, companyId: 'co-1' },
      });
      await expect(service.resendInvite(caller, 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('409s on a deactivated account', async () => {
      const { service } = build({
        userById: {
          id: 'u1',
          status: UserStatus.deactivated,
          companyId: 'co-1',
        },
      });
      await expect(service.resendInvite(caller, 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('direct creation with an admin-set password (FR-015)', () => {
    it('opens the account immediately, flagged for a forced change', async () => {
      const { service, prisma } = build();
      await service.create(caller, dto({ password: 'Str0ngPass' }));

      expect(prisma.tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'active',
            password: 'hashed:Str0ngPass',
            mustChangePassword: true,
            credentialOrigin: 'admin_direct',
          }),
        }),
      );
    });

    it('generates no invite token and sends no email', async () => {
      // The whole point of the path: an account that needs no invite must not
      // leave a live credential-setting link behind.
      const { service, prisma } = build();
      await service.create(caller, dto({ password: 'Str0ngPass' }));

      expect(prisma.tx.inviteToken.create).not.toHaveBeenCalled();
      expect(email.sendInviteEmail).not.toHaveBeenCalled();
    });

    it('leaves the invite flow untouched when no password is given', async () => {
      const { service, prisma } = build();
      await service.create(caller, dto());

      expect(prisma.tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending',
            password: null,
            mustChangePassword: false,
            credentialOrigin: 'invite',
          }),
        }),
      );
      expect(prisma.tx.inviteToken.create).toHaveBeenCalled();
      expect(email.sendInviteEmail).toHaveBeenCalled();
    });

    it('never records the password in the audit entry', async () => {
      const { service, auditLog } = build();
      await service.create(caller, dto({ password: 'Str0ngPass' }));

      const serialised = JSON.stringify(auditLog.record.mock.calls);
      expect(serialised).not.toContain('Str0ngPass');
      expect(serialised).not.toContain('hashed:Str0ngPass');
      expect(serialised).toContain('admin_direct');
    });
  });
});
