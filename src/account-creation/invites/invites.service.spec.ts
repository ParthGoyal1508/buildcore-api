import { HttpException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { InvitesService } from './invites.service';
import { TokenService } from './token.service';

describe('InvitesService', () => {
  const tokens = new TokenService();
  const RAW = 'a'.repeat(64);
  const HASH = tokens.hash(RAW);

  const invite = (over: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    userId: 'u1',
    expiresAt: new Date(Date.now() + 3_600_000),
    consumedAt: null,
    createdAt: new Date(Date.now() - 1000),
    user: { email: 'invitee@example.com', status: UserStatus.pending },
    ...over,
  });

  const build = (
    opts: { found?: unknown; newer?: unknown; consumedCount?: number } = {},
  ) => {
    const { found = invite(), newer = null, consumedCount = 1 } = opts;
    const prisma = createPrismaMock({
      inviteToken: {
        findUnique: jest.fn().mockResolvedValue(found),
        findFirst: jest.fn().mockResolvedValue(newer),
        updateMany: jest.fn().mockResolvedValue({ count: consumedCount }),
      },
      user: {
        update: jest.fn().mockResolvedValue({}),
        // Read after activation to attribute the audit entry to a company.
        findUnique: jest.fn().mockResolvedValue({ companyId: 'co-1' }),
      },
    });
    const service = new InvitesService(
      prisma as never,
      tokens,
      {
        hashPassword: jest.fn().mockResolvedValue('argon2-hash'),
        validatePassword: jest.fn(),
      } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, prisma };
  };

  describe('validate', () => {
    it('accepts a fresh, unconsumed token', async () => {
      const { service } = build();
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: true,
        email: 'invitee@example.com',
      });
    });

    it('looks the token up by hash, never by its raw value', async () => {
      // research.md §2: the raw token exists only in the email.
      const { service, prisma } = build();
      await service.validate(RAW);
      expect(prisma.tx.inviteToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: HASH } }),
      );
    });

    it('reports not_found for an unknown token', async () => {
      const { service } = build({ found: null });
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: false,
        reason: 'not_found',
      });
    });

    it('reports consumed for a spent token', async () => {
      const { service } = build({ found: invite({ consumedAt: new Date() }) });
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: false,
        reason: 'consumed',
      });
    });

    it('reports expired past the TTL', async () => {
      const { service } = build({
        found: invite({ expiresAt: new Date(Date.now() - 1000) }),
      });
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: false,
        reason: 'expired',
      });
    });

    it('treats a superseded token as spent once a newer one exists', async () => {
      // Resend does not delete the old row (FR-014); "current" is derived from
      // which row is newest rather than stored in a flag.
      const { service } = build({ newer: { id: 'inv-2' } });
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: false,
        reason: 'consumed',
      });
    });

    it('rejects a token whose account is already active', async () => {
      const { service } = build({
        found: invite({
          user: { email: 'x@example.com', status: UserStatus.active },
        }),
      });
      await expect(service.validate(RAW)).resolves.toEqual({
        valid: false,
        reason: 'consumed',
      });
    });
  });

  describe('setPassword', () => {
    it('activates the account and consumes the token', async () => {
      const { service, prisma } = build();
      await service.setPassword(RAW, 'Password1');

      expect(prisma.tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: UserStatus.active,
            password: 'argon2-hash',
            mustChangePassword: false,
          }),
        }),
      );
    });

    it('consumes conditionally, so a double submit cannot both win', async () => {
      const { service, prisma } = build();
      await service.setPassword(RAW, 'Password1');
      expect(prisma.tx.inviteToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: HASH, consumedAt: null },
        }),
      );
    });

    it('410s when the conditional consume matches nothing', async () => {
      // The race: another request consumed the same link first.
      const { service } = build({ consumedCount: 0 });
      const error = await service.setPassword(RAW, 'Password1').catch((e) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(410);
    });

    it('410s on an expired token', async () => {
      const { service } = build({
        found: invite({ expiresAt: new Date(Date.now() - 1000) }),
      });
      const error = await service.setPassword(RAW, 'Password1').catch((e) => e);
      expect((error as HttpException).getStatus()).toBe(410);
      expect((error as Error).message).toMatch(/expired/);
    });

    it('410s on an already-consumed token', async () => {
      const { service } = build({ found: invite({ consumedAt: new Date() }) });
      const error = await service.setPassword(RAW, 'Password1').catch((e) => e);
      expect((error as HttpException).getStatus()).toBe(410);
    });
  });
});
