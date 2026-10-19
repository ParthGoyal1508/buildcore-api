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
 * The Bank Guarantees register over HTTP (037, specs/037-bank-guarantees/spec.md).
 *
 * A tender with its EMD and PBG guarantees; the date rules; extend, release, encash and reopen
 * with their history; a document round trip; the client's sheet as Excel; the 30-day alert
 * reaching a `BANK_GUARANTEES` holder and nobody else; and the permission gate itself.
 *
 * Every fixture is prefixed `E2EBG` and removed in `afterAll`.
 */
const PREFIX = 'E2EBG';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(120_000);

const pdf = (marker: string) =>
  Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, 'ascii');

/** A date `days` from today (UTC), as `YYYY-MM-DD`. */
const inDays = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('Bank guarantees (037, e2e)', () => {
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

  let companyId: string;
  let writerToken: string;
  let readerToken: string;
  let outsiderToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = '/projects/bank-guarantees';

  const makeUser = async (
    label: string,
    grants: [Permission, AccessLevel[]][],
  ) => {
    const role = await sys.role.create({
      data: {
        name: unique(`${label}Role`),
        permissions: grants.map(([p]) => p),
        rolePermissions: {
          create: grants.flatMap(([permission, levels]) =>
            levels.map((level) => ({ permission, level })),
          ),
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
    return login.body.accessToken as string;
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

    const company = await sys.company.create({
      data: {
        name: 'Dummy BG Test Firm',
        shortCode: unique('B').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const both = [AccessLevel.read, AccessLevel.write];
    writerToken = await makeUser('Writer', [
      [Permission.BANK_GUARANTEES, both],
      [Permission.DASHBOARD, both],
    ]);
    readerToken = await makeUser('Reader', [
      [Permission.BANK_GUARANTEES, [AccessLevel.read]],
      [Permission.DASHBOARD, both],
    ]);
    outsiderToken = await makeUser('Outsider', [
      [Permission.PROJECTS, both],
      [Permission.DASHBOARD, both],
    ]);
  });

  afterAll(async () => {
    if (companyId) {
      await sys.bgTender.deleteMany({ where: { companyId } });
      await sys.reminderNotification.deleteMany({ where: { companyId } });
      await sys.auditLogEntry.deleteMany({ where: { companyId } });
    }
    await sys.auditLogEntry.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    if (companyId) await sys.company.deleteMany({ where: { id: companyId } });
    if (app) await app.close();
  });

  let tenderId: string;
  let emdId: string;
  let pbgId: string;

  it('enters a tender and numbers it', async () => {
    const res = await http()
      .post(base)
      .set(auth(writerToken))
      .send({
        workName: 'Dummy operation and maintenance of NH-148A',
        departmentName: 'NHAI DELHI',
        tenderAmount: '204300000.00',
      })
      .expect(201);
    tenderId = res.body.id;
    expect(res.body.serialNo).toBe(1);
    expect(res.body.tenderAmount).toBe('204300000.00');
    expect(res.body.guarantees).toEqual([]);
  });

  it('adds an EMD and a PBG, refuses bad dates and a duplicate number', async () => {
    const emdNumber = unique('IGB');
    let res = await http()
      .post(`${base}/${tenderId}/guarantees`)
      .set(auth(writerToken))
      .send({
        type: 'EMD',
        bgNumber: emdNumber,
        amount: '2043000',
        issueDate: inDays(-170),
        expiryDate: inDays(20),
        issuingBank: 'Dummy Bank',
      })
      .expect(201);
    emdId = res.body.guarantees.find(
      (g: { type: string }) => g.type === 'EMD',
    ).id;
    const emd = res.body.guarantees[0];
    expect(emd.displayStatus).toBe('RUNNING');
    expect(emd.daysToExpiry).toBeGreaterThanOrEqual(19);
    expect(emd.events.map((e: { kind: string }) => e.kind)).toEqual([
      'created',
    ]);

    // A number without dates.
    res = await http()
      .post(`${base}/${tenderId}/guarantees`)
      .set(auth(writerToken))
      .send({ type: 'PBG', bgNumber: unique('IGP'), amount: '100' })
      .expect(400);
    expect(res.body.code).toBe('BG_DATES_INVALID');

    // The same number again.
    res = await http()
      .post(`${base}/${tenderId}/guarantees`)
      .set(auth(writerToken))
      .send({
        type: 'PBG',
        bgNumber: emdNumber,
        amount: '100',
        issueDate: inDays(-1),
        expiryDate: inDays(300),
      })
      .expect(409);
    expect(res.body.code).toBe('BG_NUMBER_TAKEN');

    // Applied for, not issued yet: no number, no dates — allowed.
    res = await http()
      .post(`${base}/${tenderId}/guarantees`)
      .set(auth(writerToken))
      .send({ type: 'PBG', amount: '5395786.80' })
      .expect(201);
    pbgId = res.body.guarantees.find(
      (g: { type: string }) => g.type === 'PBG',
    ).id;
  });

  it('lists the register with the expiring filter and search', async () => {
    let res = await http()
      .get(`${base}?status=expiring`)
      .set(auth(readerToken))
      .expect(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([tenderId]);
    res = await http()
      .get(`${base}?status=released`)
      .set(auth(readerToken))
      .expect(200);
    expect(res.body.total).toBe(0);
    res = await http()
      .get(`${base}?search=nhai`)
      .set(auth(readerToken))
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].guarantees).toHaveLength(2);
  });

  it('alerts a BANK_GUARANTEES holder within 30 days, and nobody without it', async () => {
    const mine = await http()
      .get('/dashboard/reminders')
      .set(auth(readerToken))
      .expect(200);
    expect(JSON.stringify(mine.body)).toContain(emdId);
    expect(JSON.stringify(mine.body)).toContain('NHAI DELHI expires');
    const theirs = await http()
      .get('/dashboard/reminders')
      .set(auth(outsiderToken))
      .expect(200);
    expect(JSON.stringify(theirs.body)).not.toContain(emdId);

    // And in the bell, which carries only warning and overdue reminders — 20 days out is inside
    // the rule's 30-day warning band.
    const bell = await http()
      .get('/notifications')
      .set(auth(readerToken))
      .expect(200);
    expect(JSON.stringify(bell.body)).toContain('NHAI DELHI expires');
    const notTheirs = await http()
      .get('/notifications')
      .set(auth(outsiderToken))
      .expect(200);
    expect(JSON.stringify(notTheirs.body)).not.toContain('NHAI DELHI expires');
  });

  it('extends, keeping the previous expiry in the history; the alert clears', async () => {
    const before = inDays(20);
    const res = await http()
      .post(`${base}/guarantees/${emdId}/extend`)
      .set(auth(writerToken))
      .send({
        expiryDate: inDays(200),
        note: 'Extended at the department’s request',
      })
      .expect(201);
    const emd = res.body.guarantees.find((g: { id: string }) => g.id === emdId);
    expect(emd.expiryDate).toBe(inDays(200));
    expect(emd.events[0]).toMatchObject({
      kind: 'extended',
      fromDate: before,
      toDate: inDays(200),
    });

    await http()
      .post(`${base}/guarantees/${emdId}/extend`)
      .set(auth(writerToken))
      .send({ expiryDate: inDays(100) })
      .expect(400);

    const mine = await http()
      .get('/dashboard/reminders')
      .set(auth(readerToken))
      .expect(200);
    expect(JSON.stringify(mine.body)).not.toContain(emdId);
  });

  it('attaches a document, downloads it, and removes it', async () => {
    const res = await http()
      .post(`${base}/guarantees/${emdId}/documents`)
      .set(auth(writerToken))
      .send({
        title: 'BG copy',
        data: pdf('bg-copy').toString('base64'),
        contentType: 'application/pdf',
        fileName: 'bg-copy.pdf',
      })
      .expect(201);
    const doc = res.body.guarantees.find((g: { id: string }) => g.id === emdId)
      .documents[0];
    expect(doc).toMatchObject({
      title: 'BG copy',
      contentType: 'application/pdf',
    });

    const file = await http()
      .get(`${base}/documents/${doc.id}/file`)
      .set(auth(readerToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((file.body as Buffer).toString('ascii')).toContain('bg-copy');

    // A reader may download but not remove.
    await http()
      .delete(`${base}/documents/${doc.id}`)
      .set(auth(readerToken))
      .expect(403);
    const after = await http()
      .delete(`${base}/documents/${doc.id}`)
      .set(auth(writerToken))
      .expect(200);
    expect(
      after.body.guarantees.find((g: { id: string }) => g.id === emdId)
        .documents,
    ).toEqual([]);
  });

  it('releases, refuses edits while released, and reopens with a reason', async () => {
    let res = await http()
      .post(`${base}/guarantees/${emdId}/release`)
      .set(auth(writerToken))
      .send({ releasedOn: inDays(0) })
      .expect(201);
    expect(
      res.body.guarantees.find((g: { id: string }) => g.id === emdId)
        .displayStatus,
    ).toBe('RELEASED');

    res = await http()
      .patch(`${base}/guarantees/${emdId}`)
      .set(auth(writerToken))
      .send({ remarks: 'late edit' })
      .expect(409);
    expect(res.body.code).toBe('BG_NOT_RUNNING');

    res = await http()
      .post(`${base}/guarantees/${emdId}/reopen`)
      .set(auth(writerToken))
      .send({ note: 'Release recorded against the wrong BG' })
      .expect(201);
    const emd = res.body.guarantees.find((g: { id: string }) => g.id === emdId);
    expect(emd.status).toBe('RUNNING');
    expect(emd.releasedOn).toBeNull();
    expect(emd.events[0]).toMatchObject({ kind: 'reopened' });
  });

  it('encashes up to the BG amount only', async () => {
    await http()
      .post(`${base}/guarantees/${emdId}/encash`)
      .set(auth(writerToken))
      .send({ encashedOn: inDays(0), encashedAmount: '9999999' })
      .expect(400);
    const res = await http()
      .post(`${base}/guarantees/${emdId}/encash`)
      .set(auth(writerToken))
      .send({ encashedOn: inDays(0), encashedAmount: '1000000' })
      .expect(201);
    expect(
      res.body.guarantees.find((g: { id: string }) => g.id === emdId),
    ).toMatchObject({
      displayStatus: 'ENCASHED',
      encashedAmount: '1000000.00',
    });
  });

  it('exports the client’s sheet as Excel', async () => {
    const res = await http()
      .get(`${base}/export.xlsx`)
      .set(auth(readerToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // An xlsx is a zip.
    expect((res.body as Buffer).subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('gates the register on BANK_GUARANTEES: read for a reader, nothing for an outsider', async () => {
    await http().get(base).set(auth(outsiderToken)).expect(403);
    await http()
      .post(base)
      .set(auth(readerToken))
      .send({ workName: 'x', departmentName: 'y' })
      .expect(403);
    await http().get(`${base}/${tenderId}`).set(auth(readerToken)).expect(200);
  });

  it('refuses to delete a tender that still has guarantees', async () => {
    await http()
      .delete(`${base}/${tenderId}`)
      .set(auth(writerToken))
      .expect(409);
    await http()
      .delete(`${base}/guarantees/${pbgId}`)
      .set(auth(writerToken))
      .expect(200);
    await http()
      .delete(`${base}/guarantees/${emdId}`)
      .set(auth(writerToken))
      .expect(200);
    await http()
      .delete(`${base}/${tenderId}`)
      .set(auth(writerToken))
      .expect(200);
  });
});
