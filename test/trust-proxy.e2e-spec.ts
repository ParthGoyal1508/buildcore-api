import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Whose address the API believes, end to end.
 *
 * `req.ip` feeds three things: the auth rate limiter's buckets, the audit log's record of
 * who acted from where, and the sign-in lockout's per-address failure count. Express
 * decides it from `trust proxy`, which was never set — so behind a load balancer every
 * caller arrives as the balancer and all three read the same address for everybody.
 *
 * Asserted on **the audited address**, not on the setting. A test that read
 * `app.get('trust proxy')` back would pass for any value including a dangerous one, and
 * would not notice if something later in the stack discarded the resolved address before
 * it reached the log.
 *
 * The wiring — that the configured value actually reaches Express — is covered by
 * `configure-app.spec.ts`, and deliberately not here: `TRUST_PROXY` is unset in the test
 * environment and `trustedProxyHops(undefined)` is `false`, which is also Express's own
 * default, so an assertion in this file would pass whether the line existed or not.
 * Confirmed by removing it: all three tests stayed green.
 *
 * Both directions are here, and the first is the security half: with no proxy configured,
 * an `X-Forwarded-For` that a *client* wrote must be ignored. `trust proxy: true` — the
 * spelling this configuration deliberately refuses — would honour it, handing any caller
 * a fresh lockout and rate-limit bucket per request.
 */
jest.setTimeout(120_000);

const FORGED = '203.0.113.47';

describe('whose address reaches the audit log', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: string;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = <T>(
    model: string,
    operation: string,
    args?: unknown,
  ): Promise<T> =>
    withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      (tx as any)[model][operation](args),
    ) as Promise<T>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The same configuration the real server gets, which is the point of that function.
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const admin = await sys<{ email: string }>('user', 'findFirstOrThrow', {
      where: { email: 'admin@buildcore.dev' },
      select: { email: true },
    });
    email = admin.email;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** The address recorded against the most recent successful sign-in. */
  async function lastAuditedAddress(): Promise<string | null> {
    const [entry] = await sys<{ ipAddress: string | null }[]>(
      'auditLogEntry',
      'findMany',
      {
        where: { action: 'LOGIN_SUCCESS' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { ipAddress: true },
      },
    );
    return entry?.ipAddress ?? null;
  }

  async function signIn(): Promise<void> {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', FORGED)
      .send({ identifier: email, password: 'secret42' })
      .expect(201);
  }

  it('ignores a forwarded address when no proxy is configured', async () => {
    // `TRUST_PROXY` is unset in the test environment, so this is the shipped default.
    // The header is the one thing in the request a client fully controls.
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', false);

    await signIn();

    expect(await lastAuditedAddress()).not.toBe(FORGED);
  });

  it('honours one forwarded hop when one proxy is configured', async () => {
    // The other half. Without it, a configuration that ignored every address — or a
    // `trust proxy` that never reached Express at all — would satisfy the test above
    // and leave the audit log naming the load balancer forever.
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', 1);

    await signIn();

    expect(await lastAuditedAddress()).toBe(FORGED);
  });
});
