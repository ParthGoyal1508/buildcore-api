import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * End-to-end coverage of `/inventory/*` against a real database (009 T021, T027,
 * T037, TA013).
 *
 * What is asserted here is deliberately the set of behaviours a mocked Prisma
 * client would report working while the database did something else: the dual write
 * of ledger and balance, the `SELECT FOR UPDATE` that has to serialise two
 * simultaneous issues, FIFO allocation across real rows, and the claim that
 * approving an indent changes no balance at all.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`, so the suite can run
 * repeatedly against a developer database without accumulating rows.
 */
const PREFIX = 'E2EINV';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

describe('Inventory module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;

  let siteA: string;
  let siteB: string;
  let vendorId: string;
  let categoryId: string;
  let itemId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const createdIndentIds: string[] = [];
  /** Roles this suite granted `INVENTORY_APPROVE` to, so it can hand them back. */
  const grantedApproveRoleIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdCategoryIds: string[] = [];
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

  /** Today, as a `YYYY-MM-DD` string. */
  const today = () => new Date().toISOString().slice(0, 10);

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

    for (const name of ['StoreA', 'StoreB']) {
      const site = await http()
        .post(`/projects/sites?companyId=${companyId}`)
        .set(auth())
        .send({
          name: unique(name),
          latitude: 19.076,
          longitude: 72.8777,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        })
        .expect(201);
      createdSiteIds.push(site.body.id);
    }
    [siteA, siteB] = createdSiteIds;

    const vendor = await http()
      .post(`/partners/vendors?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Supplier'), type: 'material' })
      .expect(201);
    vendorId = vendor.body.id;
    createdVendorIds.push(vendorId);

    const category = await http()
      .post(`/inventory/categories?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Cat') })
      .expect(201);
    categoryId = category.body.id;
    createdCategoryIds.push(categoryId);

    const item = await http()
      .post(`/inventory/items?companyId=${companyId}`)
      .set(auth())
      .send({
        name: unique('Cement'),
        categoryId,
        unit: 'BAG',
        reorderLevel: 50,
        hsnCode: '2523',
      })
      .expect(201);
    itemId = item.body.id;
    createdItemIds.push(itemId);
  });

  /**
   * Grants the caller's roles `INVENTORY_APPROVE`.
   *
   * 009 adds the value; no seeded role holds it, which is exactly what the
   * preceding test asserts. A real deployment grants it the same way — through
   * Settings > Roles — and this is the API-less equivalent.
   */
  async function grantApprovePermission() {
    const me = await http().get('/users/me').set(auth()).expect(200);
    const userRoles = await sys.userRole.findMany({
      where: { userId: me.body.id },
      include: { role: true },
    });
    for (const userRole of userRoles) {
      if (userRole.role.permissions.includes('INVENTORY_APPROVE')) continue;
      await sys.role.update({
        where: { id: userRole.roleId },
        data: {
          permissions: [...userRole.role.permissions, 'INVENTORY_APPROVE'],
        },
      });
      grantedApproveRoleIds.push(userRole.roleId);
    }
  }

  afterAll(async () => {
    for (const roleId of grantedApproveRoleIds) {
      const role = await sys.role.findUnique({ where: { id: roleId } });
      await sys.role.update({
        where: { id: roleId },
        data: {
          permissions: role.permissions.filter(
            (permission: string) => permission !== 'INVENTORY_APPROVE',
          ),
        },
      });
    }
    // Order matters, and it is the reverse of the dependency direction: allocations
    // point at payments and bills, bills and GRNs at purchases, and every movement
    // at an item and a site.
    await sys.paymentAllocation.deleteMany({ where: { companyId } });
    await sys.payment.deleteMany({ where: { companyId } });
    await sys.purchaseBill.deleteMany({ where: { companyId } });
    await sys.goodsReceiptNote.deleteMany({ where: { companyId } });
    await sys.issue.deleteMany({ where: { itemId: { in: createdItemIds } } });
    await sys.purchase.deleteMany({ where: { itemId: { in: createdItemIds } } });
    await sys.stockTransfer.deleteMany({
      where: { itemId: { in: createdItemIds } },
    });
    await sys.stockLedgerEntry.deleteMany({
      where: { itemId: { in: createdItemIds } },
    });
    await sys.stockBalance.deleteMany({
      where: { itemId: { in: createdItemIds } },
    });
    for (const id of createdIndentIds) {
      await sys.materialIndentLine.deleteMany({ where: { indentId: id } });
      await sys.materialIndent.deleteMany({ where: { id } });
    }
    for (const id of createdItemIds) {
      await sys.item.deleteMany({ where: { id } });
    }
    for (const id of createdCategoryIds) {
      await sys.itemCategory.deleteMany({ where: { id } });
    }
    for (const id of createdVendorIds) {
      await sys.vendor.deleteMany({ where: { id } });
    }
    for (const id of createdSiteIds) {
      await sys.site.deleteMany({ where: { id } });
    }
    await app.close();
  });

  const purchase = (body: Record<string, unknown> = {}) =>
    http()
      .post(`/inventory/purchases?companyId=${companyId}`)
      .set(auth())
      .send({
        siteId: siteA,
        itemId,
        vendorId,
        date: today(),
        quantity: 100,
        rate: 350,
        ...body,
      });

  const stockAt = async (site: string) => {
    const res = await http()
      .get(`/inventory/stock/${itemId}/${site}`)
      .set(auth())
      .expect(200);
    return res.body;
  };

  // ───────────────────────────────────────────────────── Masters (US1, US2)

  describe('Item and category masters', () => {
    it('stores a category name uppercase and refuses a duplicate', async () => {
      const name = unique('Steel');
      const created = await http()
        .post(`/inventory/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: name.toLowerCase() })
        .expect(201);
      createdCategoryIds.push(created.body.id);
      expect(created.body.name).toBe(name.toUpperCase());

      // Same name in different case: the uppercase normalisation is what makes this
      // a conflict rather than a second category meaning the same thing.
      await http()
        .post(`/inventory/categories?companyId=${companyId}`)
        .set(auth())
        .send({ name: name.toUpperCase() })
        .expect(409);
    });

    it('refuses to delete a category that still has items', async () => {
      await http()
        .delete(`/inventory/categories/${categoryId}`)
        .set(auth())
        .expect(409);
    });

    it('allocates the item code from the company series', async () => {
      const created = await http()
        .post(`/inventory/items?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Sand'), categoryId, unit: 'CUM' })
        .expect(201);
      createdItemIds.push(created.body.id);
      expect(created.body.code).toMatch(/-ITM-\d{4}$/);
    });

    it('refuses a duplicate item name in the same company', async () => {
      const name = unique('Brick');
      const created = await http()
        .post(`/inventory/items?companyId=${companyId}`)
        .set(auth())
        .send({ name, categoryId, unit: 'NOS' })
        .expect(201);
      createdItemIds.push(created.body.id);

      await http()
        .post(`/inventory/items?companyId=${companyId}`)
        .set(auth())
        .send({ name, categoryId, unit: 'NOS' })
        .expect(409);
    });
  });

  // ──────────────────────────────────────────────── Purchases and WAR (US3)

  describe('Purchases, the dual write, and the weighted average rate', () => {
    it('moves the balance and the rate in the same transaction as the ledger', async () => {
      const created = await purchase().expect(201);
      expect(created.body.grnNumber).toMatch(/-GRN-\d{4}$/);
      expect(created.body.paymentStatus).toBe('unpaid');
      expect(created.body.amount).toBe(35000);

      const stock = await stockAt(siteA);
      expect(stock.inStock).toBe(100);
      expect(stock.avgRate).toBe(350);

      // The ledger entry is what the balance is reconstructible from. A balance
      // that moved without one is the failure this assertion exists to catch.
      const entries = await sys.stockLedgerEntry.findMany({
        where: { referenceId: created.body.id },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('purchase');
    });

    it('recalculates the rate against stock on hand for a second purchase', async () => {
      await purchase({ quantity: 100, rate: 450 }).expect(201);
      const stock = await stockAt(siteA);
      expect(stock.inStock).toBe(200);
      // (100 × 350 + 100 × 450) / 200
      expect(stock.avgRate).toBe(400);
    });

    it('reverses the balance and replays the rate when a purchase is deleted', async () => {
      const created = await purchase({ quantity: 50, rate: 900 }).expect(201);
      const afterCreate = await stockAt(siteA);
      expect(afterCreate.inStock).toBe(250);

      await http()
        .delete(`/inventory/purchases/${created.body.id}`)
        .set(auth())
        .expect(204);

      const afterDelete = await stockAt(siteA);
      expect(afterDelete.inStock).toBe(200);
      // Replayed from the surviving two purchases, back to what it was before.
      expect(afterDelete.avgRate).toBe(400);

      // And the reversal is in the ledger rather than the original being removed.
      const entries = await sys.stockLedgerEntry.findMany({
        where: { referenceId: created.body.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e: { type: string }) => e.type)).toEqual([
        'purchase',
        'purchase_reversal',
      ]);
    });

    it('keeps a deleted purchase out of the list', async () => {
      const list = await http()
        .get(`/inventory/purchases?siteId=${siteA}`)
        .set(auth())
        .expect(200);
      expect(list.body.purchases).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────── Issues (US4)

  describe('Issues and concurrency', () => {
    it('refuses an over-issue with 422 and the available figure', async () => {
      const res = await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 10_000,
          issuedTo: 'Gang 1',
        })
        .expect(422);
      expect(res.body.availableStock).toBe(200);
    });

    it('refuses a supplied BOQ item that does not exist', async () => {
      // Optional by decision, but an id that was supplied has to be real — an
      // unvalidated reference looks like traceability without being it.
      await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 1,
          issuedTo: 'Gang 1',
          boqItemId: 'does-not-exist',
        })
        .expect(400);
    });

    it('issues material and decrements the balance', async () => {
      await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 50,
          issuedTo: 'Gang 1',
        })
        .expect(201);

      const stock = await stockAt(siteA);
      expect(stock.inStock).toBe(150);
      // Consumption does not reprice the remaining stock.
      expect(stock.avgRate).toBe(400);
    });

    it('lets exactly one of two simultaneous issues take the last of the stock', async () => {
      // The real concurrency test, and the reason this suite exists: with a plain
      // read-then-write both requests would read 150, both would pass validation,
      // and the balance would end at −150.
      const before = await stockAt(siteA);
      const issueAll = () =>
        http()
          .post(`/inventory/issues?companyId=${companyId}`)
          .set(auth())
          .send({
            siteId: siteA,
            itemId,
            date: today(),
            quantity: before.inStock,
            issuedTo: 'Gang 2',
          });

      const [first, second] = await Promise.all([issueAll(), issueAll()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 422]);

      const after = await stockAt(siteA);
      expect(after.inStock).toBe(0);
    });

    it('returns the material to stock when an issue is deleted', async () => {
      const created = await http()
        .post(`/inventory/purchases?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          vendorId,
          date: today(),
          quantity: 20,
          rate: 100,
        })
        .expect(201);
      expect(created.body.id).toBeDefined();

      const issue = await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 20,
          issuedTo: 'Gang 3',
        })
        .expect(201);
      expect((await stockAt(siteA)).inStock).toBe(0);

      await http()
        .delete(`/inventory/issues/${issue.body.id}`)
        .set(auth())
        .expect(204);
      expect((await stockAt(siteA)).inStock).toBe(20);
    });
  });

  // ──────────────────────────────────────────────────────── Transfers (US5)

  describe('Transfers', () => {
    it('refuses a transfer to the same store', async () => {
      await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteA,
          itemId,
          date: today(),
          quantity: 1,
        })
        .expect(400);
    });

    it('moves both balances at once, creating the destination row', async () => {
      // Site B has never received this item, so it has no balance row at all —
      // the case an update rather than an upsert would silently lose.
      expect((await stockAt(siteB)).inStock).toBe(0);

      await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteB,
          itemId,
          date: today(),
          quantity: 15,
        })
        .expect(201);

      expect((await stockAt(siteA)).inStock).toBe(5);
      expect((await stockAt(siteB)).inStock).toBe(15);
    });

    it('refuses to transfer more than the source holds', async () => {
      const res = await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteB,
          itemId,
          date: today(),
          quantity: 999,
        })
        .expect(422);
      expect(res.body.availableStock).toBe(5);
    });

    it('reverts both balances when a transfer is deleted', async () => {
      const created = await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteB,
          itemId,
          date: today(),
          quantity: 5,
        })
        .expect(201);

      expect((await stockAt(siteA)).inStock).toBe(0);
      await http()
        .delete(`/inventory/transfers/${created.body.id}`)
        .set(auth())
        .expect(204);

      expect((await stockAt(siteA)).inStock).toBe(5);
      expect((await stockAt(siteB)).inStock).toBe(15);
    });

    it('refuses to delete a transfer the destination has received', async () => {
      const created = await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteB,
          itemId,
          date: today(),
          quantity: 1,
        })
        .expect(201);

      await http()
        .patch(`/inventory/transfers/${created.body.id}`)
        .set(auth())
        .send({ status: 'received' })
        .expect(200);

      await http()
        .delete(`/inventory/transfers/${created.body.id}`)
        .set(auth())
        .expect(409);
    });

    it('refuses an out-of-order status transition', async () => {
      const created = await http()
        .post(`/inventory/transfers?companyId=${companyId}`)
        .set(auth())
        .send({
          fromSiteId: siteA,
          toSiteId: siteB,
          itemId,
          date: today(),
          quantity: 1,
        })
        .expect(201);

      await http()
        .patch(`/inventory/transfers/${created.body.id}`)
        .set(auth())
        .send({ status: 'received' })
        .expect(200);
      await http()
        .patch(`/inventory/transfers/${created.body.id}`)
        .set(auth())
        .send({ status: 'in_transit' })
        .expect(409);
    });
  });

  // ───────────────────────────────────────────────────────── Payments (US7)

  describe('Payments and FIFO allocation', () => {
    let oldBillPurchase: string;
    let newBillPurchase: string;
    let paymentId: string;

    it('allocates the oldest bill first and part-pays the next', async () => {
      const older = await http()
        .post(`/inventory/purchases?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteB,
          itemId,
          vendorId,
          date: '2026-01-10',
          quantity: 10,
          rate: 500,
        })
        .expect(201);
      oldBillPurchase = older.body.id;

      const newer = await http()
        .post(`/inventory/purchases?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteB,
          itemId,
          vendorId,
          date: '2026-02-10',
          quantity: 10,
          rate: 300,
        })
        .expect(201);
      newBillPurchase = newer.body.id;

      const payment = await http()
        .post(`/inventory/payments?companyId=${companyId}`)
        .set(auth())
        .send({
          vendorId,
          amount: 7000,
          date: today(),
          paymentMode: 'bank_transfer',
          referenceNumber: unique('UTR'),
        })
        .expect(201);
      paymentId = payment.body.id;

      const purchases = await http()
        .get(`/inventory/purchases?vendorId=${vendorId}&siteId=${siteB}`)
        .set(auth())
        .expect(200);
      const byId = new Map(
        purchases.body.purchases.map((p: { id: string }) => [p.id, p]),
      );
      expect((byId.get(oldBillPurchase) as { paymentStatus: string }).paymentStatus).toBe('paid');
      expect((byId.get(newBillPurchase) as { paymentStatus: string }).paymentStatus).toBe('part_paid');
    });

    it('refuses to delete a purchase whose bill has been allocated against', async () => {
      await http()
        .delete(`/inventory/purchases/${oldBillPurchase}`)
        .set(auth())
        .expect(409);
    });

    it('reverts every bill when the payment is deleted', async () => {
      await http()
        .delete(`/inventory/payments/${paymentId}`)
        .set(auth())
        .expect(204);

      const purchases = await http()
        .get(`/inventory/purchases?vendorId=${vendorId}&siteId=${siteB}`)
        .set(auth())
        .expect(200);
      for (const row of purchases.body.purchases) {
        expect(row.paymentStatus).toBe('unpaid');
      }
    });

    it('records a surplus rather than refusing an over-payment', async () => {
      const outstanding = await http()
        .get(`/inventory/bills?vendorId=${vendorId}`)
        .set(auth())
        .expect(200);

      const payment = await http()
        .post(`/inventory/payments?companyId=${companyId}`)
        .set(auth())
        .send({
          vendorId,
          amount: outstanding.body.totalOutstanding + 5000,
          date: today(),
          paymentMode: 'upi',
          referenceNumber: unique('UPI'),
        })
        .expect(201);

      expect(payment.body.unallocatedBalance).toBe(5000);
      expect(payment.body.allocatedAmount).toBe(
        outstanding.body.totalOutstanding,
      );

      await http()
        .delete(`/inventory/payments/${payment.body.id}`)
        .set(auth())
        .expect(204);
    });
  });

  // ────────────────────────────────────────────────────────── Indents (US9)

  describe('Material indents', () => {
    let indentId: string;
    let lineId: string;

    /** Every balance for this item, as a comparable snapshot. */
    const balancesSnapshot = async () => {
      const rows = await sys.stockBalance.findMany({
        where: { itemId },
        orderBy: { siteId: 'asc' },
      });
      return JSON.stringify(rows);
    };

    it('raises an indent with lines', async () => {
      const created = await http()
        .post(`/inventory/indents?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          requiredByDate: '2026-12-31',
          justification: 'Slab casting',
          lines: [{ itemId, requestedQuantity: 100 }],
        })
        .expect(201);

      indentId = created.body.id;
      lineId = created.body.lines[0].id;
      createdIndentIds.push(indentId);

      expect(created.body.indentNumber).toMatch(/-IND-\d{4}$/);
      expect(created.body.status).toBe('submitted');
      // Nothing is approved yet, so outstanding is not yet a number.
      expect(created.body.lines[0].outstandingQuantity).toBeNull();
    });

    it('refuses an indent for a retired item', async () => {
      const retired = await http()
        .post(`/inventory/items?companyId=${companyId}`)
        .set(auth())
        .send({ name: unique('Retired'), categoryId, unit: 'KG' })
        .expect(201);
      createdItemIds.push(retired.body.id);

      await http()
        .patch(`/inventory/items/${retired.body.id}`)
        .set(auth())
        .send({ active: false })
        .expect(200);

      await http()
        .post(`/inventory/indents?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          requiredByDate: '2026-12-31',
          justification: 'Should not be allowed',
          lines: [{ itemId: retired.body.id, requestedQuantity: 1 }],
        })
        .expect(400);
    });

    it('refuses approval from a caller without INVENTORY_APPROVE (FR-029)', async () => {
      // The permission 009 adds is not held by any seeded role, and `INVENTORY`
      // alone is not enough: the method-level decorator *replaces* the class-level
      // one, so an approver needs the approval value specifically. Asserted before
      // it is granted below, because after that this can never fail again.
      await http()
        .post(`/inventory/indents/${indentId}/approve`)
        .set(auth())
        .send({ lines: [{ lineId, approvedQuantity: 60 }] })
        .expect(403);

      await grantApprovePermission();
    });

    it('refuses a reduced approval with no reason', async () => {
      await http()
        .post(`/inventory/indents/${indentId}/approve`)
        .set(auth())
        .send({ lines: [{ lineId, approvedQuantity: 60 }] })
        .expect(400);
    });

    it('approves without touching a single stock balance (SC-A02)', async () => {
      const before = await balancesSnapshot();

      const approved = await http()
        .post(`/inventory/indents/${indentId}/approve`)
        .set(auth())
        .send({
          lines: [
            {
              lineId,
              approvedQuantity: 60,
              reductionReason: 'Only 60 bags budgeted this month',
            },
          ],
        })
        .expect(201);

      expect(approved.body.status).toBe('approved');
      // Both figures survive, which is what makes the reduction auditable.
      expect(approved.body.lines[0].requestedQuantity).toBe(100);
      expect(approved.body.lines[0].approvedQuantity).toBe(60);
      expect(approved.body.lines[0].outstandingQuantity).toBe(60);

      expect(await balancesSnapshot()).toBe(before);
    });

    it('refuses an issue exceeding the line outstanding, reporting the figure', async () => {
      // There is stock at site A for this, so the refusal below can only come from
      // the indent line and not from the stock check.
      await http()
        .post(`/inventory/purchases?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          vendorId,
          date: today(),
          quantity: 500,
          rate: 100,
        })
        .expect(201);

      const res = await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 80,
          issuedTo: 'Gang 4',
          indentLineId: lineId,
        })
        .expect(400);
      expect(res.body.outstandingQuantity).toBe(60);
    });

    it('books an issue against the line and advances the indent', async () => {
      await http()
        .post(`/inventory/issues?companyId=${companyId}`)
        .set(auth())
        .send({
          siteId: siteA,
          itemId,
          date: today(),
          quantity: 25,
          issuedTo: 'Gang 4',
          indentLineId: lineId,
        })
        .expect(201);

      const detail = await http()
        .get(`/inventory/indents/${indentId}`)
        .set(auth())
        .expect(200);

      expect(detail.body.status).toBe('partially_fulfilled');
      expect(detail.body.lines[0].fulfilledQuantity).toBe(25);
      expect(detail.body.lines[0].outstandingQuantity).toBe(35);
    });

    it('refuses to cancel an indent that has been partly fulfilled', async () => {
      await http()
        .post(`/inventory/indents/${indentId}/cancel`)
        .set(auth())
        .send({ reason: 'Changed our minds' })
        .expect(409);
    });

    it('keeps indent demand and reorder shortfall as separate figures (FR-027)', async () => {
      await http()
        .post(`/inventory/indents/${indentId}/mark-procurement-needed`)
        .set(auth())
        .send({ lineIds: [lineId] })
        .expect(201);

      const report = await http()
        .get(`/inventory/indents/procurement-needed?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      const demand = report.body.indentDemand.find(
        (row: { lineId: string }) => row.lineId === lineId,
      );
      expect(demand.outstandingQuantity).toBe(35);
      expect(Object.keys(report.body).sort()).toEqual([
        'indentDemand',
        'reorderShortfall',
      ]);
    });
  });
});
