import { ClientBillsService } from './client-bills.service';
import { BILLING_ERRORS } from './billing-error-codes';

const dec = (value: number) => ({
  toNumber: () => value,
  equals: (other: { toNumber: () => number }) => value === other.toNumber(),
});

const ctx = { isSuperAdmin: false, companyId: 'co-1' };

/**
 * Client certification (018 FR-005, Phase 8, T044).
 *
 * The client confirmed on 2026-10-03 that their bills are certified and that **both figures must be
 * kept** — overwriting the claim with the certified figure was offered and declined.
 *
 * The property worth pinning is not that two columns exist. It is that a short certification does
 * not quietly reduce what was billed: cumulative billed quantity is what the next bill measures
 * against, so a shortfall absorbed there would be billed a second time or never again, and either
 * way the record that there was a disagreement is gone.
 */
function build(bill: Record<string, unknown> | null) {
  const updated: Record<string, unknown>[] = [];
  /** Every filter `previouslyBilled` has asked the database for, so the test can read it. */
  const groupByCalls: Record<string, unknown>[] = [];

  const tx = {
    $executeRaw: async () => 0,
    clientBill: {
      findFirst: async () => bill,
      findMany: async () => (bill ? [bill] : []),
      update: async (args: { data: Record<string, unknown> }) => {
        updated.push(args.data);
        // Written back as the database would hand it to the next read — a Decimal, not the plain
        // number the caller passed. Without this the `view()` that follows `certify` reads a bare
        // number and the test passes against a shape production never produces.
        Object.assign(bill ?? {}, {
          ...args.data,
          ...(typeof args.data.certifiedAmount === 'number'
            ? { certifiedAmount: dec(args.data.certifiedAmount) }
            : {}),
        });
        return bill;
      },
    },
    clientBillLine: {
      groupBy: async (args: Record<string, unknown>) => {
        groupByCalls.push(args);
        return [];
      },
    },
    bOQTaskItem: { findMany: async () => [] },
    project: {
      findFirst: async () => ({ id: 'p-1', quotedPercentage: dec(0) }),
    },
    // One group with one line, so `previouslyBilled` actually runs — it returns early on an empty
    // id list, and an empty BOQ would make the assertion below pass without exercising anything.
    bOQTaskGroup: {
      findMany: async () => [
        {
          id: 'grp-1',
          boqNo: '1',
          name: 'Earthwork',
          items: [
            {
              id: 'boq-1',
              boqNo: '1.01',
              taskName: 'Excavation',
              unit: 'Cum',
              scopeQty: dec(1000),
              rate: dec(251),
              isVariation: false,
              variationRef: null,
            },
          ],
        },
      ],
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return {
    service: new ClientBillsService(prisma as never),
    updated,
    groupByCalls,
  };
}

const submittedBill = (over: Record<string, unknown> = {}) => ({
  id: 'bill-1',
  projectId: 'p-1',
  billNumber: 'RA-01',
  description: null,
  billingDate: new Date('2026-09-30'),
  status: 'submitted',
  quotedPercentage: dec(0),
  grossAmount: dec(100000),
  retentionAmount: dec(0),
  netAmount: dec(100000),
  certifiedAmount: null,
  certifiedAt: null,
  submittedAt: new Date('2026-09-30'),
  lines: [],
  ...over,
});

describe('certify keeps both figures (FR-005)', () => {
  it('records what the client certified without touching what was billed', async () => {
    const { service, updated } = build(submittedBill());

    await service.certify(ctx, 'bill-1', 90000);

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      status: 'certified',
      certifiedAmount: 90000,
    });
    // The claim is not among the fields written. Absent, not equal — a bill that rewrote its own
    // gross to match the certification would pass an equality check against the new value.
    expect(updated[0]).not.toHaveProperty('grossAmount');
    expect(updated[0]).not.toHaveProperty('netAmount');
  });

  /**
   * **T043, and the reason this phase is not just two columns.**
   *
   * `previouslyBilled` is what the next bill measures against. It aggregates bill *lines* on bills
   * out of draft, and the filter must never mention certification: if a short certification reduced
   * the cumulative quantity, the shortfall would come back as billable scope and be billed twice —
   * or, if it went the other way, vanish with no record that anybody disagreed.
   *
   * Asserted against the query itself rather than through an outcome, because the outcome is a sum
   * the mock supplies. The structure *is* the guarantee here.
   */
  it('does not let certification into the cumulative billed quantity', async () => {
    const { service, groupByCalls } = build(submittedBill());

    await service.billableBoq(ctx, 'p-1');

    expect(groupByCalls.length).toBeGreaterThan(0);
    for (const call of groupByCalls) {
      const filter = JSON.stringify(call.where);
      expect(filter).not.toContain('certified');
      // What it does filter on: drafts, which have been withheld from nobody.
      expect(filter).toContain('draft');
    }
  });

  it('refuses a certification larger than the bill', async () => {
    const { service, updated } = build(submittedBill());

    await expect(service.certify(ctx, 'bill-1', 100001)).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.certifiedExceedsBilled },
    });
    expect(updated).toHaveLength(0);
  });

  /**
   * A draft has not been sent to anybody, so there is nothing for a client to have certified.
   * Allowing it would let a bill reach `certified` without ever having been claimed.
   */
  it('refuses to certify a bill that was never submitted', async () => {
    const { service, updated } = build(submittedBill({ status: 'draft' }));

    await expect(service.certify(ctx, 'bill-1', 50000)).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.notSubmitted },
    });
    expect(updated).toHaveLength(0);
  });

  it('accepts a certification equal to the bill', async () => {
    const { service, updated } = build(submittedBill());

    await service.certify(ctx, 'bill-1', 100000);

    expect(updated[0]).toMatchObject({ certifiedAmount: 100000 });
  });
});
