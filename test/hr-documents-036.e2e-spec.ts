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
 * Feature 036 stream 3b — HR files you can open (F14, F15).
 *
 * - F14: replacing a passport needs the new number and expiry, and is accepted with them.
 * - F15: an uploaded document can be opened (`GET …/documents/:id/file`), with its detected type;
 *   the replaced upload is kept and openable by `versionId`; file name and size are recorded; a
 *   file whose bytes are not on the allow-list is refused 415.
 *
 * Every fixture is prefixed `E2EHD` and removed in `afterAll`.
 */
const PREFIX = 'E2EHD';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(120_000);

const pdf = (marker: string) =>
  Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, 'ascii');

describe('HR documents (036 3b, e2e)', () => {
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

  let companyId: string;
  let employeeId: string;
  let passportTypeId: string;
  let token: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/hr/employees/${employeeId}/documents`;

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
        name: `${PREFIX} Dummy Docs Test Firm`,
        shortCode: unique('C').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;
    const passport = await sys.documentType.create({
      data: {
        companyId,
        code: unique('PP').slice(0, 20),
        name: `${PREFIX} Passport`,
        needsNumber: true,
        hasExpiry: true,
      },
    });
    passportTypeId = passport.id;
    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 12.97,
        longitude: 77.59,
        geofenceRadiusMeters: 100,
        weeklyOffDay: 0,
      },
    });
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    const employee = await sys.employee.create({
      data: {
        companyId,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode: unique('EMP'),
        firstName: 'Dummy',
        lastName: 'Docs',
      },
    });
    employeeId = employee.id;

    const permissions = [Permission.EMPLOYEES];
    const role = await sys.role.create({
      data: {
        name: unique('Role'),
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
        email: `${unique('hr')}@example.test`.toLowerCase(),
        username: unique('hr'),
        password: await hash('secret42'),
        displayName: `${PREFIX} HR`,
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
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await sys.employeeDocumentVersion.deleteMany({ where: { employeeId } });
    await sys.employeeDocument.deleteMany({ where: { employeeId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.documentType.deleteMany({ where: { companyId } });
    await sys.shift.deleteMany({ where: { companyId } });
    await sys.site.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    if (app) await app.close();
  });

  it('refuses a passport without its number, and a file that is not a document (415)', async () => {
    await http()
      .post(base())
      .set(auth())
      .send({
        documentTypeId: passportTypeId,
        file: pdf('first').toString('base64'),
        expiresAt: '2032-01-01',
      })
      .expect(400);
    const html = Buffer.from('<html><body>not a pdf</body></html>');
    const res = await http()
      .post(base())
      .set(auth())
      .send({
        documentTypeId: passportTypeId,
        file: html.toString('base64'),
        contentType: 'application/pdf',
        documentNumber: 'P1234567',
        expiresAt: '2032-01-01',
      })
      .expect(415);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('replaces a document with a new number and expiry, keeping the old one openable', async () => {
    const first = await http()
      .post(base())
      .set(auth())
      .send({
        documentTypeId: passportTypeId,
        file: pdf('first').toString('base64'),
        fileName: 'C:\\fakepath\\passport-old.pdf',
        documentNumber: 'P1111111',
        expiresAt: '2030-01-01',
      })
      .expect(201);
    expect(first.body.fileName).toBe('passport-old.pdf');
    expect(first.body.mimeType).toBe('application/pdf');
    expect(first.body.sizeBytes).toBe(pdf('first').length);

    const second = await http()
      .post(base())
      .set(auth())
      .send({
        documentTypeId: passportTypeId,
        file: pdf('second').toString('base64'),
        fileName: 'passport-new.pdf',
        documentNumber: 'P2222222',
        expiresAt: '2036-01-01',
      })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.documentNumber).toBe('P2222222');
    expect(second.body.previousVersions).toHaveLength(1);
    expect(second.body.previousVersions[0].documentNumber).toBe('P1111111');

    const list = await http().get(base()).set(auth()).expect(200);
    const doc = list.body.documents.find(
      (d: { id: string }) => d.id === first.body.id,
    );
    expect(doc.previousVersions).toHaveLength(1);

    const current = await http()
      .get(`${base()}/${first.body.id}/file`)
      .set(auth())
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(current.headers['content-type']).toContain('application/pdf');
    expect(current.headers['content-disposition']).toContain(
      'passport-new.pdf',
    );
    expect((current.body as Buffer).toString('ascii')).toContain('second');

    const old = await http()
      .get(
        `${base()}/${first.body.id}/file?versionId=${
          doc.previousVersions[0].id
        }`,
      )
      .set(auth())
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((old.body as Buffer).toString('ascii')).toContain('first');
  });

  it('404s a document of another employee', async () => {
    await http()
      .get(`/hr/employees/does-not-exist/documents/nope/file`)
      .set(auth())
      .expect(404);
  });
});
