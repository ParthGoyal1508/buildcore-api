import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { SLOT_FINAL } from '../src/approvals/approval-slots';
import { ChainsService } from '../src/approvals/chains.service';
import { ACTION_LETTER_WORK_ORDER } from '../src/approvals/default-chains';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Letters end to end (017 US3, US5, T046, T051, quickstart Passes 5 and 6).
 *
 * The claim under test is FR-015a: a work order commits company money and must not
 * become a document until the director has approved it. It is driven over HTTP through
 * 016's real chain — submitted, refused while pending, approved, then issued — because a
 * gate tested against a mocked approval service proves only that a mock was called.
 *
 * Every fixture is prefixed `E2ELT` and removed in `afterAll`.
 */
const PREFIX = 'E2ELT';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(60_000);

describe('Letters (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let chains: ChainsService;
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
  let financeToken: string;
  let directorToken: string;
  let adminToken: string;
  let directorUserId: string;
  let financeUserId: string;
  let workOrderLetterId: string;
  let signatoryId: string;
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
    return {
      userId: user.id,
      roleId: role.id,
      token: login.body.accessToken as string,
    };
  };

  const templateFor = async (letterKindKey: string, body: string) => {
    const kind = await sys.letterKind.findFirst({
      where: { key: letterKindKey, OR: [{ companyId }, { companyId: null }] },
    });
    return sys.letterTemplate.create({
      data: {
        companyId,
        letterKindId: kind.id,
        name: `${PREFIX} ${letterKindKey}`,
        bodyTemplate: body,
        isActive: true,
      },
    });
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
    chains = app.get(ChainsService);

    const company = await sys.company.create({
      data: {
        name: 'E2ELT Letters Constructions',
        shortCode: unique('T').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    // Aadhaar exists as a restricted type, for the FR-024 pass.
    await sys.documentType.create({
      data: { companyId, code: 'AADHAAR', name: 'Aadhaar', isRestricted: true },
    });

    const finance = await makeUser('Fin', [Permission.PROJECT_FINANCIALS]);
    financeToken = finance.token;
    financeUserId = finance.userId;
    const director = await makeUser('Dir', [
      Permission.PROJECT_FINANCIALS,
      Permission.SETTINGS,
    ]);
    directorToken = director.token;
    directorUserId = director.userId;
    const admin = await makeUser('Adm', [Permission.SETTINGS]);
    adminToken = admin.token;

    // 016's chain for work orders: one level, the director's, and it is final.
    const actor = { userId: directorUserId, ipAddress: '127.0.0.1' };
    const ctx = { isSuperAdmin: false, companyId };
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_FINAL, roleId: director.roleId },
      actor,
    );
    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: ACTION_LETTER_WORK_ORDER,
        isFinalAuthorityRequired: true,
        levels: [{ position: 1, slotKey: SLOT_FINAL, isFinalAuthority: true }],
      },
      actor,
    );

    await templateFor(
      'letter_work_order',
      'Work order to {{vendorName}} for {{amount}}. Dated {{issueDate}}.',
    );
    await templateFor('experience', 'This certifies {{employeeName}}.');

    // A work order carries a signature — an unsigned work order is not a work order —
    // so the seeded kind has `requiresSignature: true` and composing one without a
    // signatory is refused. A 1x1 PNG is enough: the renderer degrades gracefully on a
    // graphic it cannot decode, and what is under test is the freeze, not the image.
    const signatory = await http()
      .post('/signatories')
      .set(auth(adminToken))
      .send({
        name: 'Sunil Agarwal',
        title: 'Director',
        signature:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        contentType: 'image/png',
      })
      .expect(201);
    signatoryId = signatory.body.id;
  }, 180_000);

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.issuedLetter.deleteMany({ where: { companyId } });
    await sys.signatory.deleteMany({ where: { companyId } });
    await sys.letterTemplate.deleteMany({ where: { companyId } });
    await sys.letterKind.deleteMany({ where: { companyId } });
    await sys.documentType.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  }, 60_000);

  it('composes a work order without issuing it, and raises the chain (FR-015a)', async () => {
    const res = await http()
      .post('/letters')
      .set(auth(financeToken))
      .send({
        letterKindKey: 'letter_work_order',
        subjectType: 'vendor',
        subjectId: 'vendor-shree',
        signatoryId,
        variables: {
          vendorName: 'Shree Constructions',
          amount: '4,50,000',
          issueDate: '2026-09-16',
        },
      })
      .expect(201);

    workOrderLetterId = res.body.id;
    expect(res.body.status).toBe('composed');
    expect(res.body.issuedAt).toBeNull();

    // The chain is real: an instance exists against this letter.
    const instance = await sys.approvalInstance.findFirst({
      where: { companyId, entityId: workOrderLetterId },
    });
    expect(instance).toBeTruthy();
    expect(instance.state).toBe('pending');
  });

  it('refuses to issue it while the chain is pending — 016’s code (T046)', async () => {
    const res = await http()
      .post(`/letters/${workOrderLetterId}/issue`)
      .set(auth(financeToken))
      .send({ variables: { vendorName: 'Shree Constructions' } })
      .expect(409);

    // `APPROVAL_NOT_COMPLETE` comes from 016 and is not re-declared here. Two constants
    // for one condition is how a client ends up branching on the wrong one.
    expect(res.body.code).toBe('APPROVAL_NOT_COMPLETE');

    const row = await sys.issuedLetter.findUnique({
      where: { id: workOrderLetterId },
    });
    expect(row.issuedAt).toBeNull();
    expect(row.renderedRef).toBe('');
  });

  it('issues it once the director approves (US3, quickstart Pass 6)', async () => {
    const instance = await sys.approvalInstance.findFirst({
      where: { companyId, entityId: workOrderLetterId },
    });
    await http()
      .post(`/approvals/${instance.id}/decide`)
      .set(auth(directorToken))
      .send({ action: 'approve' })
      .expect(201);

    const issued = await http()
      .post(`/letters/${workOrderLetterId}/issue`)
      .set(auth(financeToken))
      .send({
        variables: {
          vendorName: 'Shree Constructions',
          amount: '4,50,000',
          issueDate: '2026-09-16',
        },
      })
      .expect(201);

    expect(issued.body.status).toBe('issued');
    expect(issued.body.issuedAt).toBeTruthy();

    const download = await http()
      .get(`/letters/${workOrderLetterId}/download`)
      .set(auth(financeToken))
      .expect(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.length).toBeGreaterThan(500);
  });

  it('refuses a caller without the permission this kind requires', async () => {
    // `adminToken` holds SETTINGS but not PROJECT_FINANCIALS. There is no single
    // letters permission, for the same reason 016 has no approvals permission.
    const res = await http()
      .post('/letters')
      .set(auth(adminToken))
      .send({
        letterKindKey: 'letter_work_order',
        subjectType: 'vendor',
        subjectId: 'vendor-x',
        signatoryId,
        variables: {},
      })
      .expect(403);

    expect(res.body.code).toBe('LETTER_KIND_FORBIDDEN');
  });

  it('lists letters by the opaque subject, and never resolves it (FR-019)', async () => {
    const res = await http()
      .get('/letters')
      .set(auth(financeToken))
      .query({ subjectType: 'vendor', subjectId: 'vendor-shree' })
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].subjectId).toBe('vendor-shree');
    // No vendor name anywhere in the response — this module does not know what a vendor
    // is, which is what let the table leave `recruitment`.
    expect(JSON.stringify(res.body)).not.toContain('Shree Constructions');
  });

  it('defines a BRAND-NEW kind with no code change, and refuses Aadhaar in it (T051, Pass 5)', async () => {
    const kind = await http()
      .post('/letter-kinds')
      .set(auth(adminToken))
      .send({ key: 'site_pass', label: 'Site pass' })
      .expect(201);

    expect(kind.body.isShipped).toBe(false);

    // A template for a kind that did not exist when this code shipped, referencing the
    // restricted type. The refusal must be identical to the seeded kinds' — if it is
    // not, the rule was written into the kinds that existed at build time.
    const letterKind = await sys.letterKind.findFirst({
      where: { companyId, key: 'site_pass' },
    });
    await sys.letterTemplate.create({
      data: {
        companyId,
        letterKindId: letterKind.id,
        name: `${PREFIX} pass`,
        bodyTemplate: 'Pass for {{workerName}}, Aadhaar {{document.AADHAAR}}.',
        isActive: true,
      },
    });

    const res = await http()
      .post('/letters')
      .set(auth(adminToken))
      .send({
        letterKindKey: 'site_pass',
        subjectType: 'worker',
        subjectId: 'w-1',
        variables: { workerName: 'Anil' },
      })
      .expect(400);

    expect(res.body.code).toBe('DOCUMENT_TYPE_RESTRICTED');
  });

  it('refuses to reuse a product-shipped key (FR-011a)', async () => {
    const res = await http()
      .post('/letter-kinds')
      .set(auth(adminToken))
      .send({ key: 'offer', label: 'Our own offer' })
      .expect(409);

    expect(res.body.code).toBe('LETTER_KIND_KEY_RESERVED');
  });

  it('refuses to delete a kind a letter references — 409, not a cascade (FR-022, T051)', async () => {
    const letterKind = await sys.letterKind.findFirst({
      where: { companyId, key: 'site_pass' },
    });
    // Give it something to reference: the template created above already does.
    const res = await http()
      .delete(`/letter-kinds/${letterKind.id}`)
      .set(auth(adminToken))
      .expect(409);

    expect(res.body.code).toBe('LETTER_KIND_IN_USE');

    // Still there. A kind that vanished would orphan every letter issued under it.
    const still = await sys.letterKind.findUnique({
      where: { id: letterKind.id },
    });
    expect(still).toBeTruthy();
  });

  it('reissues an issued letter, superseding it and keeping both (FR-014)', async () => {
    const res = await http()
      .post(`/letters/${workOrderLetterId}/reissue`)
      .set(auth(financeToken))
      .send({
        variables: {
          vendorName: 'Shree Constructions',
          amount: '5,10,000',
          issueDate: '2026-09-16',
        },
      })
      .expect(201);

    expect(res.body.version).toBe(2);

    const rows = await sys.issuedLetter.findMany({
      where: { companyId, subjectId: 'vendor-shree' },
      orderBy: { version: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].isSuperseded).toBe(true);
    // The superseded version keeps its file: a letter that went out is a fact.
    expect(rows[0].renderedRef).toBeTruthy();
    expect(rows[0].renderedRef).not.toBe(rows[1].renderedRef);
  });

  it('distinguishes issued from executed once the countersigned copy arrives (FR-017, FR-018)', async () => {
    const current = await sys.issuedLetter.findFirst({
      where: { companyId, subjectId: 'vendor-shree', isSuperseded: false },
    });

    const res = await http()
      .post(`/letters/${current.id}/countersigned`)
      .set(auth(financeToken))
      .send({
        data: Buffer.from('%PDF-1.4 executed copy').toString('base64'),
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(res.body.status).toBe('executed');

    const row = await sys.issuedLetter.findUnique({
      where: { id: current.id },
    });
    // Two distinguishable documents. "We sent this" and "they signed it" are different
    // claims, and collapsing them into one file would lose the second.
    expect(row.countersignedRef).toBeTruthy();
    expect(row.countersignedRef).not.toBe(row.renderedRef);
  });
});
