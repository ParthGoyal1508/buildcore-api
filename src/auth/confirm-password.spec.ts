import { ForbiddenException, HttpException } from '@nestjs/common';
import { AuditEntityType, Permission } from '@prisma/client';

import { AuthService } from './auth.service';
import { AuthenticatedUser } from './authenticated-user';
import { PasswordConfirmationService } from './password-confirmation.service';

/**
 * `POST /auth/confirm-password` (2026-10-14): the Super Admin re-enters their own password in
 * Settings before the cash visibility switch is revealed.
 *
 * It is a password-guessing surface reachable from any open session, so the properties under
 * test are the ones sign-in already has — the same lockout counter, an audit row per attempt —
 * plus the two that are new: it only confirms for a purpose the caller could act on, and it
 * never answers with a 401 (which the web client treats as "sign me out").
 */

const securityConfig = {
  jwtAccessSecret: 'test-secret',
  lockout: { maxAttempts: 5, durationMinutes: 15 },
};

function caller(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    companyId: 'company-1',
    email: 'admin@example.test',
    password: 'hash',
    permissions: [Permission.CROSS_COMPANY_ACCESS],
    consecutiveFailures: 0,
    lockedUntil: null,
    ...overrides,
  } as unknown as AuthenticatedUser;
}

function build(passwordValid: boolean) {
  const userUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: { update: userUpdate },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const passwordService = {
    validatePassword: jest.fn().mockResolvedValue(passwordValid),
  } as never;
  const configService = { get: () => securityConfig } as never;
  const auditLog = {
    record: jest.fn().mockResolvedValue(undefined),
    recordAuthEvent: jest.fn().mockResolvedValue(undefined),
  };
  const email = { sendAccountLockedEmail: jest.fn() } as never;
  const confirmation = new PasswordConfirmationService(configService);

  const service = new AuthService(
    {} as never,
    prisma,
    passwordService,
    configService,
    {} as never,
    auditLog as never,
    email,
    confirmation,
    {} as never,
  );
  return { service, auditLog, userUpdate, confirmation };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected a refusal');
}

describe('AuthService.confirmPassword', () => {
  it('returns a confirmation the cash visibility endpoint accepts, and audits it', async () => {
    const { service, auditLog, confirmation } = build(true);
    const result = await service.confirmPassword(
      caller(),
      'secret42',
      'cash-visibility',
      '10.0.0.1',
    );
    expect(() =>
      confirmation.assertConfirmed(
        result.confirmationToken,
        'user-1',
        'cash-visibility',
      ),
    ).not.toThrow();
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: AuditEntityType.USER_ACCOUNT,
        entityId: 'user-1',
        changes: { event: 'password_confirmed', purpose: 'cash-visibility' },
      }),
    );
  });

  it('refuses a wrong password with a coded 403, counts it toward lockout, and audits it', async () => {
    const { service, auditLog, userUpdate } = build(false);
    const err = await refusal(
      service.confirmPassword(caller(), 'wrong', 'cash-visibility', '10.0.0.1'),
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect((err.getResponse() as { code: string }).code).toBe(
      'PASSWORD_INCORRECT',
    );
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ consecutiveFailures: 1 }),
      }),
    );
    expect(auditLog.recordAuthEvent).toHaveBeenCalledWith(
      AuditEntityType.LOGIN_FAILURE,
      expect.objectContaining({
        accountId: 'user-1',
        changes: {
          event: 'password_confirmation_failed',
          purpose: 'cash-visibility',
        },
      }),
    );
  });

  it('refuses a caller who is not a Super Admin before looking at the password', async () => {
    const { service } = build(true);
    const err = await refusal(
      service.confirmPassword(
        caller({ permissions: [Permission.COMPANY_SETTINGS] }),
        'secret42',
        'cash-visibility',
        '10.0.0.1',
      ),
    );
    expect(err.getStatus()).toBe(403);
    expect((err.getResponse() as { code: string }).code).toBe(
      'CONFIRMATION_NOT_PERMITTED',
    );
  });

  it('refuses a locked account even with the right password, as sign-in does', async () => {
    const { service } = build(true);
    const err = await refusal(
      service.confirmPassword(
        caller({ lockedUntil: new Date(Date.now() + 60_000) }),
        'secret42',
        'cash-visibility',
        '10.0.0.1',
      ),
    );
    expect(err.getStatus()).toBe(423);
  });

  it('clears an earlier failure count on success', async () => {
    const { service, userUpdate } = build(true);
    await service.confirmPassword(
      caller({ consecutiveFailures: 2 }),
      'secret42',
      'cash-visibility',
      '10.0.0.1',
    );
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consecutiveFailures: 0 } }),
    );
  });
});
