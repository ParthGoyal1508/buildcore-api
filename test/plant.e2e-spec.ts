import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * End-to-end coverage of `/plant/*` against a real database (006 T011, T016, T021,
 * T026, T031, TA016, TA017).
 *
 * What is asserted here is deliberately the set of behaviours a mocked Prisma
 * client would report working while the database did something else: the UNIQUE
 * index behind one-logbook-entry-per-day, the partial unique index behind
 * one-open-job-per-machine, the `SELECT FOR UPDATE` that has to serialise two
 * simultaneous part consumptions, and the effective-dated rate resolution that
 * depends on real date comparisons in Postgres rather than on JavaScript ones.
 *
 * Every fixture is prefixed `E2EPLT` and removed in `afterAll`, so the suite can
 * run repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2EPLT';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Plant module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  let categoryId: string;
  let docTypeId: string;
  let vendorId: string;
  let siteId: string;
  let ownedEquipmentId: string;
  let hiredEquipmentId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const createdCategoryIds: string[] = [];
  const createdDocTypeIds: string[] = [];
  const createdEquipmentIds: string[] = [];
  const createdSparePartIds: string[] = [];
  const createdSiteIds: string[] = [];
  const createdVendorIds: string[] = [];

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

    const site = await http()
      .post(`/projects/sites?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Yard'),
        latitude: 19.076,
        longitude: 72.8777,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      })
      .expect(201);
    siteId = site.body.id;
    createdSiteIds.push(siteId);

    const vendor = await http()
      .post(`/partners/vendors?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('HireCo'), type: 'material', tdsRate: 2 })
      .expect(201);
    vendorId = vendor.body.id;
    createdVendorIds.push(vendorId);

    const category = await http()
      .post(`/plant/categories?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Excavator'),
        meterType: 'hours',
        fuelBenchmark: 10,
        fuelVarianceThresholdPercent: 20,
        targetHoursPerMonth: 200,
      })
      .expect(201);
    categoryId = category.body.id;
    createdCategoryIds.push(categoryId);

    const docType = await http()
      .post(`/plant/doc-types?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Insurance'), alertDays: 30 })
      .expect(201);
    docTypeId = docType.body.id;
    createdDocTypeIds.push(docTypeId);

    const owned = await http()
      .post(`/plant/equipment?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Owned JCB'),
        categoryId,
        ownership: 'owned',
        powerSource: 'diesel',
        purchaseCost: 1200000,
        depreciationRate: 12,
        deployedSiteId: siteId,
      })
      .expect(201);
    ownedEquipmentId = owned.body.id;
    createdEquipmentIds.push(ownedEquipmentId);

    const hired = await http()
      .post(`/plant/equipment?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Hired Crane'),
        categoryId,
        ownership: 'hired',
        vendorId,
        powerSource: 'diesel',
        deployedSiteId: siteId,
      })
      .expect(201);
    hiredEquipmentId = hired.body.id;
    createdEquipmentIds.push(hiredEquipmentId);
  });

  afterAll(async () => {
    // Reverse of the dependency direction: bills and movements point at jobs, jobs
    // and every log point at equipment, equipment at a category.
    await sys.serviceBill.deleteMany({ where: { companyId } });
    await sys.sparePartMovement.deleteMany({ where: { companyId } });
    for (const id of createdSparePartIds) {
      await sys.sparePart.deleteMany({ where: { id } });
    }
    await sys.hireBill.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    await sys.maintenanceJob.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    await sys.serviceSchedule.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    await sys.fuelEntry.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    await sys.logbookEntry.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    await sys.equipmentDocument.deleteMany({
      where: { equipmentId: { in: createdEquipmentIds } },
    });
    for (const id of createdEquipmentIds) {
      await sys.equipment.deleteMany({ where: { id } });
    }
    await sys.hireRate.deleteMany({
      where: { categoryId: { in: createdCategoryIds } },
    });
    for (const id of createdDocTypeIds) {
      await sys.equipmentDocType.deleteMany({ where: { id } });
    }
    for (const id of createdCategoryIds) {
      await sys.equipmentCategory.deleteMany({ where: { id } });
    }
    for (const id of createdVendorIds) {
      await sys.vendor.deleteMany({ where: { id } });
    }
    for (const id of createdSiteIds) {
      await sys.site.deleteMany({ where: { id } });
    }
    await app.close();
  });

  // ── Masters ─────────────────────────────────────────────────────────────

  describe('Machinery masters (US1)', () => {
    it('seeds a company with the ten default categories', async () => {
      const list = await http()
        .get(`/plant/categories?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      // Seeded by migration so US2-US8 are testable without visiting US1's screens
      // first. Ours is in there too, hence "at least".
      expect(list.body.length).toBeGreaterThanOrEqual(10);
      expect(list.body.map((c: { name: string }) => c.name)).toContain(
        'EXCAVATOR',
      );
    });

    it('refuses a duplicate category name', async () => {
      const existing = await sys.equipmentCategory.findUnique({
        where: { id: categoryId },
      });
      await http()
        .post(`/plant/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: existing.name, meterType: 'hours' })
        .expect(409);
    });

    it('refuses to delete a category that has machines under it', async () => {
      await http()
        .delete(`/plant/categories/${categoryId}`)
        .set(auth())
        .expect(409);
    });

    it('closes the prior hire rate when a newer one is added (FR-014)', async () => {
      await http()
        .post(`/plant/rates?companyId=${companyId}`)
        .set(auth())
        .send({
          categoryId,
          ratePerUnit: 1100,
          effectiveFrom: dayOffset(-400),
        })
        .expect(201);

      await http()
        .post(`/plant/rates?companyId=${companyId}`)
        .set(auth())
        .send({ categoryId, ratePerUnit: 1400, effectiveFrom: dayOffset(-30) })
        .expect(201);

      const rates = await http()
        .get(`/plant/rates?categoryId=${categoryId}`)
        .set(auth())
        .expect(200);

      // Newest first, and exactly one open end. Two open-ended rates would make the
      // effective-rate lookup depend on planner ordering.
      expect(rates.body).toHaveLength(2);
      expect(rates.body[0].effectiveTo).toBeNull();
      expect(rates.body[1].effectiveTo).not.toBeNull();
    });

    it('refuses a hire rate that starts inside the covered timeline', async () => {
      await http()
        .post(`/plant/rates?companyId=${companyId}`)
        .set(auth())
        .send({ categoryId, ratePerUnit: 900, effectiveFrom: dayOffset(-200) })
        .expect(409);
    });
  });

  // ── Asset register ──────────────────────────────────────────────────────

  describe('Asset register (US2)', () => {
    it('allocates a code from the company series when none is supplied', async () => {
      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.code).toMatch(/-EQP-\d{4}$/);
    });

    it('copies the meter type from the category', async () => {
      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.meterType).toBe('hours');
    });

    it('refuses a hired machine with no vendor', async () => {
      await http()
        .post(`/plant/equipment?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique('Orphan'),
          categoryId,
          ownership: 'hired',
          powerSource: 'diesel',
        })
        .expect(400);
    });

    it('flags expiryAlert on the list for a document inside its window (SC-001)', async () => {
      await http()
        .post(`/plant/equipment/${ownedEquipmentId}/documents`)
        .set(auth())
        .send({
          docTypeId,
          file: Buffer.from('policy').toString('base64'),
          fileName: 'insurance.pdf',
          contentType: 'application/pdf',
          expiresAt: dayOffset(15),
        })
        .expect(201);

      const list = await http()
        .get(`/plant/equipment?companyId=${companyId}&search=${PREFIX}`)
        .set(auth())
        .expect(200);

      const row = list.body.items.find(
        (item: { id: string }) => item.id === ownedEquipmentId,
      );
      // The whole of SC-001: the register answers this without a second call.
      expect(row.expiryAlert).toBe(true);
      expect(row.alertDocumentTypes.length).toBeGreaterThan(0);
    });

    it('refuses to set status to under_maintenance directly (FR-002)', async () => {
      await http()
        .patch(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .send({ status: 'under_maintenance' })
        .expect(400);
    });
  });

  // ── Logbook ─────────────────────────────────────────────────────────────

  describe('Logbook (US3)', () => {
    it('computes total hours and moves the machine reading', async () => {
      await http()
        .post('/plant/logbook')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          date: today(),
          openingReading: 1000,
          closingReading: 1008,
          fuelConsumed: 96,
        })
        .expect(201);

      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.currentReading).toBe(1008);
    });

    it('recomputes utilisation against the category target (FR-007)', async () => {
      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      // 8 hours against a 200-hour month.
      expect(equipment.body.utilizationPercent).toBe(4);
    });

    it('refuses a second entry for the same machine and day (FR-003)', async () => {
      await http()
        .post('/plant/logbook')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          date: today(),
          openingReading: 1008,
          closingReading: 1010,
        })
        .expect(409);
    });

    it('refuses a closing reading below the opening one', async () => {
      await http()
        .post('/plant/logbook')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          date: dayOffset(-1),
          openingReading: 1000,
          closingReading: 900,
        })
        .expect(400);
    });

    it('accepts a zero-hours day', async () => {
      const entry = await http()
        .post('/plant/logbook')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          date: dayOffset(-2),
          openingReading: 995,
          closingReading: 995,
        })
        .expect(201);
      expect(entry.body.totalHours).toBe(0);
    });

    it('does not wind the meter back when a backdated entry is added', async () => {
      // The backdated entry above closed at 995; today's closed at 1008. Assigning
      // the new entry's reading blindly would rewind the meter and silently un-due
      // every service schedule on the machine.
      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.currentReading).toBe(1008);
    });
  });

  // ── Fuel ────────────────────────────────────────────────────────────────

  describe('Fuel (US4)', () => {
    it('computes amount and flags variance above the category threshold', async () => {
      // The logbook entry for today is 96 litres over 8 hours = 12/hr against a
      // 10/hr benchmark: 20% over, and the category threshold is 20 — so this is
      // *not* an alert.
      const entry = await http()
        .post('/plant/fuel')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          date: today(),
          quantity: 96,
          rate: 92.5,
        })
        .expect(201);

      expect(entry.body.amount).toBe(8880);
      expect(entry.body.variancePercent).toBe(20);
      expect(entry.body.varianceAlert).toBe(false);
    });

    it('flags an entry whose day genuinely exceeds the threshold', async () => {
      await http()
        .post('/plant/logbook')
        .set(auth())
        .send({
          equipmentId: hiredEquipmentId,
          date: today(),
          openingReading: 0,
          closingReading: 4,
          fuelConsumed: 60,
        })
        .expect(201);

      // 15/hr against a 10/hr benchmark: 50% over a 20% threshold.
      const entry = await http()
        .post('/plant/fuel')
        .set(auth())
        .send({
          equipmentId: hiredEquipmentId,
          date: today(),
          quantity: 60,
          rate: 92.5,
        })
        .expect(201);

      expect(entry.body.variancePercent).toBe(50);
      expect(entry.body.varianceAlert).toBe(true);
    });

    it('summarises fuel per machine for a month', async () => {
      const month = today().slice(0, 7);
      const summary = await http()
        .get(`/plant/fuel/summary?month=${month}&companyId=${companyId}`)
        .set(auth())
        .expect(200);

      const row = summary.body.items.find(
        (item: { equipmentId: string }) =>
          item.equipmentId === ownedEquipmentId,
      );
      expect(row.totalQuantity).toBe(96);
      expect(row.totalAmount).toBe(8880);
    });
  });

  // ── Service schedules and maintenance ───────────────────────────────────

  describe('Service schedules and maintenance (US5, US6)', () => {
    let scheduleId: string;
    let jobId: string;

    it('computes nextDueReading as last done plus interval', async () => {
      const schedule = await http()
        .post('/plant/services')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          serviceType: 'Engine oil',
          intervalHours: 250,
          lastDoneReading: 1000,
        })
        .expect(201);
      scheduleId = schedule.body.id;
      expect(schedule.body.nextDueReading).toBe(1250);
    });

    it('derives status from the machine reading, not a stored column (FR-006)', async () => {
      const list = await http()
        .get(`/plant/services?equipmentId=${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      // Reading 1008 against a 1250 due: comfortably ok.
      expect(list.body.items[0].status).toBe('ok');
      expect(list.body.items[0].currentReading).toBe(1008);
    });

    it('filters by derived status before paging', async () => {
      const ok = await http()
        .get(`/plant/services?equipmentId=${ownedEquipmentId}&status=ok`)
        .set(auth())
        .expect(200);
      const overdue = await http()
        .get(`/plant/services?equipmentId=${ownedEquipmentId}&status=overdue`)
        .set(auth())
        .expect(200);

      // A filter applied after paging would return a short page and a total that
      // disagreed with it — the defect 009's reorder filter shipped with.
      expect(ok.body.total).toBe(1);
      expect(ok.body.items).toHaveLength(1);
      expect(overdue.body.total).toBe(0);
      expect(overdue.body.items).toHaveLength(0);
    });

    it('puts the machine under maintenance when a job opens (FR-002)', async () => {
      const job = await http()
        .post('/plant/maintenance')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          type: 'scheduled',
          description: 'Engine oil and filter change',
          linkedServiceScheduleId: scheduleId,
        })
        .expect(201);
      jobId = job.body.id;

      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.status).toBe('under_maintenance');
      expect(equipment.body.openMaintenanceJobId).toBe(jobId);
    });

    it('refuses a second open job on the same machine', async () => {
      await http()
        .post('/plant/maintenance')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          type: 'breakdown',
          description: 'Something else',
        })
        .expect(409);
    });

    it('returns the machine to service and re-dates the schedule on close', async () => {
      await http()
        .patch(`/plant/maintenance/${jobId}/close`)
        .set(auth())
        .send({ closingReading: 1010, labourCost: 2000 })
        .expect(200);

      const equipment = await http()
        .get(`/plant/equipment/${ownedEquipmentId}`)
        .set(auth())
        .expect(200);
      expect(equipment.body.status).toBe('active');

      const schedule = equipment.body.serviceSchedules.find(
        (s: { id: string }) => s.id === scheduleId,
      );
      // Discharged and moved forward: 1010 + 250. Leaving `lastDoneReading` alone
      // would keep the schedule permanently overdue.
      expect(schedule.lastDoneReading).toBe(1010);
      expect(schedule.nextDueReading).toBe(1260);
    });
  });

  // ── Hire bills ──────────────────────────────────────────────────────────

  describe('Hire bills (US7)', () => {
    let billId: string;

    it('defaults the rate from the effective hire rate and computes every figure', async () => {
      const bill = await http()
        .post('/plant/hire-bills')
        .set(auth())
        .send({
          equipmentId: hiredEquipmentId,
          vendorId,
          billedHours: 100,
          billingPeriodFrom: dayOffset(-10),
          billingPeriodTo: today(),
        })
        .expect(201);
      billId = bill.body.id;

      // The 1400 rate, in force from 30 days ago. TDS 2% from the vendor.
      expect(bill.body.rate).toBe(1400);
      expect(bill.body.grossAmount).toBe(140000);
      expect(bill.body.tdsAmount).toBe(2800);
      expect(bill.body.netPayable).toBe(137200);
      // SC-003, as a property rather than a literal.
      expect(bill.body.netPayable).toBe(
        bill.body.grossAmount - bill.body.tdsAmount,
      );
    });

    it('snapshots logbook hours and records the variance without blocking', async () => {
      const bill = await http()
        .get(`/plant/hire-bills?equipmentId=${hiredEquipmentId}`)
        .set(auth())
        .expect(200);
      const row = bill.body.items[0];
      // 4 hours logged in the period against 100 billed.
      expect(row.logbookHours).toBe(4);
      expect(row.variance).toBe(96);
      expect(row.status).toBe('pending_verification');
    });

    it('resolves a historical period to the rate in force then (SC-006)', async () => {
      const bill = await http()
        .post('/plant/hire-bills')
        .set(auth())
        .send({
          equipmentId: hiredEquipmentId,
          vendorId,
          billedHours: 10,
          billingPeriodFrom: dayOffset(-200),
          billingPeriodTo: dayOffset(-190),
        })
        .expect(201);

      // The older 1100 rate, even though 1400 is current. This is the whole reason
      // hire rates are an effective-dated timeline rather than a column.
      expect(bill.body.rate).toBe(1100);
    });

    it('refuses payment before verification', async () => {
      await http()
        .patch(`/plant/hire-bills/${billId}/pay`)
        .set(auth())
        .send({ paymentDate: today(), paymentReference: 'NEFT/1' })
        .expect(409);
    });

    it('verifies then pays', async () => {
      const verified = await http()
        .patch(`/plant/hire-bills/${billId}/verify`)
        .set(auth())
        .expect(200);
      expect(verified.body.status).toBe('verified');

      const paid = await http()
        .patch(`/plant/hire-bills/${billId}/pay`)
        .set(auth())
        .send({ paymentDate: today(), paymentReference: 'NEFT/2026/0912' })
        .expect(200);
      expect(paid.body.status).toBe('paid');
    });

    it('refuses a hire bill against an owned machine (FR-022)', async () => {
      await http()
        .post('/plant/hire-bills')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          vendorId,
          billedHours: 10,
          billingPeriodFrom: dayOffset(-5),
          billingPeriodTo: today(),
        })
        .expect(400);
    });
  });

  // ── Spare parts ─────────────────────────────────────────────────────────

  describe('Spare parts (US9, US10)', () => {
    let partId: string;
    let jobId: string;

    beforeAll(async () => {
      const part = await http()
        .post(`/plant/spare-parts?companyId=${companyId}`)
        .set(auth())
        .send({
          partNumber: unique('HF'),
          name: 'Hydraulic filter',
          unitOfMeasure: 'NOS',
          reorderLevel: 5,
          compatibleCategoryIds: [categoryId],
        })
        .expect(201);
      partId = part.body.id;
      createdSparePartIds.push(partId);

      const job = await http()
        .post('/plant/maintenance')
        .set(auth())
        .send({
          equipmentId: ownedEquipmentId,
          type: 'breakdown',
          description: 'Filter change',
        })
        .expect(201);
      jobId = job.body.id;
    });

    it('starts at zero stock and refuses a duplicate part number', async () => {
      const part = await http()
        .get(`/plant/spare-parts/${partId}`)
        .set(auth())
        .expect(200);
      expect(part.body.stockQuantity).toBe(0);

      await http()
        .post(`/plant/spare-parts?companyId=${companyId}`)
        .set(auth())
        .send({
          partNumber: part.body.partNumber,
          name: 'Duplicate',
          unitOfMeasure: 'NOS',
        })
        .expect(409);
    });

    it('recomputes the weighted average rate on each receipt (FR-017)', async () => {
      await http()
        .post(`/plant/spare-parts/${partId}/receipts`)
        .set(auth())
        .send({ quantity: 10, rate: 200, receiptDate: today() })
        .expect(201);

      const after = await http()
        .post(`/plant/spare-parts/${partId}/receipts`)
        .set(auth())
        .send({ quantity: 10, rate: 300, receiptDate: today() })
        .expect(201);

      expect(after.body.stockQuantity).toBe(20);
      expect(after.body.avgRate).toBe(250);
      expect(after.body.stockValue).toBe(5000);
    });

    it('values consumption at the current rate and accrues it onto the job', async () => {
      const movement = await http()
        .post(`/plant/maintenance/${jobId}/parts`)
        .set(auth())
        .send({ sparePartId: partId, quantity: 2 })
        .expect(201);

      expect(movement.body.rate).toBe(250);
      expect(movement.body.amount).toBe(500);

      const job = await http()
        .get(`/plant/maintenance/${jobId}`)
        .set(auth())
        .expect(200);
      expect(job.body.partsCost).toBe(500);
    });

    it('keeps a consumption at its own rate after a later receipt moves the average', async () => {
      await http()
        .post(`/plant/spare-parts/${partId}/receipts`)
        .set(auth())
        .send({ quantity: 18, rate: 500, receiptDate: today() })
        .expect(201);

      const movements = await http()
        .get(`/plant/spare-parts/${partId}/movements`)
        .set(auth())
        .expect(200);
      const consumption = movements.body.find(
        (m: { type: string }) => m.type === 'consumption',
      );
      // FR-017: rates are never retrospectively restated. The average is now higher;
      // what this repair cost is not.
      expect(consumption.rate).toBe(250);
    });

    it('never lets concurrent consumptions take stock below zero (SC-A01)', async () => {
      const scarce = await http()
        .post(`/plant/spare-parts?companyId=${companyId}`)
        .set(auth())
        .send({
          partNumber: unique('SC'),
          name: 'Scarce seal',
          unitOfMeasure: 'NOS',
        })
        .expect(201);
      createdSparePartIds.push(scarce.body.id);

      await http()
        .post(`/plant/spare-parts/${scarce.body.id}/receipts`)
        .set(auth())
        .send({ quantity: 1, rate: 100, receiptDate: today() })
        .expect(201);

      // Genuinely simultaneous: both requests are in flight before either commits.
      // Without `SELECT ... FOR UPDATE` both read a balance of 1, both pass, and the
      // part ends at -1.
      const [first, second] = await Promise.all([
        http()
          .post(`/plant/maintenance/${jobId}/parts`)
          .set(auth())
          .send({ sparePartId: scarce.body.id, quantity: 1 }),
        http()
          .post(`/plant/maintenance/${jobId}/parts`)
          .set(auth())
          .send({ sparePartId: scarce.body.id, quantity: 1 }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 400]);

      const after = await http()
        .get(`/plant/spare-parts/${scarce.body.id}`)
        .set(auth())
        .expect(200);
      expect(after.body.stockQuantity).toBe(0);
    });

    it('reports available stock on an over-consumption', async () => {
      const response = await http()
        .post(`/plant/maintenance/${jobId}/parts`)
        .set(auth())
        .send({ sparePartId: partId, quantity: 9999 })
        .expect(400);
      expect(response.body.availableStock).toBeGreaterThanOrEqual(0);
    });

    it('restores stock and reduces parts cost on reversal (FR-019)', async () => {
      const movement = await http()
        .post(`/plant/maintenance/${jobId}/parts`)
        .set(auth())
        .send({ sparePartId: partId, quantity: 1 })
        .expect(201);

      const before = await http()
        .get(`/plant/spare-parts/${partId}`)
        .set(auth())
        .expect(200);

      await http()
        .delete(`/plant/maintenance/parts/${movement.body.id}`)
        .set(auth())
        .send({ reason: 'Fitted the wrong filter' })
        .expect(200);

      const after = await http()
        .get(`/plant/spare-parts/${partId}`)
        .set(auth())
        .expect(200);
      expect(after.body.stockQuantity).toBe(before.body.stockQuantity + 1);
    });

    it('filters to parts at or below their reorder level', async () => {
      const below = await http()
        .get(`/plant/spare-parts?companyId=${companyId}&belowReorder=true`)
        .set(auth())
        .expect(200);
      // The filter runs before paging, so the total and the page agree.
      expect(below.body.items.length).toBe(
        Math.min(below.body.total, below.body.pageSize),
      );
    });

    it('refuses to delete a part with movement history', async () => {
      await http()
        .delete(`/plant/spare-parts/${partId}`)
        .set(auth())
        .expect(409);
    });

    it('refuses consumption against a closed job (FR-019)', async () => {
      await http()
        .patch(`/plant/maintenance/${jobId}/close`)
        .set(auth())
        .send({ closingReading: 1020 })
        .expect(200);

      await http()
        .post(`/plant/maintenance/${jobId}/parts`)
        .set(auth())
        .send({ sparePartId: partId, quantity: 1 })
        .expect(409);
    });
  });

  // ── Service bills ───────────────────────────────────────────────────────

  describe('Service bills (US11)', () => {
    let jobId: string;
    let billId: string;

    beforeAll(async () => {
      const job = await http()
        .post('/plant/maintenance')
        .set(auth())
        .send({
          equipmentId: hiredEquipmentId,
          type: 'breakdown',
          description: 'Sent to workshop',
        })
        .expect(201);
      jobId = job.body.id;

      await http()
        .patch(`/plant/maintenance/${jobId}/close`)
        .set(auth())
        .send({ closingReading: 10, labourCost: 500 })
        .expect(200);
    });

    it('accepts a bill against a closed job (US11 scenario 7)', async () => {
      // Invoices routinely arrive after the work is finished; refusing them would
      // force people to leave jobs open or record the cost nowhere.
      const bill = await http()
        .post('/plant/service-bills')
        .set(auth())
        .send({
          maintenanceJobId: jobId,
          vendorId,
          billNumber: unique('SVC'),
          billDate: today(),
          grossAmount: 50000,
          taxAmount: 9000,
        })
        .expect(201);
      billId = bill.body.id;

      // TDS from the vendor's own 2% rate, withheld on the gross only.
      expect(bill.body.tdsPercent).toBe(2);
      expect(bill.body.tdsAmount).toBe(1000);
      expect(bill.body.netPayable).toBe(58000);
    });

    it('refuses a duplicate bill number for the same vendor', async () => {
      const existing = await http()
        .get(`/plant/service-bills?maintenanceJobId=${jobId}`)
        .set(auth())
        .expect(200);
      await http()
        .post('/plant/service-bills')
        .set(auth())
        .send({
          maintenanceJobId: jobId,
          vendorId,
          billNumber: existing.body.items[0].billNumber,
          billDate: today(),
          grossAmount: 100,
        })
        .expect(409);
    });

    it('refuses payment before verification (FR-023)', async () => {
      await http()
        .patch(`/plant/service-bills/${billId}/pay`)
        .set(auth())
        .send({ paidOn: today(), paidAmount: 58000, paymentReference: 'X' })
        .expect(409);
    });

    it('marks a short payment partially paid, then paid on the balance', async () => {
      await http()
        .patch(`/plant/service-bills/${billId}/verify`)
        .set(auth())
        .expect(200);

      const partial = await http()
        .patch(`/plant/service-bills/${billId}/pay`)
        .set(auth())
        .send({
          paidOn: today(),
          paidAmount: 30000,
          paymentReference: 'NEFT/1',
        })
        .expect(200);
      expect(partial.body.paymentStatus).toBe('partially_paid');

      const full = await http()
        .patch(`/plant/service-bills/${billId}/pay`)
        .set(auth())
        .send({
          paidOn: today(),
          paidAmount: 28000,
          paymentReference: 'NEFT/2',
        })
        .expect(200);
      expect(full.body.paymentStatus).toBe('paid');
    });

    it('refuses to remove a verified bill (FR-027)', async () => {
      await http()
        .delete(`/plant/service-bills/${billId}`)
        .set(auth())
        .expect(409);
    });

    it('includes the verified bill in the job total and the machine lifetime cost', async () => {
      const job = await http()
        .get(`/plant/maintenance/${jobId}`)
        .set(auth())
        .expect(200);
      expect(job.body.serviceBillCost).toBe(58000);
      expect(job.body.totalCost).toBe(58500);

      const cost = await http()
        .get(`/plant/equipment/${hiredEquipmentId}/maintenance-cost`)
        .set(auth())
        .expect(200);
      expect(cost.body.serviceBillCost).toBe(58000);
      expect(cost.body.totalCost).toBe(58500);
    });
  });

  // ── Cross-module ────────────────────────────────────────────────────────

  describe('Cross-module contract', () => {
    it('lists the machines on the project detail page rather than reporting plant unavailable', async () => {
      const projects = await http()
        .get(`/projects?companyId=${companyId}&pageSize=1`)
        .set(auth())
        .expect(200);
      if (projects.body.items.length === 0) return;

      const detail = await http()
        .get(`/projects/${projects.body.items[0].id}`)
        .set(auth())
        .expect(200);

      // 006 and 009 both register as sources now, so neither is named. An empty
      // machinery array here means "we asked and there is none", which is the
      // distinction `unavailableModules` exists to draw.
      expect(detail.body.unavailableModules).not.toContain('plant');
      expect(detail.body.unavailableModules).not.toContain('inventory');
    });

    it('registers its two reminder rules with the 004 engine, not as pending', async () => {
      const reminders = await http()
        .get('/dashboard/reminders')
        .set(auth())
        .expect(200);

      const pending = reminders.body.unavailable.map(
        (source: { ruleKey: string }) => source.ruleKey,
      );
      // The placeholders 004 shipped are gone; these two evaluate for real now.
      expect(pending).not.toContain('machinery-document-expiry');
      expect(pending).not.toContain('machinery-service-due');
    });

    it('surfaces an expiring equipment document as a reminder', async () => {
      const reminders = await http()
        .get(
          `/dashboard/reminders?module=machinery&type=document_expiry&companyId=${companyId}`,
        )
        .set(auth())
        .expect(200);

      const mine = reminders.body.reminders.filter(
        (reminder: { subject: string }) => reminder.subject.includes(PREFIX),
      );
      // The insurance document uploaded above expires in 15 days, inside its type's
      // 30-day window.
      expect(mine.length).toBeGreaterThan(0);
    });
  });
});
