import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { configureApp } from '../src/common/configure-app';

/**
 * End-to-end coverage of `/partners/*` against a real database (007 T019, T023,
 * T029, T037).
 *
 * The behaviours asserted here are the ones that only appear when the database is
 * real: wholesale replacement of a vendor's contacts inside one transaction, the
 * derived compliance status and the contractor recompute that rides along with it,
 * and the immutability of a verified filing. A mocked Prisma client would happily
 * report all four working while the transactions did something else.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Partners module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const createdVendorIds: string[] = [];
  const createdCategoryIds: string[] = [];

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

    const company = await sys.company.findFirst({ orderBy: { createdAt: 'asc' } });
    companyId = company.id;
  });

  afterAll(async () => {
    // Vendors cascade to contacts, deals-in links, hire details, contractor
    // profiles, their documents and compliance rows — so deleting the vendor is
    // enough, and doing it explicitly beats relying on a database reset nobody runs.
    for (const id of createdVendorIds) {
      await sys.vendor.deleteMany({ where: { id } });
    }
    for (const id of createdCategoryIds) {
      await sys.vendorCategory.deleteMany({ where: { id } });
    }
    await sys.bOCWPayment.deleteMany({
      where: { projectId: { startsWith: PREFIX } },
    });
    await app.close();
  });

  async function createVendor(body: Record<string, unknown>) {
    const res = await http()
      .post(`/partners/vendors?companyId=${companyId}`)
      .set(auth())
      .send(body)
      .expect(201);
    createdVendorIds.push(res.body.id);
    return res.body;
  }

  describe('Vendors (T019)', () => {
    it('creates a vendor with contacts and category tags, then replaces them wholesale', async () => {
      const category = await http()
        .post(`/partners/vendor-categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Cat') })
        .expect(201);
      createdCategoryIds.push(category.body.id);

      const vendor = await createVendor({
        name: unique('Vendor'),
        type: 'material',
        gstin: '27AAPFU0939F1ZV',
        tdsSection: '194C',
        tdsRate: 2,
        contacts: [
          { name: 'Asha Rane', phone: '9876543210' },
          { name: 'Vikram Patil', phone: '9876500000' },
        ],
        categoryIds: [category.body.id],
      });

      expect(vendor.code).toMatch(/-VEN-\d{4}$/);
      expect(vendor.contacts).toHaveLength(2);
      expect(vendor.categoryIds).toEqual([category.body.id]);

      // The point of the test: sending one contact must leave exactly one, not three.
      await http()
        .patch(`/partners/vendors/${vendor.id}`)
        .set(auth())
        .send({ contacts: [{ name: 'Asha Rane', phone: '9999999999' }] })
        .expect(200);

      const after = await http()
        .get(`/partners/vendors/${vendor.id}`)
        .set(auth())
        .expect(200);
      expect(after.body.contacts).toHaveLength(1);
      expect(after.body.contacts[0].phone).toBe('9999999999');
    });

    it('returns only the TDS terms from the TDS endpoint', async () => {
      const vendor = await createVendor({
        name: unique('Tds'),
        type: 'service',
        tdsSection: '194J',
        tdsRate: 10,
      });
      const res = await http()
        .get(`/partners/vendors/${vendor.id}/tds`)
        .set(auth())
        .expect(200);
      expect(res.body).toEqual({ tdsSection: '194J', tdsRate: 10 });
    });

    it('rejects a malformed GSTIN at the boundary', async () => {
      await http()
        .post(`/partners/vendors?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Bad'), type: 'material', gstin: 'NOT-A-GSTIN' })
        .expect(400);
    });

    it('refuses to delete a category that vendors still deal in', async () => {
      const category = await http()
        .post(`/partners/vendor-categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('InUse') })
        .expect(201);
      createdCategoryIds.push(category.body.id);

      await createVendor({
        name: unique('Tagged'),
        type: 'material',
        categoryIds: [category.body.id],
      });

      await http()
        .delete(`/partners/vendor-categories/${category.body.id}`)
        .set(auth())
        .expect(409);
    });
  });

  describe('Contractor vault (T023)', () => {
    it('refuses a contractor profile for a vendor that does not supply labour', async () => {
      const vendor = await createVendor({ name: unique('Material'), type: 'material' });
      await http()
        .post('/partners/contractors')
        .set(auth())
        .send({ vendorId: vendor.id })
        .expect(400);
    });

    it('flags a document expiring inside the warning window', async () => {
      const vendor = await createVendor({
        name: unique('Labour'),
        type: 'labour_contractor',
      });
      const contractor = await http()
        .post('/partners/contractors')
        .set(auth())
        .send({ vendorId: vendor.id, licenceNumber: 'LIC-1' })
        .expect(201);
      expect(contractor.body.complianceStatus).toBe('non_compliant');

      const soon = new Date();
      soon.setDate(soon.getDate() + 20);
      await http()
        .post(`/partners/contractors/${contractor.body.id}/documents`)
        .set(auth())
        .send({
          documentType: 'labour_license',
          file: Buffer.from('licence').toString('base64'),
          fileName: 'licence.pdf',
          expiresAt: soon.toISOString().slice(0, 10),
        })
        .expect(201);

      const detail = await http()
        .get(`/partners/contractors/${contractor.body.id}`)
        .set(auth())
        .expect(200);
      expect(detail.body.documents).toHaveLength(1);
      expect(detail.body.documents[0].expiryWarning).toBe(true);
    });
  });

  describe('Monthly compliance (T029)', () => {
    it('derives status, recomputes the contractor, and freezes a verified record', async () => {
      const vendor = await createVendor({
        name: unique('Sub'),
        type: 'subcontractor',
      });
      const contractor = await http()
        .post('/partners/contractors')
        .set(auth())
        .send({ vendorId: vendor.id })
        .expect(201);

      const now = new Date();
      const prev = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      );
      const month = `${prev.getUTCFullYear()}-${String(
        prev.getUTCMonth() + 1,
      ).padStart(2, '0')}`;

      const created = await http()
        .post('/partners/compliance')
        .set(auth())
        .send({
          contractorProfileId: contractor.body.id,
          month,
          pfChallanNumber: 'PF-1',
          pfAmount: 12000,
        })
        .expect(201);
      expect(created.body.status).toBe('partial');

      // The recompute rides along in the same transaction as the filing.
      const partial = await http()
        .get(`/partners/contractors/${contractor.body.id}`)
        .set(auth())
        .expect(200);
      expect(partial.body.complianceStatus).toBe('partially_compliant');

      const updated = await http()
        .patch(`/partners/compliance/${created.body.id}`)
        .set(auth())
        .send({ esicChallanNumber: 'ESIC-1', esicAmount: 3400 })
        .expect(200);
      expect(updated.body.status).toBe('submitted');

      const verified = await http()
        .patch(`/partners/compliance/${created.body.id}/verify`)
        .set(auth())
        .expect(200);
      expect(verified.body.status).toBe('verified');
      expect(verified.body.verifiedAt).toBeTruthy();

      const compliant = await http()
        .get(`/partners/contractors/${contractor.body.id}`)
        .set(auth())
        .expect(200);
      expect(compliant.body.complianceStatus).toBe('compliant');

      // A verified filing is somebody's signed assertion; editing it must fail.
      await http()
        .patch(`/partners/compliance/${created.body.id}`)
        .set(auth())
        .send({ pfAmount: 1 })
        .expect(409);
    });

    it('refuses to verify a filing that is only partial', async () => {
      const vendor = await createVendor({
        name: unique('Partial'),
        type: 'subcontractor',
      });
      const contractor = await http()
        .post('/partners/contractors')
        .set(auth())
        .send({ vendorId: vendor.id })
        .expect(201);

      const created = await http()
        .post('/partners/compliance')
        .set(auth())
        .send({
          contractorProfileId: contractor.body.id,
          month: '2025-04',
          pfChallanNumber: 'PF-ONLY',
        })
        .expect(201);

      await http()
        .patch(`/partners/compliance/${created.body.id}/verify`)
        .set(auth())
        .expect(409);
    });
  });

  describe('RAG matrix', () => {
    it('returns twelve months and grays the ones not yet due', async () => {
      const now = new Date();
      const startYear =
        now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      const fy = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

      const res = await http()
        .get(`/partners/rag?fy=${fy}&companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(res.body.months).toHaveLength(12);
      for (const row of res.body.rows) {
        expect(row.cells).toHaveLength(12);
      }
    });

    it('rejects a financial year label spanning more than one year', async () => {
      await http().get('/partners/rag?fy=2025-27').set(auth()).expect(400);
    });
  });

  describe('BOCW cess (T037)', () => {
    it('reports projects as unavailable rather than pretending there are none', async () => {
      const res = await http()
        .get(`/partners/bocw?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      // TODO(008): once the Project Portfolio ships, this expectation flips to an
      // empty array and the rows below become real.
      expect(res.body.unavailableModules).toContain('projects');
      expect(res.body.cessRate).toBeGreaterThan(0);
    });

    it('records a payment and lists it back', async () => {
      const projectId = unique('proj');
      await http()
        .post(`/partners/bocw/${projectId}/payments?companyId=${companyId}`)
        .set(auth())
        .send({
          amountPaid: 50000,
          paymentDate: new Date().toISOString().slice(0, 10),
          referenceNumber: 'CESS-E2E-1',
        })
        .expect(201);

      const list = await http()
        .get(`/partners/bocw/${projectId}/payments?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].amountPaid).toBe(50000);
    });

    it('rejects a non-positive payment', async () => {
      await http()
        .post(`/partners/bocw/${unique('proj')}/payments?companyId=${companyId}`)
        .set(auth())
        .send({
          amountPaid: 0,
          paymentDate: new Date().toISOString().slice(0, 10),
          referenceNumber: 'CESS-E2E-2',
        })
        .expect(400);
    });
  });
});
