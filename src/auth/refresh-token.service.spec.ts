import { RefreshTokenService } from './refresh-token.service';

/**
 * Session lifetime and replay tolerance (015 US1, US2).
 *
 * These are the two behaviours the defect was made of. Before this feature a session
 * lasted one day unless the user ticked a box that 74 of 89 sign-ins left unticked, and
 * the replay window was a hardcoded five seconds that a cold instance exceeded — so
 * slowness was classified as theft and destroyed five live sessions.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const SECURITY = {
  refreshTokenHashSecret: 'test-pepper',
  refreshToken: {
    sessionDays: 90,
    reuseGraceSeconds: 60,
    cleanupRetentionDays: 7,
  },
};

/** A token row with only the fields `rotate()` reads. */
const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1',
  tokenHash: 'hash',
  familyId: 'fam-1',
  accountId: 'acc-1',
  companyId: 'co-1',
  used: false,
  usedAt: null,
  revokedAt: null,
  expiresAt: new Date(Date.now() + 30 * DAY_MS),
  createdAt: new Date(),
  ...over,
});

function build(row: ReturnType<typeof tokenRow> | null) {
  const refreshToken = {
    findUnique: jest.fn().mockResolvedValue(row),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  // withRlsContext opens a transaction and issues two set_config statements through
  // the `$executeRaw` template tag before handing the client over.
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ refreshToken, $executeRaw: jest.fn().mockResolvedValue(undefined) }),
    ),
  } as never;
  const configService = { get: () => SECURITY } as never;

  return {
    service: new RefreshTokenService(prisma, configService),
    refreshToken,
  };
}

describe('RefreshTokenService — one session length for everyone (US1)', () => {
  it('issues a family expiring in 90 days, with no preference to consult', async () => {
    const { service, refreshToken } = build(null);

    await service.issueFamily({ accountId: 'acc-1', companyId: 'co-1' });

    const { expiresAt } = refreshToken.create.mock.calls[0][0].data;
    const days = (expiresAt.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('slides the window: a rotation expires 90 days from the rotation', async () => {
    // The presented token is nearly spent — 2 days left of its original life.
    const { service, refreshToken } = build(
      tokenRow({ expiresAt: new Date(Date.now() + 2 * DAY_MS) }),
    );

    const result = await service.rotate('raw');

    expect(result.outcome).toBe('rotated');
    const { expiresAt } = refreshToken.create.mock.calls[0][0].data;
    const days = (expiresAt.getTime() - Date.now()) / DAY_MS;
    // Not 2 days, and not 90-minus-elapsed: a full 90 from now. This is what makes a
    // session in continuous use never expire.
    expect(days).toBeGreaterThan(89.9);
  });

  it('renews a session created under the old short window (FR-004)', async () => {
    // A row written before the migration: hours from expiry, not days.
    const { service } = build(
      tokenRow({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
    );

    // Nobody may be signed out by the deployment itself.
    await expect(service.rotate('raw')).resolves.toMatchObject({
      outcome: 'rotated',
    });
  });

  it('refuses a token that is genuinely past its expiry', async () => {
    const { service } = build(
      tokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(service.rotate('raw')).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('refuses a revoked token', async () => {
    const { service } = build(tokenRow({ revokedAt: new Date() }));
    await expect(service.rotate('raw')).resolves.toEqual({
      outcome: 'invalid',
    });
  });
});

describe('RefreshTokenService — concurrency is not theft (US2)', () => {
  it('rotates again for a token used moments ago', async () => {
    const { service } = build(
      tokenRow({ used: true, usedAt: new Date(Date.now() - 2_000) }),
    );

    await expect(service.rotate('raw')).resolves.toMatchObject({
      outcome: 'rotated',
    });
  });

  it('tolerates a spread that the old five-second window would have killed', async () => {
    // 30 seconds: a cold instance answering the last of a burst of parallel renewals.
    // This is the production failure, as a regression test.
    const { service, refreshToken } = build(
      tokenRow({ used: true, usedAt: new Date(Date.now() - 30_000) }),
    );

    await expect(service.rotate('raw')).resolves.toMatchObject({
      outcome: 'rotated',
    });
    // And crucially the family was not destroyed.
    expect(refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('still destroys the family for a genuinely stale credential', async () => {
    const { service, refreshToken } = build(
      tokenRow({ used: true, usedAt: new Date(Date.now() - 10 * 60 * 1000) }),
    );

    const result = await service.rotate('raw');

    expect(result).toMatchObject({ outcome: 'reuse', familyId: 'fam-1' });
    expect(refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: 'fam-1', revokedAt: null },
      }),
    );
  });

  it('reports how late the presentation was, so a false positive is recognisable', async () => {
    const { service } = build(
      tokenRow({ used: true, usedAt: new Date(Date.now() - 10 * 60 * 1000) }),
    );

    const result = await service.rotate('raw');

    // Ten minutes past a sixty-second window: ~540 s beyond it. A few seconds would
    // read as a slow client; this reads as a credential somebody kept.
    expect(result).toMatchObject({ outcome: 'reuse' });
    if (result.outcome === 'reuse') {
      expect(result.lateBySeconds).toBeGreaterThan(500);
    }
  });

  it('treats a used token with no recorded use time as a replay', async () => {
    // Unreachable through normal rotation, but the safe reading of a row that cannot
    // prove when it was used is the conservative one.
    const { service } = build(tokenRow({ used: true, usedAt: null }));

    await expect(service.rotate('raw')).resolves.toMatchObject({
      outcome: 'reuse',
      lateBySeconds: null,
    });
  });
});
