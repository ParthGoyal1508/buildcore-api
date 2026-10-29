import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { BILLING_ERRORS } from '../src/projects/billing/billing-error-codes';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * Client receipts, retention and CPBG held by the client, and project types (048).
 *
 * One government project with a 5% retention and a 3% CPBG term, one bill to the client, and the
 * money coming back: the receipt records what the client withheld, the held-by-client balance
 * follows, a PBG submitted on the project's tender stops the CPBG suggestion and flags the cash
 * deduction for refund, and the refund is recorded against that PBG.
 */
const stamp = `${Date.now() % 100000}`;
const unique = (s: string) => `E2E${s}${stamp}`;

jest.setTimeout(120_000);

describe('Client holdings — receipts, retention, CPBG, project types (e2e, 048)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;
  let clientId: string;
  let projectId: string;
  let billId: string;
  let draftBillId: string;
  let tenderId: string;
  let pbgId: string;
  let requirementsBefore: {
    documentTypeId: string;
    isMandatory: boolean;
    forGovernment: boolean;
    forPrivate: boolean;
  }[] = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const q = () => `?companyId=${companyId}`;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );

  const compose = async (
    lines: { boqTaskItemId: string; quantity: number }[],
  ) =>
    http()
      .post(`/projects/client-bills${q()}`)
      .set(auth())
      .send({
        projectId,
        billingDate: '2026-10-21',
        retentionPercent: 0.05,
        lines,
      })
      .expect(201);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const login = await http()
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;
    companyId = await effectiveCompanyIdFor(sys);

    const client = await http()
      .post(`/projects/clients${q()}`)
      .set(auth())
      .send({ name: unique('Client') })
      .expect(201);
    clientId = client.body.id;

    const project = await createProjectWithMandatoryDocuments({
      http,
      headers: auth(),
      body: {
        name: unique('Holdings'),
        clientId,
        contractValue: 10_000_000,
        startDate: '2025-01-01',
        sector: 'government',
        clientRetentionFraction: 0.05,
        clientCpbgFraction: 0.03,
      },
      companyId,
    });
    expect(project.status).toBe(201);
    projectId = project.body.id;

    const group = await http()
      .post(`/projects/${projectId}/boq/groups${q()}`)
      .set(auth())
      .send({ boqNo: '1', name: 'Works', scopeQty: '0' })
      .expect(201);
    const item = await http()
      .post(`/projects/${projectId}/boq/items${q()}`)
      .set(auth())
      .send({
        groupId: group.body.id,
        boqNo: '1.01',
        taskName: 'Earthwork',
        unit: 'Cum',
        scopeQty: '1000',
        rate: '1000',
      })
      .expect(201);

    // ₹1,00,000 billed; 5% retention on the bill is ₹5,000; the 3% CPBG term is ₹3,000.
    const bill = await compose([
      { boqTaskItemId: item.body.id, quantity: 100 },
    ]);
    billId = bill.body.id;
    await http()
      .post(`/projects/client-bills/${billId}/submit${q()}`)
      .set(auth())
      .expect(201);
    const draft = await compose([{ boqTaskItemId: item.body.id, quantity: 1 }]);
    draftBillId = draft.body.id;
  });

  afterAll(async () => {
    if (requirementsBefore.length > 0) {
      await http()
        .put(`/projects/document-requirements${q()}`)
        .set(auth())
        .send({ requirements: requirementsBefore });
    }
    await sys.clientHoldRelease.deleteMany({ where: { projectId } });
    await sys.clientBillReceipt.deleteMany({ where: { projectId } });
    if (tenderId) await sys.bgTender.deleteMany({ where: { id: tenderId } });
    await sys.clientBill.deleteMany({ where: { projectId } });
    await sys.bOQTaskGroup.deleteMany({ where: { projectId } });
    await sys.projectDocument.deleteMany({ where: { projectId } });
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    await app.close();
  }, 120_000);

  it('stores the project type and the CPBG term', async () => {
    const row = await sys.project.findFirst({ where: { id: projectId } });
    expect(row.sector).toBe('government');
    expect(Number(row.clientCpbgFraction)).toBe(0.03);
  });

  it('suggests the bill’s retention and the project’s CPBG for the first receipt', async () => {
    const res = await http()
      .get(`/projects/client-bills/${billId}/receipts${q()}`)
      .set(auth())
      .expect(200);
    expect(res.body).toMatchObject({
      billValue: '100000.00',
      billValueBasis: 'billed',
      settled: '0.00',
      outstanding: '100000.00',
      suggested: { retentionAmount: '5000.00', cpbgAmount: '3000.00' },
      pbgRunning: false,
    });
  });

  it('refuses a receipt against a draft bill', async () => {
    const res = await http()
      .post(`/projects/client-bills/${draftBillId}/receipts${q()}`)
      .set(auth())
      .send({
        receivedOn: '2026-10-25',
        amount: 100,
        instrument: 'bank_transfer',
      })
      .expect(400);
    expect(res.body.code).toBe(BILLING_ERRORS.receiptBillDraft);
  });

  it('records the payment with what the client withheld', async () => {
    const res = await http()
      .post(`/projects/client-bills/${billId}/receipts${q()}`)
      .set(auth())
      .send({
        receivedOn: '2026-10-25',
        amount: 90_000,
        retentionAmount: 5_000,
        cpbgAmount: 3_000,
        tdsAmount: 2_000,
        instrument: 'bank_transfer',
        reference: 'UTR123',
      })
      .expect(201);
    expect(res.body.receipt.settles).toBe('100000.00');
    expect(res.body.position).toMatchObject({
      settled: '100000.00',
      outstanding: '0.00',
      suggested: { retentionAmount: '0.00', cpbgAmount: '0.00' },
    });
  });

  it('refuses a receipt that would settle more than the bill', async () => {
    const res = await http()
      .post(`/projects/client-bills/${billId}/receipts${q()}`)
      .set(auth())
      .send({ receivedOn: '2026-10-26', amount: 1, instrument: 'cheque' })
      .expect(400);
    expect(res.body.code).toBe(BILLING_ERRORS.receiptExceedsBill);
  });

  it('shows what the client is holding', async () => {
    const res = await http()
      .get(`/projects/${projectId}/client-holdings${q()}`)
      .set(auth())
      .expect(200);
    expect(res.body).toMatchObject({
      received: '90000.00',
      receiptCount: 1,
      retention: { withheld: '5000.00', released: '0.00', held: '5000.00' },
      cpbg: { deducted: '3000.00', refunded: '0.00', held: '3000.00' },
      tds: '2000.00',
      totalHeld: '8000.00',
      runningPbgs: [],
      cpbgRefundDue: false,
    });
  });

  it('flags the CPBG for refund once a PBG is running, and refunds it against the PBG', async () => {
    const tender = await sys.bgTender.create({
      data: {
        companyId,
        serialNo: 900000 + Number(stamp),
        workName: unique('Work'),
        departmentName: 'PWD',
        projectId,
        createdByUserId: 'e2e-048',
      },
    });
    tenderId = tender.id;
    const pbg = await sys.bankGuarantee.create({
      data: {
        companyId,
        tenderId,
        type: 'PBG',
        bgNumber: unique('PBG'),
        amount: '300000',
        expiryDate: new Date('2027-12-31'),
        createdByUserId: 'e2e-048',
      },
    });
    pbgId = pbg.id;

    const held = await http()
      .get(`/projects/${projectId}/client-holdings${q()}`)
      .set(auth())
      .expect(200);
    expect(held.body.runningPbgs).toHaveLength(1);
    expect(held.body.cpbgRefundDue).toBe(true);

    const tooMuch = await http()
      .post(`/projects/${projectId}/client-holdings/releases${q()}`)
      .set(auth())
      .send({
        kind: 'cpbg',
        amount: 3_000.01,
        releasedOn: '2026-10-28',
        reason: 'PBG submitted',
      })
      .expect(400);
    expect(tooMuch.body.code).toBe(BILLING_ERRORS.holdReleaseExceedsHeld);

    const refunded = await http()
      .post(`/projects/${projectId}/client-holdings/releases${q()}`)
      .set(auth())
      .send({
        kind: 'cpbg',
        amount: 3_000,
        releasedOn: '2026-10-28',
        reason: 'PBG submitted',
        bankGuaranteeId: pbgId,
      })
      .expect(201);
    expect(refunded.body).toMatchObject({
      cpbg: { deducted: '3000.00', refunded: '3000.00', held: '0.00' },
      totalHeld: '5000.00',
      cpbgRefundDue: false,
    });
    expect(refunded.body.releases[0].bgNumber).toBe(pbg.bgNumber);
  });

  it('refuses to remove a receipt whose withheld CPBG has been refunded', async () => {
    const list = await http()
      .get(`/projects/client-bills/${billId}/receipts${q()}`)
      .set(auth())
      .expect(200);
    const res = await http()
      .delete(
        `/projects/client-bills/${billId}/receipts/${
          list.body.receipts[0].id
        }${q()}`,
      )
      .set(auth())
      .expect(409);
    expect(res.body.code).toBe(BILLING_ERRORS.receiptReleasedAgainst);
  });

  it('holds a private project only to the kinds marked for private projects', async () => {
    const current = await http()
      .get(`/projects/document-requirements${q()}`)
      .set(auth())
      .expect(200);
    requirementsBefore = current.body.requirements.map(
      (r: {
        documentTypeId: string;
        isMandatory: boolean;
        forGovernment: boolean;
        forPrivate: boolean;
      }) => ({
        documentTypeId: r.documentTypeId,
        isMandatory: r.isMandatory,
        forGovernment: r.forGovernment,
        forPrivate: r.forPrivate,
      }),
    );
    expect(requirementsBefore.length).toBeGreaterThan(0);

    // Every kind becomes government-only, so a private project owes nothing.
    await http()
      .put(`/projects/document-requirements${q()}`)
      .set(auth())
      .send({
        requirements: requirementsBefore.map((r) => ({
          ...r,
          forPrivate: false,
        })),
      })
      .expect(200);

    await http()
      .patch(`/projects/${projectId}${q()}`)
      .set(auth())
      .send({ sector: 'private' })
      .expect(200);
    const asPrivate = await http()
      .get(`/projects/${projectId}${q()}`)
      .set(auth())
      .expect(200);
    expect(asPrivate.body.documentReadiness.required).toBe(0);

    await http()
      .patch(`/projects/${projectId}${q()}`)
      .set(auth())
      .send({ sector: 'government' })
      .expect(200);
    const asGovernment = await http()
      .get(`/projects/${projectId}${q()}`)
      .set(auth())
      .expect(200);
    expect(asGovernment.body.documentReadiness.required).toBe(
      requirementsBefore.filter((r) => r.isMandatory).length,
    );
  });

  it('lists the held figures in the Held by client report', async () => {
    const res = await http()
      .post(`/reports/client-holdings/run${q()}`)
      .set(auth())
      .send({})
      .expect(201);
    const row = (res.body.rows ?? res.body.data?.rows ?? []).find(
      (r: { project: string }) => r.project === unique('Holdings'),
    );
    expect(row).toMatchObject({
      retentionHeld: 5000,
      cpbgHeld: 0,
      totalHeld: 5000,
    });
  });
});
