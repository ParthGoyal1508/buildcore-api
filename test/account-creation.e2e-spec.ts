import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { EmailService } from '../src/shared/email/email.service';
import { TokenService } from '../src/account-creation/invites/token.service';

/**
 * End-to-end coverage of the invite flow against a real database — required by the
 * constitution, which mandates e2e tests for endpoints touching account creation and
 * activation.
 *
 * Fixtures are prefixed `E2EAC` and removed in `afterAll`.
 */
const PREFIX = 'E2EAC';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** Captures sent mail instead of delivering it, so assertions can inspect the
 * invite without the console adapter's log formatting getting in the way. */
class CapturingEmailService extends EmailService {
  public invites: {
    to: string;
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  }[] = [];
  public lockouts: { to: string; unlockAt: Date }[] = [];
  public failNext = false;

  async sendInviteEmail(input: {
    to: string;
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated provider failure');
    }
    this.invites.push(input);
  }

  async sendAccountLockedEmail(input: {
    to: string;
    unlockAt: Date;
  }): Promise<void> {
    this.lockouts.push(input);
  }
}

describe('Account creation — invite flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  const emails = new CapturingEmailService();
  const tokens = new TokenService();

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

  let adminToken: string;
  let adminUserId: string;
  /**
   * The seeded Super Admin. Needed because 002's `/settings/users` gates on role
   * *name* (`Super Admin` / `HO User`) rather than on the USER_MANAGEMENT
   * permission, so a purpose-made role with the right permission is still refused
   * there. Only used for the two FR-008 assertions below.
   */
  let superAdminToken: string;
  let adminRoleId: string;
  let companyId: string;
  let scopedRoleId: string;
  const createdUserIds: string[] = [];

  /** The raw token never leaves the email, so the suite reads the hash the same way
   * the service does and matches it against a candidate. */
  const rawTokenFromLastInvite = (): string => {
    const last = emails.invites[emails.invites.length - 1];
    return last.setPasswordUrl.split('/set-password/')[1];
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue(emails)
      .compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'E2E AC Constructions',
        shortCode: unique('AC').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const scopedRole = await sys.role.create({
      data: { name: unique('Scoped'), permissions: [Permission.MY_WORKSPACE] },
    });
    scopedRoleId = scopedRole.id;

    const adminRole = await sys.role.create({
      data: {
        name: unique('AcAdmin'),
        permissions: [Permission.USER_MANAGEMENT],
      },
    });
    adminRoleId = adminRole.id;

    const admin = await sys.user.create({
      data: {
        email: `${unique('acadmin')}@example.test`,
        username: unique('acadmin'),
        password: await hash('secret42'),
        companyId,
      },
    });
    adminUserId = admin.id;
    await sys.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: admin.email,
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    adminToken = login.body.accessToken;

    const superAdminLogin = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    superAdminToken = superAdminLogin.body.accessToken;
  });

  afterAll(async () => {
    const ids = [...createdUserIds, adminUserId].filter(Boolean);
    for (const id of ids) {
      await sys.inviteToken.deleteMany({ where: { userId: id } });
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.auditLogEntry.deleteMany({ where: { entityId: id } });
      await sys.user.deleteMany({ where: { id } });
    }
    for (const id of [scopedRoleId, adminRoleId].filter(Boolean)) {
      await sys.role.deleteMany({ where: { id } });
    }
    if (companyId) {
      await sys.company.deleteMany({ where: { id: companyId } });
    }
    await app.close();
  });

  // ------------------------------------------------------------- User Story 1
  describe('Admin creates a user (US1, T016)', () => {
    let inviteeEmail: string;

    it('creates a pending account with no password and dispatches an invite', async () => {
      inviteeEmail = `${unique('invitee')}@example.test`;
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: inviteeEmail,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Invited Person',
        })
        .expect(201);

      createdUserIds.push(res.body.id);
      expect(res.body.status).toBe('pending');
      expect(res.body.emailDispatchFailed).toBe(false);

      const stored = await sys.user.findUnique({ where: { id: res.body.id } });
      // The defining property of a pending account: it cannot authenticate,
      // because there is nothing to authenticate against.
      expect(stored.password).toBeNull();
      expect(stored.status).toBe('pending');
      // Generated, not supplied by the admin.
      expect(stored.username).toBeTruthy();

      expect(emails.invites[emails.invites.length - 1].to).toBe(inviteeEmail);
    });

    it('stores only the hash of the invite token, never the token itself', async () => {
      const raw = rawTokenFromLastInvite();
      const rows = await sys.inviteToken.findMany({
        where: { userId: createdUserIds[0] },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(tokens.hash(raw));
      expect(rows[0].tokenHash).not.toBe(raw);
    });

    it('rejects a duplicate email, naming the pending state', async () => {
      await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: inviteeEmail,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Duplicate',
        })
        .expect(409)
        .expect((r) => expect(r.body.message).toMatch(/Resend the invite/));
    });

    it('rejects a scoped role with no companyId', async () => {
      await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: `${unique('nocompany')}@example.test`,
          roleId: scopedRoleId,
          displayName: 'No Company',
        })
        .expect(400);
    });

    it('rejects neither employeeId nor displayName', async () => {
      await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: `${unique('noname')}@example.test`,
          roleId: scopedRoleId,
          companyId,
        })
        .expect(400);
    });

    it('refuses a caller without USER_MANAGEMENT', async () => {
      const outsider = await sys.user.create({
        data: {
          email: `${unique('outsider')}@example.test`,
          username: unique('outsider'),
          password: await hash('secret42'),
          companyId,
        },
      });
      createdUserIds.push(outsider.id);
      await sys.userRole.create({
        data: { userId: outsider.id, roleId: scopedRoleId },
      });
      const login = await http()
        .post('/auth/login')
        .send({
          identifier: outsider.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201);

      await http()
        .post('/account-creation/users')
        .set(auth(login.body.accessToken))
        .send({
          email: `${unique('nope')}@example.test`,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Nope',
        })
        .expect(403);
    });

    it('still creates the account when the invite email fails', async () => {
      // Recoverable by resending; a rollback would lose an account whose email may
      // already have gone out.
      emails.failNext = true;
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: `${unique('nomail')}@example.test`,
          roleId: scopedRoleId,
          companyId,
          displayName: 'No Mail',
        })
        .expect(201);

      createdUserIds.push(res.body.id);
      expect(res.body.emailDispatchFailed).toBe(true);
      expect(res.body.status).toBe('pending');
    });

    it('returns 401, not 500, when someone tries to log in as a pending account (T029)', async () => {
      // The regression this feature introduced: `password` became nullable so a
      // pending row can exist, but login verifies the password before it checks
      // status — and argon2 throws on a null hash. A 500 here while an unknown
      // address returns 401 is also an account-enumeration oracle.
      const res = await http().post('/auth/login').send({
        identifier: inviteeEmail,
        password: 'anything',
        rememberMe: false,
      });

      expect(res.status).not.toBe(500);
      expect(res.status).toBe(401);
    });

    it('gives an unknown address the same answer as a pending one', async () => {
      // Identical status and body, or the pair still leaks which emails exist.
      const pending = await http().post('/auth/login').send({
        identifier: inviteeEmail,
        password: 'anything',
        rememberMe: false,
      });
      const unknown = await http()
        .post('/auth/login')
        .send({
          identifier: `${unique('ghost')}@example.test`,
          password: 'anything',
          rememberMe: false,
        });

      expect(pending.status).toBe(unknown.status);
      expect(pending.body.message).toEqual(unknown.body.message);
    });

    it('writes an audit entry without recording the invite link', async () => {
      const entries = await sys.auditLogEntry.findMany({
        where: { entityType: 'USER_ACCOUNT', accountId: adminUserId },
      });
      expect(entries.length).toBeGreaterThan(0);
      // An audit row must not become a second copy of a live credential link.
      expect(JSON.stringify(entries.map((e: any) => e.changes))).not.toContain(
        '/set-password/',
      );
    });
  });

  // ------------------------------------------------------------- User Story 2
  describe('Invitee sets their password (US2, T022)', () => {
    let raw: string;
    let userId: string;
    let email: string;

    beforeAll(async () => {
      email = `${unique('setter')}@example.test`;
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Password Setter',
        })
        .expect(201);
      userId = res.body.id;
      createdUserIds.push(userId);
      raw = rawTokenFromLastInvite();
    });

    it('validates a fresh token, returning the invitee email', async () => {
      const res = await http()
        .get(`/account-creation/invites/${raw}`)
        .expect(200);
      expect(res.body).toEqual({ valid: true, email });
    });

    it('reports not_found for an unknown token', async () => {
      const res = await http()
        .get(`/account-creation/invites/${'0'.repeat(64)}`)
        .expect(200);
      expect(res.body).toEqual({ valid: false, reason: 'not_found' });
    });

    it('rejects a password that fails the complexity rule', async () => {
      await http()
        .post(`/account-creation/invites/${raw}/set-password`)
        .send({ password: 'short' })
        .expect(400);
    });

    it('sets the password and activates the account', async () => {
      await http()
        .post(`/account-creation/invites/${raw}/set-password`)
        .send({ password: 'Password1' })
        .expect(201)
        .expect((r) => expect(r.body).toEqual({ success: true }));

      const stored = await sys.user.findUnique({ where: { id: userId } });
      expect(stored.status).toBe('active');
      expect(stored.password).not.toBeNull();
    });

    it('lets the newly activated account log in — the whole point of the flow', async () => {
      const login = await http()
        .post('/auth/login')
        .send({ identifier: email, password: 'Password1', rememberMe: false })
        .expect(201);
      expect(login.body.accessToken).toBeTruthy();
    });

    it('410s when the same link is used a second time', async () => {
      await http()
        .post(`/account-creation/invites/${raw}/set-password`)
        .send({ password: 'Password2' })
        .expect(410);
    });

    it('reports the consumed token as no longer valid', async () => {
      const res = await http()
        .get(`/account-creation/invites/${raw}`)
        .expect(200);
      expect(res.body).toEqual({ valid: false, reason: 'consumed' });
    });
  });

  // ------------------------------- Convergence fixes (T030, T032)
  describe('FR-008 guard on the path that actually reaches it (T030)', () => {
    let pendingId: string;

    beforeAll(async () => {
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: `${unique('guarded')}@example.test`,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Guarded',
        })
        .expect(201);
      pendingId = res.body.id;
      createdUserIds.push(pendingId);
    });

    it('refuses to activate a pending account through 002 PATCH /settings/users/:id', async () => {
      // FR-008 names this endpoint specifically. The guard previously lived on a
      // service nothing called, so the rule was unenforced exactly here.
      await http()
        .patch(`/settings/users/${pendingId}`)
        .set(auth(superAdminToken))
        .send({ status: 'active' })
        .expect(400)
        .expect((r) =>
          expect(r.body.message).toMatch(/has not accepted its invite/),
        );

      const stored = await sys.user.findUnique({ where: { id: pendingId } });
      expect(stored.status).toBe('pending');
      expect(stored.password).toBeNull();
    });

    it('still allows deactivating a pending account (cancelling the invite)', async () => {
      await http()
        .patch(`/settings/users/${pendingId}`)
        .set(auth(superAdminToken))
        .send({ status: 'deactivated' })
        .expect(200);
    });
  });

  describe('Activation is audited (T032, FR-014)', () => {
    it('writes a USER_ACCOUNT entry when an invite is redeemed', async () => {
      const email = `${unique('audited')}@example.test`;
      const created = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Audited',
        })
        .expect(201);
      createdUserIds.push(created.body.id);

      await http()
        .post(
          `/account-creation/invites/${rawTokenFromLastInvite()}/set-password`,
        )
        .send({ password: 'Password1' })
        .expect(201);

      const entries = await sys.auditLogEntry.findMany({
        where: { entityType: 'USER_ACCOUNT', entityId: created.body.id },
      });
      const activation = entries.find(
        (e: any) => e.changes && e.changes.activatedViaInvite === true,
      );
      expect(activation).toBeTruthy();
      // Attributed to the account itself — nobody else performed it.
      expect(activation.accountId).toBe(created.body.id);
      // And carries no credential.
      expect(JSON.stringify(activation.changes)).not.toContain('token');
    });
  });

  // ------------------------------------------------------------- User Story 3
  describe('Resend invite (US3, T028)', () => {
    let userId: string;
    let firstToken: string;

    beforeAll(async () => {
      const res = await http()
        .post('/account-creation/users')
        .set(auth(adminToken))
        .send({
          email: `${unique('resend')}@example.test`,
          roleId: scopedRoleId,
          companyId,
          displayName: 'Resend Target',
        })
        .expect(201);
      userId = res.body.id;
      createdUserIds.push(userId);
      firstToken = rawTokenFromLastInvite();
    });

    it('issues a new invite marked as a resend', async () => {
      const res = await http()
        .post(`/account-creation/users/${userId}/resend-invite`)
        .set(auth(adminToken))
        .expect(200);
      expect(res.body.emailDispatchFailed).toBe(false);
      expect(emails.invites[emails.invites.length - 1].isResend).toBe(true);
    });

    it('invalidates the previous link without deleting its row (FR-014)', async () => {
      const res = await http()
        .get(`/account-creation/invites/${firstToken}`)
        .expect(200);
      expect(res.body).toEqual({ valid: false, reason: 'consumed' });

      // Both rows survive, so the invite history stays auditable.
      const rows = await sys.inviteToken.findMany({ where: { userId } });
      expect(rows).toHaveLength(2);
    });

    it('accepts the newest link', async () => {
      const res = await http()
        .get(`/account-creation/invites/${rawTokenFromLastInvite()}`)
        .expect(200);
      expect(res.body.valid).toBe(true);
    });

    it('409s when resending to an already-active account', async () => {
      const newest = rawTokenFromLastInvite();
      await http()
        .post(`/account-creation/invites/${newest}/set-password`)
        .send({ password: 'Password1' })
        .expect(201);

      await http()
        .post(`/account-creation/users/${userId}/resend-invite`)
        .set(auth(adminToken))
        .expect(409);
    });
  });
});
