import { Injectable } from '@nestjs/common';
import { BillDirection, BillPackageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { DwrPeriodFiguresService } from '../../dwr/dwr-period-figures.service';
import { packageLabel } from './bill-package.service';

/** One line of an issued package whose period's measurement has since grown. */
export interface UnderstatedLine {
  boqItemId: string;
  boqNo: string;
  claimed: string;
  approvedNow: string;
  understatedBy: string;
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
  ) {}

  /**
   * Issued packages whose period's approved measurement has since moved (FR-014b, FR-048, FR-049b).
   *
   * **On demand, and exact.** Quantities are fixed-point, so there is no tolerance to apply and any
   * difference at all is reportable — an implementer assuming a float tolerance would hide small
   * understatements, which are the ones nobody would otherwise find.
   *
   * Only the client direction is compared. A subcontractor bill measures award lines, and 022
   * attributes measurement to BOQ lines, so for that direction the question has no answer this
   * report could give — stated rather than silently returning nothing.
   */
  async understatement(
    ctx: RlsContext,
    projectId: string,
  ): Promise<{
    projectId: string;
    rows: UnderstatementRow[];
    comparableDirections: string[];
  }> {
    const packages = await withRlsContext(this.prisma, ctx, (tx) =>
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
          periodFrom: true,
          periodTo: true,
          claims: {
            select: {
              claimedQty: true,
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

    const rows: UnderstatementRow[] = [];
    for (const pkg of packages) {
      const lines = await this.compare(ctx, projectId, pkg);
      if (lines.length > 0) {
        rows.push({
          packageId: pkg.id,
          label: packageLabel(pkg.sequenceNo),
          periodFrom: iso(pkg.periodFrom),
          periodTo: iso(pkg.periodTo),
          lines,
          remedy: REMEDY,
        });
      }
    }

    return {
      projectId,
      rows,
      // Said out loud, because a report that silently covers one direction reads as covering both.
      comparableDirections: ['to_client'],
    };
  }

  /**
   * **The one comparison** FR-014b, FR-048 and FR-049b all ask for (FR-048a).
   *
   * Re-reads the period's approved measurement as it now stands and holds it against what the bill
   * claimed. A quantity that has grown since issue is an understatement (FR-014b); one that has
   * shrunk is the discrepancy a reversal after issue leaves (FR-048); and one that appears in a
   * period already billed is the work-date correction FR-049b needs detected. Same subtraction.
   */
  private async compare(
    ctx: RlsContext,
    projectId: string,
    pkg: {
      periodFrom: Date;
      periodTo: Date;
      claims: {
        claimedQty: Prisma.Decimal;
        clientBillLine: {
          boqTaskItemId: string;
          boqTaskItem: { boqNo: string };
        } | null;
      }[];
    },
  ): Promise<UnderstatedLine[]> {
    const figures = await this.periodFigures.figuresFor(ctx, projectId, {
      from: iso(pkg.periodFrom),
      to: iso(pkg.periodTo),
    });
    const approvedNow = new Map(
      figures.lines.map((line) => [line.boqItemId, line.approvedInPeriod]),
    );

    const out: UnderstatedLine[] = [];
    for (const claim of pkg.claims) {
      const line = claim.clientBillLine;
      if (!line) continue;
      const now = new Prisma.Decimal(
        approvedNow.get(line.boqTaskItemId) ?? '0',
      );
      const difference = now.minus(claim.claimedQty);
      // Exact. No tolerance — fixed-point arithmetic does not need one, and inventing one would
      // hide exactly the small differences nobody else would find.
      if (difference.greaterThan(ZERO)) {
        out.push({
          boqItemId: line.boqTaskItemId,
          boqNo: line.boqTaskItem.boqNo,
          claimed: claim.claimedQty.toFixed(3),
          approvedNow: now.toFixed(3),
          understatedBy: difference.toFixed(3),
        });
      }
    }
    return out;
  }

  /**
   * Over-claims, counted per package and per project, **with their denominator** (FR-006a, FR-006b).
   *
   * A line proposed from `no_measurement_source` is never counted: nothing was exceeded, and
   * counting it would turn this into a count of unmapped award lines — which is the mitigation D2
   * depends on, so it has to count the thing it claims to.
   */
  async overClaims(
    ctx: RlsContext,
    projectId: string,
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
                    select: { boqTaskItem: { select: { boqNo: true } } },
                  },
                },
              },
            },
          },
        },
        orderBy: { sequenceNo: 'asc' },
      }),
    );

    const rows = packages.map((pkg) => ({
      packageId: pkg.id,
      label: packageLabel(pkg.sequenceNo),
      status: pkg.status,
      overClaimedCount: pkg.claims.length,
      lineCount: pkg._count.claims,
      lines: pkg.claims.map((claim) => ({
        boqNo:
          claim.clientBillLine?.boqTaskItem.boqNo ??
          claim.raBillLine?.workOrderBoqItem.boqTaskItem?.boqNo ??
          '',
        claimed: claim.claimedQty.toFixed(3),
        proposed: claim.proposedQty?.toFixed(3) ?? null,
        reason: claim.reason,
      })),
    }));

    return {
      projectId,
      rows,
      totalOverClaimed: rows.reduce(
        (sum, row) => sum + row.overClaimedCount,
        0,
      ),
      totalLines: rows.reduce((sum, row) => sum + row.lineCount, 0),
    };
  }
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
