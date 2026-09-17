import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import {
  SLOT_FINAL,
  SLOT_FIRST_APPROVER,
  SLOT_HR,
} from '../src/approvals/approval-slots';
import { ACTION_PAYMENT_RELEASE } from '../src/approvals/default-chains';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * The director has the last word — spec US5 scenarios 1 to 4 (016 T049, T050, T051).
 *
 * The action type under test is `payment_release`: one of the four FR-018 names, with no
 * module behind it yet. That is deliberate rather than a shortcut. T050 requires the gate
 * to be *the* mechanism every future module consumes, so testing it through a module that
 * does not exist is the closest this suite can get to testing it the way feature 017 will
 * — through `ApprovalService.mayTakeEffect` and nothing else.
 *
 * Scenario 4's stated precondition — no active user holds Super Admin — is unreachable
 * through the API, because `UsersAdminService.assertNotLastSuperAdmin` refuses to
 * deactivate, delete or reassign the last one. That refusal is already proven by three
 * tests in `users-admin.service.spec.ts` and is not duplicated here. What *is* reachable,
 * and what this suite covers, is the same failure by the other route: a chain level mapped
 * to a role nobody holds. The item is accepted, held, and the configuration problem
 * surfaced through `awaitingHolderCount`.
 *
 * Every fixture is prefixed `E2EDF` and removed in `afterAll`.
 */
const PREFIX = 'E2EDF';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/**
 * Jest's 5s default is not enough for these: each test walks a multi-level chain over real
 * HTTP against a real database, and the suites run with `maxWorkers: 1` against one
 * Postgres. They pass comfortably in isolation and time out under full-suite contention,
 * which is a property of the harness and not of the code — so the budget is raised here
 * rather than the tests being split into something less like the thing they are testing.
 */
jest.setTimeout(30_000);

