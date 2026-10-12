import { ClientBillsService } from './client-bills.service';
import { BILLING_ERRORS } from './billing-error-codes';

const dec = (value: number) => ({
  toNumber: () => value,
  equals: (other: { toNumber: () => number }) => value === other.toNumber(),
});

const ctx = { isSuperAdmin: false, companyId: 'co-1' };

/** Enough of a BOQ line for `view()` to sort and label by; the figures are the line's own. */
const onBoq = (boqNo: string) => ({
  id: 'boq-1',
  boqNo,
  taskName: 'Excavation',
  unit: 'Cum',
  scopeQty: dec(1000),
  isVariation: false,
  variationRef: null,
  group: { id: 'grp-1', name: 'Earthwork' },
});

/**
 * Client certification (018 FR-005, Phase 8, T044; amended 2026-10-11).
 *
 * The client confirmed on 2026-10-03 that **both figures must be kept** — overwriting the claim
 * with the certified figure was offered and declined. That still holds and is still asserted
 * below: `grossAmount`, `netAmount` and each line's billed `quantity` are never written by a
 * certification, so the record that somebody disagreed survives.
 *
 * **What changed on 2026-10-11 is what the next bill measures against.** The client reported it:
 * nine items billed, eight certified, and all nine stayed deducted from the outstanding BOQ — so
 * the ninth could never be claimed again without over-measuring. The cumulative figure now counts
 * `certifiedQty ?? quantity`, which frees exactly the quantity the client sent back and nothing
 * else.
 *
 * The test this replaces asserted the opposite, as a structural proxy: that the cumulative query's
 * filter mentioned no certification. That proxy is now wrong by construction — the query reads the
 * column — so it is replaced by an assertion on the figure itself, which is what the proxy was
 * standing in for.
 */
