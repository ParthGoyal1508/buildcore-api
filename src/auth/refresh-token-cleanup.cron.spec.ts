import { RefreshTokenCleanupCron } from './refresh-token-cleanup.cron';

/**
 * Removal of dead refresh tokens (015 FR-013).
 *
 * What matters is the *cutoff*, not that a delete happens: deleting the moment a token
 * expires would remove the rows an audit entry about a destroyed family describes,
 * leaving nobody able to tell a genuine theft signal from a false positive afterwards.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function build(retentionDays = 7) {
  const refreshToken = {
    deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ refreshToken, $executeRaw: jest.fn().mockResolvedValue(undefined) }),
    ),
  } as never;
  const configService = {
    get: () => ({ refreshToken: { cleanupRetentionDays: retentionDays } }),
  } as never;

  return {
    cron: new RefreshTokenCleanupCron(prisma, configService),
    refreshToken,
  };
}

describe('RefreshTokenCleanupCron', () => {
  it('deletes only what has been dead longer than the retention period', async () => {
    const { cron, refreshToken } = build(7);

    await cron.removeDeadTokens();

    const { where } = refreshToken.deleteMany.mock.calls[0][0];
    const cutoff: Date = where.OR[0].expiresAt.lt;
    const daysBack = (Date.now() - cutoff.getTime()) / DAY_MS;
    expect(daysBack).toBeGreaterThan(6.9);
    expect(daysBack).toBeLessThan(7.1);
  });

  it('keys on revocation as well as expiry', async () => {
    // A revoked token may be months from its own expiry, so keying only on
    // `expiresAt` would keep every destroyed family around for the full window.
    const { cron, refreshToken } = build();

    await cron.removeDeadTokens();

    const { where } = refreshToken.deleteMany.mock.calls[0][0];
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1]).toHaveProperty('revokedAt');
  });

  it('honours a changed retention period without a code change (FR-012)', async () => {
    const { cron, refreshToken } = build(30);

    await cron.removeDeadTokens();

    const cutoff: Date =
      refreshToken.deleteMany.mock.calls[0][0].where.OR[0].expiresAt.lt;
    expect((Date.now() - cutoff.getTime()) / DAY_MS).toBeGreaterThan(29.9);
  });
});
