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
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * The `/approvals` HTTP surface — spec US3 and US4 (016 T043 to T047).
 *
 * Driven over HTTP rather than through the container, because every claim in this file is
 * about the endpoint: that the badge count agrees with the list it is a badge for, that
 * paging does not skip an item while the queue drains, that the history endpoint refuses
 * the wrong reader, and that a settings screen cannot be reached without `SETTINGS`. None
 * of those are service behaviour.
 *
 * The queue is built from instances submitted directly through `ApprovalService`, with no
 * module behind them. That is deliberate: the spine stores `(entityType, entityId)` and
 * never dereferences it, so an entity id that points at nothing is not a degenerate
 * fixture — it is the design (research.md §1), and a queue that renders it proves the
 * opacity holds.
 *
 * Every fixture is prefixed `E2EQ` and removed in `afterAll`.
 */
const PREFIX = 'E2EQ';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const ACTION = 'e2eq_indent';

/**
 * Jest's 5s default is not enough for these: each test walks a multi-level chain over real
 * HTTP against a real database, and the suites run with `maxWorkers: 1` against one
 * Postgres. They pass comfortably in isolation and time out under full-suite contention,
 * which is a property of the harness and not of the code — so the budget is raised here
 * rather than the tests being split into something less like the thing they are testing.
 */
jest.setTimeout(30_000);

