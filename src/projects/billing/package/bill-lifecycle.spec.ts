import {
  BillDeductionSection,
  BillDirection,
  BillPackageStatus,
  Prisma,
} from '@prisma/client';

import { BillPackageService } from './bill-package.service';

/**
 * A bill's road out of the building (2026-10-13): draft → approval → issue → shared → certified.
 *
 * Before this, issuing a package skipped approval altogether — the old RA bill sheet went through
 * the `ra_bill` chain and the package, which replaced it, did not — and a bill to the client had no
 * chain at all.
 */

const d = (value: string | number) => new Prisma.Decimal(value);

function build(pkg: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: 'pkg-1',
    companyId: 'co-1',
    projectId: 'p-1',
    sequenceNo: 3,
    counterpartyKey: 'wo-1',
    direction: BillDirection.to_subcontractor,
    status: BillPackageStatus.draft,
    claims: [
      {
        claimedQty: d('10'),
        clientBillLine: null,
        raBillLine: { rate: d('100') },
      },
    ],
    ...pkg,
  };
  const updates: Record<string, unknown>[] = [];
  const deductionWrites: unknown[] = [];
  const raBillUpdates: Record<string, unknown>[] = [];

  const tx = {
    $executeRaw: async () => 0,
    billPackage: {
      findFirst: async () => row,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: {
        where: { status?: BillPackageStatus };
        data: Record<string, unknown>;
      }) => {
        if (args.where.status && args.where.status !== row.status) {
          return { count: 0 };
        }
        updates.push(args.data);
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    billPackageDeduction: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: { data: unknown[] }) => {
        deductionWrites.push(...args.data);
        return { count: args.data.length };
      },
    },
    rABill: {
      update: async (args: { data: Record<string, unknown> }) => {
        raBillUpdates.push(args.data);
        return {};
      },
    },
    client: { findMany: async () => [] },
    workOrder: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const submitted: Record<string, unknown>[] = [];
  const abandoned: unknown[] = [];
  const approvals = {
    submit: async (input: Record<string, unknown>) => {
      submitted.push(input);
      return {};
    },
    abandon: async (...args: unknown[]) => {
      abandoned.push(args);
    },
    stateOfSystem: async () => ({
      latestDecision: { actorUserId: 'director-1' },
    }),
  };
  const sources = { vendorIdentitySource: () => null };

  const service = new BillPackageService(
    prisma as never,
    {} as never,
    {} as never,
    sources as never,
    approvals as never,
  );
  // The view and abstract reads are covered elsewhere; here only the transitions matter.
  jest.spyOn(service, 'view').mockResolvedValue(row as never);
  jest
    .spyOn(service, 'abstractFor')
    .mockResolvedValue({ columns: { thisBill: { payable: '1000' } } } as never);

  return {
    service,
    row,
    updates,
    submitted,
    abandoned,
    deductionWrites,
    raBillUpdates,
  };
}

const ctx = { isSuperAdmin: false, companyId: 'co-1' };

describe('sending a bill for approval', () => {
  it('puts a subcontractor bill into the ra_bill chain and locks it pending', async () => {
    const { service, row, submitted } = build({});
    await service.submitForApproval(ctx, 'co-1', 'u-1', 'pkg-1');

    expect(submitted[0]).toMatchObject({
      actionType: 'ra_bill',
      entityType: 'bill_package',
      entityId: 'pkg-1',
      href: '/dashboard/projects/portfolio/p-1/bill-packages/pkg-1',
    });
    expect(row.status).toBe(BillPackageStatus.pending_approval);
  });

  it('puts a bill to the client into the client_bill chain', async () => {
    const { service, submitted } = build({
      direction: BillDirection.to_client,
      counterpartyKey: 'client-1',
      claims: [
        {
          claimedQty: d('1'),
          clientBillLine: { rate: d('50'), boqTaskItem: { boqNo: '1.1' } },
          raBillLine: null,
        },
      ],
    });
    await service.submitForApproval(ctx, 'co-1', 'u-1', 'pkg-1');
    expect(submitted[0].actionType).toBe('client_bill');
  });

  it('refuses an unpriced line, which issue would refuse after the approver had signed', async () => {
    const { service } = build({
      claims: [
        {
          claimedQty: d('5'),
          clientBillLine: null,
          raBillLine: { rate: d('0') },
        },
      ],
    });
    await expect(
      service.submitForApproval(ctx, 'co-1', 'u-1', 'pkg-1'),
    ).rejects.toThrow(/no rate/);
  });
});

