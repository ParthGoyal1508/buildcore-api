import { INestApplication, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { configureApp } from '../src/common/configure-app';
import { ReminderRule } from '../src/dashboard/reminders/reminder-rule.decorator';
import {
  ReminderCandidate,
  ReminderRuleProvider,
} from '../src/dashboard/reminders/reminder-rule.types';

/**
 * End-to-end coverage of the reminders engine (004 TA014).
 *
 * The behaviour this suite exists for is SC-A01: a module can contribute a reminder
 * rule *without any edit to feature 004*. That claim cannot be tested from inside the
 * feature — a unit test that hands the service a rule array proves only that the
 * service iterates an array. So the rule below is declared here, in a module the
 * dashboard has never heard of, and the assertion is simply that it shows up.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

const RULE_KEY = 'e2e-testing-document-expiry';

/**
 * A rule contributed by a module outside `src/dashboard/`.
 *
 * Its candidates are static and mutable so each test can set the due dates it needs;
 * the engine re-evaluates on every request, so there is nothing to invalidate.
 */
@ReminderRule()
class E2EDocumentExpiryRule implements ReminderRuleProvider {
  static candidates: ReminderCandidate[] = [];
  static available = true;

  readonly ruleKey = RULE_KEY;
  readonly sourceModule = 'e2e_testing';
  readonly type = 'document_expiry';
  readonly entityType = 'E2E_DOCUMENT';
  readonly leadDays = 30;
  readonly severityLadder = { warnWithinDays: 7 };

  isAvailable(): boolean {
    return E2EDocumentExpiryRule.available;
  }

  evaluate(): Promise<ReminderCandidate[]> {
    return Promise.resolve(E2EDocumentExpiryRule.candidates);
  }
}

/** The contributing module. Note that nothing imports it from `src/`. */
@Module({ providers: [E2EDocumentExpiryRule] })
class E2EReminderContributorModule {}

/** A calendar date `offset` days from today, as an ISO date string. */
const dayOffset = (offset: number): Date =>
  new Date(Date.now() + offset * 86_400_000);

describe('Dashboard reminders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let callerCompanyId: string;
  /** Holds DASHBOARD but not CROSS_COMPANY_ACCESS. */
  let scopedToken: string;
  let scopedUserId: string;
  /** Holds no DASHBOARD permission at all. */
  let deniedToken: string;
  let deniedUserId: string;

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_t, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );

  const candidate = (
    entityId: string,
    dueInDays: number,
    companyId: string,
  ): ReminderCandidate => ({
    companyId,
    entityId: `${PREFIX}${entityId}`,
    subject: `Fire safety certificate ${entityId}`,
    dueDate: dayOffset(dueInDays),
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, E2EReminderContributorModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;

    const caller = await sys.user.findFirst({
      where: { email: 'admin@buildcore.dev' },
      select: { companyId: true },
    });
    callerCompanyId = caller.companyId;

    // Project Manager grants DASHBOARD but not CROSS_COMPANY_ACCESS — the only
    // caller here that actually exercises the company-isolation path.
    const projectManager = await sys.role.findUniqueOrThrow({
      where: { name: 'Project Manager' },
    });
    const scoped = await sys.user.create({
      data: {
        email: `${unique('scoped')}@example.test`,
        username: unique('scoped'),
        password: await hash('secret42'),
        companyId: callerCompanyId,
      },
    });
    scopedUserId = scoped.id;
    await sys.userRole.create({
      data: {
        userId: scoped.id,
        roleId: projectManager.id,
        companyId: callerCompanyId,
      },
    });
    scopedToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: scoped.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;

    // "QA No Modules" grants no DASHBOARD, for the FR-037 guard check.
    const noModules = await sys.role.findUniqueOrThrow({
      where: { name: 'QA No Modules' },
    });
    const denied = await sys.user.create({
      data: {
        email: `${unique('denied')}@example.test`,
        username: unique('denied'),
        password: await hash('secret42'),
        companyId: callerCompanyId,
      },
    });
    deniedUserId = denied.id;
    await sys.userRole.create({
      data: {
        userId: denied.id,
        roleId: noModules.id,
        companyId: callerCompanyId,
      },
    });
    deniedToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: denied.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;
  });

  afterAll(async () => {
    await sys.reminderNotification.deleteMany({
      where: { ruleKey: RULE_KEY },
    });
    await sys.reminderSnooze.deleteMany({ where: { ruleKey: RULE_KEY } });
    await sys.reminderRule.deleteMany({ where: { ruleKey: RULE_KEY } });
    await sys.userRole.deleteMany({
      where: { userId: { in: [scopedUserId, deniedUserId] } },
    });
    // Both fixture users logged in, and a login issues a refresh token that
    // references the account. Deleting the user without clearing these violates
    // `RefreshToken_accountId_fkey` — the same teardown gap that left orphan rows
    // behind in the settings suite.
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: [scopedUserId, deniedUserId] } },
    });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: [scopedUserId, deniedUserId] } },
    });
    await sys.user.deleteMany({
      where: { id: { in: [scopedUserId, deniedUserId] } },
    });
    await app.close();
  });

  beforeEach(() => {
    E2EDocumentExpiryRule.available = true;
    E2EDocumentExpiryRule.candidates = [];
  });

  describe('rule registration (TA014, SC-A01, FR-028)', () => {
    it('surfaces a rule registered by another module with no edit to this feature', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('doc-1', 5, callerCompanyId),
      ];

      const res = await http()
        .get('/dashboard/reminders')
        .set(auth())
        .expect(200);

      const mine = res.body.reminders.filter(
        (r: { ruleKey: string }) => r.ruleKey === RULE_KEY,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        id: `${RULE_KEY}:${PREFIX}doc-1`,
        sourceModule: 'e2e_testing',
        type: 'document_expiry',
        entityType: 'E2E_DOCUMENT',
        daysRemaining: 5,
        severity: 'warning',
      });
    });

    it('syncs the rule into the catalogue table on boot (TA001)', async () => {
      const row = await sys.reminderRule.findUnique({
        where: { ruleKey: RULE_KEY },
      });

      expect(row).toMatchObject({
        sourceModule: 'e2e_testing',
        leadDays: 30,
        enabled: true,
      });
      expect(row.severityLadder).toEqual({ warnWithinDays: 7 });
    });
  });

  describe('unbuilt modules (FR-031)', () => {
    it('reports the pending rule sources rather than failing the request', async () => {
      const res = await http()
        .get('/dashboard/reminders')
        .set(auth())
        .expect(200);

      const pending = res.body.unavailable.map(
        (u: { ruleKey: string }) => u.ruleKey,
      );
      // The three modules FR-036 names as future registrants, none of them built.
      expect(pending).toEqual(
        expect.arrayContaining([
          'settings-company-document-expiry',
          'machinery-service-due',
          'project-assets-overdue-return',
        ]),
      );
      expect(res.body.unavailable[0].reason).toBe('module_pending');
    });

    it('contributes no reminders from an unavailable rule', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('doc-1', 5, callerCompanyId),
      ];
      E2EDocumentExpiryRule.available = false;

      const res = await http()
        .get('/dashboard/reminders')
        .set(auth())
        .expect(200);

      expect(
        res.body.reminders.filter(
          (r: { ruleKey: string }) => r.ruleKey === RULE_KEY,
        ),
      ).toHaveLength(0);
      expect(
        res.body.unavailable.map((u: { ruleKey: string }) => u.ruleKey),
      ).toContain(RULE_KEY);
    });
  });

  describe('ordering and counts (FR-030, AC10)', () => {
    it('returns overdue first, then soonest due, with negative days when late', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('soon', 2, callerCompanyId),
        candidate('later', 25, callerCompanyId),
        candidate('late', -3, callerCompanyId),
      ];

      const res = await http()
        .get(`/dashboard/reminders?module=e2e_testing`)
        .set(auth())
        .expect(200);

      expect(
        res.body.reminders.map((r: { entityId: string }) => r.entityId),
      ).toEqual([`${PREFIX}late`, `${PREFIX}soon`, `${PREFIX}later`]);
      expect(res.body.reminders[0].daysRemaining).toBe(-3);
    });

    it('counts by severity for the badge', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('a', -1, callerCompanyId),
        candidate('b', 3, callerCompanyId),
        candidate('c', 25, callerCompanyId),
      ];

      const res = await http()
        .get('/dashboard/reminders/count?module=e2e_testing')
        .set(auth())
        .expect(200);

      expect(res.body).toEqual({
        total: 3,
        bySeverity: { overdue: 1, warning: 1, info: 1 },
      });
    });
  });

  describe('snooze (FR-034)', () => {
    it('suppresses the reminder until its date and audit-logs the reason', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('snoozeable', 4, callerCompanyId),
      ];
      const id = `${RULE_KEY}:${PREFIX}snoozeable`;

      await http()
        .patch(`/dashboard/reminders/${id}/snooze`)
        .set(auth())
        .send({
          snoozeUntil: dayOffset(10).toISOString().slice(0, 10),
          reason: 'Renewal already lodged',
        })
        .expect(200);

      const after = await http()
        .get('/dashboard/reminders?module=e2e_testing')
        .set(auth())
        .expect(200);
      expect(after.body.reminders).toHaveLength(0);

      const audit = await sys.auditLogEntry.findFirst({
        where: { entityType: 'REMINDER', entityId: id },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(audit.changes).toMatchObject({ reason: 'Renewal already lodged' });
    });

    it('refuses to snooze a reminder that is not currently due', async () => {
      E2EDocumentExpiryRule.candidates = [];

      await http()
        .patch(`/dashboard/reminders/${RULE_KEY}:${PREFIX}ghost/snooze`)
        .set(auth())
        .send({
          snoozeUntil: dayOffset(10).toISOString().slice(0, 10),
          reason: 'nothing to snooze',
        })
        .expect(404);
    });

    it('rejects a snooze with no reason', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('needs-reason', 4, callerCompanyId),
      ];

      await http()
        .patch(`/dashboard/reminders/${RULE_KEY}:${PREFIX}needs-reason/snooze`)
        .set(auth())
        .send({ snoozeUntil: dayOffset(10).toISOString().slice(0, 10) })
        .expect(400);
    });
  });

  describe('access control (FR-035, FR-037)', () => {
    it('refuses a caller without the DASHBOARD permission', async () => {
      await http()
        .get('/dashboard/reminders')
        .set(auth(deniedToken))
        .expect(403);
    });

    it('refuses scope=all without CROSS_COMPANY_ACCESS', async () => {
      await http()
        .get('/dashboard/reminders?scope=all')
        .set(auth(scopedToken))
        .expect(403);
    });

    it("hides another company's reminders from a company-scoped caller", async () => {
      const other = await sys.company.findFirst({
        where: { id: { not: callerCompanyId } },
      });
      E2EDocumentExpiryRule.candidates = [
        candidate('mine', 5, callerCompanyId),
        ...(other ? [candidate('theirs', 5, other.id)] : []),
      ];

      const res = await http()
        .get('/dashboard/reminders?module=e2e_testing')
        .set(auth(scopedToken))
        .expect(200);

      expect(
        res.body.reminders.map((r: { entityId: string }) => r.entityId),
      ).toEqual([`${PREFIX}mine`]);
    });

    it('requires authentication', async () => {
      await http().get('/dashboard/reminders').expect(401);
    });
  });
});
