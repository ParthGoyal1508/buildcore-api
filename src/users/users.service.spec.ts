import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * Password change rules (001 FR-007, 010 FR-017).
 *
 * The "must actually differ" rule is load-bearing rather than cosmetic: an account
 * created with an admin-set password clears `mustChangePassword` by changing it, so
 * accepting the same value would retire the flag while leaving the admin's
 * credential in force — with the screen reporting success.
 */
describe('UsersService.changePassword', () => {
  const CURRENT_HASH = 'hash:Current1';

  const caller = {
    id: 'u1',
    password: CURRENT_HASH,
    permissions: [],
    roleNames: [],
  } as unknown as AuthenticatedUser;

  const build = () => {
    const update = jest.fn().mockResolvedValue({ id: 'u1' });
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
    const service = new UsersService(prisma as never, passwordService as never);
    return { service, update, passwordService };
  };

  it('rejects a new password identical to the current one', async () => {
    const { service, update } = build();
    await expect(
      service.changePassword(caller, {
        oldPassword: 'Current1',
        newPassword: 'Current1',
      }),
    ).rejects.toThrow(BadRequestException);
    // And writes nothing — otherwise the flag would clear on a non-change.
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    const { service } = build();
    await expect(
      service.changePassword(caller, {
        oldPassword: 'Wrong1',
        newPassword: 'Different1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores the new hash and clears the forced-change flag together', async () => {
    const { service, update } = build();
    await service.changePassword(caller, {
      oldPassword: 'Current1',
      newPassword: 'Different1',
    });

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
});
