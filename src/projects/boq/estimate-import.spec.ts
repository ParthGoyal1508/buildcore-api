import { readFileSync } from 'fs';
import { join } from 'path';

import { BadRequestException } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { BOQ_ERRORS } from './boq-error-codes';
import { BoqImportService } from './boq-import.service';
import { BoqWorkbookReader } from './boq-workbook.reader';
import { ImportBatchStore } from './import-batch.store';

const SYNTHETIC = join(process.cwd(), 'test', 'fixtures', 'boq-synthetic.xls');

const CALLER = {
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  ctx: { isSuperAdmin: false, companyId: 'company-1' },
};

/**
 * The estimate variant of the tender import (008 US4 AC6, T097).
 *
 * ## Why this was deferred, and what changed
 *
 * T097 recorded three grounds for leaving it unbuilt: `isEstimate` was read by nothing in `src/`,
 * the client's file is a tender and not an estimate, and "an estimate variant whose only consumer is
 * a boolean nobody reads would be scaffolding, not a feature". The first and third were the real
 * objections, and building it without answering them would have produced exactly the scaffolding the
 * task warned about.
 *
 * So the flag now does three things, and these are the assertions that matter:
 *
 *   * an estimate line is **not billable** to the client;
 *   * an estimate is **absent from the alert groups**, because it carries no programme;
 *   * an estimate **never** sets `Project.quotedPercentage`.
 *
 * Everything else is deliberately identical. The pipeline, the fourteen refusals, the block
 * identification, the unit normalisation and the reconciliation are the tender's, unchanged — they
 * are about reading a workbook honestly, which does not depend on whose figures it carries.
 */

