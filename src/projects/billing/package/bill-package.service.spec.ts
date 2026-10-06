import { BillDirection, ClaimProposalSource, Prisma } from '@prisma/client';

import { BillPackageService, packageLabel } from './bill-package.service';

/**
 * Composing a running-account bill package (023 US1, tasks T030 to T033).
 *
 * **T031 is the assertion this phase turns on**, and it is here as its own test rather than a line
 * inside another: an award line mapped to no BOQ line must propose *no measurement available* and
 * not zero. The two are the same number in every obvious implementation, and the direction they
 * differ on is the one the company bills every month.
 */

/**
 * A **real** `Prisma.Decimal`, not a hand-rolled stand-in.
 *
 * The neighbouring specs in this directory use `{ toNumber: () => value }`, which is enough there
 * because the code under test only ever reads the number out. It is not enough here: this service
 * does decimal *arithmetic* — `claimed.minus(proposed)`, `claimed.greaterThan(proposed)` — and a
 * real `Decimal` refuses an operand that is not one. The first version of this file used the
 * tolerant fake and the tests passed a plain object into real decimal arithmetic, which threw
 * `[DecimalError] Invalid argument` from inside the service rather than failing the assertion it
 * was meant to make. A fake looser than the thing it stands for is a test that passes for the
 * wrong reason.
 */
const dec = (value: number | string) => new Prisma.Decimal(value);

interface BoqFixture {
  id: string;
  boqNo: string;
  rate: number;
  scopeQty: number;
}

interface AwardFixture {
  id: string;
  description: string;
  rate: number;
  awardedQty: number;
  /** Null is the case T031 exists for. */
  boqTaskItemId: string | null;
}

interface Built {
  service: BillPackageService;
  /** Every claim row the composition wrote, in order. */
  claims: Record<string, unknown>[];
  /** Every bill line it wrote. */
  billLines: Record<string, unknown>[];
  /** How many write statements the transaction issued. */
  writeStatements: () => number;
  /** The package row it wrote. */
  pkg: () => Record<string, unknown> | null;
}

