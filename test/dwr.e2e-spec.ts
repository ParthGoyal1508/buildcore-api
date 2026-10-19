import { INestApplication } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';

import { ACTION_DWR } from '../src/approvals/default-chains';
import { ensureApprovalChain } from './fixtures/ensure-approval-chain';
import * as ExcelJS from 'exceljs';
import * as request from 'supertest';
import type { Sharp, SharpOptions } from 'sharp';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * Daily work reports, end to end against a real database (022 Phase G, quickstart passes 1–8).
 *
 * ## What only a real database can show here
 *
 * Almost everything in this feature is a transaction, and a mocked Prisma client would report each
 * of these behaviours working while the database did something else. Specifically:
 *
 * - **the `DWRTask_quantity_matches_basis` CHECK**, which no unit test can exercise;
 * - **the conditional status transitions** that make approval at-most-once — their whole content is
 *   `updateMany ... where status = X` returning a row count, which a mock would simply agree with;
 * - **the relative increment**, which has to be evaluated by Postgres against the row as it stands
 *   for two concurrent approvals of different reports to both land;
 * - **the grouped aggregate** behind the period figures, whose correctness is a `CASE` over a
 *   column chosen per row;
 * - and **the 008 US5 acceptance test that has never been runnable at all** — submit moves nothing,
 *   approve moves it once — because until this feature there was no endpoint to call.
 *
 * Every fixture is prefixed `E2E` and removed in `afterAll`.
 */
// The type is named on its own line so the statement below stays one line long: the lint
// script runs Prettier, which would otherwise wrap it and push `require` out from under the
// disable comment — the CI failure of 2026-10-18.
type SharpFn = (input?: Buffer, options?: SharpOptions) => Sharp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: SharpFn = require('sharp');

const stamp = `${Date.now() % 100000}`;
const unique = (s: string) => `E2E${s}${stamp}`;

