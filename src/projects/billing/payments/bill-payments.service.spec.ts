import { Prisma, RaBillStatus } from '@prisma/client';

import { BillPaymentsService } from './bill-payments.service';

/**
 * Payments against a running-account bill, and the figure derived from them (028 FR-021, task T049).
 *
 * ## The assertion is the outstanding figure, never the row
 *
 * **Vacuity note, carried from the plan**: _asserting the payment row exists proves the write, not
 * the derivation._ A service that recorded every payment perfectly and reported outstanding as the
 * certified amount would pass a row-exists test on every one of them, and the screen would show a
 * subcontractor still owed money they had been paid. So every test here reads
 * `outstandingAmount` — the number somebody acts on.
 *
 * The part payment is the case that matters. Nil-paid and fully-paid both come out right under a
 * derivation that ignores payments entirely or one that ignores the certified figure; only ₹60,000
 * against ₹100,000 distinguishes a subtraction from either.
 */

interface BillFixture {
  id: string;
  billNumber: string;
  status: RaBillStatus;
  netPayable: string;
  acknowledgedAt?: Date | null;
  workOrderId?: string | null;
  payments?: { id: string; amount: string; paidOn: string }[];
}

function harness(bills: BillFixture[]) {
  const created: Record<string, unknown>[] = [];

  const hydrate = (bill: BillFixture) => ({
    id: bill.id,
    billNumber: bill.billNumber,
    projectId: 'project-1',
    workOrderId: bill.workOrderId ?? 'wo-1',
    status: bill.status,
    netPayable: new Prisma.Decimal(bill.netPayable),
    acknowledgedAt: bill.acknowledgedAt ?? null,
    payments: (bill.payments ?? []).map((payment) => ({
      id: payment.id,
      raBillId: bill.id,
      paidOn: new Date(`${payment.paidOn}T00:00:00.000Z`),
      amount: new Prisma.Decimal(payment.amount),
      instrument: 'bank_transfer' as const,
      reference: null,
      remarks: null,
      recordedAt: new Date('2026-10-01T00:00:00.000Z'),
    })),
  });

  const tx = {
    $executeRaw: async () => 0,
    rABill: {
      findFirst: async (args: { where: { id: string } }) => {
        const found = bills.find((bill) => bill.id === args.where.id);
        return found ? hydrate(found) : null;
      },
      findMany: async () => bills.map(hydrate),
    },
    rABillPayment: {
      aggregate: async (args: { where: { raBillId: string } }) => {
        const bill = bills.find((b) => b.id === args.where.raBillId);
        const sum = (bill?.payments ?? []).reduce(
          (total, payment) => total.plus(new Prisma.Decimal(payment.amount)),
          new Prisma.Decimal(0),
        );
        return { _sum: { amount: sum } };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        // Written back into the fixture, so the view read afterwards is the view a caller gets
        // **after** their own payment — which is the whole of what this suite is checking.
        const bill = bills.find((b) => b.id === args.data.raBillId);
        if (bill) {
          bill.payments = [
            ...(bill.payments ?? []),
            {
              id: `payment-${created.length}`,
              amount: String(args.data.amount),
              paidOn: '2026-09-28',
            },
          ];
        }
        return args.data;
      },
      deleteMany: async () => ({ count: 1 }),
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return { service: new BillPaymentsService(prisma as never), created };
}

const CTX = { isSuperAdmin: false, companyId: 'company-1' };

describe('outstanding on a part payment', () => {
  it('reports 40,000 outstanding on a bill certified at 100,000 with 60,000 paid', async () => {
    const { service, created } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-03',
        status: RaBillStatus.approved,
        netPayable: '100000.00',
      },
    ]);

    const view = await service.record(
      CTX,
      'company-1',
      'bill-1',
      {
        paidOn: '2026-09-28',
        amount: '60000.00',
        instrument: 'bank_transfer',
        reference: 'UTR 316902847561',
      },
      { userId: 'user-1' },
    );

    // **The figure, not the row.** `created` is checked only to show the write did happen — the
    // assertion that defends FR-021 is the one below it, and a derivation that returned the
    // certified amount would satisfy the first and fail the second.
    expect(created).toHaveLength(1);
    expect(view.certifiedAmount).toBe('100000.00');
    expect(view.paidAmount).toBe('60000.00');
    expect(view.outstandingAmount).toBe('40000.00');
  });

  it('closes to exactly zero across three part payments of a third each', async () => {
    // Summed in `Decimal`. In floating point this leaves 0.000000000004 outstanding, and a bill
    // that will not close is a bill somebody chases every month for the rest of its life.
    const { service } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-04',
        status: RaBillStatus.approved,
        netPayable: '100000.00',
        payments: [
          { id: 'p1', amount: '33333.33', paidOn: '2026-08-01' },
          { id: 'p2', amount: '33333.33', paidOn: '2026-09-01' },
        ],
      },
    ]);

    const view = await service.record(
      CTX,
      'company-1',
      'bill-1',
      { paidOn: '2026-10-01', amount: '33333.34', instrument: 'cheque' },
      { userId: 'user-1' },
    );

    expect(view.paidAmount).toBe('100000.00');
    expect(view.outstandingAmount).toBe('0.00');
  });

  it('refuses a payment against a bill nobody has certified', async () => {
    const { service, created } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-05',
        status: RaBillStatus.draft,
        netPayable: '100000.00',
      },
    ]);

    await expect(
      service.record(
        CTX,
        'company-1',
        'bill-1',
        {
          paidOn: '2026-09-28',
          amount: '60000.00',
          // `bank_transfer` rather than `cash`, and not arbitrarily: `instrument` joined
          // `CASH_MODE_FIELDS` with this feature, and `cash-entry-surface.spec.ts` greps `src/`
          // for a cash mode written anywhere outside the gate. A fixture here would have been
          // flagged as a service deciding a payment was cash. Nothing in this suite is about the
          // instrument, so the guard keeps its teeth and the test loses nothing.
          instrument: 'bank_transfer',
        },
        { userId: 'user-1' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_BILL_NOT_CERTIFIED' },
    });
    // Refused **and** nothing written. A guard that throws after the insert leaves the money
    // recorded against an uncertified bill and reports an error nobody can act on.
    expect(created).toHaveLength(0);
  });

  it('refuses a payment that would take the total past what was certified', async () => {
    const { service } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-06',
        status: RaBillStatus.approved,
        netPayable: '100000.00',
        payments: [{ id: 'p1', amount: '60000.00', paidOn: '2026-08-01' }],
      },
    ]);

    await expect(
      service.record(
        CTX,
        'company-1',
        'bill-1',
        {
          paidOn: '2026-09-28',
          amount: '41000.00',
          instrument: 'bank_transfer',
        },
        { userId: 'user-1' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_EXCEEDS_CERTIFIED' },
    });
  });

  it('allows the payment that settles the bill to the paisa', async () => {
    // The boundary in the other direction: a guard written with `>=` would refuse the final
    // payment of every bill, which is a worse defect than the one it was guarding against.
    const { service } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-07',
        status: RaBillStatus.approved,
        netPayable: '100000.00',
        payments: [{ id: 'p1', amount: '60000.00', paidOn: '2026-08-01' }],
      },
    ]);

    const view = await service.record(
      CTX,
      'company-1',
      'bill-1',
      { paidOn: '2026-09-28', amount: '40000.00', instrument: 'bank_transfer' },
      { userId: 'user-1' },
    );

    expect(view.outstandingAmount).toBe('0.00');
  });
});

