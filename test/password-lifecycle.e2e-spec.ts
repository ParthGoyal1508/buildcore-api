import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Permission, UserStatus } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { EmailService } from '../src/shared/email/email.service';

// A require, not a default import: the e2e build compiles without esModuleInterop, under which
// `cookie-parser`'s CommonJS export has no `default` (main.ts compiles with it on).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cookieParser: () => unknown = require('cookie-parser');

/**
 * 029 — a password's whole life over real HTTP and a real database: Forgot Password, a
 * signed-in change, both kinds of admin reset, deactivation, and where a new account lands.
 *
 * The rate limiter is switched off here: this suite signs in far more often than ten times a
 * minute from one address, and the limits themselves are covered by unit tests.
 *
 * Fixtures are prefixed `E2EPW` and removed in `afterAll`.
 */
const PREFIX = 'E2EPW';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

class CapturingEmailService extends EmailService {
  public resets: { to: string; resetUrl: string; requestedByAdmin: boolean }[] =
    [];
  public notices: { kind: string; to: string }[] = [];

  // Not exercised by this suite; resolved rather than captured.
  sendInviteEmail(): Promise<void> {
    return Promise.resolve();
  }
  sendAccountLockedEmail(): Promise<void> {
    return Promise.resolve();
  }
  sendPayslipEmail(): Promise<void> {
    return Promise.resolve();
  }
  async sendPasswordResetEmail(input: {
    to: string;
    resetUrl: string;
    expiresAt: Date;
    requestedByAdmin: boolean;
  }): Promise<void> {
    this.resets.push(input);
  }
  async sendPasswordChangedEmail(input: {
    to: string;
    via: 'self' | 'reset_link';
  }): Promise<void> {
    this.notices.push({ kind: `changed:${input.via}`, to: input.to });
  }
  async sendAdminPasswordResetEmail(input: { to: string }): Promise<void> {
    this.notices.push({ kind: 'admin_reset', to: input.to });
  }
  async sendAccountDeactivatedEmail(input: { to: string }): Promise<void> {
    this.notices.push({ kind: 'deactivated', to: input.to });
  }
  async sendAccountReadyEmail(input: { to: string }): Promise<void> {
    this.notices.push({ kind: 'account_ready', to: input.to });
  }
}

