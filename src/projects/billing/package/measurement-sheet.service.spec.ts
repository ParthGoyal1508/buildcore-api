import { BillDirection, Prisma } from '@prisma/client';

import {
  MeasurementSheetService,
  datesBetween,
} from './measurement-sheet.service';

/**
 * The measurement sheet (023 US4, tasks T060, T061).
 *
 * **T060 is the test that makes T061 worth writing.** The footer identity — this bill plus up to
 * previous equals up to date — is the one property of a package nobody can check by reading a single
 * bill. It is also trivially true if up-to-previous is *defined* as up-to-date less this bill, which
 * is what the plan originally specified and what `checklists/silent-failure.md` CHK002 caught. So
 * the first test here asserts the figure was **read from the predecessor**, and only then is the
 * identity meaningful.
 */

const d = (value: string | number) => new Prisma.Decimal(value);

interface ClaimFixture {
  packageId: string;
  sequenceNo: number;
  periodFrom: string;
  periodTo: string;
  status: string;
  claimedQty: string;
  reason?: string | null;
  overClaimed?: boolean;
}

function build(opts: {
  /** This package. */
  sequenceNo?: number;
  /** Every claim against the item, across packages. */
  claims?: ClaimFixture[];
  /** What the logbook source returns, by date. Absent dates are absent. */
  logbook?: Record<string, { totalHours: string; remarks: string | null }>;
  /** Whether a 022 task names a machine for this line. */
  equipmentId?: string | null;
  /** Whether any logbook source is registered at all. */
  sourceRegistered?: boolean;
}) {
  const sequenceNo = opts.sequenceNo ?? 12;
  const claims = opts.claims ?? [];

  const hydrate = (claim: ClaimFixture) => ({
    packageId: claim.packageId,
    claimedQty: d(claim.claimedQty),
    reason: claim.reason ?? null,
    overClaimed: claim.overClaimed ?? false,
    package: {
      sequenceNo: claim.sequenceNo,
      periodFrom: new Date(claim.periodFrom),
      periodTo: new Date(claim.periodTo),
    },
  });

  const tx = {
    $executeRaw: async () => 0,
    billPackage: {
      findFirst: async () => ({
        id: 'pkg-this',
        companyId: 'c-1',
        projectId: 'p-1',
        direction: BillDirection.to_client,
        counterpartyKey: 'client-1',
        sequenceNo,
        periodFrom: new Date('2025-12-21'),
        periodTo: new Date('2025-12-23'),
      }),
    },
    billPackageLineClaim: {
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: { package?: Record<string, string> };
      }) => {
        const pkgWhere = (args.where.package ?? {}) as Record<string, unknown>;
        // The footer's query narrows to issued packages below this sequence number; the history's
        // does not. Honouring the difference is what lets the two tests below disagree.
        const seqFilter = pkgWhere.sequenceNo as { lt?: number } | undefined;
        const statusFilter = pkgWhere.status as
          | { in?: string[]; not?: string }
          | undefined;
        return (
          claims
            .filter((claim) =>
              seqFilter?.lt === undefined
                ? true
                : claim.sequenceNo < seqFilter.lt,
            )
            .filter((claim) =>
              statusFilter?.in ? statusFilter.in.includes(claim.status) : true,
            )
            .filter((claim) =>
              statusFilter?.not ? claim.status !== statusFilter.not : true,
            )
            // Honour the ordering the caller asked for rather than imposing one. The history reads
            // ascending by period and the footer descending by sequence, and a fake that sorted one
            // way for both would have let the history's ordering go untested.
            .sort((a, b) =>
              args.orderBy?.package?.periodFrom === 'asc'
                ? a.periodFrom.localeCompare(b.periodFrom)
                : b.sequenceNo - a.sequenceNo,
            )
            .map(hydrate)
        );
      },
    },
    bOQTaskItem: {
      findFirst: async () => ({
        id: 'boq-1',
        boqNo: '30.10',
        taskName: 'Ambulance with paramedical staff',
        unit: 'Month',
      }),
    },
    workOrderBOQItem: { findFirst: async () => null },
    dWRTask: {
      findFirst: async () =>
        opts.equipmentId === null
          ? null
          : { equipmentId: opts.equipmentId ?? 'eq-1' },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const sources = {
    logbookSource: () =>
      opts.sourceRegistered === false
        ? null
        : {
            getLogbookDays: async (
              _equipmentId: string,
              _companyId: string,
              dates: string[],
            ) => {
              const out = new Map();
              for (const date of dates) {
                const entry = opts.logbook?.[date];
                if (entry) {
                  out.set(date, {
                    date,
                    openingReading: '1000.000',
                    closingReading: '1050.000',
                    totalHours: entry.totalHours,
                    fuelConsumed: null,
                    remarks: entry.remarks,
                  });
                }
              }
              return out;
            },
          },
  };

  return new MeasurementSheetService(prisma as never, sources as never);
}

