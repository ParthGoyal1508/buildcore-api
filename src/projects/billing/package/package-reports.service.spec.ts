import { BillPackageStatus, Prisma } from '@prisma/client';

import { PackageReportsService } from './package-reports.service';

/**
 * The two reports D1 and D2 oblige (023 US7, tasks T087, T088).
 *
 * Neither is an extra. Freezing the cumulative position creates a quantity that can fall out of
 * every bill, and permitting an over-claim creates a reason field nobody aggregates. Each decision
 * is only safe with the report that makes its consequence visible.
 */

const d = (value: string | number) => new Prisma.Decimal(value);

interface PkgFixture {
  id: string;
  sequenceNo: number;
  status?: BillPackageStatus;
  periodFrom: string;
  periodTo: string;
  /** boqNo → what the bill claimed. */
  claims: Record<string, string>;
  /** Over-claimed lines, as the query returns them. */
  overClaimed?: {
    boqNo: string;
    claimed: string;
    proposed: string | null;
    reason: string | null;
  }[];
  lineCount?: number;
}

function build(opts: {
  packages?: PkgFixture[];
  /** boqNo → the measurement approved in that period **as it now stands**. */
  approvedNow?: Record<string, Record<string, string>>;
}) {
  const packages = opts.packages ?? [];

  const tx = {
    $executeRaw: async () => 0,
    billPackage: {
      findMany: async (args: {
        where: Record<string, unknown>;
        select: Record<string, unknown>;
      }) => {
        const statusFilter = args.where.status as
          | { in?: BillPackageStatus[]; not?: BillPackageStatus }
          | undefined;
        return packages
          .filter((pkg) => {
            const status = pkg.status ?? BillPackageStatus.issued;
            if (statusFilter?.in) return statusFilter.in.includes(status);
            if (statusFilter?.not) return status !== statusFilter.not;
            return true;
          })
          .map((pkg) => ({
            id: pkg.id,
            sequenceNo: pkg.sequenceNo,
            status: pkg.status ?? BillPackageStatus.issued,
            periodFrom: new Date(pkg.periodFrom),
            periodTo: new Date(pkg.periodTo),
            _count: { claims: pkg.lineCount ?? Object.keys(pkg.claims).length },
            claims:
              args.select.claims &&
              (args.select.claims as { where?: unknown }).where
                ? (pkg.overClaimed ?? []).map((line) => ({
                    claimedQty: d(line.claimed),
                    proposedQty:
                      line.proposed === null ? null : d(line.proposed),
                    reason: line.reason,
                    clientBillLine: { boqTaskItem: { boqNo: line.boqNo } },
                    raBillLine: null,
                  }))
                : Object.entries(pkg.claims).map(([boqNo, qty]) => ({
                    claimedQty: d(qty),
                    clientBillLine: {
                      boqTaskItemId: boqNo,
                      boqTaskItem: { boqNo },
                    },
                  })),
          }));
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const periodFigures = {
    figuresFor: async (
      _ctx: unknown,
      _projectId: string,
      range: { from: string; to: string },
    ) => {
      const key = `${range.from}..${range.to}`;
      const approved = opts.approvedNow?.[key] ?? {};
      return {
        from: range.from,
        to: range.to,
        lines: Object.entries(approved).map(([boqItemId, qty]) => ({
          boqItemId,
          boqNo: boqItemId,
          taskName: 'Task',
          unit: 'Cum',
          scopeQty: '100.000',
          approvedInPeriod: qty,
          approvedBefore: '0.000',
          approvedUpToDate: qty,
          doneQty: qty,
        })),
      };
    },
  };

  return new PackageReportsService(prisma as never, periodFigures as never);
}

describe('the understatement report', () => {
  it('reports a period whose approved measurement has grown since the bill went out', async () => {
    // T087, FR-014b, and the leak D1 would otherwise create. A report approved after RA-11 was
    // issued belongs to RA-11's period, so its quantity is in no bill at all unless somebody is
    // told.
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: { '30.10': '1.000' },
        },
      ],
      approvedNow: { '2025-11-21..2025-12-20': { '30.10': '1.300' } },
    });

    const report = await service.understatement({ isSuperAdmin: true }, 'p-1');

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].label).toBe('RA-11');
    expect(report.rows[0].lines[0]).toMatchObject({
      claimed: '1.000',
      approvedNow: '1.300',
      understatedBy: '0.300',
    });
  });

  it('carries the remedy, because the report alone is not one', async () => {
    // FR-014c. 022 attributes measurement by **work date**, so a quantity approved late whose work
    // date sits in an already-billed period never appears in any later period's proposal either. It
    // is unreachable rather than deferred, and the only route back is an over-claim citing this
    // report. Left unstated, one engineer finds it and the next writes the quantity off.
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: { '30.10': '1.000' },
        },
      ],
      approvedNow: { '2025-11-21..2025-12-20': { '30.10': '1.300' } },
    });

    const report = await service.understatement({ isSuperAdmin: true }, 'p-1');

    expect(report.rows[0].remedy).toContain('over-claim');
    expect(report.rows[0].remedy).toContain('work date');
  });

  it('is exact: any difference at all is reported', async () => {
    // FR-014b. Quantities are fixed-point, so there is no tolerance to apply — and an implementer
    // who assumed a float tolerance would hide exactly the small understatements nobody else finds.
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: { '30.10': '1.000' },
        },
      ],
      approvedNow: { '2025-11-21..2025-12-20': { '30.10': '1.001' } },
    });

    const report = await service.understatement({ isSuperAdmin: true }, 'p-1');

    expect(report.rows[0].lines[0].understatedBy).toBe('0.001');
  });

  it('says nothing about a period whose measurement has not moved', async () => {
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: { '30.10': '1.000' },
        },
      ],
      approvedNow: { '2025-11-21..2025-12-20': { '30.10': '1.000' } },
    });

    expect(
      (await service.understatement({ isSuperAdmin: true }, 'p-1')).rows,
    ).toEqual([]);
  });

  it('reports a reversal after issue as the discrepancy it is, without moving the bill', async () => {
    // FR-048, answered by the **same comparison** as FR-014b (FR-048a). A reversal takes the
    // approved quantity below what was claimed — the subtraction is the same, the sign is the other
    // way, and the issued bill is untouched either way.
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: { '30.10': '1.000' },
        },
      ],
      // Reversed down to 0.4 after the bill went out.
      approvedNow: { '2025-11-21..2025-12-20': { '30.10': '0.400' } },
    });

    const report = await service.understatement({ isSuperAdmin: true }, 'p-1');

    // Not an understatement, so not on this report's rows — and the issued figures are untouched,
    // which is FR-048's "leaves an issued bill unaffected".
    expect(report.rows).toEqual([]);
  });

  it('names the directions it can compare, rather than silently covering one', async () => {
    // A subcontractor bill measures award lines and 022 attributes measurement to BOQ lines, so for
    // that direction this question has no answer the report could give. Said out loud: a report
    // that silently covers one direction reads as covering both.
    const service = build({ packages: [] });

    const report = await service.understatement({ isSuperAdmin: true }, 'p-1');

    expect(report.comparableDirections).toEqual(['to_client']);
  });
});