function build(opts: {
  direction?: BillDirection;
  boq?: BoqFixture[];
  award?: AwardFixture[];
  /** `boqItemId` → quantity approved in the period, as 022 returns it. */
  approved?: Record<string, string>;
  /** An existing package occupying a period, for the overlap tests. */
  occupying?: {
    id: string;
    sequenceNo: number;
    status: string;
    periodFrom: string;
    periodTo: string;
  } | null;
  clientRetentionFraction?: number | null;
  lastSequenceNo?: number;
  /** The claim `setClaim` reads, for the reason tests. */
  claim?: Record<string, unknown>;
}): Built {
  const direction = opts.direction ?? BillDirection.to_client;
  const boq = opts.boq ?? [
    { id: 'boq-1', boqNo: '30.10', rate: 1000, scopeQty: 100 },
  ];
  const award = opts.award ?? [];
  const claims: Record<string, unknown>[] = [];
  const billLines: Record<string, unknown>[] = [];
  const claimUpdates: Record<string, unknown>[] = [];
  let pkgRow: Record<string, unknown> | null = null;
  let writes = 0;

  const tx = {
    $executeRaw: async () => 0,
    project: {
      findFirst: async () => ({
        id: 'p-1',
        clientId: 'client-1',
        cgstApplicable: true,
        quotedPercentage: dec(0),
        clientRetentionFraction:
          opts.clientRetentionFraction === null
            ? null
            : dec(opts.clientRetentionFraction ?? 0.05),
      }),
    },
    workOrder: {
      findFirst: async () => ({
        id: 'wo-1',
        retentionPercent: dec(0.05),
        partnerId: 'vendor-1',
      }),
    },
    client: {
      findFirst: async () => ({ gstin: '08AABCNHAI1D1ZX' }),
    },
    bOQTaskItem: {
      findMany: async () =>
        boq.map((item) => ({
          id: item.id,
          boqNo: item.boqNo,
          taskName: `Task ${item.boqNo}`,
          unit: 'Cum',
          scopeQty: dec(item.scopeQty),
          rate: dec(item.rate),
        })),
    },
    workOrderBOQItem: {
      findMany: async () =>
        award.map((item) => ({
          id: item.id,
          description: item.description,
          unit: 'Nos',
          awardedQty: dec(item.awardedQty),
          rate: dec(item.rate),
          boqTaskItemId: item.boqTaskItemId,
          boqTaskItem: item.boqTaskItemId ? { boqNo: '30.10' } : null,
        })),
    },
    billPackage: {
      findFirst: async (args: {
        where: Record<string, unknown>;
        include?: unknown;
      }) => {
        // The view's read, after composition — or after FR-007 returned a package that already
        // existed, in which case nothing was written and the occupying row is what the caller gets.
        if (args.include) {
          if (pkgRow) return pkgRow;
          const reused = opts.occupying;
          if (!reused) return null;
          return {
            id: reused.id,
            projectId: 'p-1',
            direction,
            sequenceNo: reused.sequenceNo,
            periodFrom: new Date(reused.periodFrom),
            periodTo: new Date(reused.periodTo),
            status: reused.status,
            retentionFraction: dec(0.05),
            cgstFraction: dec(0.09),
            sgstFraction: dec(0.09),
            igstFraction: dec(0.18),
            tdsFraction: dec(0.02),
            counterpartyKey: 'client-1',
            claims: [],
          };
        }
        // `nextSequenceNo` asks for the highest number so far.
        if (args.where.counterpartyKey && !args.where.periodFrom) {
          return opts.lastSequenceNo
            ? { sequenceNo: opts.lastSequenceNo }
            : null;
        }
        // The overlap check.
        const occupying = opts.occupying;
        if (!occupying) return null;
        return {
          id: occupying.id,
          sequenceNo: occupying.sequenceNo,
          status: occupying.status,
          periodFrom: new Date(occupying.periodFrom),
          periodTo: new Date(occupying.periodTo),
        };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        writes += 1;
        pkgRow = {
          id: 'pkg-1',
          projectId: 'p-1',
          direction,
          sequenceNo: args.data.sequenceNo,
          periodFrom: new Date(String(args.data.periodFrom)),
          periodTo: new Date(String(args.data.periodTo)),
          status: args.data.status,
          retentionFraction: dec(String(args.data.retentionFraction)),
          cgstFraction: dec(String(args.data.cgstFraction)),
          sgstFraction: dec(String(args.data.sgstFraction)),
          igstFraction: dec(String(args.data.igstFraction)),
          tdsFraction: dec(String(args.data.tdsFraction)),
          counterpartyKey: args.data.counterpartyKey,
          taxBasis: args.data.taxBasis,
          taxBasisSource: args.data.taxBasisSource,
          claims: [],
        };
        return { id: 'pkg-1' };
      },
      updateMany: async () => ({ count: 1 }),
    },
    clientBill: {
      // Read by `nextClientBillNumber` (027) to continue this project's sequence. A read, so it
      // deliberately does not touch `writes` — the "one statement for the bill" assertion counts
      // writes, and allocating a number is not one.
      findMany: async () => [],
      create: async () => {
        writes += 1;
        return { id: 'bill-1' };
      },
    },
    rABill: {
      // Read by `nextRaBillNumber` (027) to continue this work order's sequence. A read, so it
      // deliberately does not touch `writes` — the "one statement for the bill" assertion below
      // counts writes, and allocating a number is not one.
      findMany: async () => [],
      create: async () => {
        writes += 1;
        return { id: 'bill-1' };
      },
    },
    clientBillLine: {
      createManyAndReturn: async (args: {
        data: Record<string, unknown>[];
      }) => {
        writes += 1;
        billLines.push(...args.data);
        return args.data.map((row, index) => ({
          id: `line-${index}`,
          boqTaskItemId: row.boqTaskItemId as string,
        }));
      },
    },
    rABillLine: {
      createManyAndReturn: async (args: {
        data: Record<string, unknown>[];
      }) => {
        writes += 1;
        billLines.push(...args.data);
        return args.data.map((row, index) => ({
          id: `line-${index}`,
          workOrderBoqItemId: row.workOrderBoqItemId as string,
        }));
      },
    },
    billPackageLineClaim: {
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        writes += 1;
        claims.push(...args.data);
        if (pkgRow) {
          // What the view would read back, hydrated the way Prisma returns it.
          pkgRow.claims = args.data.map((row, index) => ({
            id: `claim-${index}`,
            proposedQty:
              row.proposedQty === null
                ? null
                : dec(Number(row.proposedQty ?? 0)),
            proposalSource: row.proposalSource,
            claimedQty: dec(Number(row.claimedQty ?? 0)),
            varianceQty:
              row.varianceQty === null ? null : dec(Number(row.varianceQty)),
            reason: row.reason ?? null,
            overClaimed: row.overClaimed ?? false,
            clientBillLine:
              direction === BillDirection.to_client
                ? {
                    id: `line-${index}`,
                    rate: dec(boq[index]?.rate ?? 0),
                    amount: dec(0),
                    quantity: dec(0),
                    exceedsScope: false,
                    boqTaskItem: {
                      id: boq[index]?.id ?? '',
                      boqNo: boq[index]?.boqNo ?? '',
                      taskName: 'Task',
                      unit: 'Cum',
                      scopeQty: dec(boq[index]?.scopeQty ?? 0),
                    },
                  }
                : null,
            raBillLine:
              direction === BillDirection.to_subcontractor
                ? {
                    id: `line-${index}`,
                    rate: dec(award[index]?.rate ?? 0),
                    amount: dec(0),
                    quantity: dec(0),
                    workOrderBoqItem: {
                      id: award[index]?.id ?? '',
                      description: award[index]?.description ?? '',
                      unit: 'Nos',
                      awardedQty: dec(award[index]?.awardedQty ?? 0),
                      boqTaskItem: null,
                    },
                  }
                : null,
          }));
        }
        return { count: args.data.length };
      },
      findFirst: async () => opts.claim ?? null,
      update: async (args: { data: Record<string, unknown> }) => {
        claimUpdates.push(args.data);
        return args.data;
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const periodFigures = {
    figuresFor: async () => ({
      from: '2025-12-21',
      to: '2026-01-20',
      lines: Object.entries(opts.approved ?? {}).map(([boqItemId, qty]) => ({
        boqItemId,
        boqNo: '30.10',
        taskName: 'Task',
        unit: 'Cum',
        scopeQty: '100.000',
        approvedInPeriod: qty,
        approvedBefore: '0.000',
        approvedUpToDate: qty,
        doneQty: qty,
      })),
    }),
  };

  const companies = {
    getBillingTaxRates: async () => ({
      cgstFraction: '0.090000',
      sgstFraction: '0.090000',
      igstFraction: '0.180000',
      tdsFraction: '0.020000',
    }),
    // Both parties in Rajasthan, as the client's own package has them.
    getBillingIdentity: async () => ({
      name: 'H.G. Infra Engineering Ltd',
      gstin: '08AABCH1234D1ZX',
      pan: 'AABCH1234D',
      state: 'Rajasthan',
      address: 'Jaipur',
    }),
  };

  // The registry, not an injected `VendorsService` — `PartnersModule` imports `ProjectsModule`, so
  // the dependency is inverted and `partners` registers itself (023 FR-026).
  const sources = {
    vendorIdentitySource: () => ({
      getBillingIdentity: async () => ({
        code: 'V-001',
        name: 'Parth Realcon Private Limited',
        gstin: '08AAMCP8659H1Z2',
        pan: 'AAMCP8659H',
        state: 'Rajasthan',
        address: 'Jaipur',
      }),
    }),
  };

  const service = new BillPackageService(
    prisma as never,
    periodFigures as never,
    companies as never,
    sources as never,
  );

  return {
    service,
    claims,
    billLines,
    writeStatements: () => writes,
    pkg: () => pkgRow,
    // Exposed for the reason tests.
    ...({ claimUpdates } as Record<string, unknown>),
  } as Built & { claimUpdates: Record<string, unknown>[] };
}

const period = {
  projectId: 'p-1',
  periodFrom: '2025-12-21',
  periodTo: '2026-01-20',
};

describe('composing a bill package', () => {
  it('proposes one line per schedule line, counted rather than inspected', async () => {
    // T032. Asserted as a **count against the schedule's own length**: an assertion over a returned
    // list passes just as happily over a short one, and a bill missing an item is a smaller invoice.
    const boq = Array.from({ length: 17 }, (_, i) => ({
      id: `boq-${i}`,
      boqNo: `30.${(i + 1) * 10}`,
      rate: 1000,
      scopeQty: 100,
    }));
    const built = build({ boq, approved: { 'boq-0': '1.000' } });

    await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_client,
    });

    expect(built.claims).toHaveLength(boq.length);
    expect(built.billLines).toHaveLength(boq.length);
  });

  it('writes a schedule of any size in four statements, not one per line', async () => {
    // T033. Research §8: a loop issuing one write per line was 132 sequential round trips inside a
    // five-second transaction budget — 0.17s locally, 5-7s against a hosted database, and a bare
    // 500 when it expired mid-write. The count must not scale with the schedule.
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      id: `boq-${i}`,
      boqNo: `${i}`,
      rate: 100,
      scopeQty: 10,
    }));
    const built = build({ boq: fifty });

    await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_client,
    });

    // The bill, its lines, the package, the claims.
    expect(built.writeStatements()).toBe(4);
  });

  it('refuses a period that overlaps one already billed, naming the bill', async () => {
    const built = build({
      occupying: {
        id: 'pkg-earlier',
        sequenceNo: 11,
        status: 'issued',
        periodFrom: '2025-12-01',
        periodTo: '2025-12-31',
      },
    });

    await expect(
      built.service.compose({ isSuperAdmin: true }, 'c-1', {
        ...period,
        direction: BillDirection.to_client,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'BILL_PERIOD_OVERLAPS',
        packageLabel: 'RA-11',
      },
    });
  });

  it('returns the existing package when the same period is opened again', async () => {
    // FR-007. A second package for one period would claim the same measurement twice, and refusing
    // outright would leave somebody unable to get back to the bill they already started.
    const built = build({
      occupying: {
        id: 'pkg-1',
        sequenceNo: 12,
        status: 'draft',
        periodFrom: '2025-12-21',
        periodTo: '2026-01-20',
      },
    });

    const view = await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_client,
    });

    expect(view.id).toBe('pkg-1');
    // Nothing was written: no second bill, no second set of lines.
    expect(built.writeStatements()).toBe(0);
  });

  it('refuses to open a package with no schedule, naming the absence', async () => {
    const built = build({ boq: [] });

    await expect(
      built.service.compose({ isSuperAdmin: true }, 'c-1', {
        ...period,
        direction: BillDirection.to_client,
      }),
    ).rejects.toMatchObject({ response: { code: 'BILL_NO_SCHEDULE' } });
  });

  it('refuses a client bill when no retention term is recorded, rather than billing at zero', async () => {
    // Research §4. A silent zero produces a bill with no retention and a payable 5% too high, which
    // is the error most likely to be paid before anybody notices — and the one nobody would trace
    // back to a null column.
    const built = build({ clientRetentionFraction: null });

    await expect(
      built.service.compose({ isSuperAdmin: true }, 'c-1', {
        ...period,
        direction: BillDirection.to_client,
      }),
    ).rejects.toMatchObject({
      response: { code: 'BILL_RATE_MISSING', missingRate: 'retentionFraction' },
    });
  });

  it('refuses an inverted period', async () => {
    const built = build({});

    await expect(
      built.service.compose({ isSuperAdmin: true }, 'c-1', {
        projectId: 'p-1',
        direction: BillDirection.to_client,
        periodFrom: '2026-01-20',
        periodTo: '2025-12-21',
      }),
    ).rejects.toMatchObject({ response: { code: 'BILL_PERIOD_INVERTED' } });
  });

  it('records the tax basis it derived, and that it derived it', async () => {
    // T044a. Both parties' registration numbers begin 08, as the client's own package has them, so
    // the half-rate pair applies and the source says the numbers decided it — not the project's
    // flag, which a bill cannot trust because it was set before anybody knew which subcontractor
    // this would be.
    const built = build({
      direction: BillDirection.to_subcontractor,
      award: [
        {
          id: 'award-1',
          description: 'Mapped',
          rate: 1000,
          boqTaskItemId: 'boq-1',
          awardedQty: 10,
        },
      ],
      approved: { 'boq-1': '1.000' },
    });

    await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_subcontractor,
      workOrderId: 'wo-1',
    });

    expect(built.pkg()).toMatchObject({
      taxBasis: 'intra_state',
      taxBasisSource: 'derived_from_gstin',
    });
  });

  it('numbers a package from its counterparty’s own series', async () => {
    const built = build({ lastSequenceNo: 11 });

    const view = await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_client,
    });

    expect(view.sequenceNo).toBe(12);
    expect(view.label).toBe('RA-12');
  });
});

