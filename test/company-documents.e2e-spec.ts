import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import {
  REQUIRED_COMPANY_DOCUMENT_KINDS,
  scopeForCode,
} from '../src/settings/document-kinds';
import { DEFAULT_DOCUMENT_TYPES } from '../src/settings/reference-data/default-document-types';

/**
 * Company statutory documents over HTTP (017 US1, T018).
 *
 * Driven over HTTP rather than through the container because every claim here is about
 * the endpoint: that the missing kinds are named, that an expiring kind is refused
 * without a date, that a renewal retains its predecessor, and that the partial unique
 * index — not a service check — is what keeps exactly one version current.
 *
 * Every fixture is prefixed `E2ECD` and removed in `afterAll`.
 */
const PREFIX = 'E2ECD';
// A random tail as well as the clock: e2e suites run in parallel against one database,
// and two of them entering `unique()` in the same millisecond would collide on a name a
// unique index protects. Observed once as a lone transient failure in a combined run.
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(30_000);

describe('Company documents (e2e)', () => {
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

  let companyId: string;
  let gstTypeId: string;
  let licenceTypeId: string;
  let adminToken: string;
  let outsiderToken: string;
  let crossToken: string;
  /** Holds EMPLOYEES, which is what guards the employee document master. */
  let employeeAdminToken: string;
  let otherCompanyId: string;
  let otherGstTypeId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const makeUser = async (label: string, permissions: Permission[]) => {
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
      data: { name: unique(`${label}Role`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken as string };
  };

  const b64 = Buffer.from('%PDF-1.4 fake certificate').toString('base64');

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
    prisma = app.get(PrismaService);

    const company = await sys.company.create({
      data: {
        name: 'E2ECD Documents Constructions',
        shortCode: unique('D').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    // Seven of the eight required kinds get a DocumentType; AADHAAR deliberately does not,
    // so the "never even defined" branch is exercised too.
    for (const kind of REQUIRED_COMPANY_DOCUMENT_KINDS) {
      if (kind.code === 'AADHAAR') continue;
      const t = await sys.documentType.create({
        data: {
          companyId,
          code: kind.code,
          name: kind.label,
          hasExpiry: kind.code === 'LABOUR_LICENCE',
          // Through the same rule the migration and the service use, rather than the
          // column default. A fixture that left these `both` would be testing a state
          // production never produces, and the assertion below would fail for a reason
          // that has nothing to do with the behaviour under test.
          scope: scopeForCode(
            kind.code,
            DEFAULT_DOCUMENT_TYPES.map((d) => d.code),
          ),
        },
      });
      if (kind.code === 'GST') gstTypeId = t.id;
      if (kind.code === 'LABOUR_LICENCE') licenceTypeId = t.id;
    }

    // A second company, so FR-025's scoping can be asserted against a real other-company
    // row rather than against an empty list — an empty list is what a broken scope and a
    // correct one look like identically.
    const other = await sys.company.create({
      data: {
        name: 'E2ECD Other Constructions',
        shortCode: unique('O').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    otherCompanyId = other.id;
    const otherGst = await sys.documentType.create({
      data: {
        companyId: otherCompanyId,
        code: 'GST',
        name: 'GST registration certificate',
      },
    });
    otherGstTypeId = otherGst.id;

    adminToken = (await makeUser('Admin', [Permission.COMPANY_SETTINGS])).token;
    outsiderToken = (await makeUser('Outsider', [Permission.ATTENDANCE])).token;
    crossToken = (
      await makeUser('Cross', [
        Permission.COMPANY_SETTINGS,
        Permission.CROSS_COMPANY_ACCESS,
      ])
    ).token;
    // A separate account on purpose: `/settings/document-types` is guarded by EMPLOYEES
    // and this suite's admin holds only COMPANY_SETTINGS. Needing a second account to
    // read that list is itself the permission split these tests are about.
    employeeAdminToken = (
      await makeUser('EmpAdmin', [
        Permission.EMPLOYEES,
        Permission.CROSS_COMPANY_ACCESS,
      ])
    ).token;
  }, 120_000);

  afterAll(async () => {
    await sys.companyDocument.deleteMany({ where: { companyId } });
    await sys.companyDocument.deleteMany({
      where: { companyId: otherCompanyId },
    });
    await sys.documentType.deleteMany({ where: { companyId } });
    await sys.documentType.deleteMany({ where: { companyId: otherCompanyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({
      where: { id: { in: [companyId, otherCompanyId] } },
    });
    await app?.close();
  }, 60_000);

  it('names every missing required kind rather than counting them (FR-003)', async () => {
    const res = await http()
      .get('/company-documents')
      .set(auth(adminToken))
      .expect(200);

    expect(res.body.present).toHaveLength(0);
    expect(res.body.missing).toHaveLength(
      REQUIRED_COMPANY_DOCUMENT_KINDS.length,
    );

    // Every missing entry carries the words a person reads — a bare count would make
    // somebody diff two lists by eye.
    for (const m of res.body.missing) expect(m.label).toBeTruthy();

    // AADHAAR has no DocumentType at all, which is a different problem from "defined but
    // not uploaded" and the interface has to be able to tell them apart.
    const aadhaar = res.body.missing.find(
      (m: { code: string }) => m.code === 'AADHAAR',
    );
    expect(aadhaar.documentTypeId).toBeNull();
    const gst = res.body.missing.find(
      (m: { code: string }) => m.code === 'GST',
    );
    expect(gst.documentTypeId).toBe(gstTypeId);
  });

  it('refuses an expiring kind with no expiry date (FR-004)', async () => {
    const res = await http()
      .post('/company-documents')
      .set(auth(adminToken))
      .send({
        documentTypeId: licenceTypeId,
        data: b64,
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(res.body.code).toBe('DOCUMENT_EXPIRY_REQUIRED');

    // Nothing was stored — a refused upload must not leave a row behind.
    const rows = await sys.companyDocument.findMany({
      where: { companyId, documentTypeId: licenceTypeId },
    });
    expect(rows).toHaveLength(0);
  });

  it('accepts it once a date is supplied, and reports it present', async () => {
    await http()
      .post('/company-documents')
      .set(auth(adminToken))
      .send({
        documentTypeId: licenceTypeId,
        data: b64,
        contentType: 'application/pdf',
        expiresAt: '2027-03-31',
      })
      .expect(201);

    const res = await http()
      .get('/company-documents')
      .set(auth(adminToken))
      .expect(200);
    expect(res.body.present.map((d: { code: string }) => d.code)).toContain(
      'LABOUR_LICENCE',
    );
  });

  it('retains the superseded certificate when a renewal is uploaded (FR-006)', async () => {
    const first = await http()
      .post('/company-documents')
      .set(auth(adminToken))
      .send({
        documentTypeId: gstTypeId,
        data: b64,
        contentType: 'application/pdf',
        documentNumber: '27AAAAA0000A1Z5',
      })
      .expect(201);

    const renewed = await http()
      .post('/company-documents')
      .set(auth(adminToken))
      .send({
        documentTypeId: gstTypeId,
        data: b64,
        contentType: 'application/pdf',
        documentNumber: '27BBBBB1111B2Z6',
      })
      .expect(201);

    expect(renewed.body.id).not.toBe(first.body.id);

    // Both rows survive; the predecessor keeps its fileRef, so it is genuinely retained
    // rather than merely recorded.
    const all = await sys.companyDocument.findMany({
      where: { companyId, documentTypeId: gstTypeId },
    });
    expect(all).toHaveLength(2);
    for (const row of all) expect(row.fileRef).toBeTruthy();

    const current = all.filter((r: { isCurrent: boolean }) => r.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(renewed.body.id);
    expect(current[0].supersedesId).toBe(first.body.id);

    // History is retrievable, newest first.
    const history = await http()
      .get(`/company-documents/${gstTypeId}/history`)
      .set(auth(adminToken))
      .expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[0].id).toBe(renewed.body.id);
  });

  it('lets the DATABASE refuse a second current row, not a service check (T008)', async () => {
    // The partial unique index is the guarantee. A service-level "is there already a
    // current one?" passes a single-threaded test and loses the race two concurrent
    // uploads create — so this writes straight past the service to prove the index holds.
    const error = await sys.companyDocument
      .create({
        data: {
          companyId,
          documentTypeId: gstTypeId,
          fileRef: 'e2ecd/duplicate-current',
          uploadedByUserId: userIds[0],
          isCurrent: true,
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(
      /unique|constraint|CompanyDocument_current_per_kind/i,
    );
  });

  it('records every retrieval in the audit log before returning bytes (FR-024)', async () => {
    const list = await http()
      .get('/company-documents')
      .set(auth(adminToken))
      .expect(200);
    const gst = list.body.present.find(
      (d: { code: string }) => d.code === 'GST',
    );

    await http()
      .get(`/company-documents/${gst.id}/download`)
      .set(auth(adminToken))
      .expect(200);

    const entries = await sys.auditLogEntry.findMany({
      where: { companyId, entityId: gst.id },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const read = entries.find(
      (e: { changes: { retrieved?: boolean } }) =>
        e.changes?.retrieved === true,
    );
    expect(read).toBeDefined();
  });

  it('refuses a caller without COMPANY_SETTINGS (FR-023)', async () => {
    await http().get('/company-documents').set(auth(outsiderToken)).expect(403);
  });

  /**
   * T081, FR-001a. The regression behind this: the completeness query filtered to the
   * required codes, so a document filed against any other kind was accepted, stored, and
   * then never appeared anywhere. Worse than a refusal — the file exists and nothing on
   * the screen says so.
   */
  it('lists a document of a non-required kind as supplementary (FR-001a)', async () => {
    const msme = await sys.documentType.create({
      data: {
        companyId,
        code: unique('MSME').toUpperCase(),
        name: 'Udyam registration',
      },
    });

    const before = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);

    await http()
      .post(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({
        documentTypeId: msme.id,
        data: b64,
        contentType: 'application/pdf',
      })
      .expect(201);

    const after = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);

    expect(
      after.body.supplementary.map(
        (d: { documentTypeId: string }) => d.documentTypeId,
      ),
    ).toContain(msme.id);
    // And the compliance figure did not move, which is the half that would be a quiet
    // wrong answer rather than a visible one.
    expect(after.body.present).toHaveLength(before.body.present.length);
    expect(after.body.missing).toHaveLength(before.body.missing.length);
  });

  /**
   * The chicken-and-egg the first cut of FR-001a shipped with. Over HTTP because the
   * claim is about what the ENDPOINT offers: the screen builds its upload control from
   * this list, and a kind that is defined but not yet held has to be in it or the first
   * document can never be filed.
   */
  it('offers a newly defined kind before anything is filed against it', async () => {
    const code = unique('TRADE').toUpperCase();
    const type = await sys.documentType.create({
      data: { companyId, code, name: 'Trade licence' },
    });

    const res = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);

    // In neither "what we hold" list — nothing has been filed.
    expect(
      res.body.supplementary.map(
        (d: { documentTypeId: string }) => d.documentTypeId,
      ),
    ).not.toContain(type.id);
    // And offerable anyway.
    const offered = res.body.availableKinds.find(
      (k: { documentTypeId: string }) => k.documentTypeId === type.id,
    );
    expect(offered).toBeDefined();
    expect(offered.isRequired).toBe(false);

    // Which the upload then actually accepts, closing the loop.
    await http()
      .post(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({
        documentTypeId: type.id,
        data: b64,
        contentType: 'application/pdf',
      })
      .expect(201);
  });

  /**
   * FR-001b — the thing the screen could not do at all before: add a kind of its own.
   *
   * Over HTTP, and asserting the *scope* as well as the row, because scope is the whole
   * argument for this route existing behind `COMPANY_SETTINGS` instead of `EMPLOYEES`.
   * A kind created here that came out visible in the employee file would make this route
   * general document-type creation reached through a second door.
   */
  it('defines a company kind of its own, scoped so it stays out of the employee file', async () => {
    const created = await http()
      .post(`/company-documents/types?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: 'MSME / Udyam registration', needsNumber: true })
      .expect(201);

    expect(created.body.code).toBe('MSME_UDYAM_REGISTRATION');

    const row = await sys.documentType.findUnique({
      where: { id: created.body.documentTypeId },
    });
    expect(row.scope).toBe('company');
    // Never from the request: restriction is FR-024's rule, settled in configuration.
    expect(row.isRestricted).toBe(false);

    // Offerable immediately, which is the point of having defined it.
    const list = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(
      list.body.availableKinds.map((k: { code: string }) => k.code),
    ).toContain('MSME_UDYAM_REGISTRATION');

    // And absent from the employee document master, which is the half that would be a
    // silent authorization hole rather than a visible bug.
    const employeeTypes = await http()
      .get(`/settings/document-types?companyId=${companyId}`)
      .set(auth(employeeAdminToken))
      .expect(200);
    expect(
      employeeTypes.body.map((t: { code: string }) => t.code),
    ).not.toContain('MSME_UDYAM_REGISTRATION');
  });

  it('suffixes a derived code rather than refusing a duplicate name', async () => {
    const first = await http()
      .post(`/company-documents/types?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: 'Rent agreement' })
      .expect(201);
    const second = await http()
      .post(`/company-documents/types?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({ name: 'Rent agreement' })
      .expect(201);

    expect(first.body.code).toBe('RENT_AGREEMENT');
    expect(second.body.code).toBe('RENT_AGREEMENT_2');
  });

  /**
   * The other side of the split: the statutory kinds used to appear in Employee Setup's
   * list in every company, mixed in with the marksheets.
   */
  it('keeps the statutory kinds out of the employee document list', async () => {
    const employeeTypes = await http()
      .get(`/settings/document-types?companyId=${companyId}`)
      .set(auth(employeeAdminToken))
      .expect(200);
    const codes = employeeTypes.body.map((t: { code: string }) => t.code);

    expect(codes).not.toContain('GST');
    expect(codes).not.toContain('LABOUR_LICENCE');
    expect(codes).not.toContain('WORK_ORDER');
    // Aadhaar's claim is asserted where it is created, not here: this suite skips
    // defining it so the "never defined" branch has something to exercise, so whether it
    // exists at this point depends on test order. An assertion that depends on test order
    // is worse than no assertion, because it passes until somebody reorders the file.
  });

  /**
   * T085, FR-003a. AADHAAR is the kind this suite deliberately never defined a type for,
   * so it is reported missing with a null `documentTypeId` — the "never even defined"
   * branch, which had no action behind it at all before this amendment.
   */
  it('materialises a required kind that has no type, then accepts an upload against it', async () => {
    const before = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);
    const aadhaar = before.body.missing.find(
      (m: { code: string }) => m.code === 'AADHAAR',
    );
    expect(aadhaar.documentTypeId).toBeNull();

    const defined = await http()
      .post(`/company-documents/required-kinds/AADHAAR?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(201);
    expect(defined.body.code).toBe('AADHAAR');

    // Aadhaar comes out restricted whatever the caller sent, because the flag is read
    // from configuration and not from the request (FR-024).
    const row = await sys.documentType.findUnique({
      where: { id: defined.body.documentTypeId },
    });
    expect(row.isRestricted).toBe(true);
    // And `both`, not `company`: Aadhaar is required of the company AND held on an
    // employee's file. Resolving it to one side would make it vanish from the other —
    // and for Aadhaar the other side is the screen carrying FR-024's handling.
    expect(row.scope).toBe('both');

    await http()
      .post(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .send({
        documentTypeId: defined.body.documentTypeId,
        data: b64,
        contentType: 'application/pdf',
        documentNumber: 'XXXX XXXX 4821',
      })
      .expect(201);

    const after = await http()
      .get(`/company-documents?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(after.body.present.map((d: { code: string }) => d.code)).toContain(
      'AADHAAR',
    );
  });

  it('is idempotent — defining the same required kind twice yields one type', async () => {
    const first = await http()
      .post(`/company-documents/required-kinds/TAN?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(201);
    const second = await http()
      .post(`/company-documents/required-kinds/TAN?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(201);

    expect(second.body.documentTypeId).toBe(first.body.documentTypeId);
    const types = await sys.documentType.findMany({
      where: { companyId, code: 'TAN' },
    });
    expect(types).toHaveLength(1);
  });

  /**
   * The test that would matter if `resolveCompanyId` were copied wrong: this route now
   * creates a `settings.DocumentType`, which `settings/document-types` guards with
   * `EMPLOYEES`. It stays safe only because the caller cannot name the kind freely.
   */
  it('refuses to define a kind outside the required set (FR-003a)', async () => {
    const res = await http()
      .post(`/company-documents/required-kinds/MSME?companyId=${companyId}`)
      .set(auth(adminToken))
      .expect(400);
    expect(res.body.code).toBe('DOCUMENT_KIND_NOT_REQUIRED');
  });

  describe('naming the company (FR-025)', () => {
    it('gives a cross-company caller the company they named', async () => {
      await http()
        .post(`/company-documents?companyId=${otherCompanyId}`)
        .set(auth(crossToken))
        .send({
          documentTypeId: otherGstTypeId,
          data: b64,
          contentType: 'application/pdf',
        })
        .expect(201);

      const res = await http()
        .get(`/company-documents?companyId=${otherCompanyId}`)
        .set(auth(crossToken))
        .expect(200);

      expect(
        res.body.present.map(
          (d: { documentTypeId: string }) => d.documentTypeId,
        ),
      ).toContain(otherGstTypeId);
    });

    /**
     * The one that would be a data leak rather than an inconvenience. A company-scoped
     * caller naming somebody else's company must get their OWN company back — the query
     * parameter must never widen scope, which is the rule `companyScope()` has always
     * followed and the reason `resolveCompanyId` ignores `requested` for these callers.
     */
    it('ignores a companyId from a caller without cross-company access', async () => {
      const res = await http()
        .get(`/company-documents?companyId=${otherCompanyId}`)
        .set(auth(adminToken))
        .expect(200);

      expect(
        res.body.present.map(
          (d: { documentTypeId: string }) => d.documentTypeId,
        ),
      ).not.toContain(otherGstTypeId);
      // Their own company's GST, not the other company's.
      expect(
        res.body.present.map(
          (d: { documentTypeId: string }) => d.documentTypeId,
        ),
      ).toContain(gstTypeId);
    });
  });
});
