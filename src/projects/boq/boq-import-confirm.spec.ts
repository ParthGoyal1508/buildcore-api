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
  options: {
    existingItems?: number;
    failOnCreate?: boolean;
    /** Fails the write with a Prisma error code, as a real database would. */
    failWithCode?: string;
  } = {},
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
        if (options.failWithCode) {
          throw Object.assign(new Error('transaction closed'), {
            code: options.failWithCode,
          });
        }
        created.items.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    bOQTaskGroup: {
      createManyAndReturn: jest.fn(
        ({ data }: { data: { boqNo: string }[] }) => {
          if (options.failOnCreate) throw new Error('constraint violation');
          created.groups.push(...data);
          return Promise.resolve(
            data.map((group, index) => ({
              id: `group-${created.groups.length - data.length + index + 1}`,
              // The order the write relies on, honoured here — and reversed by
              // `options.returnGroupsOutOfOrder` so the guard against it can be tested.
              boqNo: group.boqNo,
            })),
          );
        },
      ),
      /**
       * Present only so a test can assert it is **never called**.
       *
       * The write used to call this once per group, with a `createMany` for that group's lines
       * beside it — 132 sequential round trips for the client's 66-group tender, which outran the
       * transaction budget on a hosted database and reached the browser as a bare 500.
       */
      create: jest.fn(),
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

/** The client's own tender is 66 groups. This is that shape, in miniature-but-plural. */
function manyGroups(count: number): StagedGroup[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Section ${index + 1}`,
    boqNo: String(index + 1),
    items: [
      {
        boqNo: `${index + 1}.1`,
        taskName: 'Excavation',
        unit: 'Cum',
        scopeQty: '100.000',
        rate: '251.00',
        amount: '25100.00',
        sourceRow: 13 + index,
      },
    ],
  }));
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
      // The tender variant unless a case says otherwise; `estimate-import.spec.ts` covers the
      // estimate, whose confirm writes different rows and touches no quoted percentage.
      isEstimate: false,
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

    expect(result).toEqual({
      groups: 1,
      lines: 2,
      isEstimate: false,
      quotedPercentageSet: true,
    });
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

  it('writes the whole schedule in two statements, however many groups it has', async () => {
    // **The deployed failure of 2026-10-04.** This was a `create` plus a `createMany` per group:
    // 132 sequential round trips for the client's 66-group tender, inside one interactive
    // transaction whose budget is Prisma's five-second default. Locally that is 0.17s and
    // invisible; against a hosted database at 35-50ms latency it is 5-7s, and the transaction
    // expired mid-write. The browser got `{"statusCode":500,"message":"Internal server error"}`.
    //
    // Counted rather than timed: a timing assertion against a mock proves nothing, and the
    // round-trip count is the thing that actually scaled with the file.
    const { prisma, tx, created } = fakePrisma();
    const batch = seed({ groups: manyGroups(66) });

    const result = await serviceWith(prisma).confirm({
      batchId: batch.id,
      ...CALLER,
    });

    expect(result.groups).toBe(66);
    expect(result.lines).toBe(66);
    expect(created.groups).toHaveLength(66);
    expect(created.items).toHaveLength(66);

    // Two writes, not 132. Constant in the size of the schedule, which is the property that
    // matters — the old shape failed *worse* the larger the tender, so the schedules most worth
    // importing were the ones that could not be.
    expect(tx.bOQTaskGroup.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.bOQTaskItem.createMany).toHaveBeenCalledTimes(1);
    expect(tx.bOQTaskGroup.create).not.toHaveBeenCalled();
  });

  it('refuses to attach lines if the groups come back in a different order', async () => {
    // The positional match between created groups and staged groups rests on a single multi-row
    // INSERT ... RETURNING giving its rows back in the order supplied. That holds — and is
    // checked anyway, because if it ever stopped holding, every line would be filed under the
    // wrong section and the import would *succeed*. A schedule that is quietly wrong is the one
    // outcome this feature exists to refuse.
    const { prisma, tx } = fakePrisma();
    (tx.bOQTaskGroup.createManyAndReturn as jest.Mock).mockImplementationOnce(
      ({ data }: { data: { boqNo: string }[] }) =>
        Promise.resolve(
          data
            .map((group, index) => ({
              id: `group-${index + 1}`,
              boqNo: group.boqNo,
            }))
            .reverse(),
        ),
    );
    const batch = seed({ groups: manyGroups(3) });

    await expect(
      serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER }),
    ).rejects.toThrow(/out of order/);
  });

  it.each([
    ['P2028', 'the transaction expired'],
    ['P2024', 'no connection could be taken from the pool'],
  ])(
    'turns %s into a refusal that says nothing was written, not a bare 500',
    async (code) => {
      // Before this, both reached the browser as `{"statusCode":500,"message":"Internal server
      // error"}` — which answers neither "what happened" nor the operator's real question,
      // "is half my tender now on the project". It is not: the transaction rolls back.
      const { prisma } = fakePrisma({ failWithCode: code });
      const batch = seed();

      await serviceWith(prisma)
        .confirm({ batchId: batch.id, ...CALLER })
        .then(
          () => {
            throw new Error('expected a refusal, but the confirm resolved');
          },
          (error: unknown) => {
            const body = (
              error as {
                getResponse: () => { code?: string; message?: string };
              }
            ).getResponse();
            expect(body.code).toBe(BOQ_ERRORS.writeInterrupted);
            expect(body.message).toContain('nothing was saved');
          },
        );

      // Still retryable, which is the point of saying so.
      expect(batches.lookup(batch.id).batch).not.toBeNull();
    },
  );

  it('lets an unrecognised database error stay a 500, so a real bug is not disguised', async () => {
    // Only the two codes above are translated. A constraint violation is a bug in this service
    // and must keep surfacing with its stack trace, because that is what gets it fixed.
    const { prisma } = fakePrisma({ failOnCreate: true });
    const batch = seed();

    await expect(
      serviceWith(prisma).confirm({ batchId: batch.id, ...CALLER }),
    ).rejects.toThrow('constraint violation');
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
      tx.bOQTaskGroup.createManyAndReturn.mock.invocationCallOrder[0],
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