/** A Prisma stub counting existing lines **per variant**, which is the behaviour under test. */
function prismaWith(counts: {
  tender: number;
  estimate: number;
  /** 047: existing lines of this variant are billed, so replacing them is refused. */
  billed?: boolean;
}) {
  const calls: { isEstimate: boolean }[] = [];
  const written = {
    groups: [] as Record<string, unknown>[],
    items: [] as Record<string, unknown>[],
    projectUpdates: [] as Record<string, unknown>[],
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskItem: {
      // 047: the existing lines are read for replaceability rather than only counted.
      findMany: jest.fn(async (args: { where: { isEstimate: boolean } }) => {
        calls.push({ isEstimate: args.where.isEstimate });
        const n = args.where.isEstimate ? counts.estimate : counts.tender;
        return Array.from({ length: n }, (_, index) => ({
          boqNo: String(index + 1),
          doneQty: new Prisma.Decimal(0),
          _count: {
            dwrTasks: 0,
            clientBillLines: counts.billed ? 1 : 0,
            awardLines: 0,
          },
        }));
      }),
      createMany: jest.fn(async (args: { data: Record<string, unknown>[] }) => {
        written.items.push(...args.data);
        return { count: args.data.length };
      }),
    },
    bOQTaskGroup: {
      count: jest.fn(async () => 1),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createManyAndReturn: jest.fn(
        async (args: { data: Record<string, unknown>[] }) => {
          written.groups.push(...args.data);
          return args.data.map((group, index) => ({
            id: `group-${written.groups.length - args.data.length + index + 1}`,
            boqNo: group.boqNo as string,
          }));
        },
      ),
    },
    project: {
      findFirst: jest.fn(async () => ({
        quotedPercentage: new Prisma.Decimal(0),
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        written.projectUpdates.push(args.data);
        return {};
      }),
    },
  };
  return {
    calls,
    written,
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
  };
}

function build(
  counts: { tender: number; estimate: number; billed?: boolean } = {
    tender: 0,
    estimate: 0,
  },
) {
  const batches = new ImportBatchStore();
  const audit = { record: jest.fn() };
  const db = prismaWith(counts);
  return {
    batches,
    audit,
    ...db,
    service: new BoqImportService(
      new BoqWorkbookReader(),
      batches,
      db.prisma,
      audit as never,
    ),
  };
}

const read = () => readFileSync(SYNTHETIC);

describe('the estimate import (T097)', () => {
  it('reads the workbook through exactly the same pipeline', async () => {
    const tender = build();
    const estimate = build();

    const asTender = await tender.service.validate({
      buffer: read(),
      ...CALLER,
    });
    const asEstimate = await estimate.service.validate({
      buffer: read(),
      ...CALLER,
      isEstimate: true,
    });

    // Every figure identical. A second parser for estimates would be a second place for the same
    // bugs, so the only thing the flag may change is what the rows mean once written.
    expect(asEstimate.lines).toBe(asTender.lines);
    expect(asEstimate.groups).toBe(asTender.groups);
    expect(asEstimate.totals).toEqual(asTender.totals);
    expect(asEstimate.units).toEqual(asTender.units);
    expect(asEstimate.errors).toEqual(asTender.errors);
    expect(asEstimate.quotedPercentage).toBe(asTender.quotedPercentage);
  });

  it('says on the report which variant is about to be written', async () => {
    const { service } = build();

    const report = await service.validate({
      buffer: read(),
      ...CALLER,
      isEstimate: true,
    });

    // Somebody reading a long report before pressing Confirm deserves to be told which schedule it
    // is going to become. The flag lives on the batch, so it cannot be crossed — but silence here
    // would leave the screen unable to say.
    expect(report.isEstimate).toBe(true);
  });

  it('defaults to the tender when nothing says otherwise', async () => {
    const { service } = build();

    const report = await service.validate({ buffer: read(), ...CALLER });

    // The safe default is the one every existing caller already gets. An `isEstimate` that defaulted
    // true would quietly make an imported tender unbillable.
    expect(report.isEstimate).toBe(false);
  });

  describe('a project may hold both variants', () => {
    it('admits an estimate on a project that already has a tender', async () => {
      // 231 tender lines present, no estimate. This is the case the single unscoped count made
      // impossible — and the whole reason the variant exists.
      const { service, calls } = build({ tender: 231, estimate: 0 });

      await expect(
        service.validate({ buffer: read(), ...CALLER, isEstimate: true }),
      ).resolves.toMatchObject({ isEstimate: true });

      // Asserted rather than inferred: the read must have asked about estimates specifically —
      // once at validate and nowhere about the tender.
      expect(calls).toEqual([{ isEstimate: true }]);
    });

    it('offers to replace an untouched estimate, naming the variant (047)', async () => {
      const { service } = build({ tender: 231, estimate: 12 });

      const report = await service.validate({
        buffer: read(),
        ...CALLER,
        isEstimate: true,
      });

      // The 12 estimate lines, not the 231 tender lines: the replace is scoped to the variant.
      expect(report.replace).toEqual({
        existingLines: 12,
        existingGroups: 1,
        replaceable: true,
      });
    });

    it('refuses to replace a tender whose lines are billed, naming the variant', async () => {
      const { service } = build({ tender: 231, estimate: 12, billed: true });

      await service.validate({ buffer: read(), ...CALLER }).then(
        () => {
          throw new Error('expected a refusal, but the call resolved');
        },
        (error: unknown) => {
          const body = (error as BadRequestException).getResponse() as {
            code?: string;
            message?: string;
          };
          expect(body.code).toBe(BOQ_ERRORS.replaceBlocked);
          expect(body.message).toContain('BOQ (231 lines)');
        },
      );
    });
  });

  describe('what confirm writes', () => {
    it('marks every group and every line as an estimate', async () => {
      const { service, written } = build();
      const report = await service.validate({
        buffer: read(),
        ...CALLER,
        isEstimate: true,
      });

      await service.confirm({
        batchId: report.batchId,
        ...CALLER,
        ipAddress: '127.0.0.1',
      });

      expect(written.groups.length).toBeGreaterThan(0);
      expect(written.items.length).toBeGreaterThan(0);
      // Both levels. A group marked and its items not would make the tree's exclusion depend on
      // which level a reader filtered.
      for (const group of written.groups) expect(group.isEstimate).toBe(true);
      for (const item of written.items) expect(item.isEstimate).toBe(true);
    });

    it('never sets the project’s quoted percentage from an estimate', async () => {
      const { service, written } = build();
      const report = await service.validate({
        buffer: read(),
        ...CALLER,
        isEstimate: true,
      });
      // The fixture's percentage *was* located, so this is not passing by absence.
      expect(report.quotedPercentageFound).toBe(true);

      const result = await service.confirm({
        batchId: report.batchId,
        ...CALLER,
        ipAddress: '127.0.0.1',
      });

      // `Project.quotedPercentage` is the bidder's quote against the client, and every client bill
      // is priced with it. An internal costing's percentage written there would reprice the whole
      // tender at a figure the client never saw.
      expect(written.projectUpdates).toEqual([]);
      expect(result.quotedPercentageSet).toBe(false);
      expect(result.isEstimate).toBe(true);
    });

    it('does set it for a tender, so the case above is a difference and not a bug', async () => {
      const { service, written } = build();
      const report = await service.validate({ buffer: read(), ...CALLER });
      // The stub project holds 0, so the file's figure differs and must be chosen (047).
      expect(report.quotedPercentageDiffers).toBe(true);

      const result = await service.confirm({
        batchId: report.batchId,
        ...CALLER,
        ipAddress: '127.0.0.1',
        quotedPercentageSource: 'file',
      });

      expect(written.projectUpdates).toHaveLength(1);
      expect(result.quotedPercentageSet).toBe(true);
      expect(result.isEstimate).toBe(false);
    });

    it('records the variant in the audit entry', async () => {
      const { service, audit } = build();
      const report = await service.validate({
        buffer: read(),
        ...CALLER,
        isEstimate: true,
      });

      await service.confirm({
        batchId: report.batchId,
        ...CALLER,
        ipAddress: '127.0.0.1',
      });

      // One entry, as for a tender — one import is one act. But the log has to say which schedule
      // it wrote, or two entries a month apart are indistinguishable.
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][0].changes).toMatchObject({
        isEstimate: true,
      });
    });
  });
});