function build(
  bill: Record<string, unknown> | null,
  /** The rows `previouslyBilled` finds — what every earlier bill claimed and certified. */
  billedLines: Record<string, unknown>[] = [],
) {
  const updated: Record<string, unknown>[] = [];
  /** Every line-level write a certification made, so the test can read them. */
  const lineUpdates: Record<string, unknown>[] = [];

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
      findMany: async () => billedLines,
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        lineUpdates.push({ id: args.where.id, ...args.data });
        return args.data;
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
    // No storage here: these tests never upload a certificate, and a stub that threw
    // would be the more honest shape if one of them ever started to.
    service: new ClientBillsService(prisma as never, {} as never),
    updated,
    lineUpdates,
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

    await service.certify(ctx, 'bill-1', { certifiedAmount: 90000 });

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
   * **T043, amended 2026-10-11 — the reported case.**
   *
   * Billed 100, certified 80. The scope is 1000, so what is left to bill must be 920 and not 900:
   * the 20 the client sent back is claimable again.
   *
   * Asserted on the outstanding figure rather than on the query's shape. The old version of this
   * test read the filter and checked it mentioned no certification, which was a proxy for the
   * behaviour and is now exactly backwards. A figure is what the biller reads.
   */
  it('returns the uncertified quantity to the outstanding BOQ', async () => {
    const { service } = build(submittedBill(), [
      { boqTaskItemId: 'boq-1', quantity: dec(100), certifiedQty: dec(80) },
    ]);

    const boq = await service.billableBoq(ctx, 'p-1');
    const [line] = boq.groups[0].items;

    expect(line.previouslyBilledQty).toBe(80);
    expect(line.remainingQty).toBe(920);
  });

  /**
   * The other half, and the one that makes the first half mean something: a line nobody certified
   * line by line still counts at what was billed.
   *
   * Without this, "count the certified quantity" would read as "count nothing until certification",
   * and every submitted bill would stop holding its own scope — so the same work could be billed
   * twice over while the first bill was still with the client.
   */
  it('counts the billed quantity where the client did not certify line by line', async () => {
    const { service } = build(submittedBill(), [
      { boqTaskItemId: 'boq-1', quantity: dec(100), certifiedQty: null },
    ]);

    const boq = await service.billableBoq(ctx, 'p-1');
    const [line] = boq.groups[0].items;

    expect(line.previouslyBilledQty).toBe(100);
    expect(line.remainingQty).toBe(900);
  });

  /**
   * Zero is not null. A line certified at nothing gives its whole quantity back; a line nobody
   * mentioned does not. Collapsing the two is the single mistake this column exists to prevent.
   */
  it('treats a line certified at nothing as nothing billed', async () => {
    const { service } = build(submittedBill(), [
      { boqTaskItemId: 'boq-1', quantity: dec(100), certifiedQty: dec(0) },
    ]);

    const boq = await service.billableBoq(ctx, 'p-1');
    const [line] = boq.groups[0].items;

    expect(line.previouslyBilledQty).toBe(0);
    expect(line.remainingQty).toBe(1000);
  });

  /**
   * Certifying line by line writes the lines and derives the total from them.
   *
   * The amount is **not** taken alongside the lines: a certified total and a set of certified
   * lines that disagree is two answers to one question, and the lines are the ones the schedule is
   * counted from.
   */
  it('derives the certified amount from the lines and ignores a supplied total', async () => {
    const bill = submittedBill({
      lines: [
        {
          id: 'line-1',
          boqTaskItemId: 'boq-1',
          quantity: dec(100),
          rate: dec(251),
          amount: dec(25100),
          certifiedQty: null,
          exceedsScope: false,
          overScopeReason: null,
          boqTaskItem: onBoq('1.01'),
        },
        {
          id: 'line-2',
          boqTaskItemId: 'boq-2',
          quantity: dec(40),
          rate: dec(100),
          amount: dec(4000),
          certifiedQty: null,
          exceedsScope: false,
          overScopeReason: null,
          boqTaskItem: onBoq('1.02'),
        },
      ],
    });
    const { service, updated, lineUpdates } = build(bill);

    await service.certify(ctx, 'bill-1', {
      // Deliberately wrong, and deliberately ignored.
      certifiedAmount: 1,
      lines: [{ lineId: 'line-1', certifiedQty: 80 }],
    });

    // 80 × 251 + 40 × 100 — the second line was not mentioned, so it stands at what was
    // billed. Silence is "not said", never "certified at nothing".
    expect(updated[0]).toMatchObject({ certifiedAmount: 24080 });
    expect(lineUpdates).toEqual([{ id: 'line-1', certifiedQty: 80 }]);
  });

  it('refuses a line certified above what it was billed at', async () => {
    const bill = submittedBill({
      lines: [
        {
          id: 'line-1',
          boqTaskItemId: 'boq-1',
          quantity: dec(100),
          rate: dec(251),
          amount: dec(25100),
          certifiedQty: null,
          exceedsScope: false,
          overScopeReason: null,
          boqTaskItem: onBoq('1.01'),
        },
      ],
    });
    const { service, updated } = build(bill);

    await expect(
      service.certify(ctx, 'bill-1', {
        lines: [{ lineId: 'line-1', certifiedQty: 101 }],
      }),
    ).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.certifiedExceedsBilled },
    });
    expect(updated).toHaveLength(0);
  });

  it('refuses a certification larger than the bill', async () => {
    const { service, updated } = build(submittedBill());

    await expect(
      service.certify(ctx, 'bill-1', { certifiedAmount: 100001 }),
    ).rejects.toMatchObject({
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

    await expect(
      service.certify(ctx, 'bill-1', { certifiedAmount: 50000 }),
    ).rejects.toMatchObject({
      response: { code: BILLING_ERRORS.notSubmitted },
    });
    expect(updated).toHaveLength(0);
  });

  it('accepts a certification equal to the bill', async () => {
    const { service, updated } = build(submittedBill());

    await service.certify(ctx, 'bill-1', { certifiedAmount: 100000 });

    expect(updated[0]).toMatchObject({ certifiedAmount: 100000 });
  });
});
