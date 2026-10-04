import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { CreateBoqGroupDto, CreateBoqItemDto } from './dto/boq.dto';

const DEC = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

export interface BoqItemView {
  id: string;
  boqNo: string;
  taskName: string;
  /** As the source spelled it (FR-041). */
  unit: string;
  scopeQty: string;
  rate: string;
  doneQty: string;
  pendingQty: string;
  /** Null where unplanned — never 0, which would read as "achieving nothing" (FR-037). */
  perDayQty: string | null;
  avgQtyPerDay: string | null;
  daysToComplete: number | null;
  startDate: Date | null;
  finishDate: Date | null;
  isVariation: boolean;
  /**
   * True for a line imported from an internal **estimate** rather than from the client's tender
   * (US4 AC6).
   *
   * Carried on the view because it changes what the line is for, not just where it came from: an
   * estimate line is the company's own costing and is **not billable to the client**
   * (`BOQ_LINE_IS_ESTIMATE`), and it carries no programme, so it is excluded from the alert groups.
   * A screen that could not tell the two apart would show one project's tender and its estimate as
   * one schedule with doubled quantities.
   */
  isEstimate: boolean;
  /** Exactly one of the five, always (FR-048). `onTrack` means no alert. */
  state: LineState;
}

export interface BoqGroupView {
  id: string;
  boqNo: string;
  name: string;
  scopeQty: string;
  startDate: Date | null;
  finishDate: Date | null;
  /** True for a section imported from an internal estimate — see `BoqItemView.isEstimate`. */
  isEstimate: boolean;
  items: BoqItemView[];
}

/**
 * Every state a line can be in — **five**, of which four are alerts (008 FR-048).
 *
 * `onTrack` is the fifth and it is not an alert: a line inside its dates and keeping pace, or one
 * finished before its finish date, needs nobody's attention. The four alert groups are exhaustive
 * over *lines that need attention*; these five are exhaustive over every line, which is what makes
 * "exactly one home" true without reporting completed work as outstanding.
 */
export type LineState =
  | 'today'
  | 'delayed'
  | 'toBeDelayed'
  | 'unplanned'
  | 'onTrack';

/** The four states the alerts endpoint groups by. `onTrack` is deliberately absent. */
export type AlertGroup = Exclude<LineState, 'onTrack'>;

export interface BoqAlerts {
  today: BoqItemView[];
  delayed: BoqItemView[];
  toBeDelayed: BoqItemView[];
  /** The normal state of a freshly imported tender, and reported rather than hidden (FR-048). */
  unplanned: BoqItemView[];
}

const ITEM_SELECT = {
  id: true,
  boqNo: true,
  taskName: true,
  unit: true,
  scopeQty: true,
  rate: true,
  doneQty: true,
  perDayQty: true,
  startDate: true,
  finishDate: true,
  duration: true,
  isVariation: true,
  isEstimate: true,
} as const;

/**
 * BOQ entry, the tree, and the alerts (008 US4).
 *
 * The import is next door in `BoqImportService`; this is the path that needs no spreadsheet at
 * all, and the one every imported line is edited through afterwards.
 */
@Injectable()
export class BoqService {
  constructor(private readonly prisma: PrismaService) {}

