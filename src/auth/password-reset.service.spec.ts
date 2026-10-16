import { HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { UserStatus } from '@prisma/client';
import { PasswordResetService } from './password-reset.service';

/**
 * Forgot Password and admin-sent reset links (029 FR-010 to FR-015).
 *
 * The properties under test are the ones that make a reset link safe to email: one answer for
 * every address, a throttle per account, single use, newest-wins, a dead link once the account is
 * deactivated, and every session ended when it is redeemed.
 */

const RAW = 'a'.repeat(64);
const HASH = createHash('sha256').update(RAW).digest('hex');

const settings = {
  passwordReset: {
    selfServiceTtlMinutes: 30,
    adminTtlHours: 24,
    minIntervalSeconds: 60,
    maxPerHour: 5,
  },
};

const activeUser: {
  id: string;
  email: string;
  companyId: string;
  status: UserStatus;
} = {
  id: 'u1',
  email: 'u1@example.test',
  companyId: 'c1',
  status: UserStatus.active,
};

function build(
  opts: {
    user?: typeof activeUser | null;
    recentTokens?: { createdAt: Date }[];
    token?: {
      userId: string;
      createdAt: Date;
      expiresAt: Date;
      consumedAt: Date | null;
      user: { status: UserStatus };
    } | null;
    newerToken?: { id: string } | null;
    consumeCount?: number;
  } = {},
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.user === undefined ? activeUser : opts.user),
      update: jest.fn().mockResolvedValue(activeUser),
    },
    passwordResetToken: {
      findMany: jest.fn().mockResolvedValue(opts.recentTokens ?? []),
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(opts.token ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 'u1' }),
      findFirst: jest.fn().mockResolvedValue(opts.newerToken ?? null),
      updateMany: jest
        .fn()
        .mockResolvedValueOnce({ count: opts.consumeCount ?? 1 })
        .mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const config = {
    get: (key: string) =>
      key === 'email' ? { appBaseUrl: 'https://erp.example.test/' } : settings,
  };
  const passwords = { hashPassword: jest.fn(async (p: string) => `hash:${p}`) };
  const refreshTokens = { revokeAllForAccount: jest.fn() };
  const auditLog = { recordAuthEvent: jest.fn() };
  const email = {
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordChangedEmail: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PasswordResetService(
    prisma as never,
    config as never,
    passwords as never,
    refreshTokens as never,
    auditLog as never,
    email as never,
  );
  return { service, tx, refreshTokens, auditLog, email };
}

