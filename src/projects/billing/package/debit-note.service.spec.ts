import { Prisma } from '@prisma/client';

import { BillPdfRenderer } from '../workbook/bill-pdf.renderer';
import { DebitNoteService } from './debit-note.service';

/**
 * The debit register (023 US5, tasks T062, T063).
 *
 * Two of these are about money rather than bookkeeping. A debit recovered twice is money taken
 * twice (T062), and an issued bill whose register keeps growing is a signed document that changes
 * after it was signed (T063).
 */

const d = (value: string | number) => new Prisma.Decimal(value);

interface DebitFixture {
  id: string;
  groupHeading: string | null;
  description: string;
  /** Carried separately from `amountWithTax`, because the service must not derive one from the
   * other and a fake that collapsed them would pass whether it did or not. */
  amount?: string;
  amountWithTax: string;
  recoveredOnPackageId?: string | null;
  recoveredOnSequenceNo?: number | null;
  recordedAt: string;
}

function build(opts: {
  packageStatus?: string;
  issuedAt?: string | null;
  debits?: DebitFixture[];
  /** How many rows the conditional update claims. 0 means somebody else got there first. */
  claimCount?: number;
}) {
  const debits = opts.debits ?? [];
  const updates: Record<string, unknown>[] = [];

  const hydrate = (debit: DebitFixture) => ({
    id: debit.id,
    groupHeading: debit.groupHeading,
    description: debit.description,
    location: null,
    nos: null,
    length: null,
    width: null,
    quantity: null,
    unit: null,
    rate: d(100),
    amount: d(debit.amount ?? debit.amountWithTax),
    amountWithTax: d(debit.amountWithTax),
    recoveredOnPackageId: debit.recoveredOnPackageId ?? null,
    recoveredOnPackage: debit.recoveredOnSequenceNo
      ? { sequenceNo: debit.recoveredOnSequenceNo }
      : null,
    recordedAt: new Date(debit.recordedAt),
  });

  const tx = {
    $executeRaw: async () => 0,
    project: { findFirst: async () => ({ id: 'p-1' }) },
    billPackage: {
      findFirst: async () => ({
        id: 'pkg-1',
        projectId: 'p-1',
        status: opts.packageStatus ?? 'draft',
        sequenceNo: 12,
        issuedAt: opts.issuedAt ? new Date(opts.issuedAt) : null,
      }),
    },
    billPackageDebit: {
      create: async (args: { data: Record<string, unknown> }) =>
        hydrate({
          id: 'debit-new',
          groupHeading: (args.data.groupHeading as string) ?? null,
          description: args.data.description as string,
          amount: String(args.data.amount),
          amountWithTax: String(args.data.amountWithTax),
          recordedAt: '2026-01-15',
        }),
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        updates.push(args.data);
        if (opts.claimCount !== undefined) return { count: opts.claimCount };
        // Honour the `recoveredOnPackageId: null` predicate the service relies on — a fake that
        // ignored it would let the test pass against a read-then-write implementation, which is the
        // implementation this suite exists to rule out.
        const target = debits.find((debit) => debit.id === args.where.id);
        const free = target && !target.recoveredOnPackageId;
        return { count: free ? 1 : 0 };
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const found = debits.find((debit) => debit.id === args.where.id);
        return found ? hydrate(found) : null;
      },
      findFirstOrThrow: async (args: { where: Record<string, unknown> }) => {
        const found = debits.find((debit) => debit.id === args.where.id);
        if (!found) throw new Error('not found');
        return hydrate(found);
      },
      findMany: async (args: { where: Record<string, unknown> }) => {
        const cutoff = (args.where.recordedAt as { lte?: Date } | undefined)
          ?.lte;
        return debits
          .filter((debit) =>
            cutoff ? new Date(debit.recordedAt) <= cutoff : true,
          )
          .sort(
            (a, b) =>
              (a.groupHeading ?? '').localeCompare(b.groupHeading ?? '') ||
              a.recordedAt.localeCompare(b.recordedAt),
          )
          .map(hydrate);
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return {
    // A stub allocator, not the real `CodeSeriesService`: these tests are about the register and
    // the one-recovery rule, and a per-company sequence table is not part of either.
    service: new DebitNoteService(
      prisma as never,
      {
        next: async () => 'PRPL-DN-0001',
      } as never,
      new BillPdfRenderer(),
    ),
    updates,
  };
}

const THREE: DebitFixture[] = [
  {
    id: 'debit-1',
    groupHeading: 'Debit against the ATMS Equipment Missing at site',
    description: 'PTZ camera missing',
    amountWithTax: '147500.00',
    recordedAt: '2026-01-10',
  },
  {
    id: 'debit-2',
    groupHeading: 'Debit against the ATMS Equipment Missing at site',
    description: 'VSDS cable theft KM 215',
    amountWithTax: '59000.00',
    recoveredOnPackageId: 'pkg-1',
    recoveredOnSequenceNo: 12,
    recordedAt: '2026-01-11',
  },
  {
    id: 'debit-3',
    groupHeading: 'Debit against Civil',
    description: 'Shoulder reinstatement not done',
    amountWithTax: '23600.00',
    recoveredOnPackageId: 'pkg-earlier',
    recoveredOnSequenceNo: 9,
    recordedAt: '2026-01-12',
  },
];

describe('applying a debit', () => {
  it('refuses a second application, naming the bill that already recovered it', async () => {
    // T062, FR-037. A debit recovered twice is money taken twice, and the refusal names the first
    // bill because the person who hit this needs to go and look at it rather than at this one.
    const { service } = build({ debits: THREE });

    await expect(
      service.apply({ isSuperAdmin: true }, 'debit-3', 'pkg-1'),
    ).rejects.toMatchObject({
      response: { code: 'DEBIT_ALREADY_RECOVERED' },
    });
  });

  it('decides the race in the database, so one of two simultaneous applications loses', async () => {
    // FR-037a, and the reason the rule is not a read followed by a write. Two callers applying one
    // debit at the same moment both pass a read-then-write check and the second silently replaces
    // the first — after which the debit is recovered on two bills. Here the conditional update
    // claims no row, and claiming no row *is* the refusal.
    const { service } = build({ debits: THREE, claimCount: 0 });

    await expect(
      service.apply({ isSuperAdmin: true }, 'debit-1', 'pkg-1'),
    ).rejects.toMatchObject({
      response: { code: 'DEBIT_ALREADY_RECOVERED' },
    });
  });

  it('applies a free debit', async () => {
    const { service, updates } = build({ debits: THREE });

    await service.apply({ isSuperAdmin: true }, 'debit-1', 'pkg-1');

    expect(updates[0]).toEqual({ recoveredOnPackageId: 'pkg-1' });
  });

  it('refuses to apply to a package that has been issued', async () => {
    // FR-037b. Applying afterwards either moves a figure FR-044 froze or records a recovery the
    // bill never made, and a subcontractor would find out when their payment came up short.
    const { service } = build({
      debits: THREE,
      packageStatus: 'issued',
      issuedAt: '2026-01-20',
    });

    await expect(
      service.apply({ isSuperAdmin: true }, 'debit-1', 'pkg-1'),
    ).rejects.toMatchObject({ response: { code: 'BILL_PACKAGE_ISSUED' } });
  });
});

describe('the register', () => {
  it('shows every debit on the project from a draft, grouped under its heading', async () => {
    // FR-039, FR-040. The running total is the point of a register, so a debit recovered on an
    // earlier bill still appears — and the grouping is how a subcontractor finds which dispute a
    // line belongs to.
    const { service } = build({ debits: THREE });

    const register = await service.registerFor({ isSuperAdmin: true }, 'pkg-1');

    expect(register.asAtIssue).toBe(false);
    expect(register.groups.map((group) => group.heading)).toEqual([
      'Debit against Civil',
      'Debit against the ATMS Equipment Missing at site',
    ]);
    expect(register.total).toBe('230100.00');
    // What block B's mechanical-debit row carries: only what *this* package recovers.
    expect(register.recoveredOnThisPackage).toBe('59000.00');
  });

  it('names the earlier bill a debit was recovered on', async () => {
    const { service } = build({ debits: THREE });

    const register = await service.registerFor({ isSuperAdmin: true }, 'pkg-1');
    const civil = register.groups.find(
      (group) => group.heading === 'Debit against Civil',
    );

    expect(civil?.rows[0].recoveredOn).toBe('RA-09');
  });

  it('does not grow after the package is issued', async () => {
    // T063, FR-039a, and the resolution of the contradiction `checklists/silent-failure.md` CHK025
    // found. FR-039 wants the register live; FR-028 wants a bill produced twice to be identical.
    // Both hold only if an issued bill's register is the register as at issue.
    const { service } = build({
      packageStatus: 'issued',
      issuedAt: '2026-01-11',
      debits: [
        ...THREE,
        {
          id: 'debit-4',
          groupHeading: 'Debit against Civil',
          description: 'Recorded after the bill went out',
          amountWithTax: '1000000.00',
          recordedAt: '2026-02-01',
        },
      ],
    });

    const register = await service.registerFor({ isSuperAdmin: true }, 'pkg-1');
    const descriptions = register.groups.flatMap((group) =>
      group.rows.map((row) => row.description),
    );

    expect(register.asAtIssue).toBe(true);
    expect(descriptions).not.toContain('Recorded after the bill went out');
    // Two rows, not four: the one recorded on 12 January is also after this bill's issue.
    expect(descriptions).toHaveLength(2);
  });
});

describe('recording a debit', () => {
  it('carries the tax-inclusive amount as entered rather than deriving it', async () => {
    // FR-036. The real register shows both, and the tax on a debit is not always the bill's own
    // rate — a stolen item is charged at the rate it was bought at. Deriving it would quietly
    // re-rate every historical debit the first time a statute changed.
    const { service } = build({});

    const row = await service.record({ isSuperAdmin: true }, 'c-1', 'u-1', {
      projectId: 'p-1',
      description: 'PTZ camera missing',
      rate: '125000.00',
      amount: '125000.00',
      amountWithTax: '147500.00',
    });

    // The two must differ, and by the amount of tax the entry stated — not by a rate this code
    // applied. An earlier version of this fake hydrated both fields from `amountWithTax`, which
    // made the assertion pass whether or not the service derived it.
    expect(row.amount).toBe('125000.00');
    expect(row.amountWithTax).toBe('147500.00');
  });
});