  async createGroup(
    ctx: RlsContext,
    projectId: string,
    input: CreateBoqGroupDto,
    companyId: string,
  ) {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      return tx.bOQTaskGroup.create({
        data: {
          companyId,
          projectId,
          boqNo: input.boqNo,
          name: input.name,
          scopeQty: input.scopeQty,
          startDate: input.startDate ? new Date(input.startDate) : null,
          finishDate: input.finishDate ? new Date(input.finishDate) : null,
        },
        select: { id: true, boqNo: true, name: true },
      });
    });
  }

  async createItem(
    ctx: RlsContext,
    projectId: string,
    input: CreateBoqItemDto,
    companyId: string,
  ) {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      // The group has to belong to this project. Without the check, a group id from another
      // project would file the line against a schedule its author cannot see.
      const group = await tx.bOQTaskGroup.findFirst({
        where: { id: input.groupId, projectId },
        select: { id: true },
      });
      if (!group)
        throw new NotFoundException('BOQ group not found on this project');

      if (
        input.finishDate &&
        input.startDate &&
        input.finishDate < input.startDate
      ) {
        throw new BadRequestException(
          'The finish date is before the start date.',
        );
      }

      return tx.bOQTaskItem.create({
        data: {
          companyId,
          groupId: input.groupId,
          boqNo: input.boqNo,
          taskName: input.taskName,
          unit: input.unit,
          scopeQty: input.scopeQty,
          rate: input.rate ?? '0',
          startDate: input.startDate ? new Date(input.startDate) : null,
          finishDate: input.finishDate ? new Date(input.finishDate) : null,
          duration: input.duration ?? null,
          perDayQty: input.perDayQty ?? null,
          isVariation: input.isVariation ?? false,
          variationRef: input.variationRef ?? null,
        },
        select: { id: true, boqNo: true, taskName: true },
      });
    });
  }

  async getTree(
    ctx: RlsContext,
    projectId: string,
    asOf = new Date(),
  ): Promise<BoqGroupView[]> {
    const groups = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.bOQTaskGroup.findMany({
        where: { projectId },
        orderBy: { boqNo: 'asc' },
        select: {
          id: true,
          boqNo: true,
          name: true,
          scopeQty: true,
          startDate: true,
          finishDate: true,
          isEstimate: true,
          items: { orderBy: { boqNo: 'asc' }, select: ITEM_SELECT },
        },
      }),
    );

    return groups.map((group) => ({
      id: group.id,
      boqNo: group.boqNo,
      name: group.name,
      scopeQty: group.scopeQty.toFixed(3),
      startDate: group.startDate,
      finishDate: group.finishDate,
      isEstimate: group.isEstimate,
      items: group.items.map((item) => viewOf(item, asOf)),
    }));
  }

  /**
   * The four groups, and every line in exactly one of them (008 FR-047, FR-048).
   *
   * Returns four rather than three. A line with no finish date is **unplanned** — a reported state
   * of its own, not a synonym for on-time and not a synonym for delayed. Three groups would mean
   * an imported tender's 231 lines are silently absent from the one screen whose whole claim is to
   * show what needs attention.
   */
  async getAlerts(
    ctx: RlsContext,
    projectId: string,
    asOf = new Date(),
  ): Promise<BoqAlerts> {
    const tree = await this.getTree(ctx, projectId, asOf);
    const alerts: BoqAlerts = {
      today: [],
      delayed: [],
      toBeDelayed: [],
      unplanned: [],
    };
    for (const group of tree) {
      // An internal estimate carries no programme and is not work anybody is delivering, so its
      // lines are excluded rather than reported unplanned (US4 AC6). Including them would bury the
      // tender's own lines under a second copy of the same scope on the one screen whose claim is
      // to show what needs attention — and the estimate's quantities are a costing, not a
      // commitment to anybody.
      if (group.isEstimate) continue;
      for (const item of group.items) {
        if (item.isEstimate) continue;
        // `onTrack` is the absence of an alert, so it belongs on the tree and not here. Putting it
        // in one of the four would report work that needs nobody's attention as needing it today,
        // which is the defect the old three-group definition had in the other direction.
        if (item.state !== 'onTrack') alerts[item.state].push(item);
      }
    }
    return alerts;
  }

  /**
   * Moves a line's completed quantity, on DWR **approval** only (research §13).
   *
   * A submission is a claim and an approval is a decision; counting the first as progress is what
   * makes a BOQ disagree with the site.
   */
  async updateDoneQty(
    ctx: RlsContext,
    itemId: string,
    delta: Prisma.Decimal.Value,
  ) {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.bOQTaskItem.update({
        where: { id: itemId },
        data: { doneQty: { increment: DEC(delta) } },
        select: { id: true, doneQty: true },
      }),
    );
  }

  /**
   * Applies several lines' completed quantities **inside a caller's transaction**, in one statement
   * (022 FR-013, FR-015, FR-015a, FR-021).
   *
   * ## Why `updateDoneQty` above could not be used for this
   *
   * That method opens its own transaction through `withRlsContext`, which is right for a single
   * movement and wrong for a report. A daily work report must apply **every** one of its increments
   * or none (022 FR-013), and seventeen calls to a method that each commit separately is the
   * precise opposite: a failure half way leaves the BOQ showing work nobody approved, the report
   * still submitted, and no way to tell which lines moved.
   *
   * It is also the latency shape that produced a production 500 on 2026-10-04 — the BOQ import's
   * confirm step made 132 sequential round trips inside one 5 000 ms transaction budget, passing
   * every local run because the local round trip is short.
   *
   * ## Why one raw statement rather than a loop of `update` calls
   *
   * Three properties, and the statement gives all three where a loop gives none:
   *
   * 1. **Relative.** `"doneQty" = "doneQty" + delta`, evaluated by Postgres against the row as it
   *    stands. Two reports measuring one line, approved at the same moment, both land. A
   *    read-then-write would lose one, and lose it silently (022 FR-015, FR-015a).
   * 2. **One round trip**, whatever the line count.
   * 3. **The floor is part of the statement.** `AND "doneQty" + delta >= 0` means a row that would
   *    go negative is simply not updated and the returned count is short — so 022 FR-021 is
   *    enforced by the database rather than by a check the caller might forget. The caller compares
   *    the count and throws, which makes FR-013 and FR-021 one mechanism instead of two.
   *
   * Returns the number of rows actually updated. **The caller must compare it** against the number
   * it asked for; a shortfall means a line was missing or would have gone negative, and the
   * transaction must be rolled back by throwing.
   */
  async applyDoneQtyDeltas(
    tx: Prisma.TransactionClient,
    deltas: { itemId: string; delta: Prisma.Decimal }[],
  ): Promise<number> {
    if (deltas.length === 0) return 0;

    const values = Prisma.join(
      deltas.map(
        (d) => Prisma.sql`(${d.itemId}::text, ${d.delta.toFixed(3)}::numeric)`,
      ),
    );

    return tx.$executeRaw`
      UPDATE "projects"."BOQTaskItem" AS b
         SET "doneQty" = b."doneQty" + d.delta,
             "updatedAt" = NOW()
        FROM (VALUES ${values}) AS d(id, delta)
       WHERE b."id" = d.id
         AND b."doneQty" + d.delta >= 0
    `;
  }

  /**
   * Sets a line's completed quantity to an **absolute** value, returning what it held before
   * (022 FR-015b, FR-039c, decision D3).
   *
   * ## The one exception to relative-only movement, and why it must exist
   *
   * Every other path moves this counter by an increment, because `doneQty` is denormalised and two
   * concurrent approvals must both land. Reconciliation repair cannot work that way: it exists
   * precisely because the counter has drifted from the sum of approved measurement, and "make this
   * equal that" is not expressible as an increment when the difference is the very thing being
   * corrected. Computing a delta and incrementing by it would subtract from the drifted figure and
   * so preserve the drift it was called to remove.
   *
   * **This contradiction between 022 FR-015 and FR-039c was invisible inside the specification.**
   * Both requirements are individually sound; they disagree only at the mechanism level, which
   * cross-artifact analysis surfaced on 2026-10-04 as finding F1. FR-015b records the exception.
   *
   * Reachable only from reconciliation repair, which is permissioned, requires a stated reason, and
   * audits the previous value this method returns. Never automatic: a discrepancy is the only
   * symptom of whatever moved the counter without a report, and a silent self-heal would destroy
   * that evidence every time it ran.
   */
  async setDoneQtyAbsolute(
    tx: Prisma.TransactionClient,
    itemId: string,
    value: Prisma.Decimal,
  ): Promise<{ previous: Prisma.Decimal; current: Prisma.Decimal }> {
    if (value.isNegative()) {
      throw new BadRequestException(
        'A completed quantity cannot be set to a negative value.',
      );
    }

    const before = await tx.bOQTaskItem.findUnique({
      where: { id: itemId },
      select: { doneQty: true },
    });
    if (!before) throw new NotFoundException('BOQ line not found');

    const after = await tx.bOQTaskItem.update({
      where: { id: itemId },
      data: { doneQty: value },
      select: { doneQty: true },
    });

    return { previous: before.doneQty, current: after.doneQty };
  }

  /**
   * Deletes a line, unless something already measures against it.
   *
   * **Three relations, not one.** A line can be referenced by a DWR task, a client bill line and a
   * work-order award line, and each of those would be left pointing at nothing. Checking only the
   * DWR — the obvious one, and the only one that existed when US4 was written — would let a billed
   * line be deleted out from under a submitted bill.
   */
  async deleteItem(ctx: RlsContext, projectId: string, itemId: string) {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const item = await tx.bOQTaskItem.findFirst({
        where: { id: itemId, group: { projectId } },
        select: {
          id: true,
          _count: {
            select: { dwrTasks: true, clientBillLines: true, awardLines: true },
          },
        },
      });
      if (!item)
        throw new NotFoundException('BOQ item not found on this project');

      const { dwrTasks, clientBillLines, awardLines } = item._count;
      if (dwrTasks + clientBillLines + awardLines > 0) {
        throw new ConflictException(
          'This line cannot be deleted because work has already been recorded against it: ' +
            [
              dwrTasks > 0 &&
                `${dwrTasks} daily work report ${plural(
                  dwrTasks,
                  'entry',
                  'entries',
                )}`,
              clientBillLines > 0 &&
                `${clientBillLines} client bill ${plural(
                  clientBillLines,
                  'line',
                )}`,
              awardLines > 0 &&
                `${awardLines} work order award ${plural(awardLines, 'line')}`,
            ]
              .filter(Boolean)
              .join(', ') +
            '. Revise the quantity to zero instead, which keeps the history.',
        );
      }

      await tx.bOQTaskItem.delete({ where: { id: itemId } });
      return { id: itemId };
    });
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

