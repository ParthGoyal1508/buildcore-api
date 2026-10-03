import { BadRequestException } from '@nestjs/common';
import { AuditEntityType } from '@prisma/client';

import { BOQ_ERRORS } from './boq-error-codes';
import { BoqImportService } from './boq-import.service';
import { BoqWorkbookReader } from './boq-workbook.reader';
import { ImportBatchStore, StagedGroup } from './import-batch.store';

const CALLER = {
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  ctx: { isSuperAdmin: false, companyId: 'company-1' },
  ipAddress: '10.0.0.1',
};

const GROUPS: StagedGroup[] = [
  {
    name: 'Earthwork',
    boqNo: '1',
    items: [
      {
        boqNo: '1',
        taskName: 'Excavation',
        unit: 'Cum',
        scopeQty: '100.000',
        rate: '251.00',
        amount: '25100.00',
        sourceRow: 13,
      },
      {
        boqNo: '2',
        taskName: 'Filling',
        unit: 'Cum',
        scopeQty: '50.000',
        rate: '120.00',
        amount: '6000.00',
        sourceRow: 14,
      },
    ],
  },
];

/** A transaction client recording what was asked of it, with `existingItems` controllable. */
function fakePrisma(
  options: { existingItems?: number; failOnCreate?: boolean } = {},
) {
  const created = {
    groups: [] as unknown[],
    items: [] as unknown[],
    projectUpdates: [] as unknown[],
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskItem: {
      count: jest.fn().mockResolvedValue(options.existingItems ?? 0),
      createMany: jest.fn(({ data }: { data: unknown[] }) => {
        if (options.failOnCreate) throw new Error('constraint violation');
        created.items.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    bOQTaskGroup: {
      create: jest.fn(({ data }: { data: unknown }) => {
        created.groups.push(data);
        return Promise.resolve({ id: `group-${created.groups.length}` });
      }),
    },
    project: {
      update: jest.fn(({ data }: { data: unknown }) => {
        created.projectUpdates.push(data);
        return Promise.resolve({});
      }),
    },
  };
  return {
    created,
    tx,
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
  };
}

async function expectRefusal(
  call: Promise<unknown>,
  code: string,
): Promise<void> {
  await call.then(
    () => {
      throw new Error(`expected refusal ${code}, but the call resolved`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        ((error as BadRequestException).getResponse() as { code?: string })
          .code,
      ).toBe(code);
    },
  );
}

describe('BoqImportService.confirm', () => {
  let batches: ImportBatchStore;
  let audit: { record: jest.Mock };

  const seed = (
    overrides: Partial<Parameters<ImportBatchStore['create']>[0]> = {},
  ) =>
    batches.create({
      companyId: CALLER.companyId,
      userId: CALLER.userId,
      projectId: CALLER.projectId,
      groups: GROUPS,
      quotedPercentage: '0.024600',
      ...overrides,
    })!;

  const serviceWith = (prisma: unknown) =>
    new BoqImportService(
      new BoqWorkbookReader(),
      batches,
      prisma as never,
      audit as never,
    );

  beforeEach(() => {
    batches = new ImportBatchStore();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  it('writes exactly the lines that were validated, and the percentage with them', async () => {
    const { prisma, created } = fakePrisma();
    const batch = seed();

    const result = await serviceWith(prisma).confirm({
      batchId: batch.id,
      ...CALLER,
    });

    expect(result).toEqual({ groups: 1, lines: 2, quotedPercentageSet: true });
    expect(created.groups).toHaveLength(1);
    expect(created.items).toHaveLength(2);
    expect(created.projectUpdates).toEqual([{ quotedPercentage: '0.024600' }]);
  });

  it('refuses a second confirm and leaves the schedule as it was', async () => {
    const { prisma, created } = fakePrisma();
    const service = serviceWith(prisma);
    const batch = seed();
    await service.confirm({ batchId: batch.id, ...CALLER });

    // FR-052. A double-submitted confirm is the ordinary way a 231-line tender gets entered twice,
    // and the duplicate would be indistinguishable from a real re-tender.
    await expectRefusal(
      service.confirm({ batchId: batch.id, ...CALLER }),
      BOQ_ERRORS.batchAlreadyConfirmed,
    );
    expect(created.items).toHaveLength(2);
  });

  it('reports a concurrent confirm as in progress, not as a failure', async () => {
    const { prisma } = fakePrisma();
    const service = serviceWith(prisma);
    const batch = seed();
    batches.claim(batch.id);

    await expectRefusal(
      service.confirm({ batchId: batch.id, ...CALLER }),
      BOQ_ERRORS.batchInProgress,
    );
  });

  it('returns the batch to ready when the transaction fails, so a retry is possible', async () => {
    const { prisma } = fakePrisma({ failOnCreate: true });
    const batch = seed();

    await expect(
      serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER }),
    ).rejects.toThrow('constraint violation');

    // Nothing was written, so losing the batch would mean re-uploading and re-reading the whole
    // report for a failure that was not the operator's.
    expect(batches.lookup(batch.id).batch).not.toBeNull();
  });

  it('leaves quotedPercentage untouched when the figure was never located', async () => {
    const { prisma, created } = fakePrisma();
    const batch = seed({ quotedPercentage: null });

    const result = await serviceWith(prisma).confirm({
      batchId: batch.id,
      ...CALLER,
    });

    // FR-040, at the last place it could go wrong. Writing 0 here would under-bill every line on
    // the project by the real percentage, and nothing downstream would contradict it.
    expect(result.quotedPercentageSet).toBe(false);
    expect(created.projectUpdates).toEqual([]);
  });

  it('refuses a confirm by anyone but the person who validated it', async () => {
    const { prisma } = fakePrisma();
    const batch = seed();

    // FR-050. The report is the review; the person accepting a 231-line write must be the one who
    // read it.
    await expectRefusal(
      serviceWith(prisma).confirm({
        batchId: batch.id,
        ...CALLER,
        userId: 'user-2',
      }),
      BOQ_ERRORS.batchNotYours,
    );
  });

  it('refuses a confirm against a different project than it was validated for', async () => {
    const { prisma } = fakePrisma();
    const batch = seed();

    await expectRefusal(
      serviceWith(prisma).confirm({
        batchId: batch.id,
        ...CALLER,
        projectId: 'project-2',
      }),
      BOQ_ERRORS.batchNotYours,
    );
  });

  it('refuses an import onto a project that already has lines, naming the count', async () => {
    const { prisma, created } = fakePrisma({ existingItems: 231 });
    const batch = seed();

    // FR-049. Appending is the same silent doubling FR-042 guards, reached by uploading twice
    // instead of by reading the wrong columns.
    await expectRefusal(
      serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER }),
      BOQ_ERRORS.alreadyPopulated,
    );
    expect(created.groups).toHaveLength(0);
  });

  it('checks for existing lines inside the transaction, not before it', async () => {
    const { prisma, tx } = fakePrisma();
    const batch = seed();

    await serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER });

    // Two imports racing would otherwise both read an empty project and both write. The count
    // has to share the transaction with the writes for the refusal to mean anything.
    expect(tx.bOQTaskItem.count).toHaveBeenCalled();
    expect(tx.bOQTaskItem.count.mock.invocationCallOrder[0]).toBeLessThan(
      tx.bOQTaskGroup.create.mock.invocationCallOrder[0],
    );
  });

  it('writes one audit entry for the import, not one per line', async () => {
    const { prisma } = fakePrisma();
    const batch = seed();

    await serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER });

    // One import is one act. 231 entries would bury whatever came next in the log.
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: AuditEntityType.BOQ_IMPORT,
        entityId: CALLER.projectId,
        changes: expect.objectContaining({
          groups: 1,
          lines: 2,
          quotedPercentage: '0.024600',
        }),
      }),
    );
  });

  it('tells an expired batch apart from one that never existed', async () => {
    const { prisma } = fakePrisma();
    const service = serviceWith(prisma);
    const batch = seed();
    batches.ageForTesting(batch.id, 31);

    await expectRefusal(
      service.confirm({ batchId: batch.id, ...CALLER }),
      BOQ_ERRORS.batchExpired,
    );
    await expectRefusal(
      service.confirm({ batchId: 'nonexistent', ...CALLER }),
      BOQ_ERRORS.batchNotFound,
    );
  });
});