/** Yesterday, so no assertion depends on a report being filed before midnight. */
function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('Daily work reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let token: string;
  let companyId: string;
  let projectId: string;
  let clientId: string;
  let groupId: string;
  let finalSlotMapped = false;
  let itemA: string;
  let itemB: string;
  let itemUnmeasured: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

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

  /** A BOQ line's stored executed quantity, read behind the API. */
  const doneQty = async (itemId: string): Promise<string> => {
    const row = await sys.bOQTaskItem.findUnique({
      where: { id: itemId },
      select: { doneQty: true },
    });
    return row.doneQty.toFixed(3);
  };

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

    // The `dwr` chain, because as of 2026-10-10 a report is submitted to the spine and `submit`
    // refuses with `APPROVAL_CHAIN_NOT_CONFIGURED` where none exists. Kept afterwards rather than
    // torn down — see the helper for why.
    await ensureApprovalChain(sys, companyId, ACTION_DWR);

    // The chain's one level sits on `final`, so a decision is admitted only from whoever holds the
    // role that slot maps to. The seeded companies map it to Super Admin, which this suite's caller
    // is — read rather than overwritten, for the reason `ra-bills.e2e-spec.ts` records: replacing a
    // real mapping would leave the company's chains pointing at a role this suite then deleted.
    finalSlotMapped = Boolean(
      await sys.roleSlotMapping.findUnique({
        where: { companyId_slotKey: { companyId, slotKey: 'final' } },
      }),
    );

    const client = await http()
      .post(`/projects/clients?companyId=${companyId}`)
      .set(auth())
      .send({ name: unique('Client') })
      .expect(201);
    clientId = client.body.id;

    const project = await createProjectWithMandatoryDocuments({
      http,
      headers: auth(),
      body: {
        code: unique('P').slice(0, 14),
        name: unique('Project'),
        clientId,
        contractValue: 10_000_000,
        startDate: '2025-01-01',
      },
      companyId,
    });
    expect(project.status).toBe(201);
    projectId = project.body.id;

    const group = await http()
      .post(`/projects/${projectId}/boq/groups?companyId=${companyId}`)
      .set(auth())
      // Decimals cross the wire as **strings**, as everywhere else in this API — `@IsNumberString`
      // on the DTO, because a quantity routed through a JavaScript float is a quantity that has
      // already lost precision before the server sees it.
      .send({ boqNo: '30', name: 'Routine maintenance', scopeQty: '0' })
      .expect(201);
    groupId = group.body.id;

    const item = async (boqNo: string, unit: string, scopeQty: string) => {
      const res = await http()
        .post(`/projects/${projectId}/boq/items?companyId=${companyId}`)
        .set(auth())
        .send({
          groupId,
          boqNo,
          taskName: `Line ${boqNo}`,
          unit,
          scopeQty,
          rate: '1000',
        })
        .expect(201);
      return res.body.id;
    };

    itemA = await item('30.10', 'MON', '12');
    itemB = await item('30.20', 'CUM', '1000');
    // Measured by nobody, on purpose: FR-037's zero row.
    itemUnmeasured = await item('30.30', 'NO', '500');
  });

  /**
   * The report reaches the Director's queue (2026-10-10).
   *
   * Reported from a client environment: a submitted report showed Approve and Return on the
   * project's own Daily work tab and appeared in neither the Approvals tab nor the notification
   * count. It was not a glitch — `src/projects/dwr/` held no call to `approvals.submit` at all,
   * so no instance existed for either to read. 022's decision D2 had kept the report off the
   * spine deliberately; the client reversed it.
   *
   * The assertion that matters is the **quantity**, not the queue row: a report that appears in
   * the list and approves into no effect is the failure this whole module is built to prevent.
   */
  describe('a submitted report reaches the approvals queue', () => {
    it('queues it, and a decision there moves the executed quantity', async () => {
      if (!finalSlotMapped) {
        // Stated rather than silently skipped. An unmapped `final` slot is the one configuration
        // that makes every chain approval impossible, and a suite that quietly passed over it
        // would hide exactly the gap this feature exposed in the client's own environment.
        throw new Error(
          'The `final` slot is unmapped in this company, so no chain decision can be taken. ' +
            'Map it to the caller’s role before running this suite.',
        );
      }

      const before = await doneQty(itemB);

      const created = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemB,
          servedQty: '0.250',
          remark: 'Quarter day — plant down from midday',
        },
      ]);
      expect(created.status).toBe(201);
      const id = created.body.id;

      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      // Submission alone still moves nothing — the property 022 established, unchanged by
      // routing the report through the spine.
      expect(await doneQty(itemB)).toBe(before);

      const queue = await http()
        .get('/approvals/queue')
        .set(auth())
        .expect(200);
      const row = queue.body.items.find(
        (item: { entityType: string; entityId: string }) =>
          item.entityType === ACTION_DWR && item.entityId === id,
      );
      // **Found by its own id**, not by the list being non-empty: this company has other
      // subjects on the same spine, and "the queue has something in it" was true before.
      expect(row).toBeDefined();
      expect(row.subject).toContain(created.body.dprNumber);

      await http()
        .post(`/approvals/${row.instanceId}/decide`)
        .set(auth())
        .send({ action: 'approve' })
        .expect(201);

      // The whole point: deciding in the queue approved the report and moved the BOQ line.
      const detail = await http()
        .get(`/projects/dwr/${id}`)
        .set(auth())
        .expect(200);
      expect(detail.body.status).toBe('approved');
      expect(await doneQty(itemB)).toBe((Number(before) + 0.25).toFixed(3));
    });
  });

  afterAll(async () => {
    // The spine first: a decision points at an instance and an instance at this company.
    await sys.approvalDecision
      .deleteMany({
        where: { approvalInstance: { entityType: ACTION_DWR, companyId } },
      })
      .catch(() => undefined);
    await sys.approvalInstance
      .deleteMany({ where: { entityType: ACTION_DWR, companyId } })
      .catch(() => undefined);
    await sys.dailyWorkReport.deleteMany({ where: { projectId } });
    await sys.bOQTaskItem.deleteMany({ where: { groupId } });
    await sys.bOQTaskGroup.deleteMany({ where: { id: groupId } });
    await sys.project.deleteMany({ where: { id: projectId } });
    await sys.client.deleteMany({ where: { id: clientId } });
    // `app.close()` alone does not disconnect Prisma — `nestjs-prisma`'s service implements only
    // `OnModuleInit`, which is why `PrismaShutdownService` exists and why
    // `e2e-teardown.spec.ts` scans for both of these.
    await app.close();
  });

  /** Creates a report and returns the body. */
  async function createReport(
    lines: Record<string, unknown>[],
    over: Record<string, unknown> = {},
  ) {
    const res = await http()
      .post(`/projects/${projectId}/dwr?companyId=${companyId}`)
      .set(auth())
      .send({ workDate: yesterday(), workerCount: 14, lines, ...over });
    return res;
  }

  /**
   * A photograph belongs to a line, not to a pile (2026-10-11).
   *
   * Attachments were per report. Twenty files under one report is not evidence for the
   * chainage somebody is arguing about; the photo has to say which line it is of.
   */
  describe('a photograph can be filed against one measurement line', () => {
    /** Eight bytes of real PNG, so `detectContentType` sniffs the type from the file. */
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const photo = (name: string, taskId?: string) => ({
      data: PNG.toString('base64'),
      fileName: name,
      ...(taskId ? { taskId } : {}),
    });

    let dwrId = '';
    let firstLineId = '';

    beforeAll(async () => {
      const report = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          nos1: '1',
          length: '10',
          breadth: '2',
          depth: '0.1',
          chainageFrom: '228.2',
          chainageTo: '228.4',
        },
        { paymentMode: 'day_basis', boqItemId: itemB, servedQty: '1' },
      ]);
      expect(report.status).toBe(201);
      dwrId = report.body.id;
      // Line ids come from the detail view: the create response carries the report.
      const view = await http()
        .get(`/projects/dwr/${dwrId}`)
        .set(auth())
        .expect(200);
      firstLineId = view.body.lines[0].id;
    });

    it('files it against the line and says so on the report', async () => {
      const added = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(photo('CH 228+200 RHS — before.png', firstLineId))
        .expect(201);

      expect(added.body.taskId).toBe(firstLineId);
      // Sniffed from the bytes, not taken from the extension.
      expect(added.body.mimeType).toBe('image/png');

      const view = await http()
        .get(`/projects/dwr/${dwrId}`)
        .set(auth())
        .expect(200);
      const filed = view.body.attachments.find(
        (a: { id: string }) => a.id === added.body.id,
      );
      // The binding read back through the report, not merely echoed by the POST that
      // set it — an echo would pass against a column that was never written.
      expect(filed.taskId).toBe(firstLineId);
    });

    it('still takes a file for the report as a whole', async () => {
      // The report-level case is not a fallback: a general site view or a signed
      // measurement sheet belongs to no single line, and every file filed before today
      // is one of these.
      const added = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(photo('General view.png'))
        .expect(201);

      expect(added.body.taskId).toBeNull();
    });

    it('refuses a line that belongs to another report', async () => {
      // The foreign key only says the line exists. Without the report in the predicate
      // a photograph could be filed against somebody else's measurement.
      const other = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemB, servedQty: '1' },
      ]);
      expect(other.status).toBe(201);
      const otherView = await http()
        .get(`/projects/dwr/${other.body.id}`)
        .set(auth())
        .expect(200);

      await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(photo('Wrong report.png', otherView.body.lines[0].id))
        .expect(404);
    });
  });

  /**
   * Correcting a day must not destroy the evidence for it (2026-10-12).
   *
   * An edit replaced every line: `deleteMany` then `createMany`. `DWRAttachment.taskId` cascades
   * from the line it is filed against, so fixing a typo in a chainage deleted the photograph that
   * proved the chainage — silently, from the database, with the only other copy on a phone at
   * site. The entry form now offers a file box on every measurement, which would have made that a
   * trap rather than a corner case.
   */
  describe('correcting a draft keeps each line and its evidence', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    /** Two measured lines, told apart by their chainage rather than by position. */
    const twoLines = () => [
      {
        paymentMode: 'work_basis',
        boqItemId: itemB,
        nos1: '1',
        length: '10',
        breadth: '2',
        depth: '0.1',
        chainageFrom: '21.300',
        chainageTo: '21.450',
      },
      {
        paymentMode: 'work_basis',
        boqItemId: itemB,
        nos1: '1',
        length: '8',
        breadth: '2',
        depth: '0.1',
        chainageFrom: '22.100',
        chainageTo: '22.250',
      },
    ];

    const lineAt = (view: request.Response, from: string) =>
      view.body.lines.find(
        (l: { chainageFrom: string | null }) =>
          l.chainageFrom !== null && Number(l.chainageFrom) === Number(from),
      );

    it('answers a creation with one line id per line, in the order they were sent', async () => {
      const report = await createReport(twoLines());
      expect(report.status).toBe(201);

      const view = await http()
        .get(`/projects/dwr/${report.body.id}`)
        .set(auth())
        .expect(200);

      // **Which id is which, not how many there are.** A length assertion passes for two ids in
      // either order, and the form attaches the photograph picked beside the second measurement
      // to `lineIds[1]` — so an answer in the wrong order files it against the wrong chainage,
      // which is the whole defect this is here to stop.
      expect(report.body.lineIds).toEqual([
        lineAt(view, '21.300').id,
        lineAt(view, '22.100').id,
      ]);
    });

    it('keeps a photograph against the line whose chainage was corrected', async () => {
      const report = await createReport(twoLines());
      expect(report.status).toBe(201);
      const [firstLine, secondLine] = report.body.lineIds as string[];

      const photo = await http()
        .post(
          `/projects/dwr/${report.body.id}/attachments?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          data: PNG.toString('base64'),
          fileName: 'CH 22+100 — pour.png',
          taskId: secondLine,
        })
        .expect(201);

      // The correction: the second measurement started 50 m earlier than it was typed. Both lines
      // are sent back by id, which is what says "edited", not "replaced".
      const edited = await http()
        .patch(`/projects/dwr/${report.body.id}?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            { ...twoLines()[0], id: firstLine },
            { ...twoLines()[1], id: secondLine, chainageFrom: '22.050' },
          ],
        })
        .expect(200);
      expect(edited.body.lineIds).toEqual([firstLine, secondLine]);

      const view = await http()
        .get(`/projects/dwr/${report.body.id}`)
        .set(auth())
        .expect(200);

      // **Not that the attachment row survived.** It would survive being re-pointed at the first
      // measurement, or at no line at all, and either of those is a photograph arguing for a
      // quantity it is not evidence of. So: still on the report, and still filed against the line
      // that now carries the corrected chainage.
      const filed = view.body.attachments.find(
        (a: { id: string }) => a.id === photo.body.id,
      );
      expect(filed).toBeDefined();
      expect(filed.taskId).toBe(lineAt(view, '22.050').id);
      expect(lineAt(view, '22.100')).toBeUndefined();
    });

    it('removes a line left out of the edit, and its evidence with it', async () => {
      const report = await createReport(twoLines());
      expect(report.status).toBe(201);
      const [firstLine, secondLine] = report.body.lineIds as string[];

      await http()
        .post(
          `/projects/dwr/${report.body.id}/attachments?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          data: PNG.toString('base64'),
          fileName: 'Deleted measurement.png',
          taskId: secondLine,
        })
        .expect(201);

      // The second measurement was never done. Dropping it is a deletion, and the photograph of it
      // goes too — otherwise the diff would be a rule that never removes anything, which would
      // pass the test above for the wrong reason.
      await http()
        .patch(`/projects/dwr/${report.body.id}?companyId=${companyId}`)
        .set(auth())
        .send({ lines: [{ ...twoLines()[0], id: firstLine }] })
        .expect(200);

      const view = await http()
        .get(`/projects/dwr/${report.body.id}`)
        .set(auth())
        .expect(200);
      expect(view.body.lines).toHaveLength(1);
      expect(view.body.attachments).toHaveLength(0);
    });

    it('refuses a line id belonging to another report', async () => {
      const mine = await createReport(twoLines());
      const theirs = await createReport(twoLines());
      expect(theirs.status).toBe(201);

      // Accepting it would move another day's measurement — and its photographs — onto this one.
      await http()
        .patch(`/projects/dwr/${mine.body.id}?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            { ...twoLines()[0], id: (theirs.body.lineIds as string[])[0] },
          ],
        })
        .expect(404);
    });
  });

  /**
   * The printable form carries the photographs filed against each line (2026-10-12).
   *
   * ## Vacuity note
   *
   * _Asserting the download returned bytes proves a response, not a document._ It did before —
   * the form has been downloadable since 028 and carried no evidence at all. And the unit test
   * on the renderer proves only that a buffer handed to it is embedded; it cannot show that the
   * stored file was found, decoded and scaled, which is the half of this that runs through object
   * storage and libvips. So this opens the workbook the endpoint actually produced.
   */
  describe('the downloaded form carries a line’s photograph', () => {
    /** A real 1×1 PNG — sharp has to be able to decode it, which the 8-byte signature is not. */
    const REAL_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    it('embeds it, under a caption naming the measurement it is evidence for', async () => {
      const report = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '10',
          breadth: '2',
          depth: '0.1',
          chainageFrom: '71.200',
          chainageTo: '71.450',
        },
      ]);
      expect(report.status).toBe(201);
      const dwrId = report.body.id;

      await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send({
          data: REAL_PNG.toString('base64'),
          fileName: 'CH 71+200 pour.png',
          taskId: (report.body.lineIds as string[])[0],
        })
        .expect(201);

      const download = await http()
        .get(`/projects/dwr/${dwrId}/report.xlsx?companyId=${companyId}`)
        .set(auth())
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(download.body as ArrayBuffer);
      const sheet = workbook.worksheets[0];

      // The picture is in the file — read back out of the workbook the client would open.
      expect(sheet.getImages()).toHaveLength(1);

      // And it says which measurement it belongs to, in the client's own chainage notation.
      let caption = '';
      sheet.eachRow((row) => {
        const text = String(row.getCell(1).value ?? '');
        if (text.startsWith('Sr. No. 1 ·')) caption = text;
      });
      expect(caption).toContain('71+200 – 71+450');

      // The file name too, so a reader can find the original.
      let named = false;
      sheet.eachRow((row) => {
        if (String(row.getCell(1).value ?? '') === 'CH 71+200 pour.png') {
          named = true;
        }
      });
      expect(named).toBe(true);
    });
  });

  /**
   * An approved report is a certified record (2026-10-12).
   *
   * Approval moved its quantities onto the BOQ and a bill may rest on them, so evidence filed
   * afterwards would be evidence the approver never saw attached to a figure they already signed
   * off. The screen hides the control; this is why hiding it is not the whole answer.
   */
  describe('an approved report takes no further evidence', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('refuses the upload through the endpoint, not merely on the screen', async () => {
      const report = await createReport([
        { paymentMode: 'work_basis', boqItemId: itemB, length: '4' },
      ]);
      expect(report.status).toBe(201);
      const dwrId = report.body.id;
      const lineId = (report.body.lineIds as string[])[0];

      const file = {
        data: PNG.toString('base64'),
        fileName: 'Late evidence.png',
        taskId: lineId,
      };

      // **Accepted before, refused after.** The refusal alone would pass for an endpoint that
      // refuses everything, which is the vacuity this repository keeps writing tests against.
      await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(file)
        .expect(201);

      await http()
        .post(`/projects/dwr/${dwrId}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      // This suite's account holds `CROSS_COMPANY_ACCESS`, so 025 FR-040 lets it approve what it
      // submitted — see the self-approval tests below, which is where that rule is asserted.
      await http()
        .post(`/projects/dwr/${dwrId}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const refused = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send({ ...file, fileName: 'Later still.png' })
        .expect(409);
      expect(refused.body.code).toBe('DWR_APPROVED_TAKES_NO_EVIDENCE');
      // The message names the way through, because a refusal nobody can act on is a dead end.
      expect(refused.body.message).toMatch(/reverse/i);

      // And what was filed before approval is untouched — this seals the report, it does not
      // discard its evidence.
      const view = await http()
        .get(`/projects/dwr/${dwrId}`)
        .set(auth())
        .expect(200);
      expect(
        view.body.attachments.map((a: { fileName: string }) => a.fileName),
      ).toEqual(['Late evidence.png']);
    });
  });

  /**
   * 036 B6/I8/I9: photos are compressed with a thumbnail, and a wrong file can be taken back while
   * the report is still a draft.
   */
  describe('photos are compressed, and a draft’s file can be removed (036)', () => {
    it('stores a large photo at ≤ 2048 px with a thumbnail, and serves both', async () => {
      // A 3000 × 2000 noisy JPEG: large enough to be resized, noisy enough not to compress to
      // nothing at the source.
      const raw = Buffer.alloc(3000 * 2000 * 3);
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
      const big = await sharp(raw, { raw: { width: 3000, height: 2000, channels: 3 } })
        .jpeg({ quality: 95 })
        .toBuffer();

      const report = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemB, servedQty: '1' },
      ]);
      expect(report.status).toBe(201);
      const dwrId = report.body.id;

      const added = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send({ data: big.toString('base64'), fileName: 'Site view.jpg' })
        .expect(201);
      expect(added.body.hasThumbnail).toBe(true);
      expect(added.body.sizeBytes).toBeLessThan(big.length);

      const full = await http()
        .get(`/projects/dwr/attachments/${added.body.id}`)
        .set(auth())
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const fullMeta = await sharp(full.body as Buffer).metadata();
      expect(Math.max(fullMeta.width ?? 0, fullMeta.height ?? 0)).toBeLessThanOrEqual(2048);

      const thumb = await http()
        .get(`/projects/dwr/attachments/${added.body.id}/thumbnail`)
        .set(auth())
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const thumbMeta = await sharp(thumb.body as Buffer).metadata();
      expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(320);

      const view = await http().get(`/projects/dwr/${dwrId}`).set(auth()).expect(200);
      const filed = view.body.attachments.find((a: { id: string }) => a.id === added.body.id);
      expect(filed.hasThumbnail).toBe(true);
      // The storage reference never leaves the service.
      expect(filed.thumbnailRef).toBeUndefined();
    });

    it('removes a draft’s file, audited, and refuses once submitted', async () => {
      const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const report = await createReport([
        { paymentMode: 'work_basis', boqItemId: itemB, length: '2' },
      ]);
      expect(report.status).toBe(201);
      const dwrId = report.body.id;
      const file = (name: string) => ({ data: PNG.toString('base64'), fileName: name });

      const wrong = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(file('Wrong site.png'))
        .expect(201);
      const kept = await http()
        .post(`/projects/dwr/${dwrId}/attachments?companyId=${companyId}`)
        .set(auth())
        .send(file('Right site.png'))
        .expect(201);

      await http()
        .delete(`/projects/dwr/${dwrId}/attachments/${wrong.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      // An id from another report does not resolve under this one.
      await http()
        .delete(`/projects/dwr/${dwrId}/attachments/${wrong.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(404);

      const view = await http().get(`/projects/dwr/${dwrId}`).set(auth()).expect(200);
      expect(view.body.attachments.map((a: { id: string }) => a.id)).toEqual([kept.body.id]);

      const entry = await sys.auditLogEntry.findFirst({
        where: { entityType: 'DWR', entityId: dwrId, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry.changes.attachmentRemoved.fileName).toBe('Wrong site.png');

      await http()
        .post(`/projects/dwr/${dwrId}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      const refused = await http()
        .delete(`/projects/dwr/${dwrId}/attachments/${kept.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(409);
      expect(refused.body.code).toBe('DWR_WRONG_STATUS');
    });
  });

  // ── Pass 1 — the measured quantity, computed by the server ────────────────

  describe('Pass 1 — a measured day', () => {
    it('computes the quantity from the six factors', async () => {
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          nos1: '2',
          length: '12.5',
          breadth: '3.75',
          depth: '0.15',
        },
      ]);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.dprNumber).toContain('-DPR-');

      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      // 2 × 1 × 12.5 × 3.75 × 0.15 × 1
      expect(detail.body.lines[0].quantityInForce).toBe('14.063');
    });

    it('refuses a caller-supplied quantity outright rather than ignoring it', async () => {
      // Stronger than the guarantee this test was first written to assert. `configure-app` sets
      // `whitelist` **and** `forbidNonWhitelisted`, so a field the DTO does not declare is a 400
      // rather than a silently discarded value. Worth asserting rather than assuming: "the server
      // computes the quantity" and "the server refuses to be told the quantity" are different
      // promises, and only the second cannot be weakened by a later DTO gaining the field.
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '2',
          actualQty: '999',
        },
      ]);
      expect(res.status).toBe(400);
    });

    it('refuses a factor of 0 by name', async () => {
      const res = await createReport([
        { paymentMode: 'work_basis', boqItemId: itemB, nos1: '2', depth: '0' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('depth');
    });

    it('treats an omitted factor as 1 rather than 0', async () => {
      const res = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '4',
          breadth: '5',
        },
      ]);
      expect(res.status).toBe(201);
      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines[0].quantityInForce).toBe('20.000');
    });
  });

  // ── Pass 2 — the 008 US5 acceptance test, finally runnable ────────────────

  describe('Pass 2 — submission is a claim, approval is a fact', () => {
    it('moves no executed quantity on submission, and exactly once on approval', async () => {
      const before = await doneQty(itemA);

      const created = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '0.700',
          remark: '30% deduction — shoulder slope and staff not available',
        },
      ]);
      expect(created.status).toBe(201);
      const id = created.body.id;

      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      // **The assertion 008 wrote in August and nothing has ever been able to run.**
      expect(await doneQty(itemA)).toBe(before);

      // The seeded administrator submitted it **and** holds `CROSS_COMPANY_ACCESS`, so 025 FR-040
      // lets them approve it. This assertion read 403 until 2026-10-05; the override is what
      // changed it, and the rule it overrides is asserted in its own test below — against a caller
      // who does not hold that permission, which is the only way to test a rule whose exception
      // this suite's own account qualifies for.
      const approved = await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      expect(approved.body.status).toBe('approved');
      // Reported, not silent: the caller approved what they submitted, and the response says so.
      expect(approved.body.selfApproved).toBe(true);

      const after = await doneQty(itemA);
      expect(after).toBe('0.700');
      expect(after).not.toBe(before);

      // Approving twice must not bill twice.
      const again = await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth());
      expect(again.status).toBe(409);
      expect(await doneQty(itemA)).toBe(after);
    });

    it('refuses to approve a report that was never submitted', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const res = await http()
        .post(`/projects/dwr/${created.body.id}/approve?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('draft');
    });

    it('refuses to submit a report carrying no lines', async () => {
      const created = await createReport([]);
      expect(created.status).toBe(201);
      const res = await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(400);
    });
  });

  // ── Pass 3 — reversal ─────────────────────────────────────────────────────

  /**
   * Segregation of duty, and the permission that overrides it (022 FR-012a, 025 FR-040).
   *
   * **This test exists because the suite's own account qualifies for the exception.** Every other
   * test here logs in as the seeded administrator, who holds `CROSS_COMPANY_ACCESS` and may
   * therefore approve what they submitted — so the rule itself cannot be observed from that
   * account at all, and asserting it needs a caller who does not hold the permission.
   *
   * Without this, FR-012a would be a rule with no test that still *reads* as tested, because the
   * happy path next door would keep passing whether or not the refusal existed.
   */
  describe('the approver is not the author, unless they may be', () => {
    it('refuses a self-approval by a caller without the override', async () => {
      const email = `${unique('Eng')}@example.test`.toLowerCase();
      const user = await sys.user.create({
        data: {
          email,
          username: unique('Eng'),
          password: await hash('secret42'),
          displayName: unique('Eng'),
          companyId,
          status: 'active',
        },
      });
      // DWR and nothing else: enough to record, submit and attempt an approval, without the
      // cross-company permission that 025 FR-040 keys the override to.
      const role = await sys.role.create({
        data: { name: unique('EngRole'), permissions: [Permission.DWR] },
      });
      await sys.userRole.create({
        data: { userId: user.id, roleId: role.id, companyId },
      });

      try {
        const login = await http()
          .post('/auth/login')
          .send({ identifier: email, password: 'secret42', rememberMe: false })
          .expect(201);
        const engineer = { Authorization: `Bearer ${login.body.accessToken}` };

        const created = await http()
          .post(`/projects/${projectId}/dwr?companyId=${companyId}`)
          .set(engineer)
          .send({
            workDate: yesterday(),
            lines: [
              { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
            ],
          })
          .expect(201);

        await http()
          .post(
            `/projects/dwr/${created.body.id}/submit?companyId=${companyId}`,
          )
          .set(engineer)
          .expect(201);

        const before = await doneQty(itemA);

        const refused = await http()
          .post(
            `/projects/dwr/${created.body.id}/approve?companyId=${companyId}`,
          )
          .set(engineer);

        expect(refused.status).toBe(403);
        expect(refused.body.message).toContain('somebody else');
        // The counter did not move, which is the half that matters: a refusal that still applied
        // the increments would be worse than no refusal at all.
        expect(await doneQty(itemA)).toBe(before);

        // And the override does work on the same report, from an account that holds it — so this
        // test fails if the permission check is inverted, not only if it is missing.
        const approved = await http()
          .post(
            `/projects/dwr/${created.body.id}/approve?companyId=${companyId}`,
          )
          .set(auth())
          .expect(201);
        // Approved by somebody who did not submit it: an ordinary approval, not an override.
        expect(approved.body.selfApproved).toBe(false);
      } finally {
        await sys.refreshToken.deleteMany({ where: { accountId: user.id } });
        await sys.userRole.deleteMany({ where: { userId: user.id } });
        await sys.role.deleteMany({ where: { id: role.id } });
        await sys.user.deleteMany({ where: { id: user.id } });
      }
    });
  });

  describe('Pass 3 — reversal returns the counter exactly', () => {
    it('takes back precisely what the approval added', async () => {
      const before = await doneQty(itemB);

      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '3',
          breadth: '4',
        },
      ]);
      const id = created.body.id;

      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });
      await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      expect(await doneQty(itemB)).not.toBe(before);

      // A reason is required, because a reversal moves a quantity a bill may depend on.
      const noReason = await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'oops' });
      expect(noReason.status).toBe(400);

      const reversed = await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'measured twice by both crews at CH 228+200' })
        .expect(201);

      expect(reversed.body.status).toBe('draft');
      expect(reversed.body.reversalCount).toBe(1);
      // Exactly, not approximately.
      expect(await doneQty(itemB)).toBe(before);

      const detail = await http()
        .get(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      // The approval still on the record — erasing it would leave a reversal reason referring to
      // an approval nobody can see.
      expect(detail.body.approvedAt).not.toBeNull();
      expect(detail.body.reversedAt).not.toBeNull();
      expect(detail.body.reversalReason).toContain('both crews');
    });

    it('refuses to edit an approved report, naming the reversal path', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });
      await http()
        .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const res = await http()
        .patch(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .send({ workerCount: 99 });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Reverse it first');

      // Tidy up so later passes start from a known counter.
      await http()
        .post(`/projects/dwr/${id}/reverse?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'fixture cleanup for the next assertion' })
        .expect(201);
    });

    it('refuses to delete anything but a draft', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const refused = await http()
        .delete(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth());
      expect(refused.status).toBe(409);

      await http()
        .post(`/projects/dwr/${id}/return?companyId=${companyId}`)
        .set(auth())
        .send({
          reason:
            'fixture — returned so the delete below has something to delete',
        })
        .expect(201);
      await http()
        .delete(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
    });

    /**
     * 028. A return has to be visible to the person it was returned to.
     *
     * **The vacuity this avoids: asserting that the return returned 201.** It did before this
     * change — and wrote `draft`, so the author's report came back indistinguishable from one
     * nobody had ever submitted, with the reviewer's reason discarded by a route that took no
     * body. Both assertions here read the **detail response the screen renders**: the status it
     * puts in the badge, and the sentence it has to print for the author to know what to fix.
     */
    it('comes back as returned, carrying the reason the reviewer typed', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      await http()
        .post(`/projects/dwr/${id}/return?companyId=${companyId}`)
        .set(auth())
        .send({
          reason: 'CH 21+300 is measured 5.8 x 1.8 — the sheet says 5.8 x 1.6',
        })
        .expect(201);

      const detail = await http()
        .get(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);

      // Not `draft`. This is the whole defect: the two statuses mean different things to the
      // person looking at the list, and one value was being used for both.
      expect(detail.body.status).toBe('returned');
      expect(detail.body.returnReason).toContain('5.8 x 1.6');
      expect(detail.body.returnedByName).toBeTruthy();
      expect(detail.body.returnedAt).toBeTruthy();
    });

    /** A reason short enough to tell the author nothing is refused, as a reversal's is. */
    it('refuses a return with no usable reason', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      await http()
        .post(`/projects/dwr/${id}/return?companyId=${companyId}`)
        .set(auth())
        .send({ reason: 'no' })
        .expect(400);
    });

    /**
     * The corrected report must have a way forward.
     *
     * A new status is an easy way to strand work: `submit` asserted `draft` exactly, so had the
     * status changed without this, returning a report would have been the act that made it
     * permanently unsubmittable — the reviewer's own correction request as the thing that killed
     * it. Asserted through the endpoint, after an edit, because that is the author's actual path.
     */
    it('a returned report can be corrected and submitted again', async () => {
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await http()
        .post(`/projects/dwr/${id}/return?companyId=${companyId}`)
        .set(auth())
        .send({
          reason: 'the served day is 1 but the logbook shows a half day',
        })
        .expect(201);

      await http()
        .patch(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .send({
          lines: [
            {
              paymentMode: 'day_basis',
              boqItemId: itemA,
              servedQty: '0.5',
              remark: 'half day — corrected against the logbook as asked',
            },
          ],
        })
        .expect(200);

      const resubmitted = await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      expect(resubmitted.body.status).toBe('submitted');
    });
  });

  // ── Pass 4 — presence, and the number that would be right by coincidence ──

  describe('Pass 4 — presence-paid lines', () => {
    it('requires a remark for a short day', async () => {
      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '0.5' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('deduction');
    });

    it('accepts a zero day with a remark, distinguishably from no record', async () => {
      // FR-031. Many rows of the client's own measurement sheets read "-".
      const res = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '0',
          remark: 'crane on site, idle all day — no work released',
        },
      ]);
      expect(res.status).toBe(201);

      const detail = await http()
        .get(`/projects/dwr/${res.body.id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines).toHaveLength(1);
      expect(detail.body.lines[0].quantityInForce).toBe('0.000');
    });

    it('refuses measurement factors on a presence line rather than ignoring them', async () => {
      const res = await createReport([
        {
          paymentMode: 'day_basis',
          boqItemId: itemA,
          servedQty: '1',
          nos1: '7',
          length: '7',
        },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('nos1');
    });

    it('still yields the served quantity when the factors are set behind the API', async () => {
      // **Quickstart Pass 4 step 4, and the assertion most likely to rot.** All six factors
      // default to 1, so their product is 1 — identical to one day served. An implementation that
      // read them would be right for every row created through the API and wrong the instant a
      // factor moved. So they are set to 7 directly in the database, where the DTO cannot refuse
      // them, and the answer must not change. 7^6 = 117,649.
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      const id = created.body.id;

      await sys.dWRTask.updateMany({
        where: { dwrId: id },
        data: { nos1: 7, nos2: 7, length: 7, breadth: 7, depth: 7, density: 7 },
      });

      const detail = await http()
        .get(`/projects/dwr/${id}?companyId=${companyId}`)
        .set(auth())
        .expect(200);
      expect(detail.body.lines[0].quantityInForce).toBe('1.000');
    });

    it('is refused by the database when a line carries both quantities', async () => {
      // The CHECK constraint, which no unit test can reach. A service-level invariant is one
      // direct write away from being bypassed, and this is that write.
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      await expect(
        sys.dWRTask.updateMany({
          where: { dwrId: created.body.id },
          data: { actualQty: 5 },
        }),
      ).rejects.toThrow(/DWRTask_quantity_matches_basis/);
    });
  });

  // ── Pass 6 and 7 — the figures, and reconciliation ────────────────────────

  describe('Passes 6 and 7 — the figures feature 023 bills from', () => {
    it('returns every BOQ line, including the one nobody measured', async () => {
      const res = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);

      const boqNos = res.body.lines.map((l: { boqNo: string }) => l.boqNo);
      // **FR-037a asserted as a count, not as contents.** An assertion over a returned list passes
      // just as happily over a short one, and a bill missing an item is a smaller invoice.
      expect(res.body.lines).toHaveLength(3);
      expect(boqNos).toEqual(['30.10', '30.20', '30.30']);

      const unmeasured = res.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemUnmeasured,
      );
      expect(unmeasured.approvedInPeriod).toBe('0.000');
      expect(unmeasured.approvedUpToDate).toBe('0.000');
    });

    it('counts only approved reports, and attributes them by work date', async () => {
      const before = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);
      const lineBefore = before.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemB,
      );

      // A submitted report contributes nothing, however large.
      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '100',
          breadth: '100',
        },
      ]);
      await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const after = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2025-01-01&to=2030-01-01`,
        )
        .set(auth())
        .expect(200);
      const lineAfter = after.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemB,
      );

      expect(lineAfter.approvedUpToDate).toBe(lineBefore.approvedUpToDate);
    });

    /**
     * **A single day, which is the window the wide ones could never fail on** (025 FR-041).
     *
     * Found by asking a running server for one day's measurement and being told nothing had
     * happened. Every `DateTime` column here is `timestamp without time zone`; Prisma binds a JS
     * `Date` as `timestamptz`; and comparing the two makes Postgres convert the stored value using
     * the **session time zone**, which on the development database is `Asia/Kolkata`. A work date
     * stored as `2026-10-04 00:00:00` was therefore read as 18:30 on the 3rd, and a period
     * beginning on the 4th excluded it.
     *
     * The window did not lose an edge case — it **shifted by a day**. A bill for the 21st to the
     * 20th claimed the 22nd to the 21st.
     *
     * Every existing assertion in this file passed throughout, because they all query a range wide
     * enough that a one-day shift still contains the same reports. That is exactly the shape of
     * defect this repository keeps meeting: an assertion that holds for a reason unrelated to the
     * one it was written for.
     */
    it('counts a report on the first day of a one-day period', async () => {
      const day = yesterday();
      const created = await createReport(
        [
          {
            paymentMode: 'day_basis',
            boqItemId: itemUnmeasured,
            servedQty: '1',
          },
        ],
        { workDate: day },
      );
      await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await http()
        .post(`/projects/dwr/${created.body.id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);

      const figures = await http()
        .get(`/projects/${projectId}/dwr/period-figures?from=${day}&to=${day}`)
        .set(auth())
        .expect(200);

      const line = figures.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemUnmeasured,
      );
      // The period is the day the work happened. Both ends inclusive, both ends the same date.
      expect(line.approvedInPeriod).toBe('1.000');
    });

    it('refuses a period that ends before it begins', async () => {
      const res = await http()
        .get(
          `/projects/${projectId}/dwr/period-figures?from=2026-02-01&to=2026-01-01`,
        )
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('before it begins');
    });

    it('reconciles to zero, then reports a drift it did not create, then repairs it', async () => {
      const clean = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(clean.body.discrepancies).toBe(0);

      // Induce a drift the way a partial failure or a hand-edit would.
      await sys.bOQTaskItem.update({
        where: { id: itemA },
        data: { doneQty: { increment: 5 } },
      });

      const drifted = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(drifted.body.discrepancies).toBe(1);
      const line = drifted.body.lines.find(
        (l: { boqItemId: string }) => l.boqItemId === itemA,
      );
      expect(line.difference).toBe('5.000');

      // FR-039c: repair is explicit, needs a reason, and nothing happened on its own.
      const noReason = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({ boqItemIds: [itemA], reason: 'x' });
      expect(noReason.status).toBe(400);

      const repaired = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          boqItemIds: [itemA],
          reason: 'drift of 5.000 induced during verification',
        })
        .expect(201);
      expect(repaired.body.repaired[0].from).not.toBe(
        repaired.body.repaired[0].to,
      );

      const healed = await http()
        .get(`/projects/${projectId}/dwr/reconciliation`)
        .set(auth())
        .expect(200);
      expect(healed.body.discrepancies).toBe(0);

      // Refused the second time rather than succeeding quietly: a caller chasing a drift needs to
      // learn it is already gone.
      const again = await http()
        .post(
          `/projects/${projectId}/dwr/reconciliation/repair?companyId=${companyId}`,
        )
        .set(auth())
        .send({
          boqItemIds: [itemA],
          reason: 'checking the refusal when there is nothing to do',
        });
      expect(again.status).toBe(409);
    });
  });

  // ── Pass 8 — locks, permissions, tenancy ─────────────────────────────────

  describe('Pass 8 — locks and scope', () => {
    it('refuses a write to a locked project with 423, not 403', async () => {
      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: true },
      });

      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      // 423 and not 403: the same caller may write the moment it is unlocked, which is a different
      // statement from "you may not do this".
      expect(res.status).toBe(423);

      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: false },
      });
    });

    it('refuses an edit keyed by the report, not the project, on a locked project (036 I1)', async () => {
      // `PATCH /projects/dwr/:dwrId` carries no project in its path, and the guard used to
      // admit it for exactly that reason — so a locked project still took edits.
      const created = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      expect(created.status).toBe(201);
      const dwrId = created.body.id as string;

      await sys.project.update({
        where: { id: projectId },
        data: { isLocked: true },
      });
      try {
        const edit = await http()
          .patch(`/projects/dwr/${dwrId}?companyId=${companyId}`)
          .set(auth())
          .send({ workerCount: 15 });
        expect(edit.status).toBe(423);

        const removal = await http()
          .delete(`/projects/dwr/${dwrId}?companyId=${companyId}`)
          .set(auth());
        expect(removal.status).toBe(423);

        // An unknown report is still the handler's 404, not the guard's.
        const unknown = await http()
          .patch(
            `/projects/dwr/clnonexistent000000000000?companyId=${companyId}`,
          )
          .set(auth())
          .send({ workerCount: 15 });
        expect(unknown.status).toBe(404);
      } finally {
        await sys.project.update({
          where: { id: projectId },
          data: { isLocked: false },
        });
      }

      await http()
        .delete(`/projects/dwr/${dwrId}?companyId=${companyId}`)
        .set(auth())
        .expect((res) => expect([200, 204]).toContain(res.status));
    });

    it('reports an unknown report as 404 rather than 403', async () => {
      const res = await http()
        .get(`/projects/dwr/clnonexistent000000000000?companyId=${companyId}`)
        .set(auth());
      expect(res.status).toBe(404);
    });

    it('lists with a total that does not depend on the page size', async () => {
      const page = await http()
        .get(`/projects/dwr?projectId=${projectId}&pageSize=1`)
        .set(auth())
        .expect(200);

      expect(page.body.items).toHaveLength(1);
      expect(page.body.total).toBeGreaterThan(1);
      expect(page.body.pageSize).toBe(1);
    });
  });

  /**
   * Reported 2026-10-06: a project carrying both a tender workbook and an internal estimate listed
   * every BOQ line twice in the daily-work picker, the two indistinguishable — the same sentence,
   * the same unit, the same number.
   *
   * The picker was where it showed; this is where it mattered. A measurement filed against the
   * costing twin moves a `doneQty` no bill will ever draw on and that `getAlerts` deliberately
   * skips, so the day's work is accepted and then absent from progress. Recorded and lost is worse
   * than refused.
   */
  describe('the internal estimate is not measurable (027)', () => {
    let estimateGroupId = '';
    let estimateItemId = '';

    beforeAll(async () => {
      // Written directly: the only route to an estimate line is the estimate import, which needs a
      // workbook — and what is under test is the refusal, not the import.
      estimateGroupId = (
        await sys.bOQTaskGroup.create({
          data: {
            companyId,
            projectId,
            boqNo: '31',
            name: 'Routine maintenance — our own costing',
            scopeQty: '0',
            isEstimate: true,
          },
          select: { id: true },
        })
      ).id;
      estimateItemId = (
        await sys.bOQTaskItem.create({
          data: {
            companyId,
            groupId: estimateGroupId,
            boqNo: '31.10',
            taskName: 'Line 30.10 at our own cost rate',
            unit: 'MON',
            scopeQty: '12',
            rate: '640.00',
            isEstimate: true,
          },
          select: { id: true },
        })
      ).id;
    });

    afterAll(async () => {
      await sys.bOQTaskItem
        .deleteMany({ where: { groupId: estimateGroupId } })
        .catch(() => undefined);
      await sys.bOQTaskGroup
        .deleteMany({ where: { id: estimateGroupId } })
        .catch(() => undefined);
    });

    it('refuses the line and names the BOQ number, rather than recording work nothing reads', async () => {
      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: estimateItemId, servedQty: '1' },
      ]);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DWR_BOQ_ITEM_IS_ESTIMATE');
      // By number: the costing line and the contract line it twins read identically, so "one of
      // your lines is wrong" leaves somebody comparing two schedules row by row.
      expect(res.body.message).toContain('31.10');
    });

    it('still accepts the contract line that says the same thing', async () => {
      // The other half of the pair, and the one that stops the guard being "refuse everything".
      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);
      expect(res.status).toBe(201);
    });

    it('records nothing against the costing line', async () => {
      // The consequence, not the status code. A refusal that still wrote the row would pass the
      // test above.
      const row = await sys.bOQTaskItem.findUnique({
        where: { id: estimateItemId },
        select: { doneQty: true },
      });
      expect(Number(row?.doneQty)).toBe(0);
    });
  });

  // ── What this API promises a client, asserted on the wire (025 FR-008) ────

  /**
   * **Written because a client guessed this shape and the guess reached a user.**
   *
   * buildcore-web's daily-work module demanded `reportNumber`, `projectId` and `workDate` back from
   * a creation that sends none of them, and rendered an array of lines the list has never carried.
   * The server was right every time; the screen reported a successful save as a failure, which is
   * the worst available outcome — the day was recorded and believed lost.
   *
   * **Asserted as an exact key set, never as containment.** `expect(body).toHaveProperty(…)` passes
   * just as happily against a response carrying everything, which makes it worthless as a guard
   * against the field that quietly disappears. Equality fails on an addition too — deliberately:
   * adding a field to a published response is a contract change, and this test is where somebody is
   * reminded to move `contracts/dwr-api.md` in the same commit.
   *
   * What this cannot do is read any client. No automated check spans the two repositories; see
   * `specs/025-projects-flow-completion/research.md` section 3 for why, and for the condition that
   * should change the answer.
   */
  describe('the published shape (025 FR-008)', () => {
    it('answers a creation with exactly an id, a number, a status, the line ids and the warnings', async () => {
      const res = await createReport([
        { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
      ]);

      expect(res.status).toBe(201);
      // `lineIds` added 2026-10-12, with `contracts/dwr-api.md` moved in the same commit, which is
      // what this assertion exists to force. A file is attached to a line and an entry form has
      // files in hand before any line has an id; everything else here is unchanged.
      expect(Object.keys(res.body).sort()).toEqual([
        'dprNumber',
        'id',
        'lineIds',
        'status',
        'warnings',
      ]);
    });

    it('answers each list row with exactly the summary a page carries', async () => {
      const page = await http()
        .get(`/projects/dwr?projectId=${projectId}&pageSize=1`)
        .set(auth())
        .expect(200);

      expect(Object.keys(page.body).sort()).toEqual([
        'items',
        'page',
        'pageSize',
        'total',
      ]);

      // `lineCount` is a count and there is no lines array: the lines are on the detail read.
      // `createdByUserId` and `submittedByUserId` are carried so a caller can show 022 FR-012a
      // before the action rather than after it (025 FR-006).
      expect(Object.keys(page.body.items[0]).sort()).toEqual([
        'createdByUserId',
        'dprNumber',
        'id',
        'lineCount',
        'machineryCount',
        'progress',
        'status',
        'submittedByUserId',
        'workDate',
        'workerCount',
      ]);
    });

    /**
     * **The detail read, and the array it must not carry twice.**
     *
     * This response spread the raw rows, so it answered with `tasks` — the BOQ line nested under
     * `boqItem`, no flat `boqNo` — *beside* the documented `lines`. Two arrays of the same thing in
     * two shapes, one of them undocumented; the detail screen read the undocumented one and printed
     * `BOQ —` against every line in the product. Equality is what catches that: containment would
     * pass against a response carrying both.
     */
    it('answers the detail with exactly one lines array, and no tasks', async () => {
      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemA,
          nos1: '1',
          length: '30',
          breadth: '15',
          depth: '0.26',
        },
      ]);

      const res = await http()
        .get(`/projects/dwr/${created.body.id}`)
        .set(auth())
        .expect(200);

      expect(Object.keys(res.body)).not.toContain('tasks');
      expect(Object.keys(res.body.lines[0]).sort()).toEqual([
        'boqItemId',
        'boqNo',
        'breadth',
        'chainageFrom',
        'chainageTo',
        'density',
        'depth',
        'doneQty',
        'engineerName',
        'equipmentId',
        'exceedsScope',
        'id',
        'layer',
        'layerNo',
        'length',
        'logbook',
        'logbookMissing',
        'nos1',
        'nos2',
        'paymentMode',
        'pendingQty',
        'quantityInForce',
        'remark',
        'roadSide',
        'scopeQty',
        'section',
        'targetQty',
        'taskName',
        'unit',
      ]);
    });

    /**
     * FR-030. The arithmetic is the record: 117 is a figure, 30 × 15 × 0.26 is an argument. A
     * detail read that omits the factors can show only the answer, which is the half nobody checks.
     */
    it('carries the six factors on a measured line and none on a presence line', async () => {
      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemA,
          nos1: '1',
          length: '30',
          breadth: '15',
          depth: '0.26',
        },
        { paymentMode: 'day_basis', boqItemId: itemB, servedQty: '1' },
      ]);

      const res = await http()
        .get(`/projects/dwr/${created.body.id}`)
        .set(auth())
        .expect(200);

      const measured = res.body.lines.find(
        (l: { paymentMode: string }) => l.paymentMode === 'work_basis',
      );
      expect(measured).toMatchObject({
        nos1: '1.000',
        nos2: '1.000',
        length: '30.000',
        breadth: '15.000',
        depth: '0.260',
        density: '1.000',
        quantityInForce: '117.000',
      });

      // Null, never 1: a presence-paid line was not multiplied, and a 1 here would read as a
      // factor somebody entered — on the screen whose whole job is to say how a quantity arose.
      const presence = res.body.lines.find(
        (l: { paymentMode: string }) => l.paymentMode === 'day_basis',
      );
      expect(presence).toMatchObject({
        nos1: null,
        nos2: null,
        length: null,
        breadth: null,
        depth: null,
        density: null,
      });
    });
  });

  // ── The concurrency properties ───────────────────────────────────────────

  describe('concurrency', () => {
    it('lands both increments when two reports on one line are approved at once', async () => {
      // FR-015a. A read-then-write would lose one of the two, and lose it silently. The relative
      // increment is evaluated by Postgres against the row as it stands, which is why this holds —
      // and why no unit test could demonstrate it.
      const before = await doneQty(itemA);

      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const created = await createReport([
          { paymentMode: 'day_basis', boqItemId: itemA, servedQty: '1' },
        ]);
        const id = created.body.id;
        await http()
          .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
          .set(auth())
          .expect(201);
        await sys.dailyWorkReport.update({
          where: { id },
          data: { submittedByUserId: null },
        });
        ids.push(id);
      }

      const results = await Promise.all(
        ids.map((id) =>
          http()
            .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
            .set(auth()),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      // Both, not one.
      expect(Number(await doneQty(itemA))).toBeCloseTo(Number(before) + 2, 3);
    });

    it('moves the counter once when one report is approved twice at the same instant', async () => {
      // FR-014a. The status transition is a conditional update inside the same transaction as the
      // increments, so the two requests serialise on the row and exactly one sees a row count of 1.
      const before = await doneQty(itemB);

      const created = await createReport([
        {
          paymentMode: 'work_basis',
          boqItemId: itemB,
          length: '1',
          breadth: '1',
        },
      ]);
      const id = created.body.id;
      await http()
        .post(`/projects/dwr/${id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      await sys.dailyWorkReport.update({
        where: { id },
        data: { submittedByUserId: null },
      });

      const [first, second] = await Promise.all([
        http()
          .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
          .set(auth()),
        http()
          .post(`/projects/dwr/${id}/approve?companyId=${companyId}`)
          .set(auth()),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(Number(await doneQty(itemB))).toBeCloseTo(Number(before) + 1, 3);
    });
  });

  // ── SC-008 ───────────────────────────────────────────────────────────────

  describe('SC-008 — the numbers the success criteria name', () => {
    it('records, submits and approves a seventeen-line report inside three seconds a step', async () => {
      // Generous on purpose and said so rather than silently widened later: these bounds are three
      // seconds a step against a local Postgres, which is roughly an order of magnitude above what
      // the operations take and still well below the point at which a person would notice. The
      // criterion exists to catch a change that makes an operation *qualitatively* slower — a
      // per-line round trip reappearing, say — not to measure this machine.
      const lines = Array.from({ length: 17 }, (_, i) => ({
        paymentMode: 'work_basis' as const,
        boqItemId: i % 2 === 0 ? itemA : itemB,
        length: '2',
        breadth: '3',
        chainageFrom: String(220 + i),
        chainageTo: String(220.5 + i),
      }));

      const t0 = Date.now();
      const created = await createReport(lines);
      const createMs = Date.now() - t0;
      expect(created.status).toBe(201);

      const t1 = Date.now();
      await http()
        .post(`/projects/dwr/${created.body.id}/submit?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      const submitMs = Date.now() - t1;

      await sys.dailyWorkReport.update({
        where: { id: created.body.id },
        data: { submittedByUserId: null },
      });

      const t2 = Date.now();
      await http()
        .post(`/projects/dwr/${created.body.id}/approve?companyId=${companyId}`)
        .set(auth())
        .expect(201);
      const approveMs = Date.now() - t2;

      const t3 = Date.now();
      await http()
        .get(`/projects/dwr?projectId=${projectId}&pageSize=200`)
        .set(auth())
        .expect(200);
      const listMs = Date.now() - t3;

      expect(createMs).toBeLessThan(3000);
      expect(submitMs).toBeLessThan(3000);
      expect(approveMs).toBeLessThan(3000);
      expect(listMs).toBeLessThan(2000);
    });
  });
});