describe('outstanding across a subcontractor’s bills', () => {
  it('adds up the bills rather than answering about one of them', async () => {
    // The question a subcontractor actually asks. Answered bill by bill, somebody adds six figures
    // up in their head and the number they come back with is the one that gets paid.
    const { service } = harness([
      {
        id: 'bill-1',
        billNumber: 'RA-01',
        status: RaBillStatus.approved,
        netPayable: '100000.00',
        payments: [{ id: 'p1', amount: '100000.00', paidOn: '2026-07-01' }],
      },
      {
        id: 'bill-2',
        billNumber: 'RA-02',
        status: RaBillStatus.approved,
        netPayable: '250000.00',
        payments: [{ id: 'p2', amount: '90000.00', paidOn: '2026-08-01' }],
      },
    ]);

    const view = await service.outstandingForSubcontractor(CTX, 'partner-1');

    expect(view.certifiedAmount).toBe('350000.00');
    expect(view.paidAmount).toBe('190000.00');
    expect(view.outstandingAmount).toBe('160000.00');
    // And each bill still carries its own, because "which bill is this against" is the next
    // question after the total.
    expect(
      view.bills.map((bill) => [bill.billNumber, bill.outstandingAmount]),
    ).toEqual([
      ['RA-01', '0.00'],
      ['RA-02', '160000.00'],
    ]);
  });
});
