import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { BOQ_ERRORS } from '../src/projects/boq/boq-error-codes';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { effectiveCompanyIdFor } from './fixtures/effective-company';
import { createProjectWithMandatoryDocuments } from './fixtures/mandatory-project-documents';

/**
 * Tender import across every schedule, priced by basis, replaceable while untouched (047).
 *
 * Runs the client's real NEWAI SHAHID SMARAK tender — an item-rate `BoQ1` beside a percentage
 * `BoQ2` at −19.12% — through validate and confirm against a real database, then bills one line of
 * each kind. The item-rate line must bill at its own rate: before 047 it took the −19.12% too, and
 * before that it was never imported at all.
 */
const stamp = `${Date.now() % 100000}`;
const unique = (s: string) => `E2E${s}${stamp}`;
const TENDERS = join(process.cwd(), 'test', 'fixtures', 'tenders');
const base64 = (name: string) =>
  readFileSync(join(TENDERS, name)).toString('base64');

jest.setTimeout(120_000);

/** Local-only fixtures (git-ignored); without them the suite reports as skipped. */
const PRESENT = existsSync(join(TENDERS, 'NEWAI_SHAHID_SMARAK.xls'));
if (!PRESENT) {
  it.skip('SKIPPED — test/fixtures/tenders/ is not present in this checkout', () =>
    undefined);
}