describe('the award line with no measurement source', () => {
  // T031, and the reason it is its own test. Measurement is attributed to BOQ lines;
  // `WorkOrderBOQItem.boqTaskItemId` is nullable by design, because a subcontract can cover work the
  // client's BOQ itemises differently. So an unmapped award line has nothing to propose from — and
  // the obvious implementation proposes 0, which is indistinguishable from a month in which nothing
  // was done. On the subcontractor direction that is every unmapped line of every bill.

  it('proposes no measurement available, not zero', async () => {
    const built = build({
      direction: BillDirection.to_subcontractor,
      award: [
        {
          id: 'award-1',
          description: 'Toll plaza patrolling, as awarded',
          rate: 5000,
          boqTaskItemId: null,
          awardedQty: 12,
        },
      ],
    });

    await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_subcontractor,
      workOrderId: 'wo-1',
    });

    expect(built.claims[0]).toMatchObject({
      proposedQty: null,
      proposalSource: ClaimProposalSource.no_measurement_source,
      // No variance from a figure that was never proposed. Zero would say the claim matched a
      // proposal it did not have.
      varianceQty: null,
      // Nothing was exceeded, so this is not an over-claim — counting it would turn FR-006a's
      // count into a count of unmapped award lines.
      overClaimed: false,
    });
  });

  it('is a different fact from a mapped line whose measurement was nothing', async () => {
    // The contrast, asserted beside it. This is the pair that must never print the same.
    const built = build({
      direction: BillDirection.to_subcontractor,
      award: [
        {
          id: 'award-1',
          description: 'Mapped to the BOQ',
          rate: 1000,
          boqTaskItemId: 'boq-1',
          awardedQty: 10,
        },
      ],
      // 022 returns every BOQ line including those with no approved measurement, carrying zero.
      approved: { 'boq-1': '0.000' },
    });

    await built.service.compose({ isSuperAdmin: true }, 'c-1', {
      ...period,
      direction: BillDirection.to_subcontractor,
      workOrderId: 'wo-1',
    });

    expect(built.claims[0]).toMatchObject({
      proposalSource: ClaimProposalSource.approved_measurement,
      varianceQty: 0,
    });
    expect(String(built.claims[0].proposedQty)).toBe('0');
  });

  it('refuses two award lines sharing one BOQ line rather than proposing it to each', async () => {
    // FR-003b. Proposing the full approved quantity to both would claim the same work twice on one
    // bill — and FR-008's one-line-per-item rule would not catch it, because they are two different
    // lines.
    const built = build({
      direction: BillDirection.to_subcontractor,
      award: [
        {
          id: 'award-1',
          description: 'First half',
          rate: 1000,
          boqTaskItemId: 'boq-1',
          awardedQty: 5,
        },
        {
          id: 'award-2',
          description: 'Second half',
          rate: 1000,
          boqTaskItemId: 'boq-1',
          awardedQty: 5,
        },
      ],
      approved: { 'boq-1': '10.000' },
    });

    await expect(
      built.service.compose({ isSuperAdmin: true }, 'c-1', {
        ...period,
        direction: BillDirection.to_subcontractor,
        workOrderId: 'wo-1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'BILL_AMBIGUOUS_AWARD_MAPPING' },
    });
  });
});