const THREE_BILLS: ClaimFixture[] = [
  {
    packageId: 'pkg-10',
    sequenceNo: 10,
    periodFrom: '2025-10-21',
    periodTo: '2025-11-20',
    status: 'issued',
    claimedQty: '0.700',
    reason:
      '30 % deduction Shoulder Slope, Supervisor Labour, Staff Not availeble & ROW Not Cleaned',
  },
  {
    packageId: 'pkg-11',
    sequenceNo: 11,
    periodFrom: '2025-11-21',
    periodTo: '2025-12-20',
    status: 'issued',
    claimedQty: '0.400',
    reason:
      '60% deduction per month due to mbcb stickrs, Chute Draine & Slope Qurdance Cracks Not repair',
  },
  {
    packageId: 'pkg-this',
    sequenceNo: 12,
    periodFrom: '2025-12-21',
    periodTo: '2025-12-23',
    status: 'draft',
    claimedQty: '1.000',
  },
];

describe('the footer’s up-to-previous figure', () => {
  it('is read from the earlier issued packages, not derived from this one', async () => {
    // T060, and the whole reason T061 means anything. The figure must come from the predecessors'
    // own claims — 0.700 and 0.400 — and the test says which package it was read from, so a
    // reviewer can go and check rather than taking the arithmetic on trust.
    const service = build({ claims: THREE_BILLS });

    const sheet = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(sheet.footer.uptoPreviousQty).toBe('1.100');
    expect(sheet.footer.uptoPreviousFrom).toBe('RA-11');
  });

  it('satisfies the footer identity exactly', async () => {
    // T061, FR-035, SC-004. Meaningful only because of the test above: with up-to-previous read
    // from the predecessor, this can fail. Defined as up-to-date less this bill, it could not.
    const service = build({ claims: THREE_BILLS });

    const { footer } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(
      new Prisma.Decimal(footer.thisBillQty)
        .plus(footer.uptoPreviousQty)
        .equals(new Prisma.Decimal(footer.uptoDateQty)),
    ).toBe(true);
    expect(footer.uptoDateQty).toBe('2.100');
  });

  it('skips a draft sitting between two issued packages', async () => {
    // FR-014. A draft has no frozen cumulative position, so counting its claim would bill a figure
    // nobody has issued — and then un-bill it if the draft were abandoned.
    const service = build({
      claims: [
        ...THREE_BILLS.slice(0, 2),
        {
          packageId: 'pkg-draft',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          status: 'draft',
          claimedQty: '99.000',
        },
        THREE_BILLS[2],
      ],
    });

    const { footer } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(footer.uptoPreviousQty).toBe('1.100');
  });

  it('reports zero rather than nothing for the first package', async () => {
    // FR-014. Zero is a position; absent is not, and a reader subtracting columns needs the former.
    const service = build({
      sequenceNo: 1,
      claims: [
        {
          packageId: 'pkg-this',
          sequenceNo: 1,
          periodFrom: '2025-12-21',
          periodTo: '2025-12-23',
          status: 'draft',
          claimedQty: '1.000',
        },
      ],
    });

    const { footer } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(footer.uptoPreviousQty).toBe('0.000');
    expect(footer.uptoPreviousFrom).toBeNull();
    expect(footer.uptoDateQty).toBe('1.000');
  });
});

