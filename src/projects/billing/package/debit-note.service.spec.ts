import { BillTaxBasis, Prisma } from '@prisma/client';

import { DebitNoteService, noteTaxes } from './debit-note.service';

/**
 * Debit notes (023 US5, reshaped 2026-10-15 to the client's DV-04 format).
 *
 * Two of these are about money rather than bookkeeping: a note recovered twice is money taken
 * twice, and a note recovered from the wrong party — or from the client — is a claim against
 * somebody who owes nothing.
 */

const d = (value: string | number) => new Prisma.Decimal(value);

describe('the tax a note prints', () => {
  it('splits intra-state GST evenly, each half rounded, as the format does', () => {
    // The format's own figures: 35,31,213.64 at 18% → 3,17,809.23 twice.
    const taxes = noteTaxes(d('3531213.64'), d(18), BillTaxBasis.intra_state);
    expect(taxes.lines.map((line) => line.label)).toEqual([
      'CGST 9%',
      'SGST 9%',
    ]);
    expect(taxes.lines.map((line) => line.amount.toFixed(2))).toEqual([
      '317809.23',
      '317809.23',
    ]);
    expect(taxes.total.toFixed(2)).toBe('635618.46');
  });

  it('prints one IGST line inter-state', () => {
    const taxes = noteTaxes(d('1000'), d(18), BillTaxBasis.inter_state);
    expect(taxes.lines).toHaveLength(1);
    expect(taxes.lines[0].label).toBe('IGST 18%');
    expect(taxes.total.toFixed(2)).toBe('180.00');
  });

  it('prints a migrated note’s stored tax as one GST line', () => {
    const taxes = noteTaxes(d('125000'), d(18), null, d('22500'));
    expect(taxes.lines).toEqual([{ label: 'GST 18%', amount: d('22500') }]);
  });
});

function build(opts: {
  direction?: 'to_subcontractor' | 'to_client';
  status?: string;
  packageWorkOrderId?: string | null;
  noteWorkOrderId?: string | null;
  claimCount?: number;
  existingNumbers?: string[];
}) {
  const created: Record<string, unknown>[] = [];
  const noteRow = (data: Record<string, unknown> = {}) => ({
    id: 'note-1',
    companyId: 'c-1',
    noteNumber: '2026-27/001',
    noteDate: new Date('2026-06-29'),
    natureOfWork: 'O&M of Highway',
    workOrderId: 'wo-1',
    workOrder: { code: '16010503', partnerId: null },
    taxBasis: BillTaxBasis.intra_state,
    gstPercent: d(18),
    amount: d(0),
    taxAmount: d(0),
    netAmount: d(0),
    recoveredOnPackageId: null,
    recoveredOnPackage: null,
    recordedAt: new Date('2026-06-29'),
    lines: [],
    ...data,
  });
  const tx = {
    $executeRaw: async () => 0,
    project: { findFirst: async () => ({ id: 'p-1' }) },
    workOrder: {
      findFirst: async () => ({
        id: 'wo-1',
        workDetail: 'O&M of Highway',
        partnerId: null,
      }),
    },
    billPackage: {
      findFirst: async () => ({
        id: 'pkg-1',
        projectId: 'p-1',
        status: opts.status ?? 'draft',
        sequenceNo: 7,
        issuedAt: null,
        direction: opts.direction ?? 'to_subcontractor',
        raBill:
          opts.packageWorkOrderId === null
            ? null
            : { workOrderId: opts.packageWorkOrderId ?? 'wo-1' },
      }),
    },
    billPackageDebitNote: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        'noteNumber' in args.where
          ? (opts.existingNumbers ?? []).map((noteNumber) => ({ noteNumber }))
          : [],
      findFirst: async () => ({
        id: 'note-1',
        workOrderId:
          opts.noteWorkOrderId === undefined ? 'wo-1' : opts.noteWorkOrderId,
        recoveredOnPackageId: 'pkg-earlier',
        recoveredOnPackage: { sequenceNo: 3 },
      }),
      findFirstOrThrow: async () => noteRow({ recoveredOnPackageId: 'pkg-1' }),
      updateMany: async () => ({ count: opts.claimCount ?? 1 }),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return noteRow({ ...args.data, lines: [] });
      },
    },
    billPackageDebit: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const sources = { vendorIdentitySource: () => null };
  return {
    service: new DebitNoteService(
      prisma as never,
      {} as never,
      sources as never,
    ),
    created,
  };
}

