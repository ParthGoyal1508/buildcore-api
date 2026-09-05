import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * End-to-end coverage of `/assets/*` against a real database (012 US1–US3).
 *
 * What is asserted here is deliberately the set of behaviours a mocked Prisma client
 * would report working while the database did something else: the per-company unique
 * index behind serial numbers, the opening `AssetStock` row written in the same
 * transaction as its asset, the `SELECT … FOR UPDATE` that has to serialise two
 * simultaneous allocations of the last units of a bulk pool, and the row lock that
 * stops a serialised asset being allocated twice.
 *
 * Every fixture is prefixed `E2EAST` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2EAST';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Assets module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  let projectId: string;
  let siteId: string;
  let serialisedCategoryId: string;
  let bulkCategoryId: string;
  let goodGradeId: string;
  let damagedGradeId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const createdAssetIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdSiteIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdClientIds: string[] = [];

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

  /** `n` days from today, as the `YYYY-MM-DD` string a `@db.Date` field takes. */
  const dayOffset = (n: number) => {
    const date = new Date();
    date.setDate(date.getDate() + n);
    return date.toISOString().slice(0, 10);
  };
  const today = () => dayOffset(0);

  async function registerAsset(body: Record<string, unknown>) {
    const res = await http()
      .post(`/assets?companyId=${companyId}`)
      .set(auth())
      .send(body);
    if (res.status !== 201) {
      throw new Error(
        `register failed ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    createdAssetIds.push(res.body.id);
    return res.body;
  }

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

    const company = await sys.company.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    companyId = company.id;

    const client = await http()
      .post(`/projects/clients?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Client') })
      .expect(201);
    createdClientIds.push(client.body.id);

    const project = await http()
      .post(`/projects?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Project'),
        clientId: client.body.id,
        contractValue: 1,
        startDate: '2026-08-01',
      })
      .expect(201);
    projectId = project.body.id;
    createdProjectIds.push(projectId);

    const site = await http()
      .post(`/projects/sites?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Site'),
        latitude: 19.076,
        longitude: 72.8777,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
        projectId,
      })
      .expect(201);
    siteId = site.body.id;
    createdSiteIds.push(siteId);

    const serialised = await http()
      .post(`/assets/categories?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Tools'),
        trackingMode: 'serialised',
        depreciationRatePercent: 20,
        usefulLifeYears: 5,
      })
      .expect(201);
    serialisedCategoryId = serialised.body.id;
    createdCategoryIds.push(serialisedCategoryId);

    const bulk = await http()
      .post(`/assets/categories?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Props'), trackingMode: 'bulk' })
      .expect(201);
    bulkCategoryId = bulk.body.id;
    createdCategoryIds.push(bulkCategoryId);

    // The seeded ladder is what the return mapping is exercised against — the
    // defaults are part of the contract, not a convenience for the test.
    const grades = await http()
      .get(`/assets/condition-grades?companyId=${companyId}`)
      .set(auth())
      .expect(200);
    goodGradeId = grades.body.find(
      (grade: { name: string }) => grade.name === 'GOOD',
    ).id;
    damagedGradeId = grades.body.find(
      (grade: { name: string }) => grade.name === 'DAMAGED',
    ).id;
  });

  afterAll(async () => {
    await sys.assetAllocation.deleteMany({
      where: { assetId: { in: createdAssetIds } },
    });
    await sys.assetDocument.deleteMany({
      where: { assetId: { in: createdAssetIds } },
    });
    await sys.assetStock.deleteMany({
      where: { assetId: { in: createdAssetIds } },
    });
    for (const id of createdAssetIds) {
      await sys.asset.deleteMany({ where: { id } });
    }
    for (const id of createdCategoryIds) {
      await sys.assetCategory.deleteMany({ where: { id } });
    }
    for (const id of createdSiteIds) {
      await sys.site.deleteMany({ where: { id } });
    }
    for (const id of createdProjectIds) {
      await sys.project.deleteMany({ where: { id } });
    }
    for (const id of createdClientIds) {
      await sys.client.deleteMany({ where: { id } });
    }
    await app.close();
  });

  // ── Masters ───────────────────────────────────────────────────────────────

  describe('Asset masters (US1)', () => {
    it('seeds a company with the seven default categories and six grades', async () => {
      const [categories, grades, docTypes] = await Promise.all([
        http()
          .get(`/assets/categories?companyId=${companyId}`)
          .set(auth())
          .expect(200),
        http()
          .get(`/assets/condition-grades?companyId=${companyId}`)
          .set(auth())
          .expect(200),
        http()
          .get(`/assets/doc-types?companyId=${companyId}`)
          .set(auth())
          .expect(200),
      ]);

      const names = categories.body.map((c: { name: string }) => c.name);
      expect(names).toEqual(
        expect.arrayContaining(['SCAFFOLDING', 'IT ASSETS']),
      );
      expect(grades.body.length).toBeGreaterThanOrEqual(6);
      expect(docTypes.body.length).toBeGreaterThanOrEqual(6);
    });

    it('returns the grades best-first, which is what the return dropdown relies on', async () => {
      const grades = await http()
        .get(`/assets/condition-grades?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      const sequences = grades.body.map(
        (g: { sequence: number }) => g.sequence,
      );
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    });

    it('refuses inspectionRequired with no interval (US1 scenario 2)', async () => {
      await http()
        .post(`/assets/categories?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('NoInterval'),
          trackingMode: 'bulk',
          inspectionRequired: true,
        })
        .expect(400);
    });

    it('freezes trackingMode once an asset is registered (FR-003)', async () => {
      const category = await http()
        .post(`/assets/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Freeze'), trackingMode: 'bulk' })
        .expect(201);
      createdCategoryIds.push(category.body.id);

      // Free to change while nothing is registered under it.
      await http()
        .patch(`/assets/categories/${category.body.id}`)
        .set(auth())
        .send({ trackingMode: 'serialised' })
        .expect(200);

      await registerAsset({
        name: unique('Frozen'),
        categoryId: category.body.id,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });

      await http()
        .patch(`/assets/categories/${category.body.id}`)
        .set(auth())
        .send({ trackingMode: 'bulk' })
        .expect(409);
    });

    it('refuses to delete a category anything is registered under', async () => {
      const category = await http()
        .post(`/assets/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Doomed'), trackingMode: 'bulk' })
        .expect(201);
      createdCategoryIds.push(category.body.id);

      // Empty, so it deletes cleanly...
      const spare = await http()
        .post(`/assets/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Spare'), trackingMode: 'bulk' })
        .expect(201);
      await http()
        .delete(`/assets/categories/${spare.body.id}`)
        .set(auth())
        .expect(204);

      // ... and refuses once anything is registered under it.
      await registerAsset({
        name: unique('Blocker'),
        categoryId: category.body.id,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });
      await http()
        .delete(`/assets/categories/${category.body.id}`)
        .set(auth())
        .expect(409);
    });
  });

  // ── Register ──────────────────────────────────────────────────────────────

  describe('Asset register (US2)', () => {
    it('allocates a code from the ASSETS series and opens a stock row', async () => {
      const asset = await registerAsset({
        name: unique('Hammer'),
        categoryId: serialisedCategoryId,
        serialNumber: unique('SN'),
        purchaseDate: dayOffset(-40),
        purchaseCost: 120000,
        capitalisationDate: dayOffset(-31),
        currentSiteId: siteId,
      });

      expect(asset.assetCode).toContain('-AST-');
      expect(asset.trackingMode).toBe('serialised');
      expect(asset.status).toBe('idle');
      // One whole month at 20% of 120,000 is 2,000.
      expect(asset.accumulatedDepreciation).toBeGreaterThan(0);
      expect(asset.bookValue).toBeLessThan(120000);

      const stock = await sys.assetStock.findMany({
        where: { assetId: asset.id },
      });
      expect(stock).toHaveLength(1);
      expect(Number(stock[0].quantityOnHand)).toBe(1);
      expect(stock[0].siteId).toBe(siteId);
    });

    it('answers the paperwork question in the list itself (FR-025)', async () => {
      const asset = await registerAsset({
        name: unique('Papered'),
        categoryId: bulkCategoryId,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });
      const docTypes = await http()
        .get(`/assets/doc-types?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      const insurance = docTypes.body.find(
        (type: { name: string }) => type.name === 'INSURANCE',
      );

      // No documents: nothing to flag.
      const before = await http()
        .get(`/assets?companyId=${companyId}&search=${asset.assetCode}`)
        .set(auth())
        .expect(200);
      expect(before.body.items[0].expiryAlert).toBe(false);

      await http()
        .post(`/assets/${asset.id}/documents`)
        .set(auth())
        .send({
          docTypeId: insurance.id,
          file: Buffer.from('policy').toString('base64'),
          fileName: 'policy.pdf',
          contentType: 'application/pdf',
          // Inside INSURANCE's own 45-day window, and not inside a 30-day one —
          // which is the point of the window being per type.
          expiryDate: dayOffset(40),
        })
        .expect(201);

      const after = await http()
        .get(`/assets?companyId=${companyId}&search=${asset.assetCode}`)
        .set(auth())
        .expect(200);
      expect(after.body.items[0].expiryAlert).toBe(true);
      expect(after.body.items[0].alertDocumentTypes).toEqual(['INSURANCE']);
    });

    it('rejects a quantity above 1 on a serialised category (FR-004)', async () => {
      await http()
        .post(`/assets?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('TwoDrills'),
          categoryId: serialisedCategoryId,
          quantity: 2,
          capitalisationDate: today(),
          currentSiteId: siteId,
        })
        .expect(400);
    });

    it('rejects a serial number on a bulk category', async () => {
      await http()
        .post(`/assets?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('SerialProps'),
          categoryId: bulkCategoryId,
          serialNumber: unique('SN'),
          capitalisationDate: today(),
          currentSiteId: siteId,
        })
        .expect(400);
    });

    it('rejects a duplicate serial number in the same company (FR-008)', async () => {
      const serialNumber = unique('DUP');
      await registerAsset({
        name: unique('First'),
        categoryId: serialisedCategoryId,
        serialNumber,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });

      await http()
        .post(`/assets?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Second'),
          categoryId: serialisedCategoryId,
          serialNumber,
          capitalisationDate: today(),
          currentSiteId: siteId,
        })
        .expect(409);
    });

    it('rejects a capitalisation date before the purchase date (FR-019)', async () => {
      await http()
        .post(`/assets?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Backdated'),
          categoryId: bulkCategoryId,
          purchaseDate: today(),
          capitalisationDate: dayOffset(-10),
          currentSiteId: siteId,
        })
        .expect(400);
    });

    it('registers an asset ahead of capitalisation as not_in_service', async () => {
      const asset = await registerAsset({
        name: unique('Future'),
        categoryId: bulkCategoryId,
        quantity: 5,
        purchaseCost: 60000,
        capitalisationDate: dayOffset(30),
        currentSiteId: siteId,
      });

      expect(asset.status).toBe('not_in_service');
      // Nothing depreciates before its capitalisation date.
      expect(asset.accumulatedDepreciation).toBe(0);
      expect(asset.bookValue).toBe(60000);
    });

    it('refuses to move an asset between sites by edit', async () => {
      const asset = await registerAsset({
        name: unique('Fixed'),
        categoryId: bulkCategoryId,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });
      const other = await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Other'),
          latitude: 19.1,
          longitude: 72.9,
          geofenceRadiusMeters: 100,
          weeklyOffDay: 0,
          projectId,
        })
        .expect(201);
      createdSiteIds.push(other.body.id);

      await http()
        .patch(`/assets/${asset.id}`)
        .set(auth())
        .send({ currentSiteId: other.body.id })
        .expect(400);
    });

    it('reports register totals grouped by category and status', async () => {
      const summary = await http()
        .get(`/assets/summary?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      expect(summary.body.totals.count).toBeGreaterThan(0);
      const categoryTotal = summary.body.byCategory.reduce(
        (sum: number, b: { count: number }) => sum + b.count,
        0,
      );
      const statusTotal = summary.body.byStatus.reduce(
        (sum: number, b: { count: number }) => sum + b.count,
        0,
      );
      // Every asset lands in exactly one bucket of each grouping, so both sums
      // have to reconcile to the total — a bucket that silently dropped rows is
      // the failure this catches.
      expect(categoryTotal).toBe(summary.body.totals.count);
      expect(statusTotal).toBe(summary.body.totals.count);
    });

    it('exports the register as a workbook', async () => {
      const response = await http()
        .get(`/assets/export?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(response.headers['content-type']).toContain('spreadsheetml');
      expect(response.body.length ?? response.text.length).toBeGreaterThan(0);
    });
  });

  // ── Allocation ────────────────────────────────────────────────────────────

  describe('Allocation and return (US3)', () => {
    it('allocates a serialised asset and refuses a second open allocation', async () => {
      const asset = await registerAsset({
        name: unique('Grinder'),
        categoryId: serialisedCategoryId,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });

      const allocation = await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId,
          allocatedFrom: today(),
          expectedReturnDate: dayOffset(30),
        })
        .expect(201);
      expect(allocation.body.status).toBe('open');
      expect(allocation.body.overdue).toBe(false);

      const after = await http()
        .get(`/assets/${asset.id}`)
        .set(auth())
        .expect(200);
      expect(after.body.status).toBe('allocated');
      expect(after.body.stock[0].onHand).toBe(0);
      expect(after.body.stock[0].allocated).toBe(1);

      await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId,
          allocatedFrom: today(),
          expectedReturnDate: dayOffset(30),
        })
        .expect(409);
    });

    it('requires a custodian when the category says so (FR-010)', async () => {
      const category = await http()
        .post(`/assets/categories?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Custody'),
          trackingMode: 'serialised',
          custodyRequired: true,
        })
        .expect(201);
      createdCategoryIds.push(category.body.id);

      const asset = await registerAsset({
        name: unique('Laptop'),
        categoryId: category.body.id,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });

      await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId,
          allocatedFrom: today(),
          expectedReturnDate: dayOffset(30),
        })
        .expect(400);
    });

    it('refuses a site that does not belong to the named project', async () => {
      const asset = await registerAsset({
        name: unique('Mismatch'),
        categoryId: serialisedCategoryId,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });
      const orphanSite = await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Orphan'),
          latitude: 19.2,
          longitude: 72.95,
          geofenceRadiusMeters: 100,
          weeklyOffDay: 0,
        })
        .expect(201);
      createdSiteIds.push(orphanSite.body.id);

      await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId: orphanSite.body.id,
          allocatedFrom: today(),
          expectedReturnDate: dayOffset(30),
        })
        .expect(400);
    });

    it('flags an allocation past its return date as overdue (FR-016)', async () => {
      const asset = await registerAsset({
        name: unique('Late'),
        categoryId: serialisedCategoryId,
        capitalisationDate: dayOffset(-30),
        currentSiteId: siteId,
      });
      await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId,
          allocatedFrom: dayOffset(-20),
          expectedReturnDate: dayOffset(-5),
        })
        .expect(201);

      const overdue = await http()
        .get(`/assets/allocations?companyId=${companyId}&overdue=true`)
        .set(auth())
        .expect(200);
      const row = overdue.body.items.find(
        (item: { assetId: string }) => item.assetId === asset.id,
      );
      expect(row).toBeDefined();
      expect(row.overdue).toBe(true);
      expect(row.daysOverdue).toBeGreaterThanOrEqual(5);
    });

    it('sends a damaged return to under_repair and a healthy one to idle (FR-015)', async () => {
      const build = async () => {
        const asset = await registerAsset({
          name: unique('Returner'),
          categoryId: serialisedCategoryId,
          capitalisationDate: today(),
          currentSiteId: siteId,
        });
        const allocation = await http()
          .post(`/assets/allocations?companyId=${companyId}`)
          .set(auth())
          .send({
            assetId: asset.id,
            projectId,
            siteId,
            allocatedFrom: today(),
            expectedReturnDate: dayOffset(10),
          })
          .expect(201);
        return { asset, allocationId: allocation.body.id };
      };

      const healthy = await build();
      await http()
        .post(`/assets/allocations/${healthy.allocationId}/return`)
        .set(auth())
        .send({
          actualReturnDate: today(),
          conditionOnReturnId: goodGradeId,
        })
        .expect(201);
      const healthyAfter = await http()
        .get(`/assets/${healthy.asset.id}`)
        .set(auth())
        .expect(200);
      expect(healthyAfter.body.status).toBe('idle');
      expect(healthyAfter.body.stock[0].onHand).toBe(1);
      expect(healthyAfter.body.stock[0].allocated).toBe(0);

      const damaged = await build();
      await http()
        .post(`/assets/allocations/${damaged.allocationId}/return`)
        .set(auth())
        .send({
          actualReturnDate: today(),
          conditionOnReturnId: damagedGradeId,
        })
        .expect(201);
      const damagedAfter = await http()
        .get(`/assets/${damaged.asset.id}`)
        .set(auth())
        .expect(200);
      expect(damagedAfter.body.status).toBe('under_repair');
    });

    it('refuses returning the same allocation twice', async () => {
      const asset = await registerAsset({
        name: unique('Twice'),
        categoryId: serialisedCategoryId,
        capitalisationDate: today(),
        currentSiteId: siteId,
      });
      const allocation = await http()
        .post(`/assets/allocations?companyId=${companyId}`)
        .set(auth())
        .send({
          assetId: asset.id,
          projectId,
          siteId,
          allocatedFrom: today(),
          expectedReturnDate: dayOffset(10),
        })
        .expect(201);

      const body = {
        actualReturnDate: today(),
        conditionOnReturnId: goodGradeId,
      };
      await http()
        .post(`/assets/allocations/${allocation.body.id}/return`)
        .set(auth())
        .send(body)
        .expect(201);
      await http()
        .post(`/assets/allocations/${allocation.body.id}/return`)
        .set(auth())
        .send(body)
        .expect(409);
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  describe('Concurrent allocation of a bulk pool', () => {
    /**
     * The test a mocked Prisma client cannot run.
     *
     * Two requests each ask for four of the five units at the same moment. Without
     * the `SELECT … FOR UPDATE` in `AssetStockService.lockForUpdate`, both read five
     * available, both pass, and the site ends up with minus three units on hand.
     * Exactly one must succeed and the balance must never go negative.
     */
    it('serialises two simultaneous requests for the same units', async () => {
      const asset = await registerAsset({
        name: unique('Pool'),
        categoryId: bulkCategoryId,
        quantity: 5,
        unitOfMeasure: 'NOS',
        capitalisationDate: today(),
        currentSiteId: siteId,
      });

      const allocate = () =>
        http()
          .post(`/assets/allocations?companyId=${companyId}`)
          .set(auth())
          .send({
            assetId: asset.id,
            projectId,
            siteId,
            quantity: 4,
            allocatedFrom: today(),
            expectedReturnDate: dayOffset(10),
          });

      const [first, second] = await Promise.all([allocate(), allocate()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 422]);

      const stock = await sys.assetStock.findMany({
        where: { assetId: asset.id },
      });
      expect(Number(stock[0].quantityOnHand)).toBe(1);
      expect(Number(stock[0].quantityAllocated)).toBe(4);
      expect(Number(stock[0].quantityOnHand)).toBeGreaterThanOrEqual(0);
    });
  });
});