describe('Approvals HTTP surface (e2e)', () => {
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

  const userIds: string[] = [];
  const roleIds: string[] = [];

  let siteUserId: string;
  let hrUserId: string;
  let originatorUserId: string;
  let siteToken: string;
  let hrToken: string;
  let outsiderToken: string;
  let originatorToken: string;
  let settingsToken: string;

  /**
   * An account holding exactly the permissions given, plus optionally one chain role.
   *
   * Permission and chain role are set separately throughout this suite because they
   * answer different questions — the permission decides which screens you can reach, the
   * slot mapping decides whether you may act — and the tests below turn on the
   * difference.
   */
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

  const submit = async (entityId: string, subject: string) =>
    approvals.submit({
      companyId,
      actionType: ACTION,
      entityType: ACTION,
      entityId,
      originatorUserId,
      subject: `${PREFIX} ${subject}`,
      href: `/dashboard/inventory/indents/${entityId}`,
      viewPermission: Permission.INVENTORY,
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
        name: 'E2EQ Queue Constructions',
        shortCode: unique('Q').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    for (const label of ['Site', 'Hr', 'Final'] as const) {
      const role = await sys.role.create({
        data: { name: unique(`${label}Chain`), permissions: [] },
      });
      roleIds.push(role.id);
      if (label === 'Site') siteRoleId = role.id;
      if (label === 'Hr') hrRoleId = role.id;
      if (label === 'Final') finalRoleId = role.id;
    }

    const site = await makeUser('Site', [Permission.INVENTORY], siteRoleId);
    siteUserId = site.userId;
    siteToken = site.token;

    const hr = await makeUser('Hr', [Permission.INVENTORY], hrRoleId);
    hrUserId = hr.userId;
    hrToken = hr.token;

    // Holds no chain role and not the permission the items declare: the person the
    // history endpoint must refuse.
    outsiderToken = (await makeUser('Outsider', [Permission.ATTENDANCE])).token;

    // Raises the items, holds nothing else. Must still be able to read their history.
    const originator = await makeUser('Originator', []);
    originatorUserId = originator.userId;
    originatorToken = originator.token;

    settingsToken = (await makeUser('Settings', [Permission.SETTINGS])).token;

    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: siteUserId, ipAddress: '127.0.0.1' };

    for (const [slotKey, roleId] of [
      [SLOT_FIRST_APPROVER, siteRoleId],
      [SLOT_HR, hrRoleId],
      [SLOT_FINAL, finalRoleId],
    ] as const) {
      await chains.putSlotMapping(ctx, { companyId, slotKey, roleId }, actor);
    }

    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: ACTION,
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
    // Every fixture account logged in for a real token, and each login leaves a
    // RefreshToken row holding a foreign key to the user.
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // T047 — the queue
  // ───────────────────────────────────────────────────────────────────────────

  describe('GET /approvals/queue (US4, T044, T047)', () => {
    it('lists only what the caller can actually act on, and counts agree', async () => {
      const mine = await submit(unique('a'), 'Cement, 40 bags');
      const theirs = await submit(unique('b'), 'Steel, 2 tonnes');

      // Advance one item past the site level, so it now awaits HR and not the site.
      await http()
        .post(`/approvals/${theirs.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'approve' })
        .expect(201);

      const queue = await http()
        .get('/approvals/queue')
        .set(auth(siteToken))
        .expect(200);

      const ids = queue.body.items.map(
        (i: { instanceId: string }) => i.instanceId,
      );
      expect(ids).toContain(mine.instanceId);
      // Gone from the site's queue two ways over: it has moved to the HR level, and
      // FR-021a forbids this caller deciding on it a second time regardless.
      expect(ids).not.toContain(theirs.instanceId);

      const hrQueue = await http()
        .get('/approvals/queue')
        .set(auth(hrToken))
        .expect(200);
      expect(
        hrQueue.body.items.map((i: { instanceId: string }) => i.instanceId),
      ).toContain(theirs.instanceId);

      const count = await http()
        .get('/approvals/queue/count')
        .set(auth(siteToken))
        .expect(200);

      // The badge and the list are separate endpoints precisely so the badge is cheap.
      // Being separate is exactly why they can disagree, which is why this is asserted.
      expect(count.body.count).toBe(queue.body.items.length);
    });

    it('carries the subject, link, level and age the interface renders', async () => {
      const created = await submit(unique('c'), 'Sand, 3 loads');
      await sys.approvalInstance.update({
        where: { id: created.instanceId },
        data: { createdAt: new Date(Date.now() - 52 * 3_600_000) },
      });

      const queue = await http()
        .get('/approvals/queue')
        .set(auth(siteToken))
        .expect(200);

      const row = queue.body.items.find(
        (i: { instanceId: string }) => i.instanceId === created.instanceId,
      );
      expect(row).toMatchObject({
        actionType: ACTION,
        entityType: ACTION,
        subject: `${PREFIX} Sand, 3 loads`,
        levelLabel: 'First approver',
        currentPosition: 1,
        ageHours: 52,
      });
      // Supplied by the owning module at submit time — the spine cannot build it.
      expect(row.href).toContain('/dashboard/inventory/indents/');
    });

    it('pages by cursor, without repeating or skipping a row', async () => {
      const first = await http()
        .get('/approvals/queue?limit=1')
        .set(auth(siteToken))
        .expect(200);

      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await http()
        .get(`/approvals/queue?limit=1&cursor=${first.body.nextCursor}`)
        .set(auth(siteToken))
        .expect(200);

      expect(second.body.items[0].instanceId).not.toBe(
        first.body.items[0].instanceId,
      );
    });

    it('rejects a page size outside the documented range rather than clamping silently', async () => {
      await http()
        .get('/approvals/queue?limit=5000')
        .set(auth(siteToken))
        .expect(400);
    });

    it('is empty for somebody no chain level resolves to', async () => {
      const queue = await http()
        .get('/approvals/queue')
        .set(auth(outsiderToken))
        .expect(200);

      expect(queue.body.items).toEqual([]);
      const count = await http()
        .get('/approvals/queue/count')
        .set(auth(outsiderToken))
        .expect(200);
      expect(count.body.count).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T045 — deciding over HTTP
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /approvals/:instanceId/decide (US4, T045)', () => {
    it('advances the chain and hands back the updated view', async () => {
      const created = await submit(unique('d'), 'Bricks, 5000');

      const res = await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'approve' })
        .expect(201);

      expect(res.body).toMatchObject({
        state: 'pending',
        currentPosition: 2,
        levelLabel: 'HR',
      });
      // FR-008 on the record itself, without a second call.
      expect(res.body.latestDecision).toMatchObject({
        action: 'approve',
        actorUserId: siteUserId,
        levelLabel: 'First approver',
      });
    });

    it('refuses a reject with no reason, by code (FR-006)', async () => {
      const created = await submit(unique('e'), 'Tiles, 200 sq ft');

      const res = await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'reject' })
        .expect(400);

      expect(res.body.code).toBe('APPROVAL_REASON_REQUIRED');
    });

    it('refuses a caller whose roles do not hold the current level', async () => {
      const created = await submit(unique('f'), 'Paint, 20 litres');

      const res = await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(hrToken))
        .send({ action: 'approve' })
        .expect(403);

      // Distinguishable, because "wait your turn" and "you may never do this" have
      // different remedies.
      expect(res.body.code).toBe('APPROVAL_NOT_AUTHORISED');
    });

    it('reports an unmapped slot as a configuration fault, not a 403 (quickstart Pass 4)', async () => {
      const ctx = { isSuperAdmin: false, companyId };
      const actor = { userId: siteUserId, ipAddress: '127.0.0.1' };

      // A chain whose only level names a slot this company has never mapped. Its own
      // action type, so unmapping nothing disturbs the chains the rest of this suite
      // runs on.
      await chains.upsertChain(
        ctx,
        {
          companyId,
          actionType: 'e2eq_unmapped',
          levels: [{ position: 1, slotKey: 'e2eq_never_mapped' }],
        },
        actor,
      );
      const entityId = unique('u');
      const created = await approvals.submit({
        companyId,
        actionType: 'e2eq_unmapped',
        entityType: 'e2eq_unmapped',
        entityId,
        originatorUserId,
        subject: `${PREFIX} unmapped slot`,
        viewPermission: Permission.INVENTORY,
      });

      const res = await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'approve' })
        .expect(409);

      // 409, not 403. A bare "forbidden" would send an administrator hunting through
      // permissions for a problem that lives in a different screen entirely — and the
      // message has to say so, because the person who hits it is rarely the person who
      // can fix it.
      expect(res.body.code).toBe('APPROVAL_SLOT_UNMAPPED');
      expect(res.body.message).toContain('settings problem');
    });

    it('rejects a body the DTO does not recognise (Principle II)', async () => {
      const created = await submit(unique('g'), 'Gravel, 1 load');

      // A misspelt `reason` must not silently record an unexplained rejection.
      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'reject', resaon: 'typo' })
        .expect(400);

      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'maybe' })
        .expect(400);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T042, T043 — attribution and history
  // ───────────────────────────────────────────────────────────────────────────

  describe('GET /approvals/:entityType/:entityId/history (US3, T043)', () => {
    let entityId: string;

    beforeAll(async () => {
      entityId = unique('h');
      const created = await submit(entityId, 'Shuttering ply, 30 sheets');
      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(siteToken))
        .send({ action: 'approve' })
        .expect(201);
      await http()
        .post(`/approvals/${created.instanceId}/decide`)
        .set(auth(hrToken))
        .send({
          action: 'return',
          reason: 'Quantity looks high for this stage.',
        })
        .expect(201);
    });

    it('returns the sequence oldest first, with actor, action, time and reason', async () => {
      const res = await http()
        .get(`/approvals/${ACTION}/${entityId}/history`)
        .set(auth(siteToken))
        .expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({
        position: 1,
        levelLabel: 'First approver',
        action: 'approve',
        actorUserId: siteUserId,
      });
      expect(res.body[1]).toMatchObject({
        position: 2,
        levelLabel: 'HR',
        action: 'return',
        reason: 'Quantity looks high for this stage.',
      });
      expect(new Date(res.body[0].decidedAt).getTime()).toBeLessThanOrEqual(
        new Date(res.body[1].decidedAt).getTime(),
      );
    });

    it('refuses a caller who may not view the item (US3 scenario 4)', async () => {
      const res = await http()
        .get(`/approvals/${ACTION}/${entityId}/history`)
        .set(auth(outsiderToken))
        .expect(403);

      expect(res.body.code).toBe('APPROVAL_VIEW_FORBIDDEN');
    });

    it('lets the person who raised it read it, permission or not', async () => {
      const res = await http()
        .get(`/approvals/${ACTION}/${entityId}/history`)
        .set(auth(originatorToken))
        .expect(200);

      // They hold no INVENTORY permission at all. Being told why your own correction was
      // returned is not a privilege that needs one.
      expect(res.body).toHaveLength(2);
    });

    it('still names an actor whose account has since been deactivated (FR-008)', async () => {
      await sys.user.update({
        where: { id: hrUserId },
        data: { status: 'deactivated' },
      });

      try {
        const res = await http()
          .get(`/approvals/${ACTION}/${entityId}/history`)
          .set(auth(siteToken))
          .expect(200);

        const byHr = res.body.find(
          (d: { actorUserId: string }) => d.actorUserId === hrUserId,
        );
        // History that cannot say who acted is not history.
        expect(byHr.actorName).toContain(PREFIX);
        expect(byHr.actorName).not.toBe('Unknown user');
      } finally {
        await sys.user.update({
          where: { id: hrUserId },
          data: { status: 'active' },
        });
      }
    });

    it('is empty, not a refusal, for an item that was never submitted', async () => {
      const res = await http()
        .get(`/approvals/${ACTION}/never-existed/history`)
        .set(auth(outsiderToken))
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T046 — the settings surface, without which the slots are never mapped
  // ───────────────────────────────────────────────────────────────────────────

  describe('chain configuration (T046)', () => {
    it('needs SETTINGS, which approval authority does not grant', async () => {
      // The site approver decides on real money every day and still may not redefine
      // who decides. The two are separate on purpose.
      await http().get('/approvals/chains').set(auth(siteToken)).expect(403);
      await http()
        .get('/approvals/slot-mappings')
        .set(auth(siteToken))
        .expect(403);
    });

    it('lists every canonical slot, so an unmapped one is visible as a gap', async () => {
      const res = await http()
        .get('/approvals/slot-mappings')
        .set(auth(settingsToken))
        .expect(200);

      const keys = res.body.slots.map((s: { slotKey: string }) => s.slotKey);
      expect(keys).toEqual(
        expect.arrayContaining([SLOT_FIRST_APPROVER, SLOT_HR, SLOT_FINAL]),
      );
      const hr = res.body.slots.find(
        (s: { slotKey: string }) => s.slotKey === SLOT_HR,
      );
      expect(hr).toMatchObject({ label: 'HR', roleId: hrRoleId });
    });

    it('refuses a mapping that would make an active chain unsatisfiable (FR-021b)', async () => {
      // `hr` and `final` both resolving to one role means nobody can complete the chain,
      // because FR-021a forbids the same person deciding twice. Refused at the settings
      // edit, because the alternative symptom is a run that silently stops moving.
      const res = await http()
        .put('/approvals/slot-mappings')
        .set(auth(settingsToken))
        .send({ slotKey: SLOT_FINAL, roleId: hrRoleId })
        .expect(400);

      expect(res.body.code).toBe('APPROVAL_CHAIN_UNSATISFIABLE');
      // Both conflicting levels named — otherwise an administrator is left diffing
      // chain definitions by hand.
      expect(res.body.message).toContain('HR');
    });

    it('defines a chain and reads it back', async () => {
      const created = await http()
        .post('/approvals/chains')
        .set(auth(settingsToken))
        .send({
          actionType: 'e2eq_secondary',
          levels: [
            { position: 1, slotKey: SLOT_HR },
            { position: 2, slotKey: SLOT_FINAL, isFinalAuthority: true },
          ],
        })
        .expect(201);

      expect(created.body.levels).toHaveLength(2);

      const list = await http()
        .get('/approvals/chains')
        .set(auth(settingsToken))
        .expect(200);

      expect(
        list.body.some(
          (c: { actionType: string }) => c.actionType === 'e2eq_secondary',
        ),
      ).toBe(true);
    });

    it('refuses a chain whose positions are not contiguous', async () => {
      // A hole at position 2 stalls every item that reaches it, with no error raised
      // anywhere — so it is refused when written, not when somebody waits.
      await http()
        .post('/approvals/chains')
        .set(auth(settingsToken))
        .send({
          actionType: 'e2eq_broken',
          levels: [
            { position: 1, slotKey: SLOT_FIRST_APPROVER },
            { position: 3, slotKey: SLOT_FINAL },
          ],
        })
        .expect(400);
    });
  });
});