describe('the claim history', () => {
  it('lists every period the item was claimed in, in period order, naming each bill', async () => {
    const service = build({ claims: THREE_BILLS });

    const { history } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(history.map((row) => row.billLabel)).toEqual([
      'RA-10',
      'RA-11',
      'RA-12',
    ]);
    expect(history.map((row) => row.month)).toEqual([
      'November 2025',
      'December 2025',
      'December 2025',
    ]);
    expect(history.filter((row) => row.isThisBill)).toHaveLength(1);
  });

  it('reproduces a reason verbatim, misspellings and all', async () => {
    // FR-032, SC-005. The remark is the argument the document exists to settle, and an engineer
    // defending the deduction a year later needs the words that were written — not a tidied
    // version, not a corrected spelling, not a sentence somebody thought read better.
    const service = build({ claims: THREE_BILLS });

    const { history } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(history[0].reason).toBe(
      '30 % deduction Shoulder Slope, Supervisor Labour, Staff Not availeble & ROW Not Cleaned',
    );
    expect(history[1].reason).toContain('mbcb stickrs');
  });
});

describe('the daily record beneath the sheet', () => {
  it('marks a date with no logbook entry as missing, not as nothing done', async () => {
    // FR-034, and the distinction 022 established. "Nobody recorded this day" and "the machine did
    // not move" are different facts, and only one of them is an argument for a deduction. A run of
    // zeroes would state the second while meaning the first.
    const service = build({
      claims: THREE_BILLS,
      logbook: {
        '2025-12-21': { totalHours: '8.000', remarks: 'No Incident' },
        '2025-12-23': {
          totalHours: '8.000',
          remarks: 'Accident Attend at CH.239+350 RHS',
        },
      },
    });

    const { dailyRecord } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(dailyRecord.map((row) => row.date)).toEqual([
      '2025-12-21',
      '2025-12-22',
      '2025-12-23',
    ]);
    expect(dailyRecord[1]).toMatchObject({
      logbookMissing: true,
      totalHours: null,
    });
    expect(dailyRecord[0]).toMatchObject({
      logbookMissing: false,
      remarks: 'No Incident',
    });
  });

  it('is empty rather than wrong where no logbook source is registered', async () => {
    // A line whose work is not a machine running has no odometer beneath it, and the sheet is still
    // correct. An empty record and a record of zeroes are not the same claim about the month.
    const service = build({ claims: THREE_BILLS, sourceRegistered: false });

    const { dailyRecord } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(dailyRecord).toEqual([]);
  });

  it('is empty where no report named a machine for the line', async () => {
    const service = build({ claims: THREE_BILLS, equipmentId: null });

    const { dailyRecord } = await service.sheetFor(
      { isSuperAdmin: true },
      'pkg-this',
      'boq-1',
    );

    expect(dailyRecord).toEqual([]);
  });
});

describe('datesBetween', () => {
  it('includes both ends', () => {
    // FR-001: both dates inclusive. An exclusive end would drop the 20th of every month from every
    // bill, which is a day of work nobody would ever be paid for.
    expect(
      datesBetween(new Date('2026-01-18'), new Date('2026-01-20')),
    ).toEqual(['2026-01-18', '2026-01-19', '2026-01-20']);
  });

  it('handles a single day and a month boundary', () => {
    expect(
      datesBetween(new Date('2026-01-20'), new Date('2026-01-20')),
    ).toEqual(['2026-01-20']);
    expect(
      datesBetween(new Date('2025-12-30'), new Date('2026-01-02')),
    ).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
  });
});