type ItemRow = {
  id: string;
  boqNo: string;
  taskName: string;
  unit: string;
  scopeQty: Prisma.Decimal;
  rate: Prisma.Decimal;
  doneQty: Prisma.Decimal;
  perDayQty: Prisma.Decimal | null;
  startDate: Date | null;
  finishDate: Date | null;
  duration: number | null;
  isVariation: boolean;
  isEstimate: boolean;
};

const MS_PER_DAY = 86_400_000;

function viewOf(item: ItemRow, asOf: Date): BoqItemView {
  const pending = item.scopeQty.minus(item.doneQty);
  const needed = neededRate(item, pending, asOf);
  const achieved = achievedRate(item, asOf);

  return {
    id: item.id,
    boqNo: item.boqNo,
    taskName: item.taskName,
    unit: item.unit,
    scopeQty: item.scopeQty.toFixed(3),
    rate: item.rate.toFixed(2),
    isEstimate: item.isEstimate,
    doneQty: item.doneQty.toFixed(3),
    pendingQty: pending.toFixed(3),
    perDayQty: item.perDayQty?.toFixed(3) ?? null,
    avgQtyPerDay: achieved?.toFixed(3) ?? null,
    daysToComplete: daysToComplete(pending, achieved),
    startDate: item.startDate,
    finishDate: item.finishDate,
    isVariation: item.isVariation,
    state: stateOf(item, pending, needed, achieved, asOf),
  };
}