describe('Password lifecycle (029, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  const emails = new CapturingEmailService();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_x, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const userIds: string[] = [];
  const roleIds: string[] = [];
  let companyId: string;
  let adminToken: string;
  let staffRoleId: string;
  let payrollRoleId: string;

  /** Signs in and returns the access token and the refresh cookie, as a browser would hold them. */
  const signIn = async (identifier: string, password: string) => {
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('refreshToken='),
    );
    return {
      accessToken: res.body.accessToken as string,
      cookie: cookie.split(';')[0],
      body: res.body,
    };
  };
  const refresh = (cookie: string) =>
    http().post('/auth/refresh-token').set('Cookie', cookie);

  const makeUser = async (roleId: string, password = 'Original123') => {
    const user = await sys.user.create({
      data: {
        email: `${unique('u')}${userIds.length}@example.test`,
        username: `${unique('u')}${userIds.length}`,
        password: await hash(password),
        companyId,
      },
    });
    userIds.push(user.id);
    await sys.userRole.create({ data: { userId: user.id, roleId, companyId } });
    return user as { id: string; email: string };
  };

  const tokenFrom = (url: string) => url.split('/reset-password/')[1];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue(emails)
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    // Registered in main.ts rather than configureApp, so a test app has to add it — without
    // it no refresh cookie is read and every session assertion here would pass vacuously.
    app.use(cookieParser());
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'Dummy Password Test Firm',
        shortCode: unique('PW').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const adminRole = await sys.role.create({
      data: {
        name: unique('PwAdmin'),
        permissions: [Permission.USER_MANAGEMENT, Permission.EMPLOYEES],
      },
    });
    const staffRole = await sys.role.create({
      data: { name: unique('PwStaff'), permissions: [Permission.MY_WORKSPACE] },
    });
    const payrollRole = await sys.role.create({
      data: { name: unique('PwPayroll'), permissions: [Permission.PAYROLL] },
    });
    roleIds.push(adminRole.id, staffRole.id, payrollRole.id);
    staffRoleId = staffRole.id;
    payrollRoleId = payrollRole.id;

    const admin = await makeUser(adminRole.id, 'AdminPass1');
    adminToken = (await signIn(admin.email, 'AdminPass1')).accessToken;
  });

  afterAll(async () => {
    for (const id of userIds) {
      await sys.passwordResetToken.deleteMany({ where: { userId: id } });
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.deleteMany({ where: { entityId: id } });
      await sys.user.deleteMany({ where: { id } });
    }
    for (const id of roleIds) await sys.role.deleteMany({ where: { id } });
    if (companyId) await sys.company.deleteMany({ where: { id: companyId } });
    await app.close();
  });

  describe('Forgot Password', () => {
    let user: { id: string; email: string };
    let session: { cookie: string };

    beforeAll(async () => {
      user = await makeUser(staffRoleId);
      session = await signIn(user.email, 'Original123');
    });

    it('answers a known and an unknown address identically', async () => {
      const before = emails.resets.length;
      const known = await http()
        .post('/auth/forgot-password')
        .send({ identifier: user.email })
        .expect(202);
      const unknown = await http()
        .post('/auth/forgot-password')
        .send({ identifier: 'nobody-at-all@example.test' })
        .expect(202);

      expect(known.body).toEqual(unknown.body);
      expect(known.headers['cache-control']).toBe('no-store');
      // Dispatch is not awaited by the request; give it a moment.
      await new Promise((r) => setTimeout(r, 200));
      expect(emails.resets.length).toBe(before + 1);
      expect(emails.resets.at(-1)).toMatchObject({
        to: user.email,
        requestedByAdmin: false,
      });
    });

    it('validates the emailed link', async () => {
      const token = tokenFrom(emails.resets.at(-1).resetUrl);
      const res = await http()
        .post('/auth/reset-password/validate')
        .send({ token })
        .expect(200);
      expect(res.body).toEqual({ valid: true });
    });

    it('refuses a weak new password', async () => {
      await http()
        .post('/auth/reset-password')
        .send({
          token: tokenFrom(emails.resets.at(-1).resetUrl),
          password: 'weakpass',
        })
        .expect(400);
    });

    it('sets the new password and signs out every device', async () => {
      const token = tokenFrom(emails.resets.at(-1).resetUrl);
      await http()
        .post('/auth/reset-password')
        .send({ token, password: 'BrandNew123' })
        .expect(200);

      await refresh(session.cookie).expect(401);
      await http()
        .post('/auth/login')
        .send({ identifier: user.email, password: 'Original123' })
        .expect(401);
      await signIn(user.email, 'BrandNew123');
      expect(emails.notices).toContainEqual({
        kind: 'changed:reset_link',
        to: user.email,
      });
    });

    it('410s the same link a second time', async () => {
      await http()
        .post('/auth/reset-password')
        .send({
          token: tokenFrom(emails.resets.at(-1).resetUrl),
          password: 'Another123',
        })
        .expect(410);
    });

    it('records the request and the completion in the audit log', async () => {
      const rows = await sys.auditLogEntry.findMany({
        where: { accountId: user.id },
        select: { entityType: true },
      });
      const types = rows.map((r: { entityType: string }) => r.entityType);
      expect(types).toEqual(
        expect.arrayContaining([
          'PASSWORD_RESET_REQUESTED',
          'PASSWORD_RESET_COMPLETED',
        ]),
      );
    });
  });

  describe('Changing your own password', () => {
    it('keeps this device signed in and signs out the others', async () => {
      const user = await makeUser(staffRoleId);
      const thisDevice = await signIn(user.email, 'Original123');
      const otherDevice = await signIn(user.email, 'Original123');

      await http()
        .patch('/users/me/password')
        .set(auth(thisDevice.accessToken))
        .send({ oldPassword: 'Original123', newPassword: 'Changed123' })
        .expect(200);

      await refresh(thisDevice.cookie).expect(201);
      await refresh(otherDevice.cookie).expect(401);
      expect(emails.notices).toContainEqual({
        kind: 'changed:self',
        to: user.email,
      });
    });

    it('holds the new password to the complexity rule', async () => {
      const user = await makeUser(staffRoleId);
      const { accessToken } = await signIn(user.email, 'Original123');
      await http()
        .patch('/users/me/password')
        .set(auth(accessToken))
        .send({ oldPassword: 'Original123', newPassword: 'alllowercase' })
        .expect(400);
    });
  });

  describe('Admin reset', () => {
    it('with a generated temporary password, forces a change before anything else', async () => {
      const user = await makeUser(staffRoleId);
      const res = await http()
        .post('/auth/admin/reset-password')
        .set(auth(adminToken))
        .send({ targetAccountId: user.id, method: 'temporary_password' })
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const temporary = res.body.temporaryPassword as string;
      expect(temporary).toHaveLength(12);
      expect(emails.notices).toContainEqual({
        kind: 'admin_reset',
        to: user.email,
      });

      const { accessToken, body } = await signIn(user.email, temporary);
      expect(body.mustChangePassword).toBe(true);
      const refused = await http()
        .get('/my/employee')
        .set(auth(accessToken))
        .expect(403);
      expect(refused.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      // The way out stays open.
      await http().get('/users/me').set(auth(accessToken)).expect(200);
      await http()
        .patch('/users/me/password')
        .set(auth(accessToken))
        .send({ oldPassword: temporary, newPassword: 'MyOwn12345' })
        .expect(200);
      await http().get('/my/employee').set(auth(accessToken)).expect(200);
    });

    it('with a link, emails the holder and leaves the current password working', async () => {
      const user = await makeUser(staffRoleId);
      const res = await http()
        .post('/auth/admin/reset-password')
        .set(auth(adminToken))
        .send({ targetAccountId: user.id })
        .expect(200);
      expect(res.body).toMatchObject({
        method: 'link',
        emailDispatchFailed: false,
      });
      expect(res.body.temporaryPassword).toBeUndefined();
      expect(emails.resets.at(-1)).toMatchObject({
        to: user.email,
        requestedByAdmin: true,
      });
      await signIn(user.email, 'Original123');
    });

    it('refuses an account holding access the admin lacks', async () => {
      const user = await makeUser(payrollRoleId);
      const res = await http()
        .post('/auth/admin/reset-password')
        .set(auth(adminToken))
        .send({ targetAccountId: user.id, method: 'temporary_password' })
        .expect(403);
      expect(res.body.code).toBe('GRANT_EXCEEDS_CALLER');
      await signIn(user.email, 'Original123');
    });
  });

  describe('Deactivation', () => {
    it('ends the account’s sessions and tells the holder', async () => {
      const user = await makeUser(staffRoleId);
      const session = await signIn(user.email, 'Original123');
      await http()
        .patch(`/settings/users/${user.id}`)
        .set(auth(adminToken))
        .send({ status: UserStatus.deactivated })
        .expect(200);

      await refresh(session.cookie).expect(401);
      const tokens = await sys.refreshToken.findMany({
        where: { accountId: user.id, revokedAt: null },
      });
      expect(tokens).toHaveLength(0);
      expect(emails.notices).toContainEqual({
        kind: 'deactivated',
        to: user.email,
      });
    });
  });

  describe('A new account with no role named', () => {
    it('is a General User and lands on My Workspace', async () => {
      const email = `${unique('fresh')}@example.test`;
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email,
          companyId,
          displayName: 'Dummy Fresh Starter',
          password: 'Initial123',
        })
        .expect(201);
      userIds.push(res.body.id);
      expect(emails.notices).toContainEqual({
        kind: 'account_ready',
        to: email,
      });

      const roles = await sys.userRole.findMany({
        where: { userId: res.body.id },
        include: { role: true },
      });
      expect(roles.map((r: { role: { name: string } }) => r.role.name)).toEqual(
        ['General User'],
      );

      const { body, accessToken } = await signIn(email, 'Initial123');
      expect(body.homeModule).toBe('my-workspace');
      const me = await http()
        .get('/users/me')
        .set(auth(accessToken))
        .expect(200);
      expect(me.body.homeModule).toBe('my-workspace');
      expect(me.headers['cache-control']).toBe('no-store');
    });
  });

  describe('Sign-out', () => {
    it('is audited', async () => {
      const user = await makeUser(staffRoleId);
      const session = await signIn(user.email, 'Original123');
      await http()
        .post('/auth/logout')
        .set('Cookie', session.cookie)
        .expect(201);
      const rows = await sys.auditLogEntry.findMany({
        where: { accountId: user.id, entityType: 'LOGOUT' },
      });
      expect(rows).toHaveLength(1);
    });
  });
});
