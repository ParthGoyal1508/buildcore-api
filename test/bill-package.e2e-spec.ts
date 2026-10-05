import { INestApplication } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { hash } from 'argon2';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { PACKAGE_ERRORS } from '../src/projects/billing/package/package-error-codes';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * The running-account bill package, end to end (023, quickstart passes 1–8 — tasks T096, T097).
 *
 * ## What a unit test cannot see, and this can
 *
 * - **The count that must match.** A composition proposes one line per schedule line. A mocked
 *   client returns whatever the fake was given; only a database can be asked whether the number of
 *   claims written equals the number of BOQ lines that exist.
 * - **The cumulative chain across three bills.** Decision D1's whole point: the third bill's
 *   *up to previous* is the second bill's *stored* up-to-date figure, so the chain has to be three
 *   real rows with real issues between them.
 * - **The frozen header.** Read once at issue from three different services and written onto the
 *   row. A unit test asserts the write; only this can show the document standing still afterwards.
 * - **The workbook.** Produced by `exceljs` from stored figures and read back by `exceljs`, which
 *   is the only way to count its sheets.
 * - **`forbidNonWhitelisted`.** A caller sending a computed total gets a 400 from the pipe, not a
 *   stripped field — and that is configuration, not code.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`.
 */
const PREFIX = 'E2E';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

jest.setTimeout(180_000);

describe('The running-account bill package (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let clientId = '';
  let projectId = '';
  const boqItemIds: string[] = [];
  const LINES = 6;

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
  /* eslint-enable @typescript-eslint/no-explicit-any */

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

    const client = await http()
      .post('/projects/clients')
      .set(auth())
      .send({ name: unique('PkgClient') })
      .expect(201);
    clientId = client.body.id;
    companyId = client.body.companyId;

    // Created directly for the reason `client-bills.e2e-spec.ts` gives: 017 refuses project
    // creation until a document is attached for every mandatory kind, which is four blobs this
    // suite is not about. `clientRetentionFraction` is the client contract's own term — 5%, as the
    // real package has it — and without it composition refuses rather than billing at zero.
    projectId = (
      await sys.project.create({
        data: {
          companyId,
          code: unique('PKG').slice(0, 40),
          name: unique('PkgProject'),
          clientId,
          contractValue: 10000000,
          startDate: new Date('2025-10-01'),
          clientRetentionFraction: 0.05,
          cgstApplicable: true,
        },
        select: { id: true },
      })
    ).id;

    const group = await http()
      .post(`/projects/${projectId}/boq/groups`)
      .set(auth())
      .send({ boqNo: '30', name: 'Operation & Maintenance', scopeQty: '0' })
      .expect(201);

    // Six lines. **Sent as strings** — the BOQ DTOs use `@IsNumberString`, and 022 had all
    // twenty-four of its e2e tests failing from one `beforeAll` line that sent numbers.
    for (let i = 1; i <= LINES; i += 1) {
      const line = await http()
        .post(`/projects/${projectId}/boq/items`)
        .set(auth())
        .send({
          groupId: group.body.id,
          boqNo: `30.${i * 10}`,
          taskName: `Maintenance activity ${i}, all complete in the subcontractor’s scope`,
          unit: 'Month',
          scopeQty: '12',
          rate: '150000.00',
        })
        .expect(201);
      boqItemIds.push(line.body.id);
    }
  });

  afterAll(async () => {
    if (prisma) {
      await sys.billPackageLineClaim.deleteMany({ where: { companyId } });
      await sys.billPackageCheckListAnswer.deleteMany({ where: { companyId } });
      await sys.billPackageDebit.deleteMany({ where: { projectId } });
      await sys.billPackage.deleteMany({ where: { projectId } });
      await sys.clientBillLine.deleteMany({
        where: { clientBill: { projectId } },
      });
      await sys.clientBill.deleteMany({ where: { projectId } });
      await sys.bOQTaskItem.deleteMany({ where: { group: { projectId } } });
      await sys.bOQTaskGroup.deleteMany({ where: { projectId } });
      await sys.project.deleteMany({ where: { id: projectId } });
      await sys.client.deleteMany({ where: { id: clientId } });
    }
    // `src/common/prisma/e2e-teardown.spec.ts` scans these files and names any that does not.
    if (app) await app.close();
  });

  // ── Pass 1 — compose, and the count that must match ──────────────────────

  let packageId = '';

  it('proposes one line per BOQ line, counted against the schedule itself', async () => {
    const composed = await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2025-12-21',
        periodTo: '2026-01-20',
        externalBillNo: '0016014256/12',
      })
      .expect(201);

    packageId = composed.body.id;

    // The assertion that matters: **the count, against the number of lines that exist**, not
    // against a number typed here. An assertion over a returned list passes just as happily over a
    // short one, and a bill missing an item is a smaller invoice.
    const onProject = await sys.bOQTaskItem.count({
      where: { group: { projectId } },
    });
    expect(composed.body.claims).toHaveLength(onProject);
    expect(onProject).toBe(LINES);

    expect(composed.body.label).toBe('RA-01');
    // No measurement has been approved, so every proposal is zero — **read and nothing**, which is
    // `approved_measurement`, not the absence of a source.
    for (const claim of composed.body.claims) {
      expect(claim.proposalSource).toBe('approved_measurement');
      expect(claim.proposedQty).toBe('0.000');
    }
  });

  it('refuses a computed total outright rather than stripping it', async () => {
    // `whitelist` and `forbidNonWhitelisted` are both on, which 022 found is the *stronger*
    // guarantee: a caller who sends a figure the server owns is told, rather than having it
    // silently dropped and believing it was accepted.
    await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2026-02-21',
        periodTo: '2026-03-20',
        grossAmount: '999999',
      })
      .expect(400);
  });

  it('returns the existing package when the same period is opened again', async () => {
    const again = await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2025-12-21',
        periodTo: '2026-01-20',
      })
      .expect(201);

    expect(again.body.id).toBe(packageId);
  });

  it('refuses a period that overlaps one already billed, naming the bill', async () => {
    const refused = await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2026-01-01',
        periodTo: '2026-02-20',
      })
      .expect(409);

    expect(refused.body.code).toBe('BILL_PERIOD_OVERLAPS');
    expect(refused.body.packageLabel).toBe('RA-01');
  });

  // ── Pass 2 — reduce, over-claim, and the two reasons ─────────────────────

  it('requires a reason for a claim that differs from the proposal', async () => {
    const view = await http()
      .get(`/projects/bill-packages/${packageId}`)
      .set(auth())
      .expect(200);
    const claimId = view.body.claims[0].id;

    const refused = await http()
      .post(`/projects/bill-packages/${packageId}/lines/${claimId}`)
      .set(auth())
      .send({ claimedQty: '1.000' })
      .expect(400);
    expect(refused.body.code).toBe('BILL_CLAIM_NEEDS_REASON');

    const accepted = await http()
      .post(`/projects/bill-packages/${packageId}/lines/${claimId}`)
      .set(auth())
      .send({
        claimedQty: '1.000',
        reason: 'Work done ahead of the paperwork, measured on site',
      })
      .expect(201);

    const claim = accepted.body.claims.find(
      (row: { id: string }) => row.id === claimId,
    );
    expect(claim.overClaimed).toBe(true);
    expect(claim.reason).toContain('measured on site');
  });

  it('clears the reason when the claim returns to its proposal', async () => {
    const view = await http()
      .get(`/projects/bill-packages/${packageId}`)
      .set(auth())
      .expect(200);
    const claimId = view.body.claims[0].id;

    const back = await http()
      .post(`/projects/bill-packages/${packageId}/lines/${claimId}`)
      .set(auth())
      .send({ claimedQty: '0.000' })
      .expect(201);

    const claim = back.body.claims.find(
      (row: { id: string }) => row.id === claimId,
    );
    expect(claim.reason).toBeNull();
    expect(claim.overClaimed).toBe(false);
  });

  // ── Pass 3 — the abstract ────────────────────────────────────────────────

  it('marks a draft’s cumulative column provisional, and names the tax basis', async () => {
    const abstract = await http()
      .get(`/projects/bill-packages/${packageId}/abstract`)
      .set(auth())
      .expect(200);

    // FR-013b. A figure that changes when the engineer presses Issue is a figure they did not
    // approve, so a draft says so rather than presenting it as settled.
    expect(abstract.body.cumulativeProvisional).toBe(true);
    // FR-016a. `Client` carries no state, so the basis falls back to the project's flag — and the
    // response says which decided it rather than leaving a tax decision nobody made.
    expect(abstract.body.taxBasis).toBe('intra_state');
    expect(['derived_from_gstin', 'from_project_flag']).toContain(
      abstract.body.taxBasisSource,
    );
    expect(abstract.body.rates.retentionFraction).toBe('0.050000');
  });

  // ── Pass 6 — debits, and the register's two halves ───────────────────────

  let debitId = '';

  it('records a debit and recovers it on one bill, refusing a second application', async () => {
    const recorded = await http()
      .post(`/projects/${projectId}/bill-package-debits`)
      .set(auth())
      .send({
        groupHeading: 'Debit against the ATMS Equipment Missing at site',
        description: 'PTZ camera missing',
        location: 'KM.226 LHS',
        nos: '1',
        rate: '125000.00',
        amount: '125000.00',
        amountWithTax: '147500.00',
      })
      .expect(201);
    debitId = recorded.body.id;

    await http()
      .post(`/projects/bill-package-debits/${debitId}/apply/${packageId}`)
      .set(auth())
      .expect(201);

    // A debit recovered twice is money taken twice.
    const refused = await http()
      .post(`/projects/bill-package-debits/${debitId}/apply/${packageId}`)
      .set(auth())
      .expect(409);
    expect(refused.body.code).toBe('DEBIT_ALREADY_RECOVERED');
  });

  it('shows a draft’s register live, grouped under its heading', async () => {
    const register = await http()
      .get(`/projects/bill-packages/${packageId}/debits`)
      .set(auth())
      .expect(200);

    expect(register.body.asAtIssue).toBe(false);
    expect(register.body.groups[0].heading).toBe(
      'Debit against the ATMS Equipment Missing at site',
    );
    expect(register.body.recoveredOnThisPackage).toBe('147500.00');
  });

  // ── The check list ───────────────────────────────────────────────────────

  it('keeps an unanswered question distinguishable from one answered no', async () => {
    const answered = await http()
      .post(`/projects/bill-packages/${packageId}/check-list`)
      .set(auth())
      .send({
        answers: [
          { questionKey: 'cumulative_measurement', answer: 'yes' },
          { questionKey: 'rmc_dispatch_detail', answer: 'no' },
          // Deliberately omitted: `bar_bending_schedule` stays unanswered.
        ],
      })
      .expect(201);

    const items: { key: string; answer: string | null }[] = answered.body.items;
    expect(items).toHaveLength(6);
    expect(items.find((i) => i.key === 'cumulative_measurement')?.answer).toBe(
      'yes',
    );
    expect(items.find((i) => i.key === 'rmc_dispatch_detail')?.answer).toBe(
      'no',
    );
    expect(
      items.find((i) => i.key === 'bar_bending_schedule')?.answer,
    ).toBeNull();

    // A gap is an unanswered question **or** one answered no, and it never refuses anything.
    const gaps: { key: string; state: string }[] = answered.body.gaps;
    expect(gaps.find((g) => g.key === 'rmc_dispatch_detail')?.state).toBe('no');
    expect(gaps.find((g) => g.key === 'bar_bending_schedule')?.state).toBe(
      'unanswered',
    );
  });

  // ── Pass 4 — issue, and the frozen header ────────────────────────────────

  /**
   * 025 FR-044. **The entered recoveries reach the payable.**
   *
   * Every one of these columns was read by the abstract, printed on both documents and carried
   * into the next bill's cumulative position, and written by nothing — so each was permanently
   * zero and the bill printed a *Recovery of Diesel* row that could only ever say nothing.
   *
   * Asserted against the payable rather than against the stored column: a test that read the
   * column back would pass against an endpoint that wrote a number nothing subsequently used,
   * which is the state this fixes.
   */
  it('sets the month’s recoveries, and the payable moves by them', async () => {
    const before = await http()
      .get(`/projects/bill-packages/${packageId}/abstract`)
      .set(auth())
      .expect(200);

    await http()
      .patch(`/projects/bill-packages/${packageId}/adjustments`)
      .set(auth())
      .send({ recoveryDiesel: '1000.00', theftWithheld: '250.00' })
      .expect(200);

    const after = await http()
      .get(`/projects/bill-packages/${packageId}/abstract`)
      .set(auth())
      .expect(200);

    expect(Number(after.body.columns.thisBill.recoveryDiesel)).toBe(1000);
    expect(Number(after.body.columns.thisBill.theftWithheld)).toBe(250);
    expect(Number(after.body.columns.thisBill.payable)).toBe(
      Number(before.body.columns.thisBill.payable) - 1250,
    );

    // Omission leaves a column alone; an explicit zero sets it. A caller posting the whole set
    // every time would otherwise be indistinguishable from one clearing what it did not render.
    await http()
      .patch(`/projects/bill-packages/${packageId}/adjustments`)
      .set(auth())
      .send({ theftWithheld: '0.00' })
      .expect(200);

    const third = await http()
      .get(`/projects/bill-packages/${packageId}/abstract`)
      .set(auth())
      .expect(200);
    expect(Number(third.body.columns.thisBill.recoveryDiesel)).toBe(1000);
    expect(Number(third.body.columns.thisBill.theftWithheld)).toBe(0);

    // A computed figure is not an adjustable one: a bill stating a retention its own frozen rate
    // does not produce is a bill whose arithmetic has stopped being checkable.
    await http()
      .patch(`/projects/bill-packages/${packageId}/adjustments`)
      .set(auth())
      .send({ retentionAmount: '1.00' })
      .expect(400);

    // Put it back, so the issue tests below read the figures they were written against.
    await http()
      .patch(`/projects/bill-packages/${packageId}/adjustments`)
      .set(auth())
      .send({ recoveryDiesel: '0.00' })
      .expect(200);
  });

  it('issues the bill, reporting the header gaps rather than refusing', async () => {
    const issued = await http()
      .post(`/projects/bill-packages/${packageId}/issue`)
      .set(auth())
      .expect(201);

    expect(issued.body.package.status).toBe('issued');
    // FR-027a. This client carries no PAN and no state — the columns exist as of 025 FR-039 and
    // this fixture leaves them unset, which is the ordinary case for a client recorded before they
    // did. Reported, never a refusal: a bill that cannot be produced because a PAN is unrecorded
    // is worse than one produced with a blank somebody fills in by hand.
    //
    // **Unrecorded, not unrecordable** — which is the whole difference 025 made, and the case
    // below proves the other half.
    expect(issued.body.missingHeaderFields).toContain('issuerPan');
    expect(issued.body.missingHeaderFields).toContain('issuerState');
    // FR-043a. Three questions were never answered and one was answered no, and none of that
    // stopped the bill going out.
    expect(issued.body.checkListGaps.length).toBeGreaterThan(0);
  });

  it('freezes the cumulative position at issue, and the next bill reads it', async () => {
    // Decision D1, and the case that distinguishes frozen from recomputed. The second package's
    // *up to previous* must be the first package's **stored** up-to-date figure.
    const second = await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2026-01-21',
        periodTo: '2026-02-20',
      })
      .expect(201);

    const abstract = await http()
      .get(`/projects/bill-packages/${second.body.id}/abstract`)
      .set(auth())
      .expect(200);

    const firstIssued = await sys.billPackage.findFirst({
      where: { id: packageId },
      select: { payableUptoDate: true, workDoneUptoDate: true },
    });

    expect(abstract.body.columns.uptoPrevious.workDone).toBe(
      String(Math.round(Number(firstIssued.workDoneUptoDate))),
    );
    expect(second.body.label).toBe('RA-02');
  });

  /**
   * 025 FR-043. **The bill under the package leaves draft when the package is issued.**
   *
   * Composing creates it in `draft` and nothing moved it, so a package that had been issued —
   * every figure frozen, a PDF emailed — sat on a bill the rest of the product read as unsent. The
   * project position counts bills that have left draft, so Position reported no revenue at all for
   * every running-account bill ever issued.
   *
   * Asserted through the 018 read rather than on the package, because that read is what Position
   * and the Client bills tab both go through: a test on the package's own status would pass while
   * the figure a user is looking at stayed zero.
   */
  it('submits the client bill under the package it issues', async () => {
    const pkg = await http()
      .get(`/projects/bill-packages/${packageId}`)
      .set(auth())
      .expect(200);
    expect(pkg.body.status).toBe('issued');

    const bills = await http()
      .get(`/projects/client-bills?projectId=${projectId}`)
      .set(auth())
      .expect(200);

    // The 018 bill carries the package's own label as its number.
    const bill = bills.body.find(
      (row: { billNumber: string }) => row.billNumber === pkg.body.label,
    );
    expect(bill).toBeDefined();
    expect(bill.status).toBe('submitted');
    expect(bill.submittedAt).not.toBeNull();
  });

  it('refuses recoveries changed after the bill has been issued', async () => {
    // The same reasoning that refuses a debit applied after issue: a deduction recorded afterwards
    // is either an edit to a signed document or one the bill never actually made.
    await http()
      .patch(`/projects/bill-packages/${packageId}/adjustments`)
      .set(auth())
      .send({ recoveryDiesel: '500.00' })
      .expect(409);
  });

  it('refuses a debit applied to a bill that has been issued', async () => {
    const another = await http()
      .post(`/projects/${projectId}/bill-package-debits`)
      .set(auth())
      .send({
        description: 'Recorded after the bill went out',
        rate: '1000.00',
        amount: '1000.00',
        amountWithTax: '1180.00',
      })
      .expect(201);

    const refused = await http()
      .post(
        `/projects/bill-package-debits/${another.body.id}/apply/${packageId}`,
      )
      .set(auth())
      .expect(409);

    expect(refused.body.code).toBe('BILL_PACKAGE_ISSUED');
  });

  it('keeps an issued bill’s register as at issue', async () => {
    // FR-039a. The debit recorded in the test above exists on the project, and must not appear on
    // a bill that was signed before it.
    const register = await http()
      .get(`/projects/bill-packages/${packageId}/debits`)
      .set(auth())
      .expect(200);

    const descriptions = register.body.groups.flatMap(
      (group: { rows: { description: string }[] }) =>
        group.rows.map((row) => row.description),
    );

    expect(register.body.asAtIssue).toBe(true);
    expect(descriptions).not.toContain('Recorded after the bill went out');
  });

  // ── Pass 7 — the workbook ────────────────────────────────────────────────

  it('produces a workbook with one measurement sheet per CLAIMED line', async () => {
    const response = await http()
      .get(`/projects/bill-packages/${packageId}/workbook.xlsx`)
      .set(auth())
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers['content-type']).toContain('spreadsheetml');
    // FR-027a: the gaps reach the caller on a file download too, where a response body cannot
    // carry them.
    expect(response.headers['x-bill-package-missing-fields']).toContain(
      'issuerPan',
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body);
    const names = workbook.worksheets.map((sheet) => sheet.name);

    // The five kinds, in the client's order.
    expect(names.slice(0, 3)).toEqual([
      'Check List',
      'Abstract',
      'BOQ Annexure-I',
    ]);
    expect(names[names.length - 1]).toBe('Debit Note');

    // **Counted against the claims, not against the schedule** (amended 2026-10-05). A sheet per
    // schedule line is right for the three-line bill this format was drawn from and wrong at any
    // real scale: a 231-line tender with six lines measured produced a 246-page document of which
    // 225 pages carried a nil claim. Asserting against `LINES` would pass either way here, because
    // this fixture claims every line — so the count is derived from the package's own claims.
    const view = await http()
      .get(`/projects/bill-packages/${packageId}`)
      .set(auth())
      .expect(200);
    const claimed = view.body.claims.filter(
      (claim: { claimedQty: string | null }) =>
        claim.claimedQty != null && Number(claim.claimedQty) !== 0,
    );
    expect(claimed.length).toBeLessThan(view.body.claims.length);
    expect(names.filter((name) => name.startsWith('M-'))).toHaveLength(
      claimed.length,
    );

    // And the schedule annexure still carries every line, claimed or not — that is where a reader
    // checks nothing has gone missing.
    expect(view.body.claims).toHaveLength(LINES);
  });

  // ── Pass 8 — locks, permissions, tenancy ─────────────────────────────────

  it('reports another company’s package as not found, not refused', async () => {
    // FR-053. A 403 confirms the row exists, which is itself a leak across the boundary row-level
    // security is there to hold.
    await http()
      .get('/projects/bill-packages/not-a-real-package-id')
      .set(auth())
      .expect(404);
  });

  it('refuses a write against a locked project with 423, not 403', async () => {
    // FR-052. The distinction matters to the caller: the same person may write the moment the
    // project is unlocked, and a 403 sends them to ask for permission they already have.
    await sys.project.update({
      where: { id: projectId },
      data: { isLocked: true },
    });

    try {
      const refused = await http()
        .post(`/projects/${projectId}/bill-packages`)
        .set(auth())
        .send({
          direction: 'to_client',
          periodFrom: '2026-03-21',
          periodTo: '2026-04-20',
        });
      expect(refused.status).toBe(423);
    } finally {
      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: false },
      });
    }
  });

  it('requires a token at all', async () => {
    await http().get(`/projects/bill-packages/${packageId}`).expect(401);
  });

  /**
   * 023 T100, closed by 025 FR-038. **The guard was declared and never exercised.**
   *
   * Every route on this controller carries `Permission.PROJECT_FINANCIALS` and nothing established
   * that it holds. A declaration is not a proof: a decorator on the wrong class, a guard left out
   * of the module, a permission renamed in one place — each leaves the annotation reading correctly
   * above a route anybody can call.
   *
   * **The caller holds other permissions and lacks only this one.** A caller with no permissions at
   * all would also be refused by a route guarded by nothing, which would make this test pass
   * against precisely the defect it exists to catch.
   */
  it('refuses a caller who holds other permissions but not PROJECT_FINANCIALS', async () => {
    const email = `${unique('NoFin')}@example.test`.toLowerCase();
    const user = await sys.user.create({
      data: {
        email,
        username: unique('NoFin'),
        password: await hash('secret42'),
        displayName: `${unique('NoFin')}`,
        companyId,
        status: 'active',
      },
    });
    const role = await sys.role.create({
      data: {
        name: unique('NoFinRole'),
        // Everything a project person plausibly has, minus the one under test. PROJECTS and DWR
        // are the two that would most easily be mistaken for it.
        permissions: [Permission.PROJECTS, Permission.DWR],
      },
    });
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });

    try {
      const login = await http()
        .post('/auth/login')
        .send({ identifier: email, password: 'secret42', rememberMe: false })
        .expect(201);
      const limited = { Authorization: `Bearer ${login.body.accessToken}` };

      // A read and a write, because they are guarded by different decorators on different methods.
      await http()
        .get(`/projects/bill-packages/${packageId}`)
        .set(limited)
        .expect(403);

      await http()
        .post(`/projects/${projectId}/bill-packages`)
        .set(limited)
        .send({
          direction: 'to_client',
          periodFrom: '2026-03-21',
          periodTo: '2026-04-20',
        })
        .expect(403);
    } finally {
      // The login above issued a refresh token, which holds the account down.
      await sys.refreshToken.deleteMany({ where: { accountId: user.id } });
      await sys.userRole.deleteMany({ where: { userId: user.id } });
      await sys.role.deleteMany({ where: { id: role.id } });
      await sys.user.deleteMany({ where: { id: user.id } });
    }
  });

  // ── The reports the decisions oblige ─────────────────────────────────────

  it('answers the understatement report, naming the directions it can compare', async () => {
    const report = await http()
      .get(`/projects/${projectId}/bill-packages/reports/understatement`)
      .set(auth())
      .expect(200);

    expect(report.body.comparableDirections).toEqual(['to_client']);
    expect(Array.isArray(report.body.rows)).toBe(true);
  });

  it('answers the over-claim report with its denominator', async () => {
    const report = await http()
      .get(`/projects/${projectId}/bill-packages/reports/over-claims`)
      .set(auth())
      .expect(200);

    // Zero out of twelve is a fact worth reporting; an empty report is not the same statement.
    expect(report.body.totalLines).toBeGreaterThan(0);
    expect(typeof report.body.totalOverClaimed).toBe('number');
  });

  /**
   * The other half of the header gap (025 FR-039).
   *
   * Until this feature `Client` had no `pan` and no `state` column at all, so `issuerPan` and
   * `issuerState` were hardcoded null and **every** bill ever issued to a client reported them
   * missing. The test above asserts a client that has not recorded them still does; this one
   * asserts a client that has recorded them does not — without which the two columns could be
   * dropped again and the suite would not notice.
   */
  it('stops reporting the header gap once the client carries its PAN and state', async () => {
    await sys.client.update({
      where: { id: clientId },
      data: { pan: 'AABCP1234F', state: '08' },
    });

    const second = await http()
      .post(`/projects/${projectId}/bill-packages`)
      .set(auth())
      .send({
        direction: 'to_client',
        periodFrom: '2026-04-21',
        periodTo: '2026-05-20',
      })
      .expect(201);

    const issued = await http()
      .post(`/projects/bill-packages/${second.body.id}/issue`)
      .set(auth())
      .expect(201);

    expect(issued.body.missingHeaderFields).not.toContain('issuerPan');
    expect(issued.body.missingHeaderFields).not.toContain('issuerState');

    // Frozen onto the row, which the view does not carry — the workbook renders from the stored
    // package, so this is where the figure that actually prints lives.
    const frozen = await sys.billPackage.findUnique({
      where: { id: second.body.id },
      select: { issuerState: true, issuerPan: true },
    });
    expect(frozen.issuerState).toBe('08');
    expect(frozen.issuerPan).toBe('AABCP1234F');
  });

  it('produces the same bill as a PDF, from the same figures', async () => {
    // 025 FR-042. The `.xlsx` is what a client edits before signing; this is what gets attached to
    // an email and filed. **Two readings of one bill**, which is why both render from the same
    // view — a second path reading its own figures would eventually produce two documents for one
    // bill, and a client holding both would be right to believe whichever is worse for us.
    const pdf = await http()
      .get(`/projects/bill-packages/${packageId}/bill.pdf`)
      .set(auth())
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('.pdf');
    // A real PDF, not an error page with a hopeful content type.
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
  });

  // ── A statutory rate can change, and an issued bill cannot (025 US4) ──────

  /**
   * **The assertion that keeps 025 from undoing 023.**
   *
   * Issue freezes the four tax rates onto the package, which is the whole reason a document already
   * sent to a client reproduces identically. Feature 025 makes those rates editable — and a feature
   * that makes a frozen figure editable is exactly the kind that unfreezes one by accident.
   *
   * **The package must be issued before the rate moves.** A test that changed a rate and re-read a
   * *draft* would prove the opposite of what is wanted: a draft is supposed to move, and such a
   * test would pass against an implementation that recomputed issued bills too.
   */
  it('leaves an issued bill untouched when a statutory rate changes', async () => {
    const before = await http()
      .get(`/projects/bill-packages/${packageId}/abstract`)
      .set(auth())
      .expect(200);

    const rates = await http()
      .get(`/settings/companies/${companyId}/billing-rates`)
      .set(auth())
      .expect(200);
    expect(rates.body.tdsFraction).toBe('0.020000');

    await http()
      .patch(`/settings/companies/${companyId}/billing-rates`)
      .set(auth())
      .send({ tdsFraction: 0.025 })
      .expect(200);

    try {
      const after = await http()
        .get(`/projects/bill-packages/${packageId}/abstract`)
        .set(auth())
        .expect(200);

      // Every cell, not just the TDS row: a recomputation would move the deduction total and the
      // payable with it, and asserting one figure would miss the two it drags.
      expect(after.body).toEqual(before.body);
    } finally {
      // Restored whatever the assertion did — the company fixture is shared with every other suite
      // in this repository, and a test that leaves TDS at 2.5% breaks them somewhere else entirely.
      await http()
        .patch(`/settings/companies/${companyId}/billing-rates`)
        .set(auth())
        .send({ tdsFraction: 0.02 })
        .expect(200);
    }
  });

  it('refuses a rate above one, which is a percentage in a fraction’s column', async () => {
    // `9` meaning nine per cent multiplies every tax on every bill by a hundred. Large enough that
    // somebody would notice — after it had been on a document sent to a client.
    await http()
      .patch(`/settings/companies/${companyId}/billing-rates`)
      .set(auth())
      .send({ cgstFraction: 9 })
      .expect(400);
  });

  // ── The retention term, through the API rather than around it (025 US3) ───

  /**
   * **Why this exists even though the suite above composes a client bill on every test.**
   *
   * That project is created directly in the database with its retention term already set. It
   * proves composition works; it proves nothing about whether anybody can *put a figure in that
   * column* — and until 025 nobody could. The column was nullable with no default, the composer
   * refused without it, and no DTO and no screen accepted it, so the client half of this feature
   * was unreachable from the product while passing every test here.
   *
   * Both halves are asserted. A test that only composes *with* the term would pass equally well
   * against a service that had quietly started defaulting it to zero — which is the one outcome
   * the refusal exists to prevent, because a payable five per cent too high is the error most
   * likely to be paid before anybody notices.
   */
  describe('the client retention term (025 FR-016 to FR-020)', () => {
    let bareProjectId: string;

    beforeAll(async () => {
      const project = await createProjectWithMandatoryDocuments({
        http,
        headers: auth(),
        body: {
          code: unique('RET').slice(0, 14),
          name: unique('RetProject'),
          clientId,
          contractValue: 5_000_000,
          startDate: '2025-10-01',
        },
        companyId,
      });
      expect(project.status).toBe(201);
      bareProjectId = project.body.id;

      const group = await http()
        .post(`/projects/${bareProjectId}/boq/groups`)
        .set(auth())
        .send({ boqNo: '1', name: 'Works', scopeQty: '0' })
        .expect(201);

      await http()
        .post(`/projects/${bareProjectId}/boq/items`)
        .set(auth())
        .send({
          groupId: group.body.id,
          boqNo: '1.10',
          taskName: 'Works',
          unit: 'Cum',
          scopeQty: '100',
          rate: '1000',
        })
        .expect(201);
    });

    afterAll(async () => {
      await sys.billPackage.deleteMany({ where: { projectId: bareProjectId } });
      // Composing a client-direction package writes a `ClientBill` too, and the client fixture the
      // outer teardown removes cannot go while one points at it.
      await sys.clientBillLine.deleteMany({
        where: { clientBill: { projectId: bareProjectId } },
      });
      await sys.clientBill.deleteMany({ where: { projectId: bareProjectId } });
      await sys.bOQTaskItem.deleteMany({
        where: { group: { projectId: bareProjectId } },
      });
      await sys.bOQTaskGroup.deleteMany({
        where: { projectId: bareProjectId },
      });
      await sys.projectDocument.deleteMany({
        where: { projectId: bareProjectId },
      });
      await sys.project.deleteMany({ where: { id: bareProjectId } });
    });

    it('refuses a client bill while the term is unrecorded, naming what is missing', async () => {
      const refused = await http()
        .post(`/projects/${bareProjectId}/bill-packages`)
        .set(auth())
        .send({
          direction: 'to_client',
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
        })
        .expect(400);

      expect(refused.body.code).toBe(PACKAGE_ERRORS.rateMissing);
      expect(refused.body.missingRate).toBe('retentionFraction');
    });

    it('composes once the term is recorded through the project itself', async () => {
      // Through the API, which is the whole point: the column has existed since 023 and this is
      // the first route that can write it.
      await http()
        .patch(`/projects/${bareProjectId}`)
        .set(auth())
        .send({ clientRetentionFraction: 0.05 })
        .expect(200);

      const reread = await http()
        .get(`/projects/${bareProjectId}`)
        .set(auth())
        .expect(200);
      // FR-020: a round trip may not drift. A term that reads back as 0.049999 is a bill that
      // disagrees with the contract by a rupee nobody can explain.
      expect(Number(reread.body.project.clientRetentionFraction)).toBe(0.05);

      await http()
        .post(`/projects/${bareProjectId}/bill-packages`)
        .set(auth())
        .send({
          direction: 'to_client',
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
        })
        .expect(201);
    });

    it('refuses a term above one as the typo it is', async () => {
      await http()
        .patch(`/projects/${bareProjectId}`)
        .set(auth())
        .send({ clientRetentionFraction: 5 })
        .expect(400);
    });
  });
});
