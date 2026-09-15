import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { REQUIRED_COMPANY_DOCUMENT_KINDS } from '../src/settings/document-kinds';

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
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

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
        },
      });
      if (kind.code === 'GST') gstTypeId = t.id;
      if (kind.code === 'LABOUR_LICENCE') licenceTypeId = t.id;
    }

    adminToken = (await makeUser('Admin', [Permission.COMPANY_SETTINGS])).token;
    outsiderToken = (await makeUser('Outsider', [Permission.ATTENDANCE])).token;
  }, 120_000);

  afterAll(async () => {
    await sys.companyDocument.deleteMany({ where: { companyId } });
    await sys.documentType.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
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
});