const ctx = { isSuperAdmin: true } as never;

describe('raising a note', () => {
  it('computes every figure and numbers it within the financial year', async () => {
    const { service, created } = build({
      existingNumbers: ['2026-27/001', '2026-27/004', 'PRPL-DN-0009'],
    });
    await service.raise(ctx, 'c-1', 'u-1', 'p-1', {
      workOrderId: 'wo-1',
      noteDate: '2026-06-29',
      gstPercent: '18',
      taxBasis: BillTaxBasis.intra_state,
      lines: [
        {
          description: 'Solar Panel (335 W)',
          unit: 'Nos.',
          quantity: '11',
          rate: '13550',
        },
        {
          description: 'Chute drain',
          unit: 'RMT',
          quantity: '697',
          rate: '2700',
        },
      ],
    });
    const data = created[0];
    // The highest under this year's prefix plus one; the old-style number does not count.
    expect(data.noteNumber).toBe('2026-27/005');
    expect((data.amount as Prisma.Decimal).toFixed(2)).toBe('2030950.00');
    expect((data.taxAmount as Prisma.Decimal).toFixed(2)).toBe('365571.00');
    // Rounded to the rupee, as the format prints the net.
    expect((data.netAmount as Prisma.Decimal).toFixed(2)).toBe('2396521.00');
    // The nature of work defaults to the work order's own description.
    expect(data.natureOfWork).toBe('O&M of Highway');
  });

  it('starts the series again in April', async () => {
    const { service, created } = build({ existingNumbers: ['2025-26/031'] });
    await service.raise(ctx, 'c-1', null, 'p-1', {
      workOrderId: 'wo-1',
      noteDate: '2026-04-01',
      gstPercent: '18',
      taxBasis: BillTaxBasis.inter_state,
      lines: [{ description: 'Deck Light 80W', quantity: '1', rate: '3500' }],
    });
    expect(created[0].noteNumber).toBe('2026-27/001');
  });
});

describe('recovering a note', () => {
  it('recovers on a draft bill to the same subcontractor', async () => {
    const { service } = build({});
    const row = await service.apply(ctx, 'note-1', 'pkg-1');
    expect(row.recoveredOnPackageId).toBe('pkg-1');
  });

  it('refuses a bill to the client', async () => {
    const { service } = build({ direction: 'to_client' });
    await expect(service.apply(ctx, 'note-1', 'pkg-1')).rejects.toThrow(
      /subcontractor/,
    );
  });

  it('refuses a bill under a different work order', async () => {
    const { service } = build({ noteWorkOrderId: 'wo-2' });
    await expect(service.apply(ctx, 'note-1', 'pkg-1')).rejects.toThrow(
      /different work order/,
    );
  });

  it('refuses an issued bill', async () => {
    const { service } = build({ status: 'issued' });
    await expect(service.apply(ctx, 'note-1', 'pkg-1')).rejects.toThrow(
      /has been issued/,
    );
  });

  it('refuses a second recovery, naming the bill that already took it', async () => {
    const { service } = build({ claimCount: 0 });
    await expect(service.apply(ctx, 'note-1', 'pkg-1')).rejects.toThrow(
      /RA-03/,
    );
  });
});

describe('the register', () => {
  it('does not apply to a bill to the client', async () => {
    const { service } = build({ direction: 'to_client' });
    const register = await service.registerFor(ctx, 'pkg-1');
    expect(register.applicable).toBe(false);
    expect(register.notes).toEqual([]);
  });
});