/** `requestSelfService` dispatches without awaiting; let that settle before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const liveToken = (over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  createdAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  user: { status: UserStatus.active },
  ...over,
});

describe('PasswordResetService.requestSelfService', () => {
  it('issues a 30-minute link to an active account and emails it', async () => {
    const { service, tx, email } = build();
    await service.requestSelfService('  U1@Example.test ', '10.0.0.1');
    await settle();

    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(1);
    const { data } = tx.passwordResetToken.create.mock.calls[0][0];
    expect(data.requestedById).toBeNull();
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      30 * 60_000,
    );

    const sent = email.sendPasswordResetEmail.mock.calls[0][0];
    expect(sent.to).toBe('u1@example.test');
    expect(sent.requestedByAdmin).toBe(false);
    // Base URL's trailing slash is not doubled, and the stored value is the hash, never the link's.
    expect(sent.resetUrl).toMatch(
      /^https:\/\/erp\.example\.test\/reset-password\/[0-9a-f]{64}$/,
    );
    expect(sent.resetUrl).not.toContain(data.tokenHash);
  });

  it.each([
    ['no account', null],
    ['a pending account', { ...activeUser, status: UserStatus.pending }],
    [
      'a deactivated account',
      { ...activeUser, status: UserStatus.deactivated },
    ],
  ])('sends nothing for %s, and still resolves normally', async (_, user) => {
    const { service, tx, email, auditLog } = build({ user });
    await expect(
      service.requestSelfService('someone@example.test', '10.0.0.1'),
    ).resolves.toBeUndefined();
    await settle();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(auditLog.recordAuthEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_REQUESTED',
      expect.anything(),
    );
  });

  it('sends nothing within a minute of the last link', async () => {
    const { service, tx } = build({
      recentTokens: [{ createdAt: new Date(Date.now() - 10_000) }],
    });
    await service.requestSelfService('u1@example.test', '10.0.0.1');
    await settle();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('sends nothing past five links in the hour', async () => {
    const old = new Date(Date.now() - 30 * 60_000);
    const { service, tx } = build({
      recentTokens: Array.from({ length: 5 }, () => ({ createdAt: old })),
    });
    await service.requestSelfService('u1@example.test', '10.0.0.1');
    await settle();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('does not reject when the email provider fails', async () => {
    const { service, email } = build();
    email.sendPasswordResetEmail.mockRejectedValue(new Error('provider down'));
    await expect(
      service.requestSelfService('u1@example.test', '10.0.0.1'),
    ).resolves.toBeUndefined();
    await settle();
  });
});

describe('PasswordResetService.validate', () => {
  it('accepts a live, newest link', async () => {
    const { service, tx } = build({ token: liveToken() });
    await expect(service.validate(RAW)).resolves.toEqual({ valid: true });
    expect(tx.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: HASH } }),
    );
  });

  it.each([
    ['unknown', null, null, 'not_found'],
    ['used', liveToken({ consumedAt: new Date() }), null, 'consumed'],
    [
      'expired',
      liveToken({ expiresAt: new Date(Date.now() - 1) }),
      null,
      'expired',
    ],
    ['superseded by a newer link', liveToken(), { id: 'newer' }, 'consumed'],
    [
      'for an account deactivated since',
      liveToken({ user: { status: UserStatus.deactivated } }),
      null,
      'consumed',
    ],
  ])('refuses a link that is %s', async (_, token, newerToken, reason) => {
    const { service } = build({ token, newerToken });
    await expect(service.validate(RAW)).resolves.toEqual({
      valid: false,
      reason,
    });
  });
});

describe('PasswordResetService.complete', () => {
  it('sets the password, clears the lockout, ends every session and says so', async () => {
    const { service, tx, refreshTokens, auditLog, email } = build({
      token: liveToken(),
    });
    await service.complete(RAW, 'NewPassword1', '10.0.0.1');

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: {
          password: 'hash:NewPassword1',
          mustChangePassword: false,
          consecutiveFailures: 0,
          lockedUntil: null,
        },
      }),
    );
    // Every session, with no exception for this browser.
    expect(refreshTokens.revokeAllForAccount).toHaveBeenCalledWith('u1');
    expect(auditLog.recordAuthEvent).toHaveBeenCalledWith(
      'PASSWORD_RESET_COMPLETED',
      expect.objectContaining({ accountId: 'u1' }),
    );
    expect(email.sendPasswordChangedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'u1@example.test', via: 'reset_link' }),
    );
  });

  it('answers 410 for a dead link and writes nothing', async () => {
    const { service, tx, refreshTokens } = build({
      token: liveToken({ consumedAt: new Date() }),
    });
    const error = await service
      .complete(RAW, 'NewPassword1', '10.0.0.1')
      .catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(410);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(refreshTokens.revokeAllForAccount).not.toHaveBeenCalled();
  });

  it('lets only one of two simultaneous submissions win', async () => {
    // Both passed `validate()`; the conditional consume is what decides.
    const { service, tx } = build({ token: liveToken(), consumeCount: 0 });
    const error = await service
      .complete(RAW, 'NewPassword1', '10.0.0.1')
      .catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(410);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('still succeeds when the notice email fails', async () => {
    const { service, email } = build({ token: liveToken() });
    email.sendPasswordChangedEmail.mockRejectedValue(
      new Error('provider down'),
    );
    await expect(
      service.complete(RAW, 'NewPassword1', '10.0.0.1'),
    ).resolves.toBeUndefined();
  });
});
