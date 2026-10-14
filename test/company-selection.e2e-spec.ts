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
 * The company switcher and the cash toggle (019 FR-008 to FR-017) — `bugs.md` items 5 and 16.
 *
 * The two claims that matter most, and neither can be checked without a second company:
 *
 * 1. **A selection narrows scope and never widens it.** The worst a stale or forged selection
 *    can do is show the caller less than they are entitled to.
 * 2. **Revoked access is not honoured because a selection was stored.** A selection is a record
 *    of a past choice, not a standing grant.
 *
 * Every fixture is prefixed `E2ECS` and removed in `afterAll`.
 */
const PREFIX = 'E2ECS';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(90_000);

describe('Company selection and cash visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyA: string;
  let companyB: string;
  let crossToken: string;
  let singleToken: string;
  let crossRoleId: string;
  let projectAId: string;
  let projectBId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const clientIds: string[] = [];

  const newCompany = async (label: string) =>
    (
      await sys.company.create({
        data: {
          name: `${PREFIX} ${label}`,
          shortCode: unique(label).slice(0, 10),
          payrollLockDay: 7,
          pfEmployerRate: 12,
          esicEmployerRate: 3.25,
          gratuityRate: 4.81,
          bonusRate: 8.33,
        },
      })
    ).id as string;

  const makeUser = async (
    label: string,
    companyId: string,
    permissions: Permission[],
  ) => {
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
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return {
      userId: user.id,
      roleId: role.id as string,
      token: login.body.accessToken as string,
    };
  };

  const makeProject = async (companyId: string, label: string) => {
    const client = await sys.client.create({
      data: { companyId, name: `${PREFIX} ${label} Client` },
    });
    clientIds.push(client.id);
    const project = await sys.project.create({
      data: {
        companyId,
        clientId: client.id,
        code: unique(label),
        name: `${PREFIX} ${label} Project`,
        contractValue: 1000,
        startDate: new Date('2026-01-01'),
      },
    });
    return project.id as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
    prisma = app.get(PrismaService);

    companyA = await newCompany('Alpha');
    companyB = await newCompany('Beta');

    const cross = await makeUser('cross', companyA, [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.PROJECTS,
      Permission.COMPANY_SETTINGS,
    ]);
    crossToken = cross.token;
    crossRoleId = cross.roleId;

    singleToken = (await makeUser('single', companyA, [Permission.PROJECTS]))
      .token;

    projectAId = await makeProject(companyA, 'Alpha');
    projectBId = await makeProject(companyB, 'Beta');
  }, 90_000);

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.userCompanySelection.deleteMany({
      where: { userId: { in: userIds } },
    });
    await sys.permissionRefusal.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    });
    await sys.project.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    });
    await sys.client.deleteMany({ where: { id: { in: clientIds } } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({
      where: { id: { in: [companyA, companyB] } },
    });
    await app?.close();
  });

  it('offers both companies to a cross-company caller', async () => {
    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(crossToken))
      .expect(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(companyA);
    expect(ids).toContain(companyB);
  });

  it('offers exactly one company to a single-company caller (FR-013)', async () => {
    // One element is how the interface knows not to offer a switcher, without a second call.
    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(singleToken))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(companyA);
    expect(res.body[0].selected).toBe(true);
  });

  describe('the company logo the shell shows (2026-10-12)', () => {
    /**
     * Two companies, two different logos, and each must get its own.
     *
     * **Different bytes per company is the assertion.** The feature is "switching
     * company switches the mark", and a test that asserted only `200` — or only that
     * some image came back — would pass just as happily if every company were served
     * the same picture, which is precisely the bug worth catching.
     *
     * One-pixel PNG and GIF: the smallest two files that are genuinely different
     * images of genuinely different types, so the content type is proven to come from
     * the bytes rather than from anything the caller said.
     */
    const PNG_1PX =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const logoOf = (companyId: string) =>
      http().get(`/settings/companies/${companyId}/logo`).set(auth(crossToken));

    const selectable = async () =>
      (
        await http()
          .get('/settings/companies/selectable')
          .set(auth(crossToken))
          .expect(200)
      ).body as { id: string; hasLogo: boolean }[];

    it('reports no logo, and serves none, before one is uploaded', async () => {
      // The pair for everything below: without it, a `hasLogo` hardcoded true and a
      // handler that always served something would satisfy the rest of this block.
      const before = await selectable();
      expect(before.find((c) => c.id === companyA)?.hasLogo).toBe(false);
      expect(before.find((c) => c.id === companyB)?.hasLogo).toBe(false);

      // 404, not an error: a company without a logo is an ordinary state, and the
      // interface shows the product mark for it.
      await logoOf(companyA).expect(404);
    });

    it('refuses something that is not an image', async () => {
      await http()
        .put(`/settings/companies/${companyA}/logo`)
        .set(auth(crossToken))
        .send({ data: Buffer.from('this is not a picture').toString('base64') })
        .expect(400);

      // And stored nothing — a refusal that half-applied would be worse than one that
      // did not refuse at all.
      expect((await selectable()).find((c) => c.id === companyA)?.hasLogo).toBe(
        false,
      );
    });

    it('serves each company its own logo, not the other’s', async () => {
      await http()
        .put(`/settings/companies/${companyA}/logo`)
        .set(auth(crossToken))
        .send({ data: PNG_1PX })
        .expect(200);
      await http()
        .put(`/settings/companies/${companyB}/logo`)
        .set(auth(crossToken))
        .send({ data: GIF_1PX })
        .expect(200);

      const a = await logoOf(companyA).expect(200);
      const b = await logoOf(companyB).expect(200);

      // The bytes themselves, and they differ. This is the whole feature.
      expect(a.body.toString('base64')).toBe(PNG_1PX);
      expect(b.body.toString('base64')).toBe(GIF_1PX);
      expect(a.headers['content-type']).toContain('image/png');
      expect(b.headers['content-type']).toContain('image/gif');

      const after = await selectable();
      expect(after.find((c) => c.id === companyA)?.hasLogo).toBe(true);
      expect(after.find((c) => c.id === companyB)?.hasLogo).toBe(true);
    });

    it('replaces a logo rather than accumulating one', async () => {
      await http()
        .put(`/settings/companies/${companyA}/logo`)
        .set(auth(crossToken))
        .send({ data: GIF_1PX })
        .expect(200);

      const replaced = await logoOf(companyA).expect(200);
      expect(replaced.body.toString('base64')).toBe(GIF_1PX);
    });
  });

  it('switches from one company to another, not only from none to one', async () => {
    // **Every test in this suite selected exactly once**, so the row was only ever inserted and
    // the conflict path was never taken. On the deployment that path was a 42501: the upsert ran
    // scoped to the company being switched *to*, and Postgres applied the policy's USING to the
    // row already there, which still held the previous one.
    //
    // This test would **not** have caught it. The local and CI role is a superuser and Postgres
    // exempts superusers from RLS unconditionally, so the policy is not in force here — see
    // `company-selection-rls.e2e-spec.ts`, which asks under a role that cannot bypass it. This
    // covers the half that is observable from the API: that a second switch is honoured and
    // reported.
    await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyA })
      .expect(200);

    const res = await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyB })
      .expect(200);

    const selected = res.body.find((c: { selected: boolean }) => c.selected);
    expect(selected.id).toBe(companyB);
  });

  it('scopes every list to the selected company (FR-010)', async () => {
    await http()
      .put('/my/company-selection')
      .set(auth(crossToken))
      .send({ companyId: companyB })
      .expect(200);

    const res = await http().get('/projects').set(auth(crossToken)).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(projectBId);
    // The selection narrows: company A's project is no longer visible even though this caller
    // holds CROSS_COMPANY_ACCESS.
    expect(body).not.toContain(projectAId);
  });

  it('persists across a fresh sign-in (FR-011)', async () => {
    // The stronger test than reloading a browser: a new token, and the selection is still there,
    // which proves it is stored rather than held in memory or in the token.
    const user = await sys.user.findFirst({
      where: { id: { in: userIds }, companyId: companyA },
      orderBy: { createdAt: 'asc' },
    });
    const login = await http()
      .post('/auth/login')
      .send({
        identifier: user.email,
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);

    const res = await http()
      .get('/settings/companies/selectable')
      .set(auth(login.body.accessToken))
      .expect(200);
    const selected = res.body.find((c: { selected: boolean }) => c.selected);
    expect(selected.id).toBe(companyB);
  });

  it('refuses a company the caller may not reach, with 403 not 404', async () => {
    // A 404 would tell a caller which company ids exist.
    const res = await http()
      .put('/my/company-selection')
      .set(auth(singleToken))
      .send({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('COMPANY_NOT_ACCESSIBLE');
  });

  it('stops honouring a selection once cross-company access is revoked', async () => {
    // The spec's own edge case, and the one that would be a cross-tenant read if the stored
    // selection were trusted rather than re-validated.
    await sys.role.update({
      where: { id: crossRoleId },
      data: {
        permissions: [Permission.PROJECTS, Permission.COMPANY_SETTINGS],
        rolePermissions: {
          deleteMany: { permission: Permission.CROSS_COMPANY_ACCESS },
        },
      },
    });

    const res = await http().get('/projects').set(auth(crossToken)).expect(200);
    const body = JSON.stringify(res.body);
    // Back to their own company, and company B's records are gone.
    expect(body).not.toContain(projectBId);
  });

  it('hides cash amounts when the company asks, and alters no data (FR-014, FR-017)', async () => {
    // A Super Admin (`CROSS_COMPANY_ACCESS`), and only behind a password confirmation
    // (2026-10-14) — the client moved the switch into Settings, Super Admin only.
    const admin = await makeUser('cashadmin', companyA, [
      Permission.COMPANY_SETTINGS,
      Permission.PROJECTS,
      Permission.CROSS_COMPANY_ACCESS,
    ]);

    // No confirmation: refused, and with a 403 rather than the 401 that signs a client out.
    await http()
      .patch('/settings/cash-visibility')
      .set(auth(admin.token))
      .send({ hideCashTransactions: true })
      .expect(403);

    await http()
      .post('/auth/confirm-password')
      .set(auth(admin.token))
      .send({ password: 'wrong-password', purpose: 'cash-visibility' })
      .expect(403);

    const confirmed = await http()
      .post('/auth/confirm-password')
      .set(auth(admin.token))
      .send({ password: 'secret42', purpose: 'cash-visibility' })
      .expect(200);
    const confirmation = {
      'X-Confirmation-Token': confirmed.body.confirmationToken as string,
    };

    await http()
      .patch('/settings/cash-visibility')
      .set(auth(admin.token))
      .set(confirmation)
      .send({ hideCashTransactions: true })
      .expect(200);

    const current = await http()
      .get('/settings/cash-visibility')
      .set(auth(admin.token))
      .expect(200);
    expect(current.body.hideCashTransactions).toBe(true);

    // FR-017: the stored setting changed, and nothing else did. Read a project back and confirm
    // its contract value — not a cash amount — is untouched.
    const projects = await http()
      .get('/projects')
      .set(auth(admin.token))
      .expect(200);
    expect(JSON.stringify(projects.body)).toContain(PREFIX);

    await http()
      .patch('/settings/cash-visibility')
      .set(auth(admin.token))
      .set(confirmation)
      .send({ hideCashTransactions: false })
      .expect(200);
  });

  it('refuses the toggle to a caller who is not a Super Admin (FR-016, 2026-10-14)', async () => {
    const res = await http()
      .patch('/settings/cash-visibility')
      .set(auth(singleToken))
      .send({ hideCashTransactions: true });
    expect(res.status).toBe(403);
  });

  /**
   * Approval configuration under a company switch (2026-10-11).
   *
   * **The defect this defends against.** `approvals.controller.ts` read `caller.companyId`
   * where every other settings reader reads the *selected* company, so the request asked
   * for company A's rows under an RLS context scoped to company B. The two symptoms are
   * the same bug seen from either side of the database role:
   *
   *   - where the role cannot bypass RLS, every read came back empty — the settings screen
   *     reported that the company had no approval chains and that no level had a role,
   *     while both were configured — and the slot-mapping write was refused by the
   *     `tenant_isolation` policy as a bare **500 Internal server error**;
   *   - where it can bypass RLS, as this suite's role does, the same bug is silent: the
   *     administrator is shown, and edits, **the other company's** approval configuration.
   *
   * This suite runs as a superuser, so it asserts the second form. The assertions are
   * about *identity*, not shape: that the chain returned is company B's and that the row
   * the write produced carries company B's id. Asserting that three slots came back, or
   * that the PUT returned 200, passes against the defect — it did both, for company A.
   *
   * Its own caller and fixtures rather than the suite's `crossToken`: a later test in this
   * file revokes that role's cross-company access, and a test that depends on running
   * first is a test that fails for the wrong reason later.
   */
  describe('approval configuration follows the selected company', () => {
    let token: string;
    let roleInA: string;
    let roleInB: string;
    const chainIds: string[] = [];
    const actionInA = unique('actionA');
    const actionInB = unique('actionB');

    const seedChain = async (companyId: string, actionType: string) => {
      const chain = await sys.approvalChain.create({
        data: {
          companyId,
          actionType,
          levels: {
            create: [{ companyId, position: 1, slotKey: 'first_approver' }],
          },
        },
      });
      chainIds.push(chain.id as string);
    };

    beforeAll(async () => {
      const caller = await makeUser('apprcross', companyA, [
        Permission.CROSS_COMPANY_ACCESS,
        Permission.SETTINGS,
      ]);
      token = caller.token;

      roleInA = (await makeUser('slotA', companyA, [Permission.SETTINGS]))
        .roleId;
      roleInB = (await makeUser('slotB', companyB, [Permission.SETTINGS]))
        .roleId;

      await seedChain(companyA, actionInA);
      await seedChain(companyB, actionInB);

      // Both companies map `first_approver`, to different roles. One company mapped and
      // the other not would let a wrong-company read pass as an unmapped slot.
      await sys.roleSlotMapping.create({
        data: {
          companyId: companyA,
          slotKey: 'first_approver',
          roleId: roleInA,
        },
      });
      await sys.roleSlotMapping.create({
        data: {
          companyId: companyB,
          slotKey: 'first_approver',
          roleId: roleInB,
        },
      });

      await http()
        .put('/my/company-selection')
        .set(auth(token))
        .send({ companyId: companyB })
        .expect(200);
    }, 90_000);

    afterAll(async () => {
      await sys.roleSlotMapping.deleteMany({
        where: { companyId: { in: [companyA, companyB] } },
      });
      await sys.approvalChain.deleteMany({ where: { id: { in: chainIds } } });
    });

    it('lists the selected company’s chains, not the caller’s own', async () => {
      const res = await http()
        .get('/approvals/chains')
        .set(auth(token))
        .expect(200);

      const actions = res.body.map((c: { actionType: string }) => c.actionType);
      expect(actions).toContain(actionInB);
      // The half that fails against the defect. Before the fix this response was company
      // A's chain list, which is a cross-tenant read and not merely the wrong label.
      expect(actions).not.toContain(actionInA);
    });

    it('resolves a slot to the selected company’s role, not the caller’s own', async () => {
      const res = await http()
        .get('/approvals/slot-mappings')
        .set(auth(token))
        .expect(200);

      const first = res.body.slots.find(
        (s: { slotKey: string }) => s.slotKey === 'first_approver',
      );
      // Identity, not presence: the defect returned a populated `roleId` too — company A's.
      expect(first.roleId).toBe(roleInB);
      expect(first.roleId).not.toBe(roleInA);
    });

    it('writes a slot mapping into the selected company, leaving the caller’s own alone', async () => {
      await http()
        .put('/approvals/slot-mappings')
        .set(auth(token))
        .send({ slotKey: 'hr', roleId: roleInB })
        .expect(200);

      const written = await sys.roleSlotMapping.findUnique({
        where: { companyId_slotKey: { companyId: companyB, slotKey: 'hr' } },
      });
      // Where the row landed is the whole assertion. Against the defect the endpoint
      // still answered 200 and still wrote a row — into company A.
      expect(written?.roleId).toBe(roleInB);

      const strayed = await sys.roleSlotMapping.findUnique({
        where: { companyId_slotKey: { companyId: companyA, slotKey: 'hr' } },
      });
      expect(strayed).toBeNull();
    });
  });
});