describe('setting a claim', () => {
  const draftClaim = (proposed: number | null) => ({
    id: 'claim-1',
    proposedQty: proposed === null ? null : dec(proposed),
    proposalSource:
      proposed === null
        ? ClaimProposalSource.no_measurement_source
        : ClaimProposalSource.approved_measurement,
    package: { status: 'draft' },
  });

  it('requires a reason for a reduction', async () => {
    const built = build({ claim: draftClaim(1) });

    await expect(
      built.service.setClaim({ isSuperAdmin: true }, 'pkg-1', 'claim-1', {
        claimedQty: '0.700',
      }),
    ).rejects.toMatchObject({
      response: { code: 'BILL_CLAIM_NEEDS_REASON' },
    });
  });

  it('accepts an over-claim with a reason and flags it', async () => {
    const built = build({ claim: draftClaim(1) }) as Built & {
      claimUpdates: Record<string, unknown>[];
    };

    await built.service
      .setClaim({ isSuperAdmin: true }, 'pkg-1', 'claim-1', {
        claimedQty: '1.300',
        reason: 'Work done ahead of the paperwork, measured on site',
      })
      .catch(() => undefined);

    expect(built.claimUpdates[0]).toMatchObject({ overClaimed: true });
    expect(built.claimUpdates[0].reason).toContain('measured on site');
  });

  it('clears the reason when the claim returns to its proposal', async () => {
    // FR-004a. A reason sitting beside a zero variance argues on the measurement sheet for a
    // deduction the bill does not make.
    const built = build({ claim: draftClaim(1) }) as Built & {
      claimUpdates: Record<string, unknown>[];
    };

    await built.service
      .setClaim({ isSuperAdmin: true }, 'pkg-1', 'claim-1', {
        claimedQty: '1.000',
        reason: 'left over from the earlier reduction',
      })
      .catch(() => undefined);

    expect(built.claimUpdates[0]).toMatchObject({
      reason: null,
      overClaimed: false,
    });
  });

  it('needs a reason for any claim against a line with no measurement source', async () => {
    const built = build({ claim: draftClaim(null) });

    await expect(
      built.service.setClaim({ isSuperAdmin: true }, 'pkg-1', 'claim-1', {
        claimedQty: '12.000',
      }),
    ).rejects.toMatchObject({
      response: { code: 'BILL_CLAIM_NEEDS_REASON' },
    });
  });

  it('refuses to edit a line on an issued package', async () => {
    const built = build({
      claim: { ...draftClaim(1), package: { status: 'issued' } },
    });

    await expect(
      built.service.setClaim({ isSuperAdmin: true }, 'pkg-1', 'claim-1', {
        claimedQty: '0.700',
        reason: 'too late',
      }),
    ).rejects.toMatchObject({ response: { code: 'BILL_PACKAGE_ISSUED' } });
  });
});

describe('packageLabel', () => {
  it('renders one way, so two documents cannot disagree', () => {
    // The client's own register names RA-02, RA-07, RA-09 and RA-12. One rendering, everywhere —
    // the judgement 022 FR-002a made about report numbers, for the same reason.
    expect(packageLabel(2)).toBe('RA-02');
    expect(packageLabel(12)).toBe('RA-12');
    expect(packageLabel(112)).toBe('RA-112');
  });
});
