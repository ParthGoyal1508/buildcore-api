import { Injectable, NotFoundException } from '@nestjs/common';
import { BillDirection, BillPackageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import type { EquipmentLogbookDay } from '../../portfolio/project-sources.registry';
import { ProjectSourcesRegistry } from '../../portfolio/project-sources.registry';
import { packageLabel } from './bill-package.service';

/** One period this item has been claimed in, as the sheet lists it. */
export interface ClaimHistoryRow {
  /** The package the claim went out on — "RA-10", "RA-11", "RA-12". */
  billLabel: string;
  sequenceNo: number;
  periodFrom: string;
  periodTo: string;
  /** The month, as the client's sheet heads the column. */
  month: string;
  quantity: string;
  /**
   * The reduction's reason, **verbatim** (FR-032).
   *
   * No normalising, no trimming to a sentence, no spelling corrected. "30 % deduction Shoulder
   * Slope, Supervisor Labour, Staff Not availeble & ROW Not Cleaned" is the argument the document
   * exists to settle, and an engineer defending a deduction a year later needs the words that were
   * written, not a tidied version of them.
   */
  reason: string | null;
  /** Shown on the sheet so an over-claim can be seen where it was made (FR-006a). */
  overClaimed: boolean;
  /** True where this row is the package the sheet belongs to. */
  isThisBill: boolean;
}

/** A date beneath the claim history, with the machine's day where there is one. */
export interface DailyRecordRow {
  date: string;
  /**
   * **True where no logbook entry exists for the date** (FR-034).
   *
   * Distinct from a day on which nothing was done. 022 established the distinction and its source
   * returns a map, so an absent date is absent rather than a run of zeroes — flattening the two
   * would print "0 km" against a day nobody recorded, which reads as a machine that stood idle.
   */
  logbookMissing: boolean;
  openingReading: string | null;
  closingReading: string | null;
  totalHours: string | null;
  remarks: string | null;
}

export interface MeasurementSheet {
  packageId: string;
  billLabel: string;
  scheduleLineId: string;
  boqNo: string;
  description: string;
  unit: string;
  history: ClaimHistoryRow[];
  dailyRecord: DailyRecordRow[];
  footer: MeasurementFooter;
}

/**
 * The footer identity (FR-035).
 *
 * `thisBillQty + uptoPreviousQty = uptoDateQty`, **exactly**. The one property of a package that
 * cannot be checked by reading a single bill.
 */
export interface MeasurementFooter {
  thisBillQty: string;
  /**
   * **Read from the previous issued package's own claim on this item** (FR-013a, FR-014).
   *
   * Not this package's up-to-date figure less its own quantity. The two are equal only while the
   * chain is unbroken — and defining it the second way makes the identity above a rearrangement of
   * its own definition, true for any values whatever. `checklists/silent-failure.md` CHK002 found
   * the plan doing exactly that, which would have made the feature's headline test unable to fail.
   */
  uptoPreviousQty: string;
  uptoDateQty: string;
  /** Which package the up-to-previous figure was read from, so a reviewer can go and look. */
  uptoPreviousFrom: string | null;
}

const ZERO = new Prisma.Decimal(0);

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The measurement sheet's data — one per schedule line (023 US4, FR-031 to FR-035).
 *
 * Holds **no workbook**. It produces the figures and the renderer in `../workbook/` turns them into
 * cells, which is what keeps FR-028's "every figure comes from the stored bill" a property of what
 * the renderer can see rather than a rule it has to follow.
 */
@Injectable()
export class MeasurementSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /**
   * One item's sheet: its claim history across every package, the daily record beneath it, and the
   * footer.
   */
  async sheetFor(
    ctx: RlsContext,
    packageId: string,
    scheduleLineId: string,
  ): Promise<MeasurementSheet> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: {
          id: true,
          companyId: true,
          projectId: true,
          direction: true,
          counterpartyKey: true,
          sequenceNo: true,
          periodFrom: true,
          periodTo: true,
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      const history = await this.historyFor(tx, pkg, scheduleLineId);
      const thisRow = history.find((row) => row.isThisBill);
      const line = await this.lineIdentity(tx, pkg.direction, scheduleLineId);

      return {
        packageId: pkg.id,
        billLabel: packageLabel(pkg.sequenceNo),
        scheduleLineId,
        boqNo: line.boqNo,
        description: line.description,
        unit: line.unit,
        history,
        dailyRecord: await this.dailyRecordFor(tx, pkg, line.boqTaskItemId),
        footer: await this.footerFor(
          tx,
          pkg,
          scheduleLineId,
          thisRow ? new Prisma.Decimal(thisRow.quantity) : ZERO,
        ),
      };
    });
  }

  /**
   * Every period this item has been claimed in, in period order (FR-031).
   *
   * A query across the project's packages rather than a field on one, which is what makes SC-005
   * true: a reason attached to a reduction on RA-10 is readable on the sheet printed with RA-12, a
   * year later, without anything having copied it forward.
   */
  private async historyFor(
    tx: Prisma.TransactionClient,
    pkg: {
      id: string;
      projectId: string;
      direction: BillDirection;
      counterpartyKey: string;
    },
    scheduleLineId: string,
  ): Promise<ClaimHistoryRow[]> {
    const claims = await tx.billPackageLineClaim.findMany({
      where: {
        package: {
          projectId: pkg.projectId,
          direction: pkg.direction,
          counterpartyKey: pkg.counterpartyKey,
          status: { not: BillPackageStatus.abandoned },
        },
        ...(pkg.direction === BillDirection.to_client
          ? { clientBillLine: { boqTaskItemId: scheduleLineId } }
          : { raBillLine: { workOrderBoqItemId: scheduleLineId } }),
      },
      select: {
        packageId: true,
        claimedQty: true,
        reason: true,
        overClaimed: true,
        package: {
          select: { sequenceNo: true, periodFrom: true, periodTo: true },
        },
      },
      orderBy: { package: { periodFrom: 'asc' } },
    });

    return claims.map((claim) => ({
      billLabel: packageLabel(claim.package.sequenceNo),
      sequenceNo: claim.package.sequenceNo,
      periodFrom: iso(claim.package.periodFrom),
      periodTo: iso(claim.package.periodTo),
      // The client's sheet heads this column by the month the period ends in, because a cycle
      // running the 21st to the 20th belongs to the later month in everybody's conversation.
      month: `${
        MONTHS[claim.package.periodTo.getUTCMonth()]
      } ${claim.package.periodTo.getUTCFullYear()}`,
      quantity: claim.claimedQty.toFixed(3),
      // Verbatim (FR-032).
      reason: claim.reason,
      overClaimed: claim.overClaimed,
      isThisBill: claim.packageId === pkg.id,
    }));
  }

  /**
   * The footer (FR-035), with up-to-previous **read** rather than derived.
   *
   * The previous package is the highest sequence number below this one, to the same counterparty,
   * that has been issued — and its own claim on this item is what the middle figure is. Where there
   * is none the figure is `"0.000"`, which is a position, and not absent, which is not.
   */
  private async footerFor(
    tx: Prisma.TransactionClient,
    pkg: {
      projectId: string;
      direction: BillDirection;
      counterpartyKey: string;
      sequenceNo: number;
    },
    scheduleLineId: string,
    thisBillQty: Prisma.Decimal,
  ): Promise<MeasurementFooter> {
    const earlier = await tx.billPackageLineClaim.findMany({
      where: {
        package: {
          projectId: pkg.projectId,
          direction: pkg.direction,
          counterpartyKey: pkg.counterpartyKey,
          sequenceNo: { lt: pkg.sequenceNo },
          status: {
            in: [BillPackageStatus.issued, BillPackageStatus.certified],
          },
        },
        ...(pkg.direction === BillDirection.to_client
          ? { clientBillLine: { boqTaskItemId: scheduleLineId } }
          : { raBillLine: { workOrderBoqItemId: scheduleLineId } }),
      },
      select: {
        claimedQty: true,
        package: { select: { sequenceNo: true } },
      },
      orderBy: { package: { sequenceNo: 'desc' } },
    });

    // Every issued package before this one, summed — which is the predecessor's own up-to-previous
    // plus its own claim, read from the rows rather than reconstructed from this bill's figures.
    const uptoPreviousQty = earlier.reduce(
      (total, claim) => total.plus(claim.claimedQty),
      ZERO,
    );

    return {
      thisBillQty: thisBillQty.toFixed(3),
      uptoPreviousQty: uptoPreviousQty.toFixed(3),
      uptoDateQty: uptoPreviousQty.plus(thisBillQty).toFixed(3),
      uptoPreviousFrom:
        earlier.length > 0 ? packageLabel(earlier[0].package.sequenceNo) : null,
    };
  }

  /** The line's number, description and unit, from whichever schedule it belongs to. */
  private async lineIdentity(
    tx: Prisma.TransactionClient,
    direction: BillDirection,
    scheduleLineId: string,
  ): Promise<{
    boqNo: string;
    description: string;
    unit: string;
    boqTaskItemId: string | null;
  }> {
    if (direction === BillDirection.to_client) {
      const item = await tx.bOQTaskItem.findFirst({
        where: { id: scheduleLineId },
        select: { id: true, boqNo: true, taskName: true, unit: true },
      });
      if (!item) throw new NotFoundException('Schedule line not found');
      return {
        boqNo: item.boqNo,
        description: item.taskName,
        unit: item.unit,
        boqTaskItemId: item.id,
      };
    }

    const award = await tx.workOrderBOQItem.findFirst({
      where: { id: scheduleLineId },
      select: {
        description: true,
        unit: true,
        boqTaskItemId: true,
        boqTaskItem: { select: { boqNo: true } },
      },
    });
    if (!award) throw new NotFoundException('Schedule line not found');
    return {
      boqNo: award.boqTaskItem?.boqNo ?? '',
      description: award.description,
      unit: award.unit,
      boqTaskItemId: award.boqTaskItemId,
    };
  }

  /**
   * The daily record beneath the claim history (FR-033, FR-034).
   *
   * Read through `ProjectSourcesRegistry`, **never by querying the `plant` schema** — Principle I,
   * and the registry 022 built for exactly this. Where no source is registered the record is simply
   * empty: the sheet is still correct, it just has no odometer beneath it, which is the right answer
   * for an item whose work is not a machine running.
   *
   * Every date in the period appears. A date with no entry carries `logbookMissing` rather than
   * zeroes, because "nobody recorded this day" and "the machine did not move" are different facts
   * and only one of them is an argument for a deduction.
   */
  private async dailyRecordFor(
    tx: Prisma.TransactionClient,
    pkg: {
      companyId: string;
      projectId: string;
      periodFrom: Date;
      periodTo: Date;
    },
    boqTaskItemId: string | null,
  ): Promise<DailyRecordRow[]> {
    const source = this.sources.logbookSource();
    if (!source || !boqTaskItemId) return [];

    // Which machine this line's work was recorded against, from 022's own reports. A line measured
    // by hand has none, and then there is nothing to print.
    const equipment = await tx.dWRTask.findFirst({
      where: {
        boqItemId: boqTaskItemId,
        equipmentId: { not: null },
        dwr: {
          projectId: pkg.projectId,
          workDate: { gte: pkg.periodFrom, lte: pkg.periodTo },
        },
      },
      select: { equipmentId: true },
      // The most recent report in the period that named a machine. `DWRTask` carries no timestamp of
      // its own, and the parent's work date is the better key regardless: where a line was worked by
      // two machines in a month, the sheet shows the one that finished it.
      orderBy: { dwr: { workDate: 'desc' } },
    });
    if (!equipment?.equipmentId) return [];

    const dates = datesBetween(pkg.periodFrom, pkg.periodTo);
    const days = await source.getLogbookDays(
      equipment.equipmentId,
      pkg.companyId,
      dates,
    );

    return dates.map((date) => {
      const day: EquipmentLogbookDay | undefined = days.get(date);
      if (!day) {
        return {
          date,
          logbookMissing: true,
          openingReading: null,
          closingReading: null,
          totalHours: null,
          remarks: null,
        };
      }
      return {
        date,
        logbookMissing: false,
        openingReading: day.openingReading,
        closingReading: day.closingReading,
        totalHours: day.totalHours,
        remarks: day.remarks,
      };
    });
  }
}

/** Every date from one day to another, both inclusive (FR-001). */
export function datesBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cursor.getTime() <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
