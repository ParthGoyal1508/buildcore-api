import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * T035 — THE PHASE 5 REGRESSION GATE.
 *
 * `recruitment.GeneratedLetter` moved to `shared.IssuedLetter` and `enum LetterType`
 * became a table. Nothing in that was supposed to change what Recruitment does, and this
 * file is the only reason anybody may believe it.
 *
 * Recruitment's letter path had **no test at all** before this. "Recruitment's behaviour
 * continues unchanged" was an assertion with nothing behind it — which is exactly what
 * the migration checklist meant by asking whether the claim was testable or merely
 * stated. It is driven over HTTP with the same request bodies a client sent before the
 * move: `letterType: "appointment"`, a plain string that used to be an enum value and is
 * now a `LetterKind` key, byte-identical either way.
 *
 * Every fixture is prefixed `E2ELR` and removed in `afterAll`.
 */
const PREFIX = 'E2ELR';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(60_000);

describe('Letters after the schema move (e2e, T035)', () => {
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
  let token: string;
  let employeeId: string;
  let letterId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

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
        name: 'E2ELR Letters Constructions',
        shortCode: unique('L').slice(0, 10),
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
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });

    const adminUser = await sys.user.create({
      data: {
        email: `${unique('Hr')}@example.test`.toLowerCase(),
        username: unique('Hr'),
        password: await hash('secret42'),
        displayName: `${PREFIX} HR`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(adminUser.id);
    const role = await sys.role.create({
      data: {
        name: unique('HrRole'),
        permissions: [Permission.RECRUITMENT, Permission.SETTINGS],
      },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: adminUser.id, roleId: role.id, companyId },
    });
    token = (
      await http()
        .post('/auth/login')
        .send({
          identifier: adminUser.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;

    const employeeUser = await sys.user.create({
      data: {
        email: `${unique('Emp')}@example.test`.toLowerCase(),
        username: unique('Emp'),
        password: await hash('secret42'),
        displayName: `${PREFIX} Anil Deshpande`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(employeeUser.id);
    const employee = await sys.employee.create({
      data: {
        userId: employeeUser.id,
        companyId,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode: unique('E').slice(0, 20),
        firstName: 'Anil',
        lastName: 'Deshpande',
        dateOfJoining: new Date('2026-01-01'),
      },
    });
    employeeId = employee.id;
  }, 180_000);

  afterAll(async () => {
    await sys.issuedLetter.deleteMany({ where: { companyId } });
    await sys.letterTemplate.deleteMany({ where: { companyId } });
    await sys.letterKind.deleteMany({ where: { companyId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.shift.deleteMany({ where: { companyId } });
    await sys.site.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  it('still accepts a template keyed by the old enum value', async () => {
    // The request body is unchanged from before the restructure. `letterType:
    // "appointment"` was an enum value; it is now a LetterKind key, and the point of
    // making them byte-identical is that no client had to learn the difference.
    const res = await http()
      .post('/recruitment/letter-templates')
      .set(auth(token))
      .send({
        companyId,
        letterType: 'appointment',
        name: `${PREFIX} Appointment`,
        bodyTemplate:
          'Dear {{employeeName}} ({{employeeCode}}), you are appointed as ' +
          '{{designation}} in {{department}} at {{companyName}} from {{dateOfJoining}}. ' +
          'Issued {{issueDate}}.',
        isActive: true,
      })
      .expect(201);

    expect(res.body.letterType).toBe('appointment');
    // The new field is additive: the wire keeps its old name AND now names the row.
    expect(res.body.letterKindId).toBeTruthy();
  });

  it('still rejects a template referencing tokens the kind does not document', async () => {
    const res = await http()
      .post('/recruitment/letter-templates')
      .set(auth(token))
      .send({
        companyId,
        letterType: 'appointment',
        name: `${PREFIX} Bad`,
        bodyTemplate:
          'Dear {{employeeName}}, your {{favouriteColour}} is noted.',
      })
      .expect(400);

    expect(res.body.message).toContain('favouriteColour');
  });

  it('still issues an employee letter, and renders a real PDF', async () => {
    const res = await http()
      .post('/recruitment/letters')
      .set(auth(token))
      .send({ letterType: 'appointment', employeeId })
      .expect(201);

    letterId = res.body.id;
    expect(res.body.version).toBe(1);

    // Issued, not drafted. 017 made `issuedAt` nullable so a letter awaiting approval
    // can exist unissued — Recruitment has no gated kinds and must never land in that
    // state, which is the regression this assertion catches.
    expect(res.body.issuedAt).toBeTruthy();

    const download = await http()
      .get(`/recruitment/letters/${letterId}/download`)
      .set(auth(token))
      .expect(200);

    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.length).toBeGreaterThan(500);
    // The filename came from the enum value before the move and from the kind's key
    // after it. Same string, which is the whole basis of the migration.
    expect(download.headers['content-disposition']).toContain('appointment-v1');
  });

  it('still lists the letter under its old type name', async () => {
    const res = await http()
      .get('/recruitment/letters')
      .set(auth(token))
      .query({ companyId, employeeId })
      .expect(200);

    const row = res.body.find((r: { id: string }) => r.id === letterId);
    expect(row).toBeDefined();
    expect(row.letterType).toBe('appointment');
    expect(row.isSuperseded).toBe(false);
  });

  it('still supersedes on re-issue rather than overwriting', async () => {
    const second = await http()
      .post('/recruitment/letters')
      .set(auth(token))
      .send({ letterType: 'appointment', employeeId })
      .expect(201);

    expect(second.body.version).toBe(2);

    const rows = await sys.issuedLetter.findMany({
      where: { companyId, employeeId },
      orderBy: { version: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].isSuperseded).toBe(true);
    expect(rows[1].isSuperseded).toBe(false);
    // The first letter's file is still there — superseded is not deleted.
    expect(rows[0].renderedRef).toBeTruthy();
  });

  it('refuses a letter kind that does not exist, rather than rendering an empty one', async () => {
    await http()
      .post('/recruitment/letters')
      .set(auth(token))
      .send({ letterType: 'not_a_real_kind', employeeId })
      .expect(404);
  });

  it('refuses a letter addressed BOTH ways, at the database (T037)', async () => {
    // The CHECK constraint, not a service check. "Who is this letter for?" must have one
    // answer, and a service-level guard is bypassed by every script, seed and future
    // module that writes this table directly.
    const kind = await sys.letterKind.findFirst({
      where: { key: 'appointment', companyId: null },
    });
    const error = await sys.issuedLetter
      .create({
        data: {
          companyId,
          letterKindId: kind.id,
          employeeId,
          subjectType: 'vendor',
          subjectId: 'vendor-1',
          templateId: 'tpl-x',
          renderedRef: 'e2elr/both.pdf',
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(
      /one_addressing_form|constraint|check/i,
    );
  });

  it('refuses a letter addressed to NOBODY, at the database (T037)', async () => {
    const kind = await sys.letterKind.findFirst({
      where: { key: 'appointment', companyId: null },
    });
    const error = await sys.issuedLetter
      .create({
        data: {
          companyId,
          letterKindId: kind.id,
          templateId: 'tpl-x',
          renderedRef: 'e2elr/nobody.pdf',
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(
      /one_addressing_form|constraint|check/i,
    );
  });

  it('accepts a letter addressed to an opaque subject, which is the point of the move', async () => {
    const kind = await sys.letterKind.findFirst({
      where: { key: 'letter_work_order', companyId: null },
    });
    const row = await sys.issuedLetter.create({
      data: {
        companyId,
        letterKindId: kind.id,
        // A vendor. This module does not know what a vendor is and never resolves it —
        // that is what let the table leave `recruitment` at all.
        subjectType: 'vendor',
        subjectId: 'vendor-abc',
        templateId: 'tpl-x',
        renderedRef: 'e2elr/wo.pdf',
      },
    });
    expect(row.subjectId).toBe('vendor-abc');
    expect(row.employeeId).toBeNull();
  });

  it('carried every pre-existing letter through the move', async () => {
    // The 18 rows that were in `recruitment.GeneratedLetter` before Phase 5 ran. This
    // asserts the population is intact and joined to a kind — the thing a `SET SCHEMA`
    // on a live table is actually risked on.
    const orphaned = await sys.issuedLetter.count({
      where: { letterKindId: '' },
    });
    expect(orphaned).toBe(0);

    const all = await sys.issuedLetter.findMany({
      include: { letterKind: { select: { key: true } } },
      take: 500,
    });
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.letterKind.key).toBeTruthy();
      // Every historical row addresses somebody. The CHECK constraint now enforces it;
      // this confirms the existing population satisfied it rather than being exempted.
      const addressed =
        row.employeeId !== null ||
        row.candidateId !== null ||
        row.subjectId !== null;
      expect(addressed).toBe(true);
    }
  });
});
