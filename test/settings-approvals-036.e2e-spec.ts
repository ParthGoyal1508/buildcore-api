import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessLevel, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Feature 036 stream 3a — settings, approvals, dashboard, observed through the HTTP API.
 *
 * - C1/C2: a role-set save adds a role without removing the others; an empty set is refused.
 * - C5: the Users list answers a page when asked, the bare array otherwise, and searches.
 * - D1: approval history date range, search and CSV export; a From after the To is refused.
 * - D6: the bell counts unread notifications; Mark all read clears the count, not the list.
 * - E2: a report range must be real and ordered.
 * - E3: the activity log takes a custom range, a user and a search; its User picker lists accounts.
 *
 * Every fixture is prefixed `E2E3A` and removed in `afterAll`.
 */
const PREFIX = 'E2E3A';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(120_000);

describe('Settings, approvals, dashboard (036 3a, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyId: string;
  let adminToken: string;
  let adminId: string;
  let targetId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const newRole = async (label: string, permissions: Permission[]) => {
    const role = await sys.role.create({
      data: {
        name: unique(`${label}Role`),
        permissions,
        rolePermissions: {
          create: permissions.flatMap((permission) => [
            { permission, level: AccessLevel.read },
            { permission, level: AccessLevel.write },
          ]),
        },
      },
    });
    roleIds.push(role.id);
    return role.id as string;
  };

  const newUser = async (label: string, roles: string[]) => {
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
    for (const roleId of roles) {
      await sys.userRole.create({
        data: { userId: user.id, roleId, companyId },
      });
    }
    return user as { id: string; email: string };
  };

  const login = async (email: string) =>
    (
      await http()
        .post('/auth/login')
        .send({ identifier: email, password: 'secret42', rememberMe: false })
        .expect(201)
    ).body.accessToken as string;

  let roleA: string;
  let roleB: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Dummy Settings Test Firm`,
        shortCode: unique('C').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const adminRole = await newRole('admin', [
      Permission.USER_MANAGEMENT,
      Permission.DASHBOARD,
      Permission.REPORTS,
      Permission.EMPLOYEES,
      Permission.MY_WORKSPACE,
    ]);
    roleA = await newRole('a', [Permission.MY_WORKSPACE]);
    roleB = await newRole('b', [Permission.DASHBOARD]);

    const admin = await newUser('admin', [adminRole]);
    adminId = admin.id;
    adminToken = await login(admin.email);
    targetId = (await newUser('target', [roleA])).id;
  });

  afterAll(async () => {
    await sys.notification.deleteMany({ where: { userId: { in: userIds } } });
    await sys.exportJob.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.permissionRefusal.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    if (app) await app.close();
  });

  describe('Users (C1, C2, C5)', () => {
    it('adds a role to the set without removing the one already held', async () => {
      const res = await http()
        .patch(`/settings/users/${targetId}`)
        .set(auth(adminToken))
        .send({ roleIds: [roleA, roleB] })
        .expect(200);
      expect(res.body.roles.map((r: { id: string }) => r.id).sort()).toEqual(
        [roleA, roleB].sort(),
      );

      const removed = await http()
        .patch(`/settings/users/${targetId}`)
        .set(auth(adminToken))
        .send({ roleIds: [roleB] })
        .expect(200);
      expect(removed.body.roles.map((r: { id: string }) => r.id)).toEqual([
        roleB,
      ]);
    });

    it('refuses an empty role set rather than reporting a save that changed nothing', async () => {
      await http()
        .patch(`/settings/users/${targetId}`)
        .set(auth(adminToken))
        .send({ roleIds: [] })
        .expect(400);
    });

    it('answers a page when asked, and searches', async () => {
      const page = await http()
        .get('/settings/users')
        .query({ page: 1, pageSize: 1, q: `${PREFIX} target` })
        .set(auth(adminToken))
        .expect(200);
      expect(page.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
      expect(page.body.items[0].id).toBe(targetId);

      const bare = await http()
        .get('/settings/users')
        .set(auth(adminToken))
        .expect(200);
      expect(Array.isArray(bare.body)).toBe(true);
      expect(bare.body.map((u: { id: string }) => u.id)).toEqual(
        expect.arrayContaining([adminId, targetId]),
      );
    });
  });

  describe('Approval history (D1)', () => {
    it('filters by date range and search, and refuses a From after the To', async () => {
      const res = await http()
        .get('/approvals/history')
        .query({
          status: 'all',
          from: '2026-10-01',
          to: '2026-10-31',
          q: 'nothing-matches-this',
        })
        .set(auth(adminToken))
        .expect(200);
      expect(res.body).toMatchObject({ items: [], total: 0 });

      const bad = await http()
        .get('/approvals/history')
        .query({ from: '2026-10-05', to: '2026-10-01' })
        .set(auth(adminToken))
        .expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    });

    it('exports the filtered history as CSV', async () => {
      const res = await http()
        .get('/approvals/history/export')
        .query({ status: 'all' })
        .set(auth(adminToken))
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\r\n')[0]).toContain('Subject');
    });
  });

  describe('Notifications inbox (D6)', () => {
    it('counts unread, and Mark all read clears the count but not the list', async () => {
      // A finished export the caller has not been told about: the one provider whose row this
      // test can create without a whole approval chain.
      await sys.exportJob.create({
        data: {
          reportType: 'employee',
          format: 'excel',
          filters: {},
          status: 'ready',
          requestedByUserId: adminId,
          companyId,
          completedAt: new Date(),
        },
      });

      const before = await http()
        .get('/notifications/count')
        .set(auth(adminToken))
        .expect(200);
      expect(before.body.count).toBeGreaterThanOrEqual(1);

      const all = await http()
        .post('/notifications/read-all')
        .set(auth(adminToken))
        .expect(200);
      expect(all.body.updated).toBe(before.body.count);

      const after = await http()
        .get('/notifications/count')
        .set(auth(adminToken))
        .expect(200);
      expect(after.body).toEqual({ count: 0, total: before.body.total });

      const list = await http()
        .get('/notifications')
        .set(auth(adminToken))
        .expect(200);
      const ready = list.body.find(
        (n: { type: string }) => n.type === 'export_ready',
      );
      expect(ready).toMatchObject({ read: true });
      expect(typeof ready.id).toBe('string');
    });

    it('answers 404 for marking a notification that is not the caller’s', async () => {
      await http()
        .post('/notifications/not-a-notification/read')
        .set(auth(adminToken))
        .expect(404);
    });
  });

  describe('Reports and activity log (E2, E3)', () => {
    it('refuses a report range whose From is after its To, or not a real date', async () => {
      const after = await http()
        .post('/reports/employee/run')
        .set(auth(adminToken))
        .send({ fromDate: '2026-10-05', toDate: '2026-10-01' })
        .expect(400);
      expect(after.body.code).toBe('VALIDATION_FAILED');
      await http()
        .post('/reports/employee/run')
        .set(auth(adminToken))
        .send({ fromDate: '2026-02-30' })
        .expect(400);
      // An empty box is no date, not a malformed one.
      await http()
        .post('/reports/employee/run')
        .set(auth(adminToken))
        .send({ fromDate: '', toDate: '' })
        .expect(201);
    });

    it('takes a custom range, a user and a search; lists users for the filter', async () => {
      await sys.auditLogEntry.create({
        data: {
          entityType: 'USER_ACCOUNT',
          action: 'UPDATE',
          entityId: targetId,
          companyId,
          accountId: adminId,
          ipAddress: '127.0.0.1',
        },
      });
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
      }).format(new Date());
      const res = await http()
        .get('/activity-log')
        .query({ from: today, to: today, userId: adminId, q: `${PREFIX} admin` })
        .set(auth(adminToken))
        .expect(200);
      expect(
        res.body.entries.some((e: { target: string }) => e.target === targetId),
      ).toBe(true);

      const users = await http()
        .get('/activity-log/users')
        .query({ q: `${PREFIX} target` })
        .set(auth(adminToken))
        .expect(200);
      expect(users.body.items).toEqual([
        { id: targetId, name: `${PREFIX} target` },
      ]);
    });
  });
});
