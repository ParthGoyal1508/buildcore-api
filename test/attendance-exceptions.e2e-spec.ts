import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { SLOT_FIRST_APPROVER, SLOT_HR } from '../src/approvals/approval-slots';
import { ACTION_ATTENDANCE_EXCEPTION } from '../src/approvals/default-chains';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Attendance exceptions on the approval spine — spec US1 scenarios 1 to 5 (016 T028).
 *
 * Exercised through the real HTTP route an administrator uses, because the claim being
 * made is about the endpoint's behaviour, not the service's: `/resolve` is unchanged from
 * before this feature, and what changed is that a decision there is now one level of a
 * chain rather than the end of the matter.
 *
 * The flagged punch is written directly rather than produced through `/my/punch`. Driving
 * a real exception through that endpoint needs face enrolment, photographs and a geofence
 * miss, all of which `my-workspace.e2e-spec.ts` already covers; what matters here is what
 * happens *after* a punch is flagged. That the flagging itself submits into the chain is
 * proven in `punch.service.spec.ts`.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`.
 */
const PREFIX = 'E2EAX';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Attendance exceptions through the approval chain (e2e)', () => {
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
  let siteId: string;
  let shiftId: string;
  let employeeId: string;
  let employeeUserId: string;
  let employeeToken: string;

  const userIds: string[] = [];
  const roleIds: string[] = [];

  let siteRoleId: string;
  let hrRoleId: string;
  let finalRoleId: string;

  let siteToken: string;
  let hrToken: string;
  let directorToken: string;
  let siteUserId: string;
  let hrUserId: string;

  /**
   * An account holding ATTENDANCE (so it can reach the admin routes at all) plus one
   * chain role (so it holds exactly one level). The two are separate concerns and the
   * separation is the point: permission gets you to the screen, the slot mapping decides
   * whether you may act.
   */
  const makeApprover = async (label: string, chainRoleId: string) => {
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

    const accessRole = await sys.role.create({
      data: {
        name: unique(`${label}Access`),
        permissions: [Permission.ATTENDANCE],
      },
    });
    roleIds.push(accessRole.id);

    await sys.userRole.create({
      data: { userId: user.id, roleId: accessRole.id, companyId },
    });
    await sys.userRole.create({
      data: { userId: user.id, roleId: chainRoleId, companyId },
    });

    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);

    return { userId: user.id, token: login.body.accessToken };
  };

  /** A flagged punch, already in its chain — the state `/my/punch` leaves behind. */
  const flaggedPunch = async (dayOffset: number) => {
    const day = new Date(Date.UTC(2026, 8, 11 - dayOffset));
    const punch = await sys.punchRecord.create({
      data: {
        employeeId,
        type: 'in',
        capturedAt: new Date(day.getTime() + 4 * 3_600_000),
        punchDate: day,
        photoRef: 'punch/e2e-ax-ref',
        faceMatchResult: 'matched',
        latitude: 18.5204,
        longitude: 73.8567,
        geofenceResult: 'exception',
        exceptionResolution: 'pending',
      },
    });

    await approvals.submit({
      companyId,
      actionType: ACTION_ATTENDANCE_EXCEPTION,
      entityType: ACTION_ATTENDANCE_EXCEPTION,
      entityId: punch.id,
      originatorUserId: employeeUserId,
      subject: `${PREFIX} Rajesh Kulkarni — outside the site geofence`,
      href: `/dashboard/hr/attendance/exceptions/${punch.id}`,
      viewPermission: Permission.ATTENDANCE,
    });

    return punch.id;
  };

  const rowFor = async (token: string, punchId: string) => {
    const res = await http()
      .get(`/workspace-admin/attendance-exceptions/${punchId}`)
      .set(auth(token))
      .expect(200);
    return res.body;
  };

  const resolve = (token: string, punchId: string, body: object) =>
    http()
      .post(`/workspace-admin/attendance-exceptions/${punchId}/resolve`)
      .set(auth(token))
      .send(body);

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
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'E2E Attendance Exceptions Co',
        shortCode: unique('AX').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 18.5204,
        longitude: 73.8567,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    siteId = site.id;

    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    shiftId = shift.id;

    const employeeUser = await sys.user.create({
      data: {
        email: `${unique('Emp')}@example.test`.toLowerCase(),
        username: unique('Emp'),
        // A real password: T042's endpoint is the employee's own, so the only honest way
        // to test it is as the employee, over HTTP, with their own token.
        password: await hash('secret42'),
        displayName: `${PREFIX} Rajesh Kulkarni`,
        companyId,
        status: 'active',
      },
    });
    employeeUserId = employeeUser.id;
    userIds.push(employeeUser.id);

    const employeeAccess = await sys.role.create({
      data: {
        name: unique('EmpAccess'),
        permissions: [Permission.ATTENDANCE],
      },
    });
    roleIds.push(employeeAccess.id);
    await sys.userRole.create({
      data: { userId: employeeUser.id, roleId: employeeAccess.id, companyId },
    });

    const employee = await sys.employee.create({
      data: {
        userId: employeeUser.id,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('E').slice(0, 20),
        firstName: 'Rajesh',
        lastName: 'Kulkarni',
        dateOfJoining: new Date('2026-01-01'),
      },
    });
    employeeId = employee.id;

    employeeToken = (
      await http()
        .post('/auth/login')
        .send({
          identifier: employeeUser.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;

    for (const label of ['Site', 'Hr', 'Final'] as const) {
      const role = await sys.role.create({
        data: { name: unique(`Chain${label}`), permissions: [] },
      });
      roleIds.push(role.id);
      if (label === 'Site') siteRoleId = role.id;
      if (label === 'Hr') hrRoleId = role.id;
      if (label === 'Final') finalRoleId = role.id;
    }

    const setup = await makeApprover('Setup', siteRoleId);
    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: setup.userId, ipAddress: '127.0.0.1' };

    // The default three-level chain, exactly as a newly created company would receive it.
    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      chains.seedDefaultsForCompany(companyId, tx, {
        superAdminRoleId: finalRoleId,
      }),
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_FIRST_APPROVER, roleId: siteRoleId },
      actor,
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_HR, roleId: hrRoleId },
      actor,
    );

    const site1 = await makeApprover('SiteApprover', siteRoleId);
    siteToken = site1.token;
    siteUserId = site1.userId;
    const hr = await makeApprover('HrApprover', hrRoleId);
    hrToken = hr.token;
    hrUserId = hr.userId;
    directorToken = (await makeApprover('Director', finalRoleId)).token;
  }, 90_000);

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.punchRecord.deleteMany({ where: { employeeId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.shift.deleteMany({ where: { id: shiftId } });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 90_000);

  it('scenario 1 — shows the flagged punch with its current level and who it waits on', async () => {
    const punchId = await flaggedPunch(0);

    const res = await http()
      .get('/workspace-admin/attendance-exceptions')
      .set(auth(siteToken))
      .expect(200);

    const row = res.body.find(
      (r: { punch: { id: string } }) => r.punch.id === punchId,
    );
    expect(row).toBeDefined();
    expect(row.approval).toMatchObject({
      state: 'pending',
      currentPosition: 1,
      totalLevels: 3,
      levelLabel: 'Site / Employer',
      canActNow: true,
      inertReason: null,
    });
    expect(row.approval.subject).toContain('Rajesh Kulkarni');
  }, 30_000);

  it('scenario 2 — leaves the first approver’s queue once they have approved, and awaits the next level', async () => {
    const punchId = await flaggedPunch(1);

    await resolve(siteToken, punchId, { resolution: 'confirmed' }).expect(201);

    // Gone from the queue of the person who acted (FR-021a applied to the listing).
    const mine = await http()
      .get('/workspace-admin/attendance-exceptions')
      .set(auth(siteToken))
      .expect(200);
    const stillMine = mine.body.find(
      (r: { punch: { id: string } }) => r.punch.id === punchId,
    );
    expect(stillMine.approval.canActNow).toBe(false);
    expect(stillMine.approval.inertReason).toBe('already_decided');

    // And shown as awaiting HR, by name, because exactly one person holds that role.
    const asHr = await rowFor(hrToken, punchId);
    expect(asHr.approval).toMatchObject({
      state: 'pending',
      currentPosition: 2,
      levelLabel: 'HR',
      canActNow: true,
    });
    expect(asHr.approval.awaitingUserName).toContain('HrApprover');

    // Crucially: the punch itself is NOT yet confirmed. One person agreeing is not the
    // end of the matter, which is the whole point of the feature.
    expect(asHr.punch.exceptionResolution).toBe('pending');
  }, 30_000);

  it('scenario 3 — a rejection stops the chain, records who and why, and does not count the punch as present', async () => {
    const punchId = await flaggedPunch(2);

    await resolve(siteToken, punchId, {
      resolution: 'rejected',
      reason: 'GPS shows the worker two kilometres from site.',
    }).expect(201);

    const row = await rowFor(hrToken, punchId);
    expect(row.approval.state).toBe('rejected');
    expect(row.punch.exceptionResolution).toBe('rejected');
    expect(row.approval.latestDecision).toMatchObject({
      action: 'reject',
      actorUserId: siteUserId,
      reason: 'GPS shows the worker two kilometres from site.',
    });

    // The chain has stopped: HR cannot carry on with it.
    const res = await resolve(hrToken, punchId, {
      resolution: 'confirmed',
    }).expect(409);
    expect(res.body.code).toBe('APPROVAL_NOT_PENDING');
  }, 30_000);

  it('scenario 3b — refuses a rejection with no reason (FR-006)', async () => {
    const punchId = await flaggedPunch(3);

    const res = await resolve(siteToken, punchId, {
      resolution: 'rejected',
    }).expect(400);
    expect(res.body.code).toBe('APPROVAL_REASON_REQUIRED');

    // Nothing was recorded — a refused decision must not half-apply.
    const row = await rowFor(siteToken, punchId);
    expect(row.approval.state).toBe('pending');
    expect(row.approval.latestDecision).toBeNull();
  }, 30_000);

  it('scenario 4 — a return shows the originator who sent it back and why, and it can be resubmitted from the beginning', async () => {
    const punchId = await flaggedPunch(4);

    await resolve(siteToken, punchId, {
      resolution: 'returned',
      reason: 'Attach the site supervisor’s note.',
    }).expect(201);

    const returned = await rowFor(hrToken, punchId);
    expect(returned.approval.state).toBe('returned');
    expect(returned.approval.latestDecision).toMatchObject({
      action: 'return',
      actorUserId: siteUserId,
      reason: 'Attach the site supervisor’s note.',
    });
    // Returned is not a verdict — the punch is still awaiting a decision.
    expect(returned.punch.exceptionResolution).toBe('pending');

    // The originator resubmits: a fresh round from level 1, with the trip recorded.
    const resubmitted = await approvals.resubmit(
      ACTION_ATTENDANCE_EXCEPTION,
      punchId,
      companyId,
      employeeUserId,
    );
    expect(resubmitted).toMatchObject({
      state: 'pending',
      currentPosition: 1,
      round: 2,
      returnCount: 1,
    });

    // And the same approver may decide again, because it is a new round.
    await resolve(siteToken, punchId, { resolution: 'confirmed' }).expect(201);
    const afterward = await rowFor(hrToken, punchId);
    expect(afterward.approval.currentPosition).toBe(2);
  }, 30_000);

  it('T042 — the employee sees their own returned punch and resubmits it over HTTP', async () => {
    const punchId = await flaggedPunch(12);

    // Before T042 this endpoint did not exist, and `app/my/` had no approval surface at
    // all: an approver returning an exception was returning it to somebody with no screen
    // on which to receive it, while `returned` held the punch's chain slot so nothing
    // else could be raised for it either.
    const before = await http()
      .get('/my/punch/exceptions')
      .set(auth(employeeToken))
      .expect(200);
    const mine = before.body.find(
      (r: { punch: { id: string } }) => r.punch.id === punchId,
    );
    expect(mine).toBeDefined();
    expect(mine.approval.state).toBe('pending');
    expect(mine.approval.canResubmitNow).toBe(false);

    await resolve(siteToken, punchId, {
      resolution: 'returned',
      reason: 'Attach the supervisor’s note.',
    }).expect(201);

    const after = await http()
      .get('/my/punch/exceptions')
      .set(auth(employeeToken))
      .expect(200);
    const returned = after.body.find(
      (r: { punch: { id: string } }) => r.punch.id === punchId,
    );
    // The field the control branches on, and the reason it had to be added: a returned
    // item reports `canActNow: false` with a null reason, which renders as nothing.
    expect(returned.approval).toMatchObject({
      state: 'returned',
      canActNow: false,
      inertReason: null,
      canResubmitNow: true,
    });
    expect(returned.approval.latestDecision.reason).toBe(
      'Attach the supervisor’s note.',
    );

    // And the employee moves it themselves, with their own token.
    const back = await http()
      .post(`/approvals/${ACTION_ATTENDANCE_EXCEPTION}/${punchId}/resubmit`)
      .set(auth(employeeToken))
      .expect(201);
    expect(back.body).toMatchObject({
      state: 'pending',
      round: 2,
      returnCount: 1,
    });

    // The chain really is running again.
    await resolve(siteToken, punchId, { resolution: 'confirmed' }).expect(201);
  }, 30_000);

  it('T042 — derives the employee from the token, so there is nothing to tamper with', async () => {
    const punchId = await flaggedPunch(13);

    // The site approver holds ATTENDANCE and reviews this very punch on the admin screen.
    // Here they are refused outright, because this endpoint resolves the employee through
    // `requireByUserId` — the guarantee `EmployeesService` documents for every `/my/*`
    // route: the employee comes only from the authenticated token, so there is no
    // parameter to tamper with and no per-endpoint ownership check to forget later.
    // An `?employeeId=` on this route is the obvious way to have got it wrong.
    const refused = await http()
      .get('/my/punch/exceptions')
      .set(auth(siteToken))
      .expect(403);
    expect(refused.body.message).toMatch(/No employee record/i);

    // The employee whose punch it is still sees it, on the same route.
    const theirs = await http()
      .get('/my/punch/exceptions')
      .set(auth(employeeToken))
      .expect(200);
    expect(
      theirs.body.some(
        (r: { punch: { id: string } }) => r.punch.id === punchId,
      ),
    ).toBe(true);
  }, 30_000);

  it('scenario 5 — refuses an approval from somebody without that level, and records the attempt', async () => {
    const punchId = await flaggedPunch(5);

    // The item sits at level 1 (Site); HR holds level 2 and has no authority here yet.
    const res = await resolve(hrToken, punchId, {
      resolution: 'confirmed',
    }).expect(403);
    expect(res.body.code).toBe('APPROVAL_NOT_AUTHORISED');

    // FR-003: the attempt is recorded, not merely refused.
    const instance = await sys.approvalInstance.findFirst({
      where: { entityType: ACTION_ATTENDANCE_EXCEPTION, entityId: punchId },
    });
    const refusals = await sys.auditLogEntry.findMany({
      where: {
        companyId,
        entityType: 'APPROVAL_REFUSED',
        entityId: instance.id,
      },
    });
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0].accountId).toBe(hrUserId);

    // The punch is untouched by the refused attempt.
    const row = await rowFor(siteToken, punchId);
    expect(row.punch.exceptionResolution).toBe('pending');
    expect(row.approval.currentPosition).toBe(1);
  }, 30_000);

  it('walks all three levels, and only then is the punch confirmed (FR-007)', async () => {
    const punchId = await flaggedPunch(6);

    await resolve(siteToken, punchId, { resolution: 'confirmed' }).expect(201);
    expect((await rowFor(hrToken, punchId)).punch.exceptionResolution).toBe(
      'pending',
    );

    await resolve(hrToken, punchId, { resolution: 'confirmed' }).expect(201);
    expect(
      (await rowFor(directorToken, punchId)).punch.exceptionResolution,
    ).toBe('pending');

    const final = await resolve(directorToken, punchId, {
      resolution: 'confirmed',
    }).expect(201);

    expect(final.body.approval.state).toBe('approved');
    // The completion event fires synchronously in-process, so the punch is already in
    // step by the time the response is written.
    expect(final.body.punch.exceptionResolution).toBe('confirmed');

    // Three decisions, three different people, in order (FR-002, FR-009).
    const row = await rowFor(directorToken, punchId);
    expect(row.approval.latestDecision.levelLabel).toBe('Director');
    expect(row.approval.returnCount).toBe(0);
  }, 30_000);

  it('refuses a second decision by the same person even when they hold every level (FR-021a)', async () => {
    // The Super Admin case the specification calls out: one account holding all three
    // roles could otherwise approve its own work through the entire chain.
    const punchId = await flaggedPunch(7);
    const omni = await makeApprover('Omni', siteRoleId);
    await sys.userRole.create({
      data: { userId: omni.userId, roleId: hrRoleId, companyId },
    });
    await sys.userRole.create({
      data: { userId: omni.userId, roleId: finalRoleId, companyId },
    });

    // Re-login so the token carries the newly added roles.
    const relogin = await http()
      .post('/auth/login')
      .send({
        identifier: (
          await sys.user.findUnique({ where: { id: omni.userId } })
        ).email,
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    const omniToken = relogin.body.accessToken;

    await resolve(omniToken, punchId, { resolution: 'confirmed' }).expect(201);

    const second = await resolve(omniToken, punchId, {
      resolution: 'confirmed',
    }).expect(403);
    expect(second.body.code).toBe('APPROVAL_ALREADY_DECIDED');
    // Not "you lack permission" — this account holds every role in the chain, and saying
    // otherwise would send the one person who can change permissions to go and change
    // permissions that were never the problem.
    expect(second.body.code).not.toBe('APPROVAL_NOT_AUTHORISED');
  }, 30_000);
});