(PRESENT ? describe : describe.skip)(
  'Tender BOQ import — schedules, basis, replace (e2e, 047)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let http: () => request.SuperTest<request.Test>;
    let token: string;
    let companyId: string;
    let projectId: string;
    let clientId: string;

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

    const validate = (file: string) =>
      http()
        .post(`/projects/${projectId}/boq/import/validate${q()}`)
        .set(auth())
        .send({ file: base64(file) });

    const confirm = (body: Record<string, unknown>) =>
      http()
        .post(`/projects/${projectId}/boq/import/confirm${q()}`)
        .set(auth())
        .send(body);

    const tree = async () =>
      (
        await http()
          .get(`/projects/${projectId}/boq${q()}`)
          .set(auth())
          .expect(200)
      ).body as {
        id: string;
        name: string;
        items: { id: string; boqNo: string; pricingBasis: string }[];
      }[];

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
          code: unique('T').slice(0, 14),
          name: unique('Tender'),
          clientId,
          contractValue: 10_000_000,
          startDate: '2025-01-01',
        },
        companyId,
      });
      expect(project.status).toBe(201);
      projectId = project.body.id;
      // A figure that is not the file's, so the choice is forced.
      await sys.project.update({
        where: { id: projectId },
        data: { quotedPercentage: '-0.04' },
      });
    });

    afterAll(async () => {
      await sys.clientBill
        .deleteMany({ where: { projectId } })
        .catch(() => undefined);
      await sys.bOQTaskGroup
        .deleteMany({ where: { projectId } })
        .catch(() => undefined);
      await sys.project.deleteMany({ where: { id: projectId } });
      await sys.client.deleteMany({ where: { id: clientId } });
      await app.close();
    }, 120_000);

    it('reads both schedules of a mixed tender and reports both quoted percentages', async () => {
      const res = await validate('NEWAI_SHAHID_SMARAK.xls').expect(201);

      expect(
        res.body.schedules.map(
          (s: { sheetName: string; pricingBasis: string }) => [
            s.sheetName,
            s.pricingBasis,
            (s as unknown as { lines: number }).lines,
          ],
        ),
      ).toEqual([
        ['BoQ1', 'item_rate', 2],
        ['BoQ2', 'percentage', 100],
      ]);
      expect(res.body.confirmable).toBe(true);
      expect(res.body.quotedPercentage).toBe('-0.191200');
      expect(res.body.projectQuotedPercentage).toBe('-0.040000');
      expect(res.body.quotedPercentageDiffers).toBe(true);
      expect(res.body.replace).toBeNull();
    });

    it('refuses confirm without a quoted-percentage choice, then takes the file’s', async () => {
      const report = await validate('NEWAI_SHAHID_SMARAK.xls').expect(201);

      const refused = await confirm({ batchId: report.body.batchId }).expect(
        400,
      );
      expect(refused.body.code).toBe(BOQ_ERRORS.quotedPercentageChoiceRequired);

      const done = await confirm({
        batchId: report.body.batchId,
        quotedPercentageSource: 'file',
      }).expect(201);
      expect(done.body).toMatchObject({
        lines: 102,
        quotedPercentage: '-0.191200',
        replaced: 0,
      });

      const groups = await tree();
      const items = groups.flatMap((g) => g.items);
      expect(items).toHaveLength(102);
      expect(items.filter((i) => i.pricingBasis === 'item_rate')).toHaveLength(
        2,
      );
      expect(items.every((i) => /^BoQ[12]\//.test(i.boqNo))).toBe(true);
    });

    it('prices the billable BOQ and a bill by basis', async () => {
      const boq = await http()
        .get(`/projects/client-bills/boq?projectId=${projectId}`)
        .set(auth())
        .expect(200);
      // ₹4,88,000 item-rate as quoted + ₹97,52,823 at −19.12% = ₹83,76,083.24.
      expect(boq.body.estimatedTotal).toBeCloseTo(488000 + 9752823, 0);
      expect(boq.body.quotedTotal).toBeCloseTo(8376083.24, 0);

      const items = boq.body.groups.flatMap(
        (g: { items: unknown[] }) => g.items,
      ) as {
        id: string;
        rate: number;
        pricingBasis: string;
        takesQuotedPercentage: boolean;
      }[];
      const itemRate = items.find((i) => i.pricingBasis === 'item_rate');
      const percentage = items.find((i) => i.pricingBasis === 'percentage');
      expect(itemRate.takesQuotedPercentage).toBe(false);
      expect(percentage.takesQuotedPercentage).toBe(true);

      const bill = await http()
        .post(`/projects/client-bills${q()}`)
        .set(auth())
        .send({
          projectId,
          billingDate: '2026-10-28',
          lines: [
            { boqTaskItemId: itemRate.id, quantity: 1 },
            { boqTaskItemId: percentage.id, quantity: 1 },
          ],
        })
        .expect(201);
      const view = await http()
        .get(`/projects/client-bills/${bill.body.id}`)
        .set(auth())
        .expect(200);
      const line = (id: string) =>
        view.body.lines.find(
          (l: { boqTaskItemId: string }) => l.boqTaskItemId === id,
        );
      expect(line(itemRate.id).amount).toBeCloseTo(itemRate.rate, 2);
      expect(line(itemRate.id).quotedRate).toBeCloseTo(itemRate.rate, 2);
      expect(line(percentage.id).amount).toBeCloseTo(
        Math.round(percentage.rate * 0.8088 * 100) / 100,
        2,
      );
    });

    it('refuses to replace a BOQ once a line is billed, naming it', async () => {
      const res = await validate('PHC_KALEDA_604833.xls').expect(400);
      expect(res.body.code).toBe(BOQ_ERRORS.replaceBlocked);
      expect(res.body.blockedBy.billed).toBe(2);
    });

    it('replaces an untouched BOQ in one confirm, only when asked', async () => {
      await sys.clientBill.deleteMany({ where: { projectId } });

      const report = await validate('PHC_KALEDA_604833.xls').expect(201);
      expect(report.body.replace).toEqual({
        existingLines: 102,
        existingGroups: expect.any(Number),
        replaceable: true,
      });

      const refused = await confirm({
        batchId: report.body.batchId,
        quotedPercentageSource: 'project',
      }).expect(400);
      expect(refused.body.code).toBe(BOQ_ERRORS.alreadyPopulated);

      const done = await confirm({
        batchId: report.body.batchId,
        quotedPercentageSource: 'project',
        replaceExisting: true,
      }).expect(201);
      expect(done.body).toMatchObject({
        lines: 131,
        replaced: 102,
        // Kept the project's, as asked.
        quotedPercentage: '-0.191200',
      });

      const items = (await tree()).flatMap((g) => g.items);
      expect(items).toHaveLength(131);
      // A single-schedule workbook keeps its own numbers.
      expect(items.some((i) => i.boqNo.includes('/'))).toBe(false);
    });

    it('deletes an empty section and refuses one with lines', async () => {
      const empty = await http()
        .post(`/projects/${projectId}/boq/groups${q()}`)
        .set(auth())
        .send({ boqNo: '99', name: 'Spare', scopeQty: '0' })
        .expect(201);
      await http()
        .delete(`/projects/${projectId}/boq/groups/${empty.body.id}${q()}`)
        .set(auth())
        .expect(200);

      const full = (await tree())[0];
      const refused = await http()
        .delete(`/projects/${projectId}/boq/groups/${full.id}${q()}`)
        .set(auth())
        .expect(409);
      expect(refused.body.code).toBe(BOQ_ERRORS.groupNotEmpty);
    });

    it('takes a basis on a hand-entered line and lets it change while unbilled', async () => {
      const group = (await tree())[0];
      const created = await http()
        .post(`/projects/${projectId}/boq/items${q()}`)
        .set(auth())
        .send({
          groupId: group.id,
          boqNo: 'X1',
          taskName: 'Solar street light',
          unit: 'Each',
          scopeQty: '3',
          rate: '105000',
          pricingBasis: 'item_rate',
        })
        .expect(201);
      let line = (await tree())
        .flatMap((g) => g.items)
        .find((i) => i.id === created.body.id);
      expect(line.pricingBasis).toBe('item_rate');

      await http()
        .patch(`/projects/${projectId}/boq/items/${created.body.id}${q()}`)
        .set(auth())
        .send({ pricingBasis: 'percentage' })
        .expect(200);
      line = (await tree())
        .flatMap((g) => g.items)
        .find((i) => i.id === created.body.id);
      expect(line.pricingBasis).toBe('percentage');

      await http()
        .patch(`/projects/${projectId}/boq/items/${created.body.id}${q()}`)
        .set(auth())
        .send({ pricingBasis: 'lump_sum' })
        .expect(400);
    });
  },
);