/**
 * Which one of the five states a line is in (FR-048).
 *
 * **Ordered so the five are disjoint and cover every line**, with the finish date deciding first.
 * A line with a finish date and no per-day quantity still has exactly one home, because the needed
 * rate is *derived* where that column is empty rather than treated as zero — the pre-amendment
 * definition compared against `perDayQty` directly, and once that column became optional it would
 * have read every imported line as not-at-risk.
 *
 * **`onTrack` exists because the first draft of this function did not have it**, and a line
 * finished before its finish date therefore fell through into `today`. That reports completed work
 * as needing attention — the mirror image of the defect the amendment set out to fix, written into
 * the amendment's own replacement. FR-048 was corrected with this function.
 */
function stateOf(
  item: ItemRow,
  pending: Prisma.Decimal,
  needed: Prisma.Decimal | null,
  achieved: Prisma.Decimal | null,
  asOf: Date,
): LineState {
  if (!item.finishDate) return 'unplanned';
  // Nothing outstanding is nothing to report, whatever the dates say.
  if (pending.lessThanOrEqualTo(0)) return 'onTrack';

  const finish = startOfDay(item.finishDate).getTime();
  const today = startOfDay(asOf).getTime();
  if (finish < today) return 'delayed';
  if (finish === today) return 'today';
  if (needed !== null && achieved !== null && needed.greaterThan(achieved))
    return 'toBeDelayed';
  return 'onTrack';
}

/** `perDayQty` where set, else what finishing by the finish date would take (FR-047). */
function neededRate(
  item: ItemRow,
  pending: Prisma.Decimal,
  asOf: Date,
): Prisma.Decimal | null {
  if (item.perDayQty) return item.perDayQty;
  if (!item.finishDate) return null;
  const daysLeft = Math.ceil(
    (startOfDay(item.finishDate).getTime() - startOfDay(asOf).getTime()) /
      MS_PER_DAY,
  );
  if (daysLeft <= 0) return null;
  return pending.dividedBy(daysLeft);
}

/** What has actually been achieved per day since the line started. */
function achievedRate(item: ItemRow, asOf: Date): Prisma.Decimal | null {
  if (!item.startDate) return null;
  const elapsed = Math.ceil(
    (startOfDay(asOf).getTime() - startOfDay(item.startDate).getTime()) /
      MS_PER_DAY,
  );
  if (elapsed <= 0) return null;
  return item.doneQty.dividedBy(elapsed);
}

function daysToComplete(
  pending: Prisma.Decimal,
  achieved: Prisma.Decimal | null,
): number | null {
  // Null rather than Infinity when nothing has been achieved: "no progress yet" and "it will take
  // forever" look the same in arithmetic and are different facts to a reader.
  if (!achieved || achieved.lessThanOrEqualTo(0)) return null;
  return Math.ceil(pending.dividedBy(achieved).toNumber());
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
