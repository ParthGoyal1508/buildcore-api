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
  /** Site Engineer: DASHBOARD without EMPLOYEES — the persona the 2026-10-10
   *  entitlement work is about. */
  let engineerToken: string;
  let engineerUserId: string;
  /** Viewer: exactly [DASHBOARD, REPORTS] — may use the reporting surface and holds
   *  no module permission at all. */
  let viewerToken: string;
  let viewerUserId: string;

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

    // Site Engineer grants DASHBOARD, ATTENDANCE, DWR, MACHINERY, LOGBOOK, FUEL and
    // INVENTORY — and no EMPLOYEES. The reported defect is exactly this account being
    // shown things it cannot act on.
    const siteEngineer = await sys.role.findUniqueOrThrow({
      where: { name: 'Site Engineer' },
    });
    const engineer = await sys.user.create({
      data: {
        email: `${unique('engineer')}@example.test`,
        username: unique('engineer'),
        password: await hash('secret42'),
        companyId: callerCompanyId,
      },
    });
    engineerUserId = engineer.id;
    await sys.userRole.create({
      data: {
        userId: engineer.id,
        roleId: siteEngineer.id,
        companyId: callerCompanyId,
      },
    });
    engineerToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: engineer.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;

    // Viewer grants exactly DASHBOARD and REPORTS — the caller the reports gate is
    // about: entitled to the reporting surface, entitled to no module's data.
    const viewerRole = await sys.role.findUniqueOrThrow({
      where: { name: 'Viewer' },
    });
    const viewer = await sys.user.create({
      data: {
        email: `${unique('viewer')}@example.test`,
        username: unique('viewer'),
        password: await hash('secret42'),
        companyId: callerCompanyId,
      },
    });
    viewerUserId = viewer.id;
    await sys.userRole.create({
      data: {
        userId: viewer.id,
        roleId: viewerRole.id,
        companyId: callerCompanyId,
      },
    });
    viewerToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: viewer.email,
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
      where: {
        userId: {
          in: [scopedUserId, deniedUserId, engineerUserId, viewerUserId],
        },
      },
    });
    // Both fixture users logged in, and a login issues a refresh token that
    // references the account. Deleting the user without clearing these violates
    // `RefreshToken_accountId_fkey` — the same teardown gap that left orphan rows
    // behind in the settings suite.
    await sys.refreshToken.deleteMany({
      where: {
        accountId: {
          in: [scopedUserId, deniedUserId, engineerUserId, viewerUserId],
        },
      },
    });
    await sys.auditLogEntry.deleteMany({
      where: {
        accountId: {
          in: [scopedUserId, deniedUserId, engineerUserId, viewerUserId],
        },
      },
    });
    await sys.auditLogEntry.deleteMany({
      where: { entityId: { startsWith: `${PREFIX}audit` } },
    });
    await sys.user.deleteMany({
      where: {
        id: { in: [scopedUserId, deniedUserId, engineerUserId, viewerUserId] },
      },
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

  describe('operator-disabled rules', () => {
    it('stops evaluating a rule switched off in the catalogue, with no restart', async () => {
      E2EDocumentExpiryRule.candidates = [
        candidate('disable-me', 5, callerCompanyId),
      ];

      const before = await http()
        .get('/dashboard/reminders?module=e2e_testing')
        .set(auth())
        .expect(200);
      expect(before.body.reminders).toHaveLength(1);

      // Exactly what an operator would do at 3am: one UPDATE, no deploy.
      await sys.reminderRule.update({
        where: { ruleKey: RULE_KEY },
        data: { enabled: false },
      });

      const after = await http()
        .get('/dashboard/reminders?module=e2e_testing')
        .set(auth())
        .expect(200);
      expect(after.body.reminders).toHaveLength(0);
      // Not reported as pending either — nothing is missing, it was switched off.
      expect(
        after.body.unavailable.map((u: { ruleKey: string }) => u.ruleKey),
      ).not.toContain(RULE_KEY);

      await sys.reminderRule.update({
        where: { ruleKey: RULE_KEY },
        data: { enabled: true },
      });
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
      // The modules FR-036 names as future registrants that are still unbuilt.
      // `machinery-*` used to be on this list and is deliberately not any more:
      // feature 006 shipped and registers both rules for real, which is the
      // handover FR-028 exists to make possible.
      expect(pending).toEqual(
        expect.arrayContaining(['project-assets-overdue-return']),
      );
      expect(pending).not.toContain('machinery-service-due');
      expect(pending).not.toContain('machinery-document-expiry');
      // And `settings-company-document-expiry` left the list the same way: 017 built
      // company documents and `CompanyDocumentExpiryRule` now registers under that
      // exact `ruleKey`, replacing the placeholder rather than running beside it.
      // Asserting its absence is what proves the replacement happened — two rules
      // sharing a key would otherwise show up as one working reminder and one
      // permanent "module pending" entry for the same thing.
      expect(pending).not.toContain('settings-company-document-expiry');
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
        // Added when the badge was fixed: `total` counts every matching reminder while
        // `bySeverity` is computed from the capped page, so the response says when the two can
        // disagree rather than letting a reader assume they never do. False here — three
        // reminders is nowhere near the cap — and asserted rather than ignored, because a
        // `toEqual` that silently tolerated extra fields would not have caught the field
        // arriving in the first place.
        breakdownTruncated: false,
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

  /**
   * The Activity Log is the broadest read in the product and had the narrowest gate:
   * `DASHBOARD`, which every employee holds. Any account could page through — and
   * CSV-export — payroll runs, loans, role changes and every bill, with before/after
   * values attached.
   *
   * Tested through HTTP against two real seeded roles rather than against the mapping
   * function, because the mapping was never the part that could be wrong: a correct map
   * that `where()` does not consult is exactly the defect.
   */
  describe('activity log entitlement (2026-10-10)', () => {
    /** One payroll row and one projects row, in the caller's own company. */
    beforeAll(async () => {
      await sys.auditLogEntry.createMany({
        data: [
          {
            companyId: callerCompanyId,
            accountId: null,
            action: 'UPDATE',
            entityType: 'PAYROLL_RUN',
            entityId: `${PREFIX}audit-payroll`,
            ipAddress: '127.0.0.1',
          },
          {
            companyId: callerCompanyId,
            accountId: null,
            action: 'UPDATE',
            entityType: 'PROJECT',
            entityId: `${PREFIX}audit-project`,
            ipAddress: '127.0.0.1',
          },
          // One row with a real account on it, for the actor's name. The two above
          // carry `accountId: null` and resolve to "system", so neither of them can
          // tell a name apart from an id.
          {
            companyId: callerCompanyId,
            accountId: scopedUserId,
            action: 'UPDATE',
            entityType: 'PROJECT',
            entityId: `${PREFIX}actorrow`,
            ipAddress: '127.0.0.1',
          },
        ],
      });
    });

    /**
     * The User column names a person.
     *
     * Asserted against the user's actual username, not against "is not empty" or "is
     * not a cuid": a cuid is a non-empty string, so a truthiness check passes against
     * the defect, and a negative regex passes for any wrong name too. Before this fix
     * both the feed and the CSV export printed `accountId` verbatim, so an audit trail
     * answered "who did this" with `cmu40n37h0001123njsvg08v5`.
     */
    it('names the actor rather than printing their id', async () => {
      const res = await http().get('/activity-log').set(auth()).expect(200);

      const row = res.body.entries.find(
        (entry: { target: string | null }) =>
          entry.target === `${PREFIX}actorrow`,
      );
      const scoped = await sys.user.findUniqueOrThrow({
        where: { id: scopedUserId },
        select: { username: true },
      });
      expect(row.actor).toBe(scoped.username);
    });

    it('names the actor in the CSV export too', async () => {
      // A second route over the same rows, and the one that leaves the building.
      const scoped = await sys.user.findUniqueOrThrow({
        where: { id: scopedUserId },
        select: { username: true },
      });
      const res = await http()
        .get('/activity-log/export')
        .set(auth())
        .expect(200);

      const line = res.text
        .split('\n')
        .find((l: string) => l.includes(`${PREFIX}actorrow`));
      expect(line).toContain(scoped.username);
      expect(line).not.toContain(scopedUserId);
    });

    const targets = (body: { entries: { target: string | null }[] }) =>
      body.entries
        .map((e) => e.target)
        .filter((t): t is string => !!t && t.startsWith(`${PREFIX}audit`));

    it('withholds a module the caller holds no permission for', async () => {
      // Project Manager holds PROJECTS but not PAYROLL. Both rows exist, in their own
      // company, inside the default time range — so a missing payroll row is the filter
      // and nothing else.
      const res = await http()
        .get('/activity-log')
        .set(auth(scopedToken))
        .expect(200);

      expect(targets(res.body)).toEqual([`${PREFIX}audit-project`]);
    });

    it('shows both to a caller holding both', async () => {
      // The other half of the pair. Without it, a filter that hid everything would pass.
      const res = await http().get('/activity-log').set(auth()).expect(200);

      expect(targets(res.body).sort()).toEqual([
        `${PREFIX}audit-payroll`,
        `${PREFIX}audit-project`,
      ]);
    });

    it('does not leak the withheld module through the CSV export', async () => {
      // The export is a second route over the same filter, and the one that puts the
      // data on somebody's disk.
      const res = await http()
        .get('/activity-log/export')
        .set(auth(scopedToken))
        .expect(200);

      expect(res.text).toContain(`${PREFIX}audit-project`);
      expect(res.text).not.toContain(`${PREFIX}audit-payroll`);
    });

    it('asking for a module the caller cannot see returns an empty feed, not a 403', async () => {
      // A 403 here would confirm the bucket holds rows.
      const res = await http()
        .get('/activity-log?module=payroll')
        .set(auth(scopedToken))
        .expect(200);

      expect(targets(res.body)).toEqual([]);
    });
  });

  /**
   * The rest of the dashboard's `DASHBOARD`-only surfaces, from the seat the reported
   * defect was seen from: a Site Engineer, holding DASHBOARD and no EMPLOYEES.
   *
   * Each assertion is paired with the admin, because "the engineer sees nothing" is
   * also what a broken endpoint returns.
   */
  describe('dashboard entitlement from a Site Engineer’s seat (2026-10-10)', () => {
    it('withholds the HR widgets and keeps the ungated ones', async () => {
      const ids = async (t: string) =>
        (
          await http().get('/dashboard/widgets').set(auth(t)).expect(200)
        ).body.map((w: { id: string }) => w.id);

      const admin = await ids(token);
      const engineer = await ids(engineerToken);

      expect(admin).toContain('total-employees');
      expect(admin).toContain('recent-leaves');
      // No EMPLOYEES: the headcount goes. ATTENDANCE is held, so the leave table stays
      // — which is the point, the filter is per widget and not a blanket.
      expect(engineer).not.toContain('total-employees');
      expect(engineer).toContain('recent-leaves');
      // A widget declaring no permission belongs to everyone. This used to be the
      // Monthly Expenses placeholder; it left the dashboard on 2026-10-15 with every
      // other expense card, so Alerts & Reminders — filtered by the engine, not here —
      // is the ungated card now.
      expect(engineer).toContain('alerts-reminders');
      // And the expense cards are gone for everybody, the admin included.
      for (const id of [
        'monthly-expenses',
        'materials-cost',
        'fuel-cost',
        'hire-bills',
      ]) {
        expect(admin).not.toContain(id);
      }
    });

    it('lists no real report type to a Viewer, who holds REPORTS and no module', async () => {
      // REPORTS says somebody may use the reporting surface; it never said which data
      // they may take away. The admin pair below is what makes the emptiness meaningful.
      const ids = async (t: string) =>
        (await http().get('/reports/types').set(auth(t)).expect(200)).body.map(
          (r: { id: string }) => r.id,
        );

      const admin = await ids(token);
      const viewer = await ids(viewerToken);

      expect(admin).toEqual(expect.arrayContaining(['employee', 'attendance']));
      expect(viewer).not.toContain('employee');
      expect(viewer).not.toContain('attendance');
      // And every report built on 2026-10-12, each declaring its module's own
      // permission. Listed one by one rather than as "nothing but placeholders": the
      // next report added must be *chosen* to be visible here, not become visible by
      // being forgotten.
      for (const id of [
        'payroll',
        'machinery',
        'equipment-utilization',
        'fuel',
        'project-cost',
        'pnl',
      ]) {
        expect(viewer).not.toContain(id);
      }
      // No placeholder report is listed to anybody since 2026-10-15: `expense`, the last, went
      // when the client asked for expenses to go from Reports.
      expect(admin).not.toContain('expense');
      expect(viewer).not.toContain('expense');
    });

    it('refuses to run the Employee report it did not list', async () => {
      // 404, not 403 — the same answer as for a report id that does not exist, so a
      // caller cannot enumerate what they are not allowed to run.
      await http()
        .post('/reports/employee/run')
        .set(auth(viewerToken))
        .send({})
        .expect(404);

      await http()
        .post('/reports/employee/run')
        .set(auth())
        .send({})
        .expect(201);
    });

    /**
     * The Department and Designation columns hold names.
     *
     * **Asserted on the cell, against the master's own name.** The test above asserts
     * only that the run returned 201, and it did so happily while both columns were
     * full of `cmu40n39a0030123nt0se33v5` — in the one report of the roster anybody
     * can export to a file and send on. Asserting the column *label* reads "Department"
     * would have passed too; the label was never wrong.
     */
    it('names the department and designation rather than their ids', async () => {
      const employee = await sys.employee.findFirst({
        where: {
          companyId: callerCompanyId,
          isActive: true,
          departmentId: { not: null },
          designationId: { not: null },
        },
        select: {
          employeeCode: true,
          departmentId: true,
          designationId: true,
        },
      });
      // Not skipped when absent: a test that quietly passes on no data is the failure
      // mode this suite exists to avoid.
      expect(employee).not.toBeNull();

      const [department, designation] = await Promise.all([
        sys.department.findUniqueOrThrow({
          where: { id: employee.departmentId },
          select: { name: true },
        }),
        sys.designation.findUniqueOrThrow({
          where: { id: employee.designationId },
          select: { name: true },
        }),
      ]);

      const res = await http()
        .post('/reports/employee/run')
        .set(auth())
        .send({})
        .expect(201);

      const row = res.body.rows.find(
        (r: { employeeCode: string }) =>
          r.employeeCode === employee.employeeCode,
      );
      expect(row.department).toBe(department.name);
      expect(row.designation).toBe(designation.name);
    });

    it('refuses the cross-company employee search', async () => {
      // A staff directory by name, previously readable by anyone with DASHBOARD.
      await http()
        .get('/group/employees/search?q=an')
        .set(auth(engineerToken))
        .expect(403);

      await http().get('/group/employees/search?q=an').set(auth()).expect(200);
    });

    it('refuses the group company cards', async () => {
      await http().get('/group/companies').set(auth(engineerToken)).expect(403);

      await http().get('/group/companies').set(auth()).expect(200);
    });

    // 2026-10-15: the calendar is computed now, not a "module pending" placeholder, and
    // it gates its payroll figures per scheme rather than at the route — so the engineer
    // (DASHBOARD, no PAYROLL or CHALLANS) reaches it and is given no dates.
    it('computes the statutory calendar, showing no payroll dates without payroll access', async () => {
      const admin = await http()
        .get('/group/statutory-calendar')
        .set(auth())
        .expect(200);
      expect(admin.body.unavailable).toBeUndefined();
      expect(Array.isArray(admin.body.value.items)).toBe(true);

      const engineer = await http()
        .get('/group/statutory-calendar')
        .set(auth(engineerToken))
        .expect(200);
      expect(engineer.body.value.schemes).toEqual([]);
      expect(engineer.body.value.items).toEqual([]);
    });
  });
});
