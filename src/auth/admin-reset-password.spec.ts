import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { CredentialOrigin, Permission, UserStatus } from '@prisma/client';
import { PASSWORD_COMPLEXITY } from '../account-creation/constants/account-creation.constants';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './authenticated-user';

/**
 * `POST /auth/admin/reset-password` (FR-022, 029 FR-014 to FR-017).
 *
 * The rule most worth a test is the ceiling: a temporary password is a credential the admin
 * knows, so resetting one for an account that holds more than the admin does is a way to become
 * that account.
 */

const admin = {
  id: 'admin-1',
  companyId: 'c1',
  permissions: [Permission.USER_MANAGEMENT, Permission.EMPLOYEES],
} as unknown as AuthenticatedUser;

function targetRow(
  over: {
    id?: string;
    status?: UserStatus;
    companyId?: string;
    permissions?: Permission[];
  } = {},
) {
  return {
    id: over.id ?? 'u1',
    email: 'u1@example.test',
    companyId: over.companyId ?? 'c1',
    status: over.status ?? UserStatus.active,
    userRoles: [
      {
        role: {
          name: 'Site User',
          homeModule: null,
          isDefault: false,
          permissions: over.permissions ?? [Permission.MY_WORKSPACE],
          rolePermissions: [],
        },
      },
    ],
  };
}

function build(target: ReturnType<typeof targetRow> | null = targetRow()) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: {
      findUnique: jest.fn().mockResolvedValue(target),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const passwordService = {
    hashPassword: jest.fn(async (p: string) => `hash:${p}`),
  };
  const configService = {
    get: () => ({ passwordReset: { adminTtlHours: 24 } }),
  };
  const refreshTokens = { revokeAllForAccount: jest.fn() };
  const auditLog = { recordAuthEvent: jest.fn() };
  const email = { sendAdminPasswordResetEmail: jest.fn() };
  const passwordReset = {
    issue: jest.fn().mockResolvedValue({ emailDispatchFailed: false }),
  };
  const service = new AuthService(
    {} as never,
    prisma as never,
    passwordService as never,
    configService as never,
    refreshTokens as never,
    auditLog as never,
    email as never,
    {} as never,
    passwordReset as never,
  );
  return { service, tx, refreshTokens, auditLog, email, passwordReset };
}

describe('AuthService.adminResetPassword', () => {
  it('sends a 24-hour reset link by default, leaving the password and sessions alone', async () => {
    const { service, tx, refreshTokens, passwordReset, auditLog } = build();
    const result = await service.adminResetPassword(
      admin,
      'u1',
      {},
      '10.0.0.1',
    );

    expect(result).toEqual({ method: 'link', emailDispatchFailed: false });
    expect(passwordReset.issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({
        requestedById: 'admin-1',
        ttlMs: 24 * 3_600_000,
      }),
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(refreshTokens.revokeAllForAccount).not.toHaveBeenCalled();
    expect(auditLog.recordAuthEvent).toHaveBeenCalledWith(
      'ADMIN_PASSWORD_RESET',
      expect.objectContaining({
        changes: expect.objectContaining({ method: 'link' }),
      }),
    );
  });

  it('generates a temporary password, forces its change, signs out everywhere and notifies', async () => {
    const { service, tx, refreshTokens, email, auditLog } = build();
    const result = await service.adminResetPassword(
      admin,
      'u1',
      { method: 'temporary_password' },
      '10.0.0.1',
    );

    expect(result.method).toBe('temporary_password');
    expect(result.temporaryPassword).toMatch(PASSWORD_COMPLEXITY);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({
        password: `hash:${result.temporaryPassword}`,
        mustChangePassword: true,
        credentialOrigin: CredentialOrigin.admin_reset,
        lockedUntil: null,
      }),
    });
    expect(refreshTokens.revokeAllForAccount).toHaveBeenCalledWith('u1');
    expect(email.sendAdminPasswordResetEmail).toHaveBeenCalledWith({
      to: 'u1@example.test',
    });
    // The value is never in the audit row.
    expect(JSON.stringify(auditLog.recordAuthEvent.mock.calls)).not.toContain(
      result.temporaryPassword,
    );
  });

  it('does not echo back a temporary password the admin typed themselves', async () => {
    const { service } = build();
    const result = await service.adminResetPassword(
      admin,
      'u1',
      { temporaryPassword: 'Chosen123' },
      '10.0.0.1',
    );
    expect(result).toEqual({
      method: 'temporary_password',
      emailDispatchFailed: false,
    });
  });

  it('refuses an account that holds access the admin does not (029 FR-017)', async () => {
    const { service, tx, passwordReset } = build(
      targetRow({ permissions: [Permission.PAYROLL] }),
    );
    for (const method of ['link', 'temporary_password'] as const) {
      await expect(
        service.adminResetPassword(admin, 'u1', { method }, '10.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(passwordReset.issue).not.toHaveBeenCalled();
  });

  it('treats My Workspace as held by everyone', async () => {
    const { service } = build(
      targetRow({ permissions: [Permission.MY_WORKSPACE] }),
    );
    await expect(
      service.adminResetPassword(admin, 'u1', {}, '10.0.0.1'),
    ).resolves.toMatchObject({ method: 'link' });
  });

  it('refuses another company’s account to a single-company admin', async () => {
    const { service } = build(targetRow({ companyId: 'c2' }));
    await expect(
      service.adminResetPassword(admin, 'u1', {}, '10.0.0.1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sends the admin to Change password for their own account', async () => {
    const { service } = build(targetRow({ id: 'admin-1' }));
    await expect(
      service.adminResetPassword(admin, 'admin-1', {}, '10.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([UserStatus.pending, UserStatus.deactivated])(
    'refuses a %s account with a next step',
    async (status) => {
      const { service } = build(targetRow({ status }));
      await expect(
        service.adminResetPassword(admin, 'u1', {}, '10.0.0.1'),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );
});
