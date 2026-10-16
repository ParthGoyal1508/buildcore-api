import { BadRequestException } from '@nestjs/common';
import { ChangePasswordService } from './change-password.service';
import { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * Password change rules (001 FR-007, 010 FR-017).
 *
 * The "must actually differ" rule is load-bearing rather than cosmetic: an account
 * created with an admin-set password clears `mustChangePassword` by changing it, so
 * accepting the same value would retire the flag while leaving the admin's
 * credential in force — with the screen reporting success.
 */
describe('ChangePasswordService.changePassword', () => {
  const CURRENT_HASH = 'hash:Current1';

  const caller = {
    id: 'u1',
    email: 'u1@example.test',
    companyId: 'c1',
    password: CURRENT_HASH,
    permissions: [],
    roleNames: [],
    sessionId: 'family-this-device',
  } as unknown as AuthenticatedUser;

  const build = () => {
    const update = jest
      .fn()
      .mockResolvedValue({ id: 'u1', updatedAt: new Date('2026-10-16') });
    const prisma = {
      // `withRlsContext` sets the RLS session variables on the transaction client
      // before handing it over, so the stub needs `$executeRaw` too.
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          $executeRaw: jest.fn().mockResolvedValue(undefined),
          user: { update },
        }),
      ),
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      user: { update },
    };
    const passwordService = {
      // Stands in for argon2: a value matches the stored hash when the hash is
      // exactly `hash:<value>`.
      validatePassword: jest.fn(
        async (plain: string, hash: string) => hash === `hash:${plain}`,
      ),
      hashPassword: jest.fn(async (plain: string) => `hash:${plain}`),
    };
    const refreshTokens = { revokeAllForAccount: jest.fn() };
    const auditLog = { recordAuthEvent: jest.fn() };
    const email = { sendPasswordChangedEmail: jest.fn() };
    const service = new ChangePasswordService(
      prisma as never,
      passwordService as never,
      refreshTokens as never,
      auditLog as never,
      email as never,
    );
    return { service, update, passwordService, refreshTokens, auditLog, email };
  };

  it('rejects a new password identical to the current one', async () => {
    const { service, update } = build();
    await expect(
      service.changePassword(
        caller,
        { oldPassword: 'Current1', newPassword: 'Current1' },
        '10.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    // And writes nothing — otherwise the flag would clear on a non-change.
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    const { service } = build();
    await expect(
      service.changePassword(
        caller,
        { oldPassword: 'Wrong1', newPassword: 'Different1' },
        '10.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores the new hash and clears the forced-change flag together', async () => {
    const { service, update } = build();
    await service.changePassword(
      caller,
      { oldPassword: 'Current1', newPassword: 'Different1' },
      '10.0.0.1',
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: {
          password: 'hash:Different1',
          mustChangePassword: false,
        },
      }),
    );
  });

  it('signs out every other device, keeps this one, audits it and tells the holder (029)', async () => {
    const { service, refreshTokens, auditLog, email } = build();
    await service.changePassword(
      caller,
      { oldPassword: 'Current1', newPassword: 'Different1' },
      '10.0.0.1',
    );

    expect(refreshTokens.revokeAllForAccount).toHaveBeenCalledWith(
      'u1',
      'family-this-device',
    );
    expect(auditLog.recordAuthEvent).toHaveBeenCalledWith(
      'PASSWORD_CHANGED',
      expect.objectContaining({ accountId: 'u1', ipAddress: '10.0.0.1' }),
    );
    expect(email.sendPasswordChangedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'u1@example.test', via: 'self' }),
    );
  });

  it('still succeeds when the notice email fails', async () => {
    const { service, email } = build();
    email.sendPasswordChangedEmail.mockRejectedValue(
      new Error('provider down'),
    );
    await expect(
      service.changePassword(
        caller,
        { oldPassword: 'Current1', newPassword: 'Different1' },
        '10.0.0.1',
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('touches no session when the current password is wrong', async () => {
    const { service, refreshTokens, email } = build();
    await expect(
      service.changePassword(
        caller,
        { oldPassword: 'Wrong1', newPassword: 'Different1' },
        '10.0.0.1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(refreshTokens.revokeAllForAccount).not.toHaveBeenCalled();
    expect(email.sendPasswordChangedEmail).not.toHaveBeenCalled();
  });
});