describe('the over-claim report', () => {
  it('counts per package and per project, with the denominator', async () => {
    // T088, FR-006a, FR-006b. Three out of five lines and three out of 312 are the same count and
    // different facts, and "observed as a pattern" is FR-006a's own stated purpose.
    const service = build({
      packages: [
        {
          id: 'pkg-11',
          sequenceNo: 11,
          periodFrom: '2025-11-21',
          periodTo: '2025-12-20',
          claims: {},
          lineCount: 17,
          overClaimed: [
            {
              boqNo: '30.10',
              claimed: '1.300',
              proposed: '1.000',
              reason: 'Work done ahead of the paperwork, measured on site',
            },
          ],
        },
        {
          id: 'pkg-12',
          sequenceNo: 12,
          periodFrom: '2025-12-21',
          periodTo: '2026-01-20',
          claims: {},
          lineCount: 17,
          overClaimed: [
            {
              boqNo: '30.20',
              claimed: '2.000',
              proposed: '1.500',
              reason: 'Late approval',
            },
            {
              boqNo: '30.30',
              claimed: '3.000',
              proposed: '2.000',
              reason: 'Late approval',
            },
          ],
        },
      ],
    });

    const report = await service.overClaims({ isSuperAdmin: true }, 'p-1');

    expect(report.rows.map((row) => row.overClaimedCount)).toEqual([1, 2]);
    expect(report.rows.map((row) => row.lineCount)).toEqual([17, 17]);
    expect(report.totalOverClaimed).toBe(3);
    expect(report.totalLines).toBe(34);
  });

  it('carries each reason, so a pattern can be read rather than counted', async () => {
    // The mitigation D2 depends on. A reason nobody aggregates is a reason nobody reads — and two
    // bills carrying "Late approval" is the pattern, not the count.
    const service = build({
      packages: [
        {
          id: 'pkg-12',
          sequenceNo: 12,
          periodFrom: '2025-12-21',
          periodTo: '2026-01-20',
          claims: {},
          lineCount: 17,
          overClaimed: [
            {
              boqNo: '30.20',
              claimed: '2.000',
              proposed: '1.500',
              reason: 'Late approval',
            },
          ],
        },
      ],
    });

    const report = await service.overClaims({ isSuperAdmin: true }, 'p-1');

    expect(report.rows[0].lines[0]).toMatchObject({
      boqNo: '30.20',
      claimed: '2.000',
      proposed: '1.500',
      reason: 'Late approval',
    });
  });

  it('is zero out of the line count when nothing was over-claimed', async () => {
    // Zero over three hundred is a fact worth reporting. An empty report and "no over-claims on 312
    // lines" are different statements, and only the second is reassuring.
    const service = build({
      packages: [
        {
          id: 'pkg-12',
          sequenceNo: 12,
          periodFrom: '2025-12-21',
          periodTo: '2026-01-20',
          claims: {},
          lineCount: 312,
          overClaimed: [],
        },
      ],
    });

    const report = await service.overClaims({ isSuperAdmin: true }, 'p-1');

    expect(report.totalOverClaimed).toBe(0);
    expect(report.totalLines).toBe(312);
  });
});
