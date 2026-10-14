import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { BillDirection, BillPackageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { DwrPeriodFiguresService } from '../../dwr/dwr-period-figures.service';
import { BillPackageService, packageLabel } from './bill-package.service';

/** One line of an issued package whose period's measurement has since grown. */
export interface UnderstatedLine {
  boqItemId: string;
  boqNo: string;
  claimed: string;
  approvedNow: string;
  /** What is still short, after anything a later bill over-claimed for this item. */
  understatedBy: string;
  /**
   * How much of the original shortfall later bills have already claimed back as over-claims —
   * the remedy this report prescribes. Without netting it the report went on flagging a shortfall
   * that had been recovered, for ever, and a report that is always red is a report nobody reads.
   */
  recoveredLater: string;
}

/** One line of an issued package that claimed more than its period's measurement now stands at. */
export interface ReversedLine {
  boqItemId: string;
  boqNo: string;
  claimed: string;
  approvedNow: string;
  overBy: string;
}

export interface ReversalRow {
  packageId: string;
  label: string;
  periodFrom: string;
  periodTo: string;
  lines: ReversedLine[];
}

export interface UnderstatementRow {
  packageId: string;
  label: string;
  periodFrom: string;
  periodTo: string;
  lines: UnderstatedLine[];
  /**
   * **What to do about it** (FR-014c).
   *
   * Carried on the report rather than left as an implication, because the remedy is not obvious and
   * is not "it will fall into the next bill". Feature 022 attributes measurement by **work date**,
   * so a quantity approved after this bill went out, whose work date sits inside this bill's period,
   * will never appear in any later period's proposal either. It is not deferred — it is unreachable.
   * The only route back is an over-claim under FR-006 on a later package, carrying this report as
   * its written reason.
   */
  remedy: string;
}

export interface OverClaimRow {
  packageId: string;
  label: string;
  status: BillPackageStatus;
  overClaimedCount: number;
  /**
   * **The denominator** (FR-006b).
   *
   * Three over-claims out of five lines and three out of 312 are the same count and different
   * facts, and FR-006a's stated purpose is that over-claiming "can be observed as a pattern". A
   * count without what it is a count *of* cannot be read as one.
   */
  lineCount: number;
  lines: {
    boqNo: string;
    claimed: string;
    proposed: string | null;
    reason: string | null;
  }[];
}

export interface OverClaimReport {
  projectId: string;
  rows: OverClaimRow[];
  totalOverClaimed: number;
  totalLines: number;
  /**
   * Issued bills whose period's approved measurement was **reduced** after they went out — they
   * now claim more than was measured, though nobody over-claimed when they were written. The same
   * comparison the understatement report makes, with the other sign (FR-048).
   */
  reversedAfterIssue: ReversalRow[];
}

/** Names the counterparty on a row — "RA-03 · Tirupati Enterprises". */
export interface CounterpartyNamer {
  counterpartyNames(
    ctx: RlsContext,
    companyId: string,
    packages: {
      projectId: string;
      direction: BillDirection;
      counterpartyKey: string;
    }[],
  ): Promise<(string | null)[]>;
}

const ZERO = new Prisma.Decimal(0);

const REMEDY =
  'Claim this quantity on a later bill as an over-claim, citing this report as the reason. It ' +
  'will not appear in any later period’s proposal on its own: measurement is attributed by work ' +
  'date, and this work date falls inside a period that has already been billed.';

/**
 * The two reports this feature's own decisions oblige (023 US7, FR-006a to FR-014c, FR-048, FR-049b).
 *
 * ## Why these are not optional extras
 *
 * **D1 chose to freeze the cumulative position**, so that every bill is reproducible from itself for
 * ever and a later bill's *Upto Previous* always agrees with the signed predecessor in the client's
 * file. The cost is that a report approved after a bill went out belongs to a period already billed.
 * Without `understatement`, choosing to freeze would trade a reconciliation problem for a **silent
 * revenue leak**, which is worse because nothing surfaces it.
 *
 * **D2 chose to permit an over-claim with a written reason**, because refusing it means the work is
 * recorded nowhere. The stated risk is that the reason field becomes the route around the control,
 * and the mitigation is not a stricter rule but visibility: a flag findable only by inspecting lines
 * one at a time is a flag that will not be found.
 *
 * ## One comparison, not three
 *
 * FR-014b (the understatement), FR-048 (a reversal after issue) and FR-049b (a work date corrected
 * across a period boundary) are **the same question asked three ways**: does a billed period's
 * claimed quantity still match that period's approved measurement? They share `compare` below.
 * FR-048a makes that a requirement rather than a plan note, because two implementations of one
 * comparison disagree — and the first time they do, nobody knows which to believe.
 */
@Injectable()
export class PackageReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodFigures: DwrPeriodFiguresService,
    /** `BillPackageService`, narrowed to the one method a label needs. */
    @Inject(forwardRef(() => BillPackageService))
    private readonly namer: CounterpartyNamer,
  ) {}

  /**
   * Issued packages whose period's approved measurement has since grown (FR-014b, FR-048,
   * FR-049b), **net of what later bills have already claimed back**.
   *
   * **On demand, and exact.** Quantities are fixed-point, so there is no tolerance to apply and any
   * difference at all is reportable — an implementer assuming a float tolerance would hide small
   * understatements, which are the ones nobody would otherwise find.
   *
   * **Netted, oldest shortfall first.** The remedy is an over-claim on a later bill. Each later
   * over-claim on the same item pays down the earliest outstanding shortfall, so a period that has
   * been made good drops off the report rather than staying red for ever.
   *
   * Only the client direction is compared. A subcontractor bill measures award lines, and 022
   * attributes measurement to BOQ lines, so for that direction the question has no answer this
   * report could give — stated rather than silently returning nothing.
   */
  async understatement(
    ctx: RlsContext,
    projectId: string,
    companyId?: string,
  ): Promise<{
    projectId: string;
    rows: UnderstatementRow[];
    comparableDirections: string[];
  }> {
    const packages = await this.issuedClientPackages(ctx, projectId);
    const labels = await this.labels(ctx, companyId, packages);
    const compared = await this.compareAll(ctx, projectId, packages);

    // Outstanding shortfalls per item, oldest first, paid down by later over-claims.
    const queue = new Map<
      string,
      {
        line: UnderstatedLine;
        remaining: Prisma.Decimal;
        recovered: Prisma.Decimal;
      }[]
    >();
    const owing: {
      pkgIndex: number;
      entries: {
        line: UnderstatedLine;
        remaining: Prisma.Decimal;
        recovered: Prisma.Decimal;
      }[];
    }[] = [];

    packages.forEach((pkg, index) => {
      // First, this bill's own over-claims pay down earlier shortfalls on the same item.
      for (const claim of pkg.claims) {
        const item = claim.clientBillLine?.boqTaskItemId;
        if (!item || !claim.overClaimed || claim.proposedQty === null) continue;
        let excess = claim.claimedQty.minus(claim.proposedQty);
        for (const entry of queue.get(item) ?? []) {
          if (excess.lessThanOrEqualTo(ZERO)) break;
          const take = Prisma.Decimal.min(excess, entry.remaining);
          entry.remaining = entry.remaining.minus(take);
          entry.recovered = entry.recovered.plus(take);
          excess = excess.minus(take);
        }
      }
      // Then this bill's own shortfalls join the queue.
      const entries = compared[index]
        .filter((line) => line.difference.greaterThan(ZERO))
        .map((line) => ({
          line: {
            boqItemId: line.boqItemId,
            boqNo: line.boqNo,
            claimed: line.claimed.toFixed(3),
            approvedNow: line.approvedNow.toFixed(3),
            understatedBy: '',
            recoveredLater: '',
          },
          remaining: line.difference,
          recovered: ZERO,
        }));
      for (const entry of entries) {
        const list = queue.get(entry.line.boqItemId) ?? [];
        list.push(entry);
        queue.set(entry.line.boqItemId, list);
      }
      owing.push({ pkgIndex: index, entries });
    });

    const rows: UnderstatementRow[] = [];
    for (const { pkgIndex, entries } of owing) {
      const lines = entries
        .filter((entry) => entry.remaining.greaterThan(ZERO))
        .map((entry) => ({
          ...entry.line,
          understatedBy: entry.remaining.toFixed(3),
          recoveredLater: entry.recovered.toFixed(3),
        }));
      if (lines.length === 0) continue;
      const pkg = packages[pkgIndex];
      rows.push({
        packageId: pkg.id,
        label: labels[pkgIndex],
        periodFrom: iso(pkg.periodFrom),
        periodTo: iso(pkg.periodTo),
        lines,
        remedy: REMEDY,
      });
    }

    return {
      projectId,
      rows,
      // Said out loud, because a report that silently covers one direction reads as covering both.
      comparableDirections: ['to_client'],
    };
  }

  /**
   * Over-claims, counted per package and per project, **with their denominator** (FR-006a, FR-006b),
   * and the bills a later reversal has left claiming more than was measured (FR-048).
   *
   * A line proposed from `no_measurement_source` is never counted: nothing was exceeded, and
   * counting it would turn this into a count of unmapped award lines — which is the mitigation D2
   * depends on, so it has to count the thing it claims to.
   */
  async overClaims(
    ctx: RlsContext,
    projectId: string,
    companyId?: string,
  ): Promise<OverClaimReport> {
    const packages = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackage.findMany({
        where: {
          projectId,
          status: { not: BillPackageStatus.abandoned },
        },
        select: {
          id: true,
          sequenceNo: true,
          status: true,
          direction: true,
          counterpartyKey: true,
          _count: { select: { claims: true } },
          claims: {
            where: { overClaimed: true },
            select: {
              claimedQty: true,
              proposedQty: true,
              reason: true,
              clientBillLine: {
                select: { boqTaskItem: { select: { boqNo: true } } },
              },
              raBillLine: {
                select: {
                  workOrderBoqItem: {
                    select: {
                      description: true,
                      boqTaskItem: { select: { boqNo: true } },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ direction: 'asc' }, { sequenceNo: 'asc' }],
      }),
    );
    const labels = await this.labels(ctx, companyId, packages);

    const rows = packages.map((pkg, index) => ({
      packageId: pkg.id,
      label: labels[index],
      status: pkg.status,
      overClaimedCount: pkg.claims.length,
      lineCount: pkg._count.claims,
      lines: pkg.claims.map((claim) => ({
        // An award line with no BOQ line behind it has no number of its own; its description is
        // the only name it has, and an empty cell names nothing.
        boqNo:
          claim.clientBillLine?.boqTaskItem.boqNo ??
          claim.raBillLine?.workOrderBoqItem.boqTaskItem?.boqNo ??
          claim.raBillLine?.workOrderBoqItem.description ??
          '',
        claimed: claim.claimedQty.toFixed(3),
        proposed: claim.proposedQty?.toFixed(3) ?? null,
        reason: claim.reason,
      })),
    }));

    const issued = await this.issuedClientPackages(ctx, projectId);
    const issuedLabels = await this.labels(ctx, companyId, issued);
    const compared = await this.compareAll(ctx, projectId, issued);
    const reversedAfterIssue: ReversalRow[] = [];
    issued.forEach((pkg, index) => {
      const lines = compared[index]
        .filter((line) => line.difference.lessThan(ZERO))
        .map((line) => ({
          boqItemId: line.boqItemId,
          boqNo: line.boqNo,
          claimed: line.claimed.toFixed(3),
          approvedNow: line.approvedNow.toFixed(3),
          overBy: line.difference.negated().toFixed(3),
        }));
      if (lines.length > 0) {
        reversedAfterIssue.push({
          packageId: pkg.id,
          label: issuedLabels[index],
          periodFrom: iso(pkg.periodFrom),
          periodTo: iso(pkg.periodTo),
          lines,
        });
      }
    });

    return {
      projectId,
      rows,
      totalOverClaimed: rows.reduce(
        (sum, row) => sum + row.overClaimedCount,
        0,
      ),
      totalLines: rows.reduce((sum, row) => sum + row.lineCount, 0),
      reversedAfterIssue,
    };
  }

  /** Issued or certified client packages, oldest first, with everything both reports read. */
  private issuedClientPackages(ctx: RlsContext, projectId: string) {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackage.findMany({
        where: {
          projectId,
          direction: BillDirection.to_client,
          status: {
            in: [BillPackageStatus.issued, BillPackageStatus.certified],
          },
        },
        select: {
          id: true,
          sequenceNo: true,
          direction: true,
          counterpartyKey: true,
          periodFrom: true,
          periodTo: true,
          claims: {
            select: {
              claimedQty: true,
              proposedQty: true,
              overClaimed: true,
              clientBillLine: {
                select: {
                  boqTaskItemId: true,
                  boqTaskItem: { select: { boqNo: true } },
                },
              },
            },
          },
        },
        orderBy: { sequenceNo: 'asc' },
      }),
    );
  }

  /** "RA-03 · Tirupati Enterprises" — the number alone repeats once per counterparty. */
  private async labels(
    ctx: RlsContext,
    companyId: string | undefined,
    packages: {
      sequenceNo: number;
      direction: BillDirection;
      counterpartyKey: string;
    }[],
  ): Promise<string[]> {
    const names =
      companyId && packages.length > 0
        ? await this.namer.counterpartyNames(
            ctx,
            companyId,
            packages.map((pkg) => ({ ...pkg, projectId: '' })),
          )
        : packages.map(() => null);
    return packages.map((pkg, index) => {
      const label = packageLabel(pkg.sequenceNo);
      return names[index] ? `${label} · ${names[index]}` : label;
    });
  }

  /**
   * **The one comparison** FR-014b, FR-048 and FR-049b all ask for (FR-048a).
   *
   * Re-reads each period's approved measurement as it now stands and holds it against what the bill
   * claimed: positive is an understatement, negative is a reversal after issue. Same subtraction.
   * Periods repeat across the two reports and across bills that share dates, so each distinct
   * period is read once.
   */
  private async compareAll(
    ctx: RlsContext,
    projectId: string,
    packages: {
      periodFrom: Date;
      periodTo: Date;
      claims: {
        claimedQty: Prisma.Decimal;
        clientBillLine: {
          boqTaskItemId: string;
          boqTaskItem: { boqNo: string };
        } | null;
      }[];
    }[],
  ): Promise<
    {
      boqItemId: string;
      boqNo: string;
      claimed: Prisma.Decimal;
      approvedNow: Prisma.Decimal;
      difference: Prisma.Decimal;
    }[][]
  > {
    const figures = new Map<string, Map<string, string>>();
    const out = [];
    for (const pkg of packages) {
      const range = { from: iso(pkg.periodFrom), to: iso(pkg.periodTo) };
      const key = `${range.from}..${range.to}`;
      if (!figures.has(key)) {
        const read = await this.periodFigures.figuresFor(ctx, projectId, range);
        figures.set(
          key,
          new Map(
            read.lines.map((line) => [line.boqItemId, line.approvedInPeriod]),
          ),
        );
      }
      const approvedNow = figures.get(key) as Map<string, string>;
      const lines = [];
      for (const claim of pkg.claims) {
        const line = claim.clientBillLine;
        if (!line) continue;
        const now = new Prisma.Decimal(
          approvedNow.get(line.boqTaskItemId) ?? '0',
        );
        // Exact. No tolerance — fixed-point arithmetic does not need one, and inventing one would
        // hide exactly the small differences nobody else would find.
        const difference = now.minus(claim.claimedQty);
        if (difference.isZero()) continue;
        lines.push({
          boqItemId: line.boqTaskItemId,
          boqNo: line.boqTaskItem.boqNo,
          claimed: claim.claimedQty,
          approvedNow: now,
          difference,
        });
      }
      out.push(lines);
    }
    return out;
  }
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