describe('what the chain decides', () => {
  it('approves the bill when the chain completes, naming who signed', async () => {
    const { service, row } = build({
      status: BillPackageStatus.pending_approval,
    });
    await service.onApprovalCompleted({
      entityType: 'bill_package',
      entityId: 'pkg-1',
      companyId: 'co-1',
      instanceId: 'i-1',
    });
    expect(row.status).toBe(BillPackageStatus.approved);
    expect(row.approvedByUserId).toBe('director-1');
  });

  it('ignores another module’s completion', async () => {
    const { service, row } = build({
      status: BillPackageStatus.pending_approval,
    });
    await service.onApprovalCompleted({
      entityType: 'ra_bill',
      entityId: 'pkg-1',
      companyId: 'co-1',
      instanceId: 'i-1',
    });
    expect(row.status).toBe(BillPackageStatus.pending_approval);
  });

  it('returns a rejected bill to draft, so it can be corrected and sent again', async () => {
    const { service, row } = build({
      status: BillPackageStatus.pending_approval,
    });
    await service.onApprovalRejected({
      entityType: 'bill_package',
      entityId: 'pkg-1',
      companyId: 'co-1',
    } as never);
    expect(row.status).toBe(BillPackageStatus.draft);
  });

  it('withdraws a pending bill to draft and closes its approval', async () => {
    const { service, row, abandoned } = build({
      status: BillPackageStatus.pending_approval,
    });
    await service.withdraw(ctx, 'co-1', 'pkg-1', 'Diesel recovery missed');
    expect(row.status).toBe(BillPackageStatus.draft);
    expect(abandoned[0]).toEqual([
      'bill_package',
      'pkg-1',
      'co-1',
      'Diesel recovery missed',
    ]);
  });
});

describe('issuing', () => {
  it.each([BillPackageStatus.draft, BillPackageStatus.pending_approval])(
    'refuses a %s bill — nothing leaves the company unapproved',
    async (status) => {
      const { service } = build({ status });
      await expect(service.issue(ctx, 'co-1', 'u-1', 'pkg-1')).rejects.toThrow(
        /not been approved/,
      );
    },
  );
});

describe('sharing and certifying', () => {
  it('refuses to mark a bill shared before it is issued', async () => {
    const { service } = build({ status: BillPackageStatus.approved });
    await expect(
      service.markShared(ctx, 'u-1', 'pkg-1', 'accounts@client'),
    ).rejects.toThrow(/Only an issued bill/);
  });

  it('certifying a subcontractor bill releases it for payment', async () => {
    // The payment screen reads the RA bill's `approved`, which only the old sheet's chain ever set
    // — so a package-built subcontractor bill could never be paid.
    const { service, row, raBillUpdates } = build({
      status: BillPackageStatus.issued,
      raBillId: 'ra-1',
      clientBillId: null,
    });
    await service.certify(ctx, 'u-1', 'pkg-1', { certifiedAmount: '1000.00' });
    expect(row.status).toBe(BillPackageStatus.certified);
    expect(raBillUpdates[0]).toMatchObject({ status: 'approved' });
  });
});

describe('a subcontractor bill’s own deduction lines', () => {
  it('sums recoveries and deductions separately onto the package', async () => {
    const { service, updates, deductionWrites } = build({});
    await service.setDeductionLines(ctx, 'pkg-1', [
      {
        section: BillDeductionSection.recovery,
        label: 'Diesel',
        amount: '1200',
      },
      {
        section: BillDeductionSection.recovery,
        label: 'Camp rent',
        amount: '300',
      },
      {
        section: BillDeductionSection.deduction,
        label: 'Penalty',
        amount: '500',
      },
    ]);
    expect(deductionWrites).toHaveLength(3);
    const last = updates[updates.length - 1];
    expect((last.customRecoveries as Prisma.Decimal).toFixed(2)).toBe(
      '1500.00',
    );
    expect((last.customDeductions as Prisma.Decimal).toFixed(2)).toBe('500.00');
  });

  it('refuses two lines with one description, whose running totals would merge', async () => {
    const { service } = build({});
    await expect(
      service.setDeductionLines(ctx, 'pkg-1', [
        {
          section: BillDeductionSection.recovery,
          label: 'Diesel',
          amount: '1',
        },
        {
          section: BillDeductionSection.recovery,
          label: 'diesel ',
          amount: '2',
        },
      ]),
    ).rejects.toThrow(/appears twice/);
  });

  it('refuses them on a bill to the client, whose abstract has no row for them', async () => {
    const { service } = build({ direction: BillDirection.to_client });
    await expect(
      service.setDeductionLines(ctx, 'pkg-1', [
        {
          section: BillDeductionSection.deduction,
          label: 'Penalty',
          amount: '1',
        },
      ]),
    ).rejects.toThrow(/subcontractor bills/);
  });

  it('refuses them once the bill has left draft', async () => {
    const { service } = build({ status: BillPackageStatus.pending_approval });
    await expect(service.setDeductionLines(ctx, 'pkg-1', [])).rejects.toThrow(
      /Withdraw it/,
    );
  });
});