describe('Director-final authority (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let http: () => request.SuperTest<request.Test>;

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

  let companyId: string;
  let siteRoleId: string;
  let hrRoleId: string;
  let finalRoleId: string;
  /** Mapped to a slot but held by nobody — scenario 4's reachable half. */
  let emptyRoleId: string;

  const userIds: string[] = [];
  const roleIds: string[] = [];

  let siteUserId: string;
  let directorUserId: string;
  let siteToken: string;
  let hrToken: string;
  let directorToken: string;
  let originatorUserId: string;

  const makeUser = async (
    label: string,
    permissions: Permission[],
    chainRoleId?: string,
  ) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`.toLowerCase(),
        username: unique(label),
        password: await hash('secret42'),
        displayName: `${PREFIX} ${label}`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(user.id);

    const role = await sys.role.create({
      data: { name: unique(`${label}Perm`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    if (chainRoleId) {
      await sys.userRole.create({
        data: { userId: user.id, roleId: chainRoleId, companyId },
      });
    }

    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);

    return { userId: user.id, token: login.body.accessToken as string };
  };

  const submit = async (entityId: string) =>
    approvals.submit({
      companyId,
      actionType: ACTION_PAYMENT_RELEASE,
      entityType: ACTION_PAYMENT_RELEASE,
      entityId,
      originatorUserId,
      subject: `${PREFIX} Vendor payment ${entityId}`,
      href: `/dashboard/payments/${entityId}`,
      viewPermission: Permission.PAYROLL,
    });

  const gate = (entityId: string) =>
    approvals.mayTakeEffect({
      actionType: ACTION_PAYMENT_RELEASE,
      entityType: ACTION_PAYMENT_RELEASE,
      entityId,
      companyId,
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());

    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalService);
    chains = app.get(ChainsService);

    const company = await sys.company.create({
      data: {
        name: 'E2EDF Director Constructions',
        shortCode: unique('D').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    for (const label of ['Site', 'Hr', 'Final', 'Empty'] as const) {
      const role = await sys.role.create({
        data: { name: unique(`${label}Chain`), permissions: [] },
      });
      roleIds.push(role.id);
      if (label === 'Site') siteRoleId = role.id;
      if (label === 'Hr') hrRoleId = role.id;
      if (label === 'Final') finalRoleId = role.id;
      if (label === 'Empty') emptyRoleId = role.id;
    }

    const site = await makeUser('Site', [Permission.PAYROLL], siteRoleId);
    siteUserId = site.userId;
    siteToken = site.token;

    hrToken = (await makeUser('Hr', [Permission.PAYROLL], hrRoleId)).token;

    const director = await makeUser(
      'Director',
      [Permission.PAYROLL],
      finalRoleId,
    );
    directorUserId = director.userId;
    directorToken = director.token;

    originatorUserId = (await makeUser('Originator', [Permission.PAYROLL]))
      .userId;

    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: siteUserId, ipAddress: '127.0.0.1' };

    for (const [slotKey, roleId] of [
      [SLOT_FIRST_APPROVER, siteRoleId],
      [SLOT_HR, hrRoleId],
      [SLOT_FINAL, finalRoleId],
    ] as const) {
      await chains.putSlotMapping(ctx, { companyId, slotKey, roleId }, actor);
    }

    // Three levels, the last of them the director gate. Longer than the one-level
    // default on purpose: US5's claim is that the director's word is required *whatever
    // preceded*, and a chain with nothing preceding cannot demonstrate that.
    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: ACTION_PAYMENT_RELEASE,
        isFinalAuthorityRequired: true,
        levels: [
          { position: 1, slotKey: SLOT_FIRST_APPROVER },
          { position: 2, slotKey: SLOT_HR },
          { position: 3, slotKey: SLOT_FINAL, isFinalAuthority: true },
        ],
      },
      actor,
    );
  }, 120_000);

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  it('scenario 1 — every prior level approved, still held, awaiting the director', async () => {
    const entityId = unique('s1');
    const created = await submit(entityId);

    await http()
      .post(`/approvals/${created.instanceId}/decide`)
      .set(auth(siteToken))
      .send({ action: 'approve' })
      .expect(201);

    const afterHr = await http()
      .post(`/approvals/${created.instanceId}/decide`)
      .set(auth(hrToken))
      .send({ action: 'approve' })
      .expect(201);

    expect(afterHr.body).toMatchObject({
      state: 'pending',
      currentPosition: 3,
      levelLabel: 'Director',
    });

    // The claim that matters: two approvals recorded, and the payment still cannot be
    // released.
    const held = await gate(entityId);
    expect(held).toMatchObject({
      allowed: false,
      code: 'APPROVAL_NOT_COMPLETE',
      state: 'pending',
      levelLabel: 'Director',
    });
    expect(held.awaitingHolderCount).toBe(1);
  });

  it('scenario 2 — the director approves, it takes effect, and is recorded as final', async () => {
    const entityId = unique('s2');
    const created = await submit(entityId);

    for (const token of [siteToken, hrToken]) {
      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(token))
        .send({ action: 'approve' })
        .expect(201);
    }

    const done = await http()
      .post(`/approvals/${created.instanceId}/decide`)
      .set(auth(directorToken))
      .send({ action: 'approve' })
      .expect(201);

    expect(done.body.state).toBe('approved');

    await expect(gate(entityId)).resolves.toMatchObject({
      allowed: true,
      code: null,
    });

    // Recorded as the final authority, not merely as the third approval: the level the
    // decision sits at is the one the chain marks `isFinalAuthority`.
    const history = await http()
      .get(`/approvals/${ACTION_PAYMENT_RELEASE}/${entityId}/history`)
      .set(auth(siteToken))
      .expect(200);

    const last = history.body[history.body.length - 1];
    expect(last).toMatchObject({
      actorUserId: directorUserId,
      position: 3,
      levelLabel: 'Director',
      action: 'approve',
    });
  });

  it('scenario 3 — the director rejects, nothing takes effect, and everyone sees why', async () => {
    const entityId = unique('s3');
    const created = await submit(entityId);

    for (const token of [siteToken, hrToken]) {
      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(token))
        .send({ action: 'approve' })
        .expect(201);
    }

    await http()
      .post(`/approvals/${created.instanceId}/decide`)
      .set(auth(directorToken))
      .send({
        action: 'reject',
        reason: 'Vendor is outside the approved panel.',
      })
      .expect(201);

    const refused = await gate(entityId);
    expect(refused).toMatchObject({
      allowed: false,
      code: 'APPROVAL_NOT_COMPLETE',
      state: 'rejected',
    });
    expect(refused.message).toContain('rejected');

    // The reason must reach the people who approved earlier — being overridden without
    // being told why is how a chain stops being taken seriously.
    for (const token of [siteToken, hrToken]) {
      const history = await http()
        .get(`/approvals/${ACTION_PAYMENT_RELEASE}/${entityId}/history`)
        .set(auth(token))
        .expect(200);

      const rejection = history.body.find(
        (d: { action: string }) => d.action === 'reject',
      );
      expect(rejection.reason).toBe('Vendor is outside the approved panel.');
      expect(rejection.actorUserId).toBe(directorUserId);
    }
  });

  it('scenario 4 — held on a level nobody holds, and the problem is surfaced not swallowed', async () => {
    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: siteUserId, ipAddress: '127.0.0.1' };
    const entityId = unique('s4');

    // A second action type, so remapping its `final` slot does not disturb the chain the
    // scenarios above run on. `empty_final` is mapped to a role with no holders — the
    // reachable form of "no active user holds the final role".
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: 'empty_final', roleId: emptyRoleId },
      actor,
    );
    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: 'e2edf_unstaffed',
        isFinalAuthorityRequired: true,
        levels: [
          { position: 1, slotKey: 'empty_final', isFinalAuthority: true },
        ],
      },
      actor,
    );

    // Accepted into the chain, not refused. A configuration problem must not stop work
    // being submitted — it must stop work taking effect.
    const created = await approvals.submit({
      companyId,
      actionType: 'e2edf_unstaffed',
      entityType: 'e2edf_unstaffed',
      entityId,
      originatorUserId,
      subject: `${PREFIX} unstaffed`,
      viewPermission: Permission.PAYROLL,
    });
    expect(created.state).toBe('pending');

    const result = await approvals.mayTakeEffect({
      actionType: 'e2edf_unstaffed',
      entityType: 'e2edf_unstaffed',
      entityId,
      companyId,
    });

    expect(result).toMatchObject({
      allowed: false,
      code: 'APPROVAL_NOT_COMPLETE',
      state: 'pending',
    });
    // The surfaced problem. Zero is not "waiting patiently" — it is an item that will
    // never move, and the module is told so rather than left to infer it.
    expect(result.awaitingHolderCount).toBe(0);

    // And the item's own view says the same thing to the interface.
    const view = await approvals.stateOfSystem(
      'e2edf_unstaffed',
      entityId,
      companyId,
    );
    expect(view.awaitingHolderCount).toBe(0);
    expect(view.awaitingUserName).toBeNull();
  });

  it('refuses an action of a director-final type that was never submitted (T049)', async () => {
    // Fail closed. This is what stops a module releasing a payment by simply never
    // asking — and it applies only to the action types FR-018 names, so an unmigrated
    // module keeps working (FR-022).
    await expect(gate(unique('never'))).resolves.toMatchObject({
      allowed: false,
      code: 'APPROVAL_NOT_SUBMITTED',
      state: null,
    });

    await expect(
      approvals.mayTakeEffect({
        actionType: 'e2edf_unmigrated_module',
        entityType: 'e2edf_unmigrated_module',
        entityId: unique('other'),
        companyId,
      }),
    ).resolves.toMatchObject({ allowed: true, code: null });
  });

  it('refuses to define a director-final chain with no director in it', async () => {
    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: siteUserId, ipAddress: '127.0.0.1' };

    await expect(
      chains.upsertChain(
        ctx,
        {
          companyId,
          actionType: 'e2edf_no_director',
          isFinalAuthorityRequired: true,
          levels: [{ position: 1, slotKey: SLOT_HR }],
        },
        actor,
      ),
    ).rejects.toThrow(/final authority/);
  });
});
