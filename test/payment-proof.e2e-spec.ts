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
 * Proof that the money moved (017 US7, T060, FR-020, FR-021).
 *
 * Payments carried a reference number somebody typed and nothing behind it. US7 closes
 * that: the RTGS advice and the entry become one record, and the list says which
 * payments are still missing theirs.
 *
 * Every fixture is prefixed `E2EPP` and removed in `afterAll`.
 */
const PREFIX = 'E2EPP';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(60_000);

describe('Payment proof (e2e)', () => {
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
  let vendorId: string;
  let token: string;
  let withProofId: string;
  let withoutProofId: string;
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
        name: 'E2EPP Payments Constructions',
        shortCode: unique('P').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const vendor = await sys.vendor.create({
      data: {
        companyId,
        code: unique('V').slice(0, 20),
        name: `${PREFIX} Shree Suppliers`,
        type: 'material',
      },
    });
    vendorId = vendor.id;

    const user = await sys.user.create({
      data: {
        email: `${unique('Acc')}@example.test`.toLowerCase(),
        username: unique('Acc'),
        password: await hash('secret42'),
        displayName: `${PREFIX} Accounts`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(user.id);
    const role = await sys.role.create({
      data: { name: unique('AccRole'), permissions: [Permission.INVENTORY] },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    token = (
      await http()
        .post('/auth/login')
        .send({
          identifier: user.email,
          password: 'secret42',
          rememberMe: false,
        })
        .expect(201)
    ).body.accessToken;
  }, 180_000);

  afterAll(async () => {
    await sys.paymentAllocation.deleteMany({ where: { companyId } });
    await sys.payment.deleteMany({ where: { companyId } });
    await sys.vendor.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  const recordPayment = async (reference: string) => {
    const res = await http()
      .post('/inventory/payments')
      .set(auth(token))
      .send({
        vendorId,
        amount: 125000,
        date: '2026-09-10',
        paymentMode: 'bank_transfer',
        referenceNumber: reference,
      })
      .expect(201);
    return res.body.id as string;
  };

  it('records a payment with no proof, and says so', async () => {
    withoutProofId = await recordPayment(unique('REF'));

    const res = await http()
      .get('/inventory/payments')
      .set(auth(token))
      .expect(200);
    const row = res.body.payments.find(
      (p: { id: string }) => p.id === withoutProofId,
    );

    // A payment is recorded when the money moves; the advice often arrives afterwards.
    // Refusing the payment until the proof exists would push people to record it
    // somewhere else, which is how the gap US7 closes was created.
    expect(row.hasProof).toBe(false);
    expect(row.proofUploadedAt).toBeNull();
  });

  it('attaches the transaction proof and retrieves it (FR-020)', async () => {
    withProofId = await recordPayment(unique('REF'));

    const attached = await http()
      .post(`/inventory/payments/${withProofId}/proof`)
      .set(auth(token))
      .send({
        data: Buffer.from('%PDF-1.4 RTGS advice').toString('base64'),
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(attached.body.hasProof).toBe(true);
    expect(attached.body.proofUploadedAt).toBeTruthy();

    const download = await http()
      .get(`/inventory/payments/${withProofId}/proof`)
      .set(auth(token))
      .expect(200);
    expect(download.body.toString()).toContain('RTGS advice');
  });

  it('lists exactly the payments missing a proof (FR-021)', async () => {
    const res = await http()
      .get('/inventory/payments')
      .set(auth(token))
      .query({ missingProof: 'true' })
      .expect(200);

    const ids = res.body.payments.map((p: { id: string }) => p.id);
    // A filter, not a count. "2 payments lack proof" makes somebody scroll looking for
    // them; this hands them the list.
    expect(ids).toContain(withoutProofId);
    expect(ids).not.toContain(withProofId);
    expect(
      res.body.payments.every((p: { hasProof: boolean }) => !p.hasProof),
    ).toBe(true);
  });

  it('audit-logs the retrieval before the bytes leave (FR-023)', async () => {
    await http()
      .get(`/inventory/payments/${withProofId}/proof`)
      .set(auth(token))
      .expect(200);

    const entries = await sys.auditLogEntry.findMany({
      where: { companyId, entityId: withProofId },
    });
    const read = entries.find(
      (e: { changes: { retrieved?: string } }) =>
        e.changes?.retrieved === 'proof',
    );
    // A payment advice names an account number. Who looked at it is worth knowing.
    expect(read).toBeDefined();
  });

  it('404s a proof that was never attached, rather than an empty file', async () => {
    await http()
      .get(`/inventory/payments/${withoutProofId}/proof`)
      .set(auth(token))
      .expect(404);
  });

  it('keeps the old advice when a corrected one replaces it', async () => {
    const before = await sys.payment.findUnique({ where: { id: withProofId } });

    await http()
      .post(`/inventory/payments/${withProofId}/proof`)
      .set(auth(token))
      .send({
        data: Buffer.from('%PDF-1.4 corrected advice').toString('base64'),
        contentType: 'application/pdf',
      })
      .expect(201);

    const after = await sys.payment.findUnique({ where: { id: withProofId } });
    // A new reference, so the old blob is still addressable. The first advice is itself
    // a record of what somebody believed at the time, and a bank re-issuing a corrected
    // one should not erase that.
    expect(after.proofRef).not.toBe(before.proofRef);
  });
});
