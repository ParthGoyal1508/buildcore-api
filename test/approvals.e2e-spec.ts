import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import {
  SLOT_FINAL,
  SLOT_FIRST_APPROVER,
  SLOT_HR,
} from '../src/approvals/approval-slots';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * The approval spine against a real database (016 T020, T002).
 *
 * This suite exists for one claim that cannot be made anywhere else: **FR-021a is
 * enforced by a unique index, not by the service's own check.** A unit test with a mocked
 * client proves the service *asks* the question; it cannot prove what happens when two
 * requests ask it at the same moment and both get the answer "no decisions yet". Only a
 * real index, under a real race, decides that — so the test that matters here runs two
 * genuinely concurrent transactions and counts the rows that survived.
 *
 * The service is exercised through the DI container rather than through supertest, and
 * stays that way now that the controller exists: a race between two transactions is not
 * an HTTP claim, and routing it through supertest would only add a second thing that
 * could be the reason a run went green. The `/approvals` endpoints are covered in
 * `approvals-queue.e2e-spec.ts`.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Approval spine (e2e, real database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;

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

  let companyId: string;
  let siteRoleId: string;
  let hrRoleId: string;
  let finalRoleId: string;
  let chainId: string;

  const userIds: string[] = [];
  const roleIds: string[] = [];
  /** A real account for the audit trail — `AuditLogEntry.accountId` is a foreign key. */
  let setupUserId: string;

  /** An authenticated caller as `request.user` would carry it. */
  const asUser = (id: string, holds: string[]): AuthenticatedUser =>
    ({
      id,
      companyId,
      permissions: [],
      roleNames: [],
      roleIds: holds,
      displayName: null,
      firstname: 'E2E',
      lastname: id.slice(-6),
      username: id,
      email: `${id}@example.test`,
      status: 'active',
    } as unknown as AuthenticatedUser);

  const makeUser = async (label: string, roleId: string | null) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`.toLowerCase(),
        username: unique(label),
        displayName: `${PREFIX} ${label}`,
        companyId,
        status: 'active',
        ...(roleId ? { userRoles: { create: { roleId, companyId } } } : {}),
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalService);
    chains = app.get(ChainsService);

    const company = await sys.company.create({
      data: {
        name: 'E2E Approval Constructions',
        shortCode: unique('AP').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    for (const [label, target] of [
      ['Site', 'site'],
      ['Hr', 'hr'],
      ['Final', 'final'],
    ] as const) {
      const role = await sys.role.create({
        data: { name: unique(label), permissions: [Permission.ATTENDANCE] },
      });
      roleIds.push(role.id);
      if (target === 'site') siteRoleId = role.id;
      if (target === 'hr') hrRoleId = role.id;
      if (target === 'final') finalRoleId = role.id;
    }

    setupUserId = await makeUser('Setup', null);

    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: setupUserId, ipAddress: '127.0.0.1' };

    // Mappings before the chain, so the FR-021b guard has something to check against.
    for (const [slotKey, roleId] of [
      [SLOT_FIRST_APPROVER, siteRoleId],
      [SLOT_HR, hrRoleId],
      [SLOT_FINAL, finalRoleId],
    ] as const) {
      await chains.putSlotMapping(ctx, { companyId, slotKey, roleId }, actor);
    }

    const chain = await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: 'e2e_attendance_exception',
        levels: [
          { position: 1, slotKey: SLOT_FIRST_APPROVER },
          { position: 2, slotKey: SLOT_HR },
          { position: 3, slotKey: SLOT_FINAL, isFinalAuthority: true },
        ],
      },
      actor,
    );
    chainId = chain.id;
  }, 60_000);

  afterAll(async () => {
    // Children before parents; the spine's rows cascade from the company, but the users
    // and roles do not.
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  const submitFresh = async (entityId: string, originatorUserId: string) =>
    approvals.submit({
      companyId,
      actionType: 'e2e_attendance_exception',
      entityType: 'e2e_attendance_exception',
      entityId,
      originatorUserId,
      subject: `${PREFIX} punch ${entityId}`,
      viewPermission: Permission.ATTENDANCE,
      href: `/hr/attendance/${entityId}`,
    });

  it('puts an item into the chain at level 1, naming the level that decides', async () => {
    const originator = await makeUser('Originator', null);
    const view = await submitFresh(unique('punch'), originator);

    expect(view).toMatchObject({
      state: 'pending',
      currentPosition: 1,
      totalLevels: 3,
      levelLabel: 'First approver',
    });
    expect(view.instanceId).toBeTruthy();
  });

  it('refuses a second live instance for the same item — the partial unique index, not a service check', async () => {
    const originator = await makeUser('Dup', null);
    const entityId = unique('dup');
    await submitFresh(entityId, originator);

    await expect(submitFresh(entityId, originator)).rejects.toMatchObject({
      response: { code: 'APPROVAL_ALREADY_SUBMITTED' },
    });
  });

  it('lets the same item re-enter a chain once the first attempt reached a terminal state', async () => {
    // The index must be PARTIAL: a plain unique would permanently bar a corrected item
    // from ever being raised again.
    const originator = await makeUser('Reraise', null);
    const site = await makeUser('ReraiseSite', siteRoleId);
    const entityId = unique('reraise');

    await submitFresh(entityId, originator);
    const raised = await approvals.stateOf(
      'e2e_attendance_exception',
      entityId,
      asUser(site, [siteRoleId]),
    );
    // Asserted rather than assumed: a null here would otherwise surface as a confusing
    // failure inside `decide` instead of naming the missing instance.
    expect(raised).not.toBeNull();
    await approvals.decide(
      {
        instanceId: String(raised?.instanceId),
        action: ApprovalDecisionAction.reject,
        reason: 'E2E rejection so the item can be raised again',
      },
      asUser(site, [siteRoleId]),
      '127.0.0.1',
    );

    await expect(submitFresh(entityId, originator)).resolves.toMatchObject({
      state: 'pending',
      currentPosition: 1,
    });
  });

  /**
   * T020 — the test this suite exists for.
   */
  it('records exactly ONE decision when the same person decides twice at the same moment (FR-021a)', async () => {
    const originator = await makeUser('RaceOrig', null);
    const site = await makeUser('RaceSite', siteRoleId);
    const entityId = unique('race');
    const { instanceId } = await submitFresh(entityId, originator);

    const caller = asUser(site, [siteRoleId]);

    // Both calls start before either finishes, so both read "no decisions yet" and both
    // proceed to insert. The service's own pre-check cannot separate them; the unique
    // index on (approvalInstanceId, round, actorUserId) is the only thing that can.
    const results = await Promise.allSettled([
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        caller,
        '127.0.0.1',
      ),
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        caller,
        '127.0.0.1',
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // And the row count agrees — the assertion that makes this about the database rather
    // than about which promise happened to settle first.
    const decisions = await sys.approvalDecision.findMany({
      where: { approvalInstanceId: instanceId },
    });
    expect(decisions).toHaveLength(1);

    // The item advanced exactly one level, not two.
    const instance = await sys.approvalInstance.findUnique({
      where: { id: instanceId },
    });
    expect(instance.currentPosition).toBe(2);
  }, 30_000);

  it('records exactly ONE decision when two different approvers at the same level race (FR-021)', async () => {
    const originator = await makeUser('TwoOrig', null);
    const siteA = await makeUser('TwoSiteA', siteRoleId);
    const siteB = await makeUser('TwoSiteB', siteRoleId);
    const entityId = unique('two');
    const { instanceId } = await submitFresh(entityId, originator);

    const results = await Promise.allSettled([
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(siteA, [siteRoleId]),
        '127.0.0.1',
      ),
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(siteB, [siteRoleId]),
        '127.0.0.1',
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const decisions = await sys.approvalDecision.findMany({
      where: { approvalInstanceId: instanceId },
    });
    expect(decisions).toHaveLength(1);
    // The unique on (instance, round, position) is what held: one decision per level.
    expect(decisions[0].position).toBe(1);
  }, 30_000);

  it('walks all three levels and announces completion once (FR-004, FR-007, T013)', async () => {
    const originator = await makeUser('WalkOrig', null);
    const site = await makeUser('WalkSite', siteRoleId);
    const hr = await makeUser('WalkHr', hrRoleId);
    const director = await makeUser('WalkDir', finalRoleId);
    const entityId = unique('walk');
    const { instanceId } = await submitFresh(entityId, originator);

    const one = await approvals.decide(
      { instanceId, action: ApprovalDecisionAction.approve },
      asUser(site, [siteRoleId]),
      '127.0.0.1',
    );
    expect(one).toMatchObject({
      state: 'pending',
      currentPosition: 2,
      levelLabel: 'HR',
    });

    const two = await approvals.decide(
      { instanceId, action: ApprovalDecisionAction.approve },
      asUser(hr, [hrRoleId]),
      '127.0.0.1',
    );
    expect(two).toMatchObject({
      state: 'pending',
      currentPosition: 3,
      levelLabel: 'Director',
    });

    const three = await approvals.decide(
      { instanceId, action: ApprovalDecisionAction.approve },
      asUser(director, [finalRoleId]),
      '127.0.0.1',
    );
    expect(three.state).toBe('approved');

    // Three decisions, three actors, in order.
    const history = await approvals.historyOf(
      'e2e_attendance_exception',
      entityId,
      asUser(director, [finalRoleId]),
    );
    expect(history.map((h) => h.position)).toEqual([1, 2, 3]);
    expect(history.map((h) => h.actorUserId)).toEqual([site, hr, director]);
    expect(history[2].levelLabel).toBe('Director');
  }, 30_000);

  it('refuses a decision from somebody without the level’s authority, and records the attempt (US1 scenario 5, FR-003)', async () => {
    const originator = await makeUser('RefuseOrig', null);
    const site = await makeUser('RefuseSite', siteRoleId);
    const hr = await makeUser('RefuseHr', hrRoleId);
    const entityId = unique('refuse');
    const { instanceId } = await submitFresh(entityId, originator);

    // The item is at level 1 (site); HR has no authority there yet.
    await expect(
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(hr, [hrRoleId]),
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ response: { code: 'APPROVAL_NOT_AUTHORISED' } });

    const refusals = await sys.auditLogEntry.findMany({
      where: {
        companyId,
        entityType: 'APPROVAL_REFUSED',
        entityId: instanceId,
      },
    });
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0].accountId).toBe(hr);

    // Unaffected: the site approver can still act.
    await expect(
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(site, [siteRoleId]),
        '127.0.0.1',
      ),
    ).resolves.toMatchObject({ currentPosition: 2 });
  }, 30_000);

  it('stalls a chain a single person cannot complete, and reassignment is what clears it (FR-019)', async () => {
    // The scenario the specification's own Clarifications call out: one person holds two
    // levels, so FR-021a leaves the item stuck with no error raised anywhere.
    const originator = await makeUser('StallOrig', null);
    const bothLevels = await makeUser('StallBoth', siteRoleId);
    await sys.userRole.create({
      data: { userId: bothLevels, roleId: hrRoleId, companyId },
    });
    const admin = await makeUser('StallAdmin', null);
    const standIn = await makeUser('StallStandIn', null);

    const entityId = unique('stall');
    const { instanceId } = await submitFresh(entityId, originator);

    await approvals.decide(
      { instanceId, action: ApprovalDecisionAction.approve },
      asUser(bothLevels, [siteRoleId, hrRoleId]),
      '127.0.0.1',
    );

    // Now at level 2, which only this same person can hold — and they have decided.
    await expect(
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(bothLevels, [siteRoleId, hrRoleId]),
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ response: { code: 'APPROVAL_ALREADY_DECIDED' } });

    // Reassignment, by somebody who is not the person being waited on.
    await approvals.reassign(
      instanceId,
      standIn,
      'Sole HR holder already approved at level 1',
      asUser(admin, []),
      '127.0.0.1',
    );

    // The stand-in can now act despite holding none of the chain's roles.
    await expect(
      approvals.decide(
        { instanceId, action: ApprovalDecisionAction.approve },
        asUser(standIn, []),
        '127.0.0.1',
      ),
    ).resolves.toMatchObject({ currentPosition: 3 });
  }, 30_000);

  it('scopes the queue to the caller’s level and excludes what they have already decided (T016)', async () => {
    const originator = await makeUser('QOrig', null);
    const site = await makeUser('QSite', siteRoleId);
    const hr = await makeUser('QHr', hrRoleId);

    const mine = unique('qmine');
    await submitFresh(mine, originator);

    const siteCaller = asUser(site, [siteRoleId]);
    const hrCaller = asUser(hr, [hrRoleId]);

    const siteQueue = await approvals.queueFor(siteCaller, { limit: 100 });
    expect(siteQueue.items.some((i) => i.entityId === mine)).toBe(true);

    // HR's level is 2; the item is at 1, so it must not appear in their queue yet.
    const hrQueue = await approvals.queueFor(hrCaller, { limit: 100 });
    expect(hrQueue.items.some((i) => i.entityId === mine)).toBe(false);

    const before = await approvals.queueCountFor(siteCaller);
    const instance = await approvals.stateOf(
      'e2e_attendance_exception',
      mine,
      siteCaller,
    );
    expect(instance).not.toBeNull();
    await approvals.decide(
      {
        instanceId: String(instance?.instanceId),
        action: ApprovalDecisionAction.approve,
      },
      siteCaller,
      '127.0.0.1',
    );

    // Gone from the queue of the person who acted, present in HR's.
    const after = await approvals.queueCountFor(siteCaller);
    expect(after).toBe(before - 1);
    const hrQueueAfter = await approvals.queueFor(hrCaller, { limit: 100 });
    expect(hrQueueAfter.items.some((i) => i.entityId === mine)).toBe(true);
  }, 30_000);

  it('refuses a slot mapping that would make the live chain unsatisfiable (FR-021b)', async () => {
    const ctx = { isSuperAdmin: false, companyId };

    await expect(
      chains.putSlotMapping(
        ctx,
        { companyId, slotKey: SLOT_HR, roleId: siteRoleId },
        { userId: setupUserId, ipAddress: '127.0.0.1' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'APPROVAL_CHAIN_UNSATISFIABLE' },
    });

    // The existing mapping is untouched — a refused write must not half-apply.
    const still = await chains.resolveSlot(ctx, companyId, SLOT_HR);
    expect(still).toBe(hrRoleId);
  }, 30_000);

  it('keeps one company’s pending work out of another company’s queue (Principle IV)', async () => {
    // The one place in this feature where a policy mistake leaks across tenants: an
    // ordinary user's queue read.
    //
    // Postgres exempts superusers and BYPASSRLS roles from every policy
    // UNCONDITIONALLY — `ENABLE` and `FORCE ROW LEVEL SECURITY` do not apply to them and
    // no error is raised. The local developer role is a superuser (see
    // src/common/prisma/rls-preflight.ts, which warns about exactly this and refuses to
    // boot in production). So under that role the isolation itself cannot be observed,
    // and a test asserting it would pass or fail for reasons unrelated to the policy.
    //
    // What is asserted unconditionally is that the policies exist and are FORCEd, which
    // is the part this feature is responsible for. The isolation assertion runs only
    // where the role can actually enforce it.
    const [role] = await prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    const rlsEnforceable = !role.rolsuper && !role.rolbypassrls;

    const policies = await prisma.$queryRaw<
      { relname: string; forced: boolean }[]
    >`
      SELECT c.relname, c.relforcerowsecurity AS forced
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'shared'
        AND pol.polname = 'tenant_isolation'
        AND (c.relname LIKE 'Approval%' OR c.relname = 'RoleSlotMapping')
      ORDER BY c.relname
    `;
    expect(policies.map((p) => p.relname)).toEqual([
      'ApprovalChain',
      'ApprovalDecision',
      'ApprovalInstance',
      'ApprovalLevel',
      'RoleSlotMapping',
    ]);
    // FORCE, not merely ENABLE: without it the table owner bypasses its own policy.
    expect(policies.every((p) => p.forced)).toBe(true);

    const originator = await makeUser('RlsOrig', null);
    const entityId = unique('rls');
    await submitFresh(entityId, originator);

    const otherCompany = await sys.company.create({
      data: {
        name: 'E2E Other Constructions',
        shortCode: unique('OT').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });

    try {
      const visible = await withRlsContext(
        prisma,
        { isSuperAdmin: false, companyId: otherCompany.id },
        (tx) => tx.approvalInstance.findMany({ where: { entityId } }),
      );

      if (rlsEnforceable) {
        expect(visible).toHaveLength(0);
      } else {
        // Recorded rather than silently skipped, so a green run is not mistaken for
        // evidence of isolation.
        expect(visible.length).toBeGreaterThanOrEqual(0);
        // eslint-disable-next-line no-console
        console.warn(
          'Tenant isolation NOT asserted: this database role bypasses RLS ' +
            '(superuser/BYPASSRLS). The policies exist and are FORCEd, but their effect ' +
            'is only observable under a NOSUPERUSER, NOBYPASSRLS role — DEPLOYMENT.md §2a.',
        );
      }

      const mine = await withRlsContext(
        prisma,
        { isSuperAdmin: false, companyId },
        (tx) => tx.approvalInstance.findMany({ where: { entityId } }),
      );
      expect(mine).toHaveLength(1);
    } finally {
      await sys.company.deleteMany({ where: { id: otherCompany.id } });
    }
  }, 30_000);

  it('closes an abandoned chain rather than leaving it pending forever (T015)', async () => {
    const originator = await makeUser('AbOrig', null);
    const entityId = unique('abandon');
    const { instanceId } = await submitFresh(entityId, originator);

    await approvals.abandon(
      'e2e_attendance_exception',
      entityId,
      companyId,
      'Punch deleted by site admin',
    );

    const instance = await sys.approvalInstance.findUnique({
      where: { id: instanceId },
    });
    expect(instance.state).toBe('abandoned');

    // Idempotent: a retrying module must not get an error.
    await expect(
      approvals.abandon(
        'e2e_attendance_exception',
        entityId,
        companyId,
        'again',
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('has a chain whose levels all belong to the company that owns it', async () => {
    // Guards the denormalised `companyId` the RLS policies depend on: a level whose
    // company disagreed with its chain's would be invisible to its own tenant.
    const levels = await sys.approvalLevel.findMany({ where: { chainId } });
    expect(levels).toHaveLength(3);
    expect(
      levels.every((l: { companyId: string }) => l.companyId === companyId),
    ).toBe(true);
  });
});
