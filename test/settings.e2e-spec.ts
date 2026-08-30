import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { ReferenceDataService } from '../src/settings/reference-data/reference-data.service';
import { EmployeeCodeService } from '../src/settings/employee-code/employee-code.service';
import { CompaniesService } from '../src/settings/companies/companies.service';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * End-to-end coverage of the whole `/settings/*` surface, against a real database —
 * required by the constitution for endpoints touching auth or PII-adjacent admin
 * actions, which role management and user administration both are.
 *
 * Every fixture this suite creates is prefixed `E2E` and removed in `afterAll`, so
 * it can run repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Settings module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;

  /**
   * Fixture access that sets the same system/bypass RLS context the application
   * uses for its own system-level writes.
   *
   * Direct `prisma.*` calls only work when the connecting Postgres role bypasses
   * row-level security — true of a superuser, false of a correctly provisioned
   * application role. Going through this facade lets the suite pass under either,
   * and means the fixtures exercise the policies rather than sidestepping them.
   */
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

  let superAdminToken: string;
  let limitedToken: string;
  let limitedUserId: string;
  let scopedUserId: string;
  let companyId: string;
  let otherCompanyId: string;
  let viewerRoleId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // `bodyParser: false` + configureApp() applies the SAME parsers and pipes
    // main.ts does, rather than hand-copying a subset of them. Mirroring by hand is
    // what previously let the suite pass against an app configured differently from
    // the deployed one — see configure-app.ts.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    // The seeded Super Admin account (prisma/seed.ts).
    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    superAdminToken = login.body.accessToken;

    // A second account holding only the Viewer role — the "any other role" case
    // FR-014 requires to be rejected.
    const viewer = await sys.role.findUniqueOrThrow({
      where: { name: 'Viewer' },
    });
    viewerRoleId = viewer.id;
    const limited = await sys.user.create({
      data: {
        email: `${unique('limited')}@example.test`,
        username: unique('limited'),
        password: await hash('secret42'),
        firstname: 'Limited',
        lastname: 'User',
      },
    });
    limitedUserId = limited.id;
    await sys.userRole.create({
      data: { userId: limited.id, roleId: viewer.id },
    });
    const limitedLogin = await http()
      .post('/auth/login')
      .send({
        identifier: limited.email,
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    limitedToken = limitedLogin.body.accessToken;
  });

  afterAll(async () => {
    // Children first — every settings table FKs back to Company.
    const companies = await sys.company.findMany({
      where: { shortCode: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = companies.map((c) => c.id);
    if (ids.length) {
      await sys.employeeCodeSequence.deleteMany({
        where: { companyId: { in: ids } },
      });
      await sys.documentType.deleteMany({
        where: { companyId: { in: ids } },
      });
      await sys.department.deleteMany({ where: { companyId: { in: ids } } });
      await sys.designation.deleteMany({
        where: { companyId: { in: ids } },
      });
      await sys.shift.deleteMany({ where: { companyId: { in: ids } } });
      await sys.company.deleteMany({ where: { id: { in: ids } } });
    }
    await sys.role.deleteMany({ where: { name: { startsWith: PREFIX } } });
    for (const id of [limitedUserId, scopedUserId].filter(Boolean)) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.user.deleteMany({ where: { id } });
    }
    await app.close();
  });

  // ---------------------------------------------------------------- User Story 1
  describe('Companies (US1)', () => {
    it('creates a company (T022)', async () => {
      const res = await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'E2E Demo Constructions',
          shortCode: unique('DC').slice(0, 10),
          gstin: '27AAPFU0939F1ZV',
          pan: 'AAPFU0939F',
          payrollLockDay: 7,
        })
        .expect(201);

      companyId = res.body.id;
      expect(res.body.status).toBe('active');
      // Omitted rates fall back to SettingsConfig (FR-002).
      expect(res.body.pfEmployerRate).toBe(12);
      expect(res.body.esicEmployerRate).toBe(3.25);
      expect(res.body.gratuityRate).toBe(4.81);
      expect(res.body.bonusRate).toBe(8.33);
    });

    it('rejects a duplicate short code with 409, case-insensitively (T022, FR-004)', async () => {
      const company = await sys.company.findUniqueOrThrow({
        where: { id: companyId },
      });
      await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'Clashing',
          shortCode: company.shortCode.toLowerCase(),
          payrollLockDay: 7,
        })
        .expect(409);
    });

    it('rejects a malformed GSTIN or PAN with 400 (T022, research.md §10)', async () => {
      await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'Bad GSTIN',
          shortCode: unique('BG').slice(0, 10),
          gstin: 'NOPE',
          payrollLockDay: 7,
        })
        .expect(400);

      await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'Bad PAN',
          shortCode: unique('BP').slice(0, 10),
          pan: 'AAPFU0939',
          payrollLockDay: 7,
        })
        .expect(400);
    });

    it('rejects an unexpected field (Principle II)', async () => {
      await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'X',
          shortCode: unique('X').slice(0, 10),
          payrollLockDay: 7,
          nonsense: true,
        })
        .expect(400);
    });

    it('edits payroll rates and persists them (T023)', async () => {
      await http()
        .patch(`/settings/companies/${companyId}`)
        .set(auth(superAdminToken))
        .send({ pfEmployerRate: 10.5, bonusRate: 9 })
        .expect(200);

      const res = await http()
        .get(`/settings/companies/${companyId}`)
        .set(auth(superAdminToken))
        .expect(200);
      expect(res.body.pfEmployerRate).toBe(10.5);
      expect(res.body.bonusRate).toBe(9);
    });

    it('excludes a deactivated company from other modules but keeps it listed (T023, FR-005)', async () => {
      const created = await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'E2E Dormant',
          shortCode: unique('DM').slice(0, 10),
          payrollLockDay: 7,
        })
        .expect(201);
      otherCompanyId = created.body.id;

      await http()
        .patch(`/settings/companies/${otherCompanyId}`)
        .set(auth(superAdminToken))
        .send({ status: 'inactive' })
        .expect(200);

      const adminList = await http()
        .get('/settings/companies')
        .set(auth(superAdminToken))
        .expect(200);
      expect(adminList.body.map((c: { id: string }) => c.id)).toContain(
        otherCompanyId,
      );

      const forOtherModules = await app
        .get(CompaniesService)
        .listActiveForOtherModules();
      expect(forOtherModules.map((c) => c.id)).not.toContain(otherCompanyId);
    });

    it('refuses a caller without COMPANY_SETTINGS (403)', async () => {
      await http()
        .get('/settings/companies')
        .set(auth(limitedToken))
        .expect(403);
    });

    it('refuses an unauthenticated caller (401)', async () => {
      await http().get('/settings/companies').expect(401);
    });
  });

  // ---------------------------------------------------------------- User Story 5
  describe('Document Types (US5)', () => {
    it('seeds a new company with all 17 PRD defaults (T061, FR-020)', async () => {
      const seeded = await sys.documentType.findMany({
        where: { companyId },
      });
      expect(seeded).toHaveLength(17);
      const aadhaar = seeded.find((d) => d.code === 'AADHAAR');
      expect(aadhaar).toMatchObject({
        isMandatory: true,
        needsNumber: true,
        hasExpiry: false,
      });
    });

    it('maps every toggle combination to its derived flag (T060)', async () => {
      const cases: [boolean, boolean, boolean, string][] = [
        [true, false, true, 'MandatoryNumber'],
        [true, false, false, 'Mandatory'],
        [false, true, true, 'ExpiryNumber'],
        [false, true, false, 'Expiry'],
        [false, false, true, 'Number'],
        [false, false, false, 'Optional'],
      ];

      for (const [isMandatory, hasExpiry, needsNumber, flag] of cases) {
        const res = await http()
          .post('/settings/document-types')
          .set(auth(superAdminToken))
          .send({
            companyId,
            code: `${PREFIX}_${flag.toUpperCase()}`,
            name: `E2E ${flag}`,
            isMandatory,
            hasExpiry,
            needsNumber,
          })
          .expect(201);
        expect(res.body.flag).toBe(flag);
      }
    });

    it('409s on a duplicate code within one company', async () => {
      await http()
        .post('/settings/document-types')
        .set(auth(superAdminToken))
        .send({ companyId, code: 'AADHAAR', name: 'Dupe' })
        .expect(409);
    });

    it('deactivates rather than deletes (FR-019)', async () => {
      const existing = await sys.documentType.findFirstOrThrow({
        where: { companyId, code: 'PAN' },
      });
      const res = await http()
        .patch(`/settings/document-types/${existing.id}`)
        .set(auth(superAdminToken))
        .send({ isActive: false })
        .expect(200);
      expect(res.body.isActive).toBe(false);

      await http()
        .delete(`/settings/document-types/${existing.id}`)
        .set(auth(superAdminToken))
        .expect(404);
    });
  });

  // ------------------------------------------------------------ User Stories 4/6
  describe('Departments, Designations and Shifts (US4, US6)', () => {
    it('creates, lists and edits a department, isolating it per company (T051)', async () => {
      const created = await http()
        .post('/settings/departments')
        .set(auth(superAdminToken))
        .send({ companyId, name: 'E2E Civil' })
        .expect(201);

      // Same name under a different company is allowed...
      await http()
        .post('/settings/departments')
        .set(auth(superAdminToken))
        .send({ companyId: otherCompanyId, name: 'E2E Civil' })
        .expect(201);

      // ...but an exact duplicate within one company is not.
      await http()
        .post('/settings/departments')
        .set(auth(superAdminToken))
        .send({ companyId, name: 'E2E Civil' })
        .expect(409);

      const renamed = await http()
        .patch(`/settings/departments/${created.body.id}`)
        .set(auth(superAdminToken))
        .send({ name: 'E2E Civil Works' })
        .expect(200);
      expect(renamed.body.name).toBe('E2E Civil Works');
    });

    it('creates and edits a designation (T051)', async () => {
      const created = await http()
        .post('/settings/designations')
        .set(auth(superAdminToken))
        .send({ companyId, name: 'E2E Foreman' })
        .expect(201);

      await http()
        .patch(`/settings/designations/${created.body.id}`)
        .set(auth(superAdminToken))
        .send({ name: 'E2E Senior Foreman' })
        .expect(200);

      const list = await http()
        .get('/settings/designations')
        .set(auth(superAdminToken))
        .expect(200);
      expect(
        list.body.some(
          (d: { name: string }) => d.name === 'E2E Senior Foreman',
        ),
      ).toBe(true);
    });

    it('creates and edits a shift, round-tripping HH:mm (T068)', async () => {
      const created = await http()
        .post('/settings/shifts')
        .set(auth(superAdminToken))
        .send({
          companyId,
          name: 'E2E General',
          inTime: '09:00',
          outTime: '18:00',
          graceMinutes: 10,
        })
        .expect(201);
      expect(created.body).toMatchObject({ inTime: '09:00', outTime: '18:00' });

      await http()
        .post('/settings/shifts')
        .set(auth(superAdminToken))
        .send({
          companyId,
          name: 'E2E General',
          inTime: '10:00',
          outTime: '19:00',
        })
        .expect(409);

      const edited = await http()
        .patch(`/settings/shifts/${created.body.id}`)
        .set(auth(superAdminToken))
        .send({ inTime: '08:30' })
        .expect(200);
      expect(edited.body.inTime).toBe('08:30');
    });

    it('rejects a malformed shift time with 400', async () => {
      await http()
        .post('/settings/shifts')
        .set(auth(superAdminToken))
        .send({ companyId, name: 'E2E Bad', inTime: '25:00', outTime: '18:00' })
        .expect(400);
    });

    it('409s on deleting something still referenced by an employee (T052, T068)', async () => {
      const created = await http()
        .post('/settings/departments')
        .set(auth(superAdminToken))
        .send({ companyId, name: 'E2E Referenced' })
        .expect(201);

      // The Employees module doesn't exist yet, so its reference check is stubbed
      // here — this asserts the guard's wiring, which is all this feature owns.
      const referenceCheck = jest
        .spyOn(
          app.get(ReferenceDataService) as unknown as {
            isReferencedByEmployee: () => Promise<boolean>;
          },
          'isReferencedByEmployee',
        )
        .mockResolvedValue(true);

      await http()
        .delete(`/settings/departments/${created.body.id}`)
        .set(auth(superAdminToken))
        .expect(409);

      referenceCheck.mockRestore();

      await http()
        .delete(`/settings/departments/${created.body.id}`)
        .set(auth(superAdminToken))
        .expect(200);
    });
  });

  // ------------------------------------------------- Tenant isolation (SC-003)
  describe('Company scoping for a caller without cross-company access (SC-003)', () => {
    let scopedToken: string;

    beforeAll(async () => {
      // Project Manager grants EMPLOYEES (so these endpoints are reachable) but not
      // CROSS_COMPANY_ACCESS — unlike every other caller in this suite, which is why
      // it is the only one that actually exercises the isolation path.
      const projectManager = await sys.role.findUniqueOrThrow({
        where: { name: 'Project Manager' },
      });
      const scoped = await sys.user.create({
        data: {
          email: `${unique('scoped')}@example.test`,
          username: unique('scoped'),
          password: await hash('secret42'),
          companyId,
        },
      });
      scopedUserId = scoped.id;
      await sys.userRole.create({
        data: { userId: scoped.id, roleId: projectManager.id, companyId },
      });

      const login = await http()
        .post('/auth/login')
        .send({
          identifier: scoped.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201);
      scopedToken = login.body.accessToken;
    });

    it("sees only its own company's departments", async () => {
      // Both companies own a department; the scoped caller must see exactly one.
      const mine = await sys.department.count({ where: { companyId } });
      const theirs = await sys.department.count({
        where: { companyId: otherCompanyId },
      });
      expect(mine).toBeGreaterThan(0);
      expect(theirs).toBeGreaterThan(0);

      const res = await http()
        .get('/settings/departments')
        .set(auth(scopedToken))
        .expect(200);

      expect(res.body.length).toBe(mine);
      expect(
        res.body.every((d: { companyId: string }) => d.companyId === companyId),
      ).toBe(true);
    });

    it("sees only its own company's document types", async () => {
      const res = await http()
        .get('/settings/document-types')
        .set(auth(scopedToken))
        .expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      expect(
        res.body.every((d: { companyId: string }) => d.companyId === companyId),
      ).toBe(true);
    });

    it('ignores a companyId query param from a non-cross-company caller', async () => {
      // A query parameter must never widen scope: asking for another company's
      // rows still returns only the caller's own.
      const res = await http()
        .get(`/settings/departments?companyId=${otherCompanyId}`)
        .set(auth(scopedToken))
        .expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      expect(
        res.body.every((d: { companyId: string }) => d.companyId === companyId),
      ).toBe(true);
    });

    it('lets a cross-company caller narrow to one company', async () => {
      const all = await http()
        .get('/settings/departments')
        .set(auth(superAdminToken))
        .expect(200);
      const narrowed = await http()
        .get(`/settings/departments?companyId=${otherCompanyId}`)
        .set(auth(superAdminToken))
        .expect(200);

      expect(all.body.length).toBeGreaterThan(narrowed.body.length);
      expect(
        narrowed.body.every(
          (d: { companyId: string }) => d.companyId === otherCompanyId,
        ),
      ).toBe(true);
    });

    it("cannot edit another company's department", async () => {
      const theirs = await sys.department.findFirstOrThrow({
        where: { companyId: otherCompanyId },
      });

      // 404 rather than 403 — a caller who may not touch a row should not be able
      // to confirm it exists.
      await http()
        .patch(`/settings/departments/${theirs.id}`)
        .set(auth(scopedToken))
        .send({ name: 'Hijacked' })
        .expect(404);

      await http()
        .delete(`/settings/departments/${theirs.id}`)
        .set(auth(scopedToken))
        .expect(404);

      const unchanged = await sys.department.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(unchanged.name).toBe(theirs.name);
    });
  });

  // ---------------------------------------------------------------- User Story 2
  describe('Roles (US2)', () => {
    let customRoleId: string;

    it('lists the default roles with counts, Super Admin protected (T031)', async () => {
      const res = await http()
        .get('/settings/roles')
        .set(auth(superAdminToken))
        .expect(200);

      const byName = Object.fromEntries(
        res.body.map((r: { name: string }) => [r.name, r]),
      );
      // All nine defaults from FR-006.
      for (const name of [
        'Super Admin',
        'Site Admin',
        'Project Manager',
        'HO User',
        'Accountant',
        'Site Engineer',
        'Store Keeper',
        'Site User',
        'Viewer',
      ]) {
        expect(byName[name]).toBeDefined();
      }
      expect(byName['Super Admin'].isProtected).toBe(true);
      expect(byName['Super Admin'].assignedUserCount).toBeGreaterThanOrEqual(1);
      expect(byName['Viewer'].assignedUserCount).toBeGreaterThanOrEqual(1);
    });

    it('creates a custom role (T032)', async () => {
      const res = await http()
        .post('/settings/roles')
        .set(auth(superAdminToken))
        .send({ name: unique('Role'), permissions: ['DASHBOARD', 'REPORTS'] })
        .expect(201);
      customRoleId = res.body.id;
      expect(res.body.isProtected).toBe(false);
      expect(res.body.assignedUserCount).toBe(0);
    });

    it('rejects a permission outside the enum with 400 (T032, FR-007)', async () => {
      await http()
        .post('/settings/roles')
        .set(auth(superAdminToken))
        .send({ name: unique('Bad'), permissions: ['NOT_A_PERMISSION'] })
        .expect(400);
    });

    it('does not let role editing grant CROSS_COMPANY_ACCESS', async () => {
      await http()
        .post('/settings/roles')
        .set(auth(superAdminToken))
        .send({ name: unique('Cross'), permissions: ['CROSS_COMPANY_ACCESS'] })
        .expect(400);
    });

    it('edits a non-protected role (T032)', async () => {
      const res = await http()
        .patch(`/settings/roles/${customRoleId}`)
        .set(auth(superAdminToken))
        .send({ permissions: ['DASHBOARD'] })
        .expect(200);
      expect(res.body.permissions).toEqual(['DASHBOARD']);
    });

    it('refuses to rename, re-permission or delete Super Admin with 403 (T032, FR-008)', async () => {
      const superAdmin = await sys.role.findUniqueOrThrow({
        where: { name: 'Super Admin' },
      });

      await http()
        .patch(`/settings/roles/${superAdmin.id}`)
        .set(auth(superAdminToken))
        .send({ name: 'Root' })
        .expect(403);

      await http()
        .patch(`/settings/roles/${superAdmin.id}`)
        .set(auth(superAdminToken))
        .send({ permissions: ['DASHBOARD'] })
        .expect(403);

      await http()
        .delete(`/settings/roles/${superAdmin.id}`)
        .set(auth(superAdminToken))
        .expect(403);
    });

    it('clears assignments when a held role is deleted, revoking access (T033, FR-010/FR-012)', async () => {
      // Give the limited account a second, deletable role that grants EMPLOYEES.
      const doomed = await sys.role.create({
        data: {
          name: unique('Doomed'),
          permissions: ['EMPLOYEES'],
          isProtected: false,
        },
      });
      await sys.userRole.create({
        data: { userId: limitedUserId, roleId: doomed.id },
      });

      const relogin = await http()
        .post('/auth/login')
        .send({
          identifier: (
            await sys.user.findUniqueOrThrow({
              where: { id: limitedUserId },
            })
          ).email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201);
      const tokenWithEmployees = relogin.body.accessToken;

      // The permission is live before the delete...
      await http()
        .get('/settings/departments')
        .set(auth(tokenWithEmployees))
        .expect(200);

      await http()
        .delete(`/settings/roles/${doomed.id}`)
        .set(auth(superAdminToken))
        .expect(200);

      // ...and gone on the very next request with the same token, because the guard
      // resolves permissions per request rather than trusting the JWT's snapshot.
      await http()
        .get('/settings/departments')
        .set(auth(tokenWithEmployees))
        .expect(403);

      expect(await sys.userRole.count({ where: { roleId: doomed.id } })).toBe(
        0,
      );
    });

    it('deletes a custom role (T032)', async () => {
      await http()
        .delete(`/settings/roles/${customRoleId}`)
        .set(auth(superAdminToken))
        .expect(200);
    });
  });

  // ---------------------------------------------------------------- User Story 3
  describe('User administration (US3)', () => {
    it('lists accounts for a permitted caller (T042)', async () => {
      const res = await http()
        .get('/settings/users')
        .set(auth(superAdminToken))
        .expect(200);
      const found = res.body.find(
        (u: { id: string }) => u.id === limitedUserId,
      );
      expect(found).toMatchObject({ status: 'active' });
      expect(found.roles.map((r: { name: string }) => r.name)).toContain(
        'Viewer',
      );
      // The password hash must never cross this boundary.
      expect(found.password).toBeUndefined();
    });

    it('refuses a caller who is neither Super Admin nor HO User (T043, FR-014)', async () => {
      await http().get('/settings/users').set(auth(limitedToken)).expect(403);
    });

    it('changes a role and enforces it on the next request (T042)', async () => {
      const storeKeeper = await sys.role.findUniqueOrThrow({
        where: { name: 'Store Keeper' },
      });

      await http()
        .patch(`/settings/users/${limitedUserId}`)
        .set(auth(superAdminToken))
        .send({ roleId: storeKeeper.id })
        .expect(200);

      const res = await http()
        .get('/settings/users')
        .set(auth(superAdminToken))
        .expect(200);
      const found = res.body.find(
        (u: { id: string }) => u.id === limitedUserId,
      );
      expect(found.roles.map((r: { name: string }) => r.name)).toEqual([
        'Store Keeper',
      ]);

      // Restore, so later assertions see the original fixture.
      await http()
        .patch(`/settings/users/${limitedUserId}`)
        .set(auth(superAdminToken))
        .send({ roleId: viewerRoleId })
        .expect(200);
    });

    it('deactivates an account (T042)', async () => {
      const res = await http()
        .patch(`/settings/users/${limitedUserId}`)
        .set(auth(superAdminToken))
        .send({ status: 'deactivated' })
        .expect(200);
      expect(res.body.status).toBe('deactivated');

      await http()
        .patch(`/settings/users/${limitedUserId}`)
        .set(auth(superAdminToken))
        .send({ status: 'active' })
        .expect(200);
    });

    it('refuses to deactivate, reassign or delete the last Super Admin (T043, FR-016)', async () => {
      const admin = await sys.user.findUniqueOrThrow({
        where: { email: 'admin@buildcore.dev' },
      });
      await http()
        .patch(`/settings/users/${admin.id}`)
        .set(auth(superAdminToken))
        .send({ status: 'deactivated' })
        .expect(409);

      await http()
        .patch(`/settings/users/${admin.id}`)
        .set(auth(superAdminToken))
        .send({ roleId: viewerRoleId })
        .expect(409);

      await http()
        .delete(`/settings/users/${admin.id}`)
        .set(auth(superAdminToken))
        .expect(409);
    });

    it('deletes an ordinary account (T043, FR-015)', async () => {
      const doomed = await sys.user.create({
        data: {
          email: `${unique('doomed')}@example.test`,
          username: unique('doomed'),
          password: await hash('secret42'),
        },
      });

      await http()
        .delete(`/settings/users/${doomed.id}`)
        .set(auth(superAdminToken))
        .expect(200);

      expect(
        await sys.user.findUnique({ where: { id: doomed.id } }),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------- User Story 7
  describe('Employee code series (US7)', () => {
    it('reads the series without incrementing it (T077)', async () => {
      const first = await http()
        .get(`/settings/companies/${companyId}/code-series`)
        .set(auth(superAdminToken))
        .expect(200);
      const second = await http()
        .get(`/settings/companies/${companyId}/code-series`)
        .set(auth(superAdminToken))
        .expect(200);

      expect(first.body.lastNumber).toBe(second.body.lastNumber);
      expect(first.body.nextCode).toBe(
        `${first.body.shortCode}-${String(first.body.lastNumber + 1).padStart(
          4,
          '0',
        )}`,
      );
    });

    it('allocates concurrent codes with no duplicates or gaps against the real database (SC-007)', async () => {
      const service = app.get(EmployeeCodeService);
      const before = await service.getCurrentState(companyId);

      // 200 rather than SC-007's full 1,000: this exercises the same single atomic
      // UPDATE ... RETURNING statement, and the guarantee it relies on is Postgres's
      // per-row serialization, which does not weaken with volume. The 1,000-call
      // contract is asserted in employee-code.service.spec.ts.
      const codes = await Promise.all(
        Array.from({ length: 200 }, () =>
          service.getNextEmployeeCode(companyId),
        ),
      );

      expect(new Set(codes).size).toBe(200);
      const numbers = codes
        .map((c) => Number(c.split('-')[1]))
        .sort((a, b) => a - b);
      expect(numbers[0]).toBe(before.lastNumber + 1);
      expect(numbers[199]).toBe(before.lastNumber + 200);
      expect(numbers.every((n, i) => n === before.lastNumber + 1 + i)).toBe(
        true,
      );
    });

    it('keeps the sequence running when the short code changes (FR-024)', async () => {
      const service = app.get(EmployeeCodeService);
      const before = await service.getCurrentState(companyId);
      const newShortCode = unique('NEW').slice(0, 10);

      await http()
        .patch(`/settings/companies/${companyId}`)
        .set(auth(superAdminToken))
        .send({ shortCode: newShortCode })
        .expect(200);

      const next = await service.getNextEmployeeCode(companyId);
      expect(next).toBe(
        `${newShortCode.toUpperCase()}-${String(before.lastNumber + 1).padStart(
          4,
          '0',
        )}`,
      );
    });
  });

  // ------------------------------------------------------------------- Polish
  describe('Audit trail (T081a, SC-009, FR-025)', () => {
    it('records entityType, action, entityId, actor and company for each change', async () => {
      const admin = await sys.user.findUniqueOrThrow({
        where: { email: 'admin@buildcore.dev' },
      });
      const startedAt = new Date();

      // One create/update/delete each across Company, Role and a reference resource.
      const company = await http()
        .post('/settings/companies')
        .set(auth(superAdminToken))
        .send({
          name: 'E2E Audited',
          shortCode: unique('AU').slice(0, 10),
          payrollLockDay: 7,
        })
        .expect(201);
      await http()
        .patch(`/settings/companies/${company.body.id}`)
        .set(auth(superAdminToken))
        .send({ name: 'E2E Audited Renamed' })
        .expect(200);

      const role = await http()
        .post('/settings/roles')
        .set(auth(superAdminToken))
        .send({ name: unique('Audited'), permissions: ['DASHBOARD'] })
        .expect(201);
      await http()
        .patch(`/settings/roles/${role.body.id}`)
        .set(auth(superAdminToken))
        .send({ permissions: ['REPORTS'] })
        .expect(200);
      await http()
        .delete(`/settings/roles/${role.body.id}`)
        .set(auth(superAdminToken))
        .expect(200);

      const dept = await http()
        .post('/settings/departments')
        .set(auth(superAdminToken))
        .send({ companyId: company.body.id, name: 'E2E Audited Dept' })
        .expect(201);
      await http()
        .delete(`/settings/departments/${dept.body.id}`)
        .set(auth(superAdminToken))
        .expect(200);

      const entries = await sys.auditLogEntry.findMany({
        where: { createdAt: { gte: startedAt } },
      });

      const matching = (entityType: string, action: string, entityId: string) =>
        entries.find(
          (e) =>
            e.entityType === entityType &&
            e.action === action &&
            e.entityId === entityId,
        );

      expect(matching('COMPANY', 'CREATE', company.body.id)).toBeDefined();
      expect(matching('COMPANY', 'UPDATE', company.body.id)).toBeDefined();
      expect(matching('ROLE', 'CREATE', role.body.id)).toBeDefined();
      expect(matching('ROLE', 'UPDATE', role.body.id)).toBeDefined();
      expect(matching('ROLE', 'DELETE', role.body.id)).toBeDefined();
      expect(matching('DEPARTMENT', 'CREATE', dept.body.id)).toBeDefined();
      expect(matching('DEPARTMENT', 'DELETE', dept.body.id)).toBeDefined();

      const companyCreate = matching('COMPANY', 'CREATE', company.body.id)!;
      expect(companyCreate.accountId).toBe(admin.id);
      expect(companyCreate.companyId).toBe(company.body.id);
      expect(companyCreate.createdAt.getTime()).toBeGreaterThanOrEqual(
        startedAt.getTime(),
      );

      // Updates carry a before/after snapshot.
      expect(
        matching('COMPANY', 'UPDATE', company.body.id)!.changes,
      ).not.toBeNull();
    });
  });
});
