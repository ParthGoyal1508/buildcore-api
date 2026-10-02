import { ACTION_RA_BILL } from '../../approvals/default-chains';
import { RaBillsService } from './ra-bills.service';

/**
 * Certifying an RA bill, and invalidating that certification when its quantities change
 * (018 Phase 4, FR-009, research §6 — tasks T021 to T023).
 *
 * Two properties carry the phase, and they are the two failure modes that would be invisible:
 *
 *   1. **A completed approval is never mutated.** Editing quantities under a completed decision
 *      leaves the approver's name against numbers they never saw.
 *   2. **The spine is asked before anything is written.** The other order produces a bill that reads
 *      as certified against numbers nobody signed — which nothing on the screen would reveal.
 */

const dec = (value: number) => ({ toNumber: () => value });

function build(opts: {
  status?: 'draft' | 'submitted' | 'approved';
  workOrderId?: string | null;
  revisionCount?: number;
  awardedQty?: number;
  /** What every *other* bill has measured against the award line. */
  measuredByOthers?: number;
  submitThrows?: boolean;
  writeThrows?: boolean;
  latestDeciderId?: string | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const updateManyCalls: Record<string, unknown>[] = [];
  const groupByCalls: Record<string, unknown>[] = [];
  let linesDeleted = 0;

  const bill = {
    id: 'ra-1',
    companyId: 'co-1',
    projectId: 'p-1',
    workOrderId: opts.workOrderId === undefined ? 'wo-1' : opts.workOrderId,
    billNumber: 'SC-01',
    description: null,
    billingDate: new Date('2026-09-20T00:00:00.000Z'),
    status: opts.status ?? 'approved',
    revisionCount: opts.revisionCount ?? 0,
    grossAmount: dec(180000),
    retentionAmount: dec(0),
    advanceRecovery: dec(0),
    otherDeductions: dec(0),
    netPayable: dec(180000),
    lines: [
      {
        id: 'rl-1',
        workOrderBoqItemId: 'aw-1',
        quantity: dec(40),
        rate: dec(4500),
        amount: dec(180000),
        workOrderBoqItem: {
          id: 'aw-1',
          description: 'RCC M25 in foundations',
          unit: 'Cum',
          awardedQty: dec(opts.awardedQty ?? 100),
          rate: dec(4500),
        },
      },
    ],
  };

  const tx = {
    $executeRaw: async () => 0,
    workOrder: {
      findFirst: async () => ({ id: 'wo-1', retentionPercent: dec(0) }),
    },
    workOrderBOQItem: {
      findMany: async () => [
        {
          id: 'aw-1',
          description: 'RCC M25 in foundations',
          unit: 'Cum',
          awardedQty: dec(opts.awardedQty ?? 100),
          rate: dec(4500),
        },
      ],
    },
    rABillLine: {
      deleteMany: async () => {
        linesDeleted += 1;
        return { count: 1 };
      },
      groupBy: async (args: Record<string, unknown>) => {
        groupByCalls.push(args);
        return opts.measuredByOthers
          ? [
              {
                workOrderBoqItemId: 'aw-1',
                _sum: { quantity: dec(opts.measuredByOthers) },
              },
            ]
          : [];
      },
    },
    rABill: {
      findFirst: async () => bill,
      update: async (args: { data: Record<string, unknown> }) => {
        if (opts.writeThrows) throw new Error('the write failed');
        updates.push(args.data);
        return bill;
      },
      updateMany: async (args: Record<string, unknown>) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const approvals = {
    submit: jest.fn(async (_input: Record<string, unknown>) => {
      if (opts.submitThrows) throw new Error('no active approval chain');
      return { id: 'ai-2' };
    }),
    abandon: jest.fn(
      async (
        _entityType: string,
        _entityId: string,
        _companyId: string,
        _reason: string,
      ) => undefined,
    ),
    stateOfSystem: jest.fn(async () =>
      opts.latestDeciderId === undefined
        ? null
        : { latestDecision: { actorUserId: opts.latestDeciderId } },
    ),
  };

  return {
    service: new RaBillsService(prisma as never, approvals as never),
    approvals,
    updates,
    updateManyCalls,
    groupByCalls,
    linesDeleted: () => linesDeleted,
  };
}

const ctx = { isSuperAdmin: true } as never;
const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;

const revision = (overrides: Record<string, unknown> = {}) => ({
  lines: [{ workOrderBoqItemId: 'aw-1', quantity: 36 }],
  reason: 'Re-measured after joint survey on 3 Oct',
  ...overrides,
});

describe('a completed approval is never mutated (T021, research §6)', () => {
  it('raises a fresh instance and clears the certification on the bill', async () => {
    const t = build({ status: 'approved' });

    await t.service.revise(ctx, caller, 'ra-1', revision());

    expect(t.approvals.submit).toHaveBeenCalledTimes(1);
    expect(t.approvals.submit.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        actionType: ACTION_RA_BILL,
        entityType: ACTION_RA_BILL,
        entityId: 'ra-1',
        originatorUserId: 'u-1',
        subject: 'RA bill SC-01 (revised)',
      }),
    );
    expect(t.updates[0]).toEqual(
      expect.objectContaining({
        status: 'submitted',
        // A certification naming an approver against quantities they never saw is the precise
        // thing FR-009 exists to prevent.
        approvedByUserId: null,
        approvedAt: null,
        revisionCount: 1,
        lastRevisedByUserId: 'u-1',
      }),
    );
  });

  it('closes a still-pending instance, naming the reason', async () => {
    const t = build({ status: 'submitted' });

    await t.service.revise(ctx, caller, 'ra-1', revision());

    expect(t.approvals.abandon).toHaveBeenCalledWith(
      ACTION_RA_BILL,
      'ra-1',
      'co-1',
      'Quantities revised: Re-measured after joint survey on 3 Oct',
    );
  });

  it('counts each trip round, so nobody has to reconstruct it from the audit trail', async () => {
    const t = build({ status: 'approved', revisionCount: 2 });

    await t.service.revise(ctx, caller, 'ra-1', revision());

    expect(t.updates[0].revisionCount).toBe(3);
  });
});

describe('the spine is asked before anything is written (T022)', () => {
  it('refuses the edit outright when the chain cannot be reached', async () => {
    const t = build({ status: 'approved', submitThrows: true });

    await expect(
      t.service.revise(ctx, caller, 'ra-1', revision()),
    ).rejects.toThrow('no active approval chain');

    // Nothing written. The bill keeps its quantities *and* its certification — the failure to
    // design against is the other order, which leaves a bill reading as certified against numbers
    // nobody signed.
    expect(t.updates).toEqual([]);
    expect(t.linesDeleted()).toBe(0);
  });

  it('abandons the fresh instance when the write then fails', async () => {
    const t = build({ status: 'approved', writeThrows: true });

    await expect(
      t.service.revise(ctx, caller, 'ra-1', revision()),
    ).rejects.toThrow('the write failed');

    // Twice: once for the revision, once to undo the instance the failed revision raised. Leaving
    // it would ask somebody to certify a revision that does not exist.
    expect(t.approvals.abandon).toHaveBeenCalledTimes(2);
    expect(t.approvals.abandon.mock.calls[1][3]).toContain('failed to save');
  });
});

describe('a draft revision never touches the spine', () => {
  it('leaves it in draft and raises nothing', async () => {
    const t = build({ status: 'draft' });

    await t.service.revise(ctx, caller, 'ra-1', revision());

    expect(t.approvals.submit).not.toHaveBeenCalled();
    expect(t.approvals.abandon).not.toHaveBeenCalled();
    expect(t.updates[0]).toEqual(
      expect.objectContaining({ status: 'draft', revisionCount: 0 }),
    );
  });
});

describe('a revision measures the award, not itself', () => {
  it('leaves the bill being revised out of its own to-date figure', async () => {
    const t = build({ status: 'approved' });

    await t.service.revise(ctx, caller, 'ra-1', revision());

    // Without this exclusion the bill's own 40 Cum count as previously billed, and reducing a
    // quantity on a fully-measured award is refused for exceeding the award it is reducing.
    expect(t.groupByCalls[0].where).toEqual(
      expect.objectContaining({ raBillId: { not: 'ra-1' } }),
    );
  });

  it('still refuses a revision that measures past the award', async () => {
    const t = build({
      status: 'approved',
      awardedQty: 100,
      measuredByOthers: 90,
    });

    await expect(
      t.service.revise(
        ctx,
        caller,
        'ra-1',
        revision({
          lines: [{ workOrderBoqItemId: 'aw-1', quantity: 20 }],
        }),
      ),
    ).rejects.toThrow(/measure more than the work order awarded/);
  });
});

describe('a revision has to say why (FR-016)', () => {
  it('refuses an empty reason', async () => {
    const t = build({ status: 'approved' });

    await expect(
      t.service.revise(ctx, caller, 'ra-1', revision({ reason: '   ' })),
    ).rejects.toThrow(/Say why the quantities changed/);
    expect(t.approvals.submit).not.toHaveBeenCalled();
  });

  it('refuses a revision with no lines', async () => {
    const t = build({ status: 'approved' });

    await expect(
      t.service.revise(ctx, caller, 'ra-1', revision({ lines: [] })),
    ).rejects.toThrow(/at least one line/);
  });
});

describe('a bill raised before 018 has no award to re-measure against', () => {
  it('says to raise a new bill rather than inventing an award', async () => {
    const t = build({ status: 'approved', workOrderId: null });

    await expect(
      t.service.revise(ctx, caller, 'ra-1', revision()),
    ).rejects.toThrow(/no award to measure against/);
    expect(t.approvals.submit).not.toHaveBeenCalled();
  });
});

describe('submitting for certification', () => {
  it('asks the spine before writing the status', async () => {
    const t = build({ status: 'draft' });

    await t.service.submitForCertification(ctx, caller, 'ra-1');

    expect(t.approvals.submit).toHaveBeenCalledTimes(1);
    expect(t.updates[0]).toEqual(
      expect.objectContaining({ status: 'submitted' }),
    );
  });

  it('leaves the bill in draft when the chain is not configured', async () => {
    const t = build({ status: 'draft', submitThrows: true });

    await expect(
      t.service.submitForCertification(ctx, caller, 'ra-1'),
    ).rejects.toThrow('no active approval chain');

    // A bill flipped to submitted with no instance behind it waits on nobody, sits in no queue,
    // and looks to its author exactly like one that was submitted.
    expect(t.updates).toEqual([]);
  });

  it('refuses a bill that has already left draft', async () => {
    const t = build({ status: 'approved' });

    await expect(
      t.service.submitForCertification(ctx, caller, 'ra-1'),
    ).rejects.toThrow(/already approved/);
    expect(t.approvals.submit).not.toHaveBeenCalled();
  });
});

describe('completion is what certifies the bill', () => {
  it('records the approver read back through the spine, not from its tables', async () => {
    const t = build({ status: 'submitted', latestDeciderId: 'director-1' });

    await t.service.onApprovalCompleted({
      entityType: ACTION_RA_BILL,
      entityId: 'ra-1',
      companyId: 'co-1',
      instanceId: 'ai-1',
    });

    expect(t.updateManyCalls[0]).toEqual(
      expect.objectContaining({
        // Guarded on still being `submitted`: a second delivery of the event is normal, and a
        // revision raced against a completion must not re-certify quantities that have changed.
        where: { id: 'ra-1', status: 'submitted' },
        data: expect.objectContaining({
          status: 'approved',
          approvedByUserId: 'director-1',
        }),
      }),
    );
  });

  it('ignores an event for somebody else’s item', async () => {
    const t = build({ status: 'submitted' });

    await t.service.onApprovalCompleted({
      entityType: 'payroll_run',
      entityId: 'run-1',
      companyId: 'co-1',
      instanceId: 'ai-1',
    });

    expect(t.updateManyCalls).toEqual([]);
  });
});
