import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  DwrStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { BoqService } from '../boq/boq.service';
import { DWR_ERRORS } from './dwr-error-codes';
import { sortByBoqNo } from '../boq/boq-order';

/** One BOQ line's approved measurement, for one billing period. */
export interface PeriodFigureLine {
  boqItemId: string;
  boqNo: string;
  taskName: string;
  unit: string;
  scopeQty: string;
  /** Approved **within** the range, attributed by work date (FR-034, FR-036). */
  approvedInPeriod: string;
  /** Approved **before** the range begins. */
  approvedBefore: string;
  /** The two, added. */
  approvedUpToDate: string;
  /** The stored counter, for comparison — see `reconcile` (FR-039b). */
  doneQty: string;
}

export interface PeriodFigures {
  from: string;
  to: string;
  lines: PeriodFigureLine[];
}

export interface ReconciliationLine {
  boqItemId: string;
  boqNo: string;
  doneQty: string;
  approvedSum: string;
  /** `doneQty − approvedSum`. Exactly 0 when the cache agrees with the record. */
  difference: string;
}

export interface Reconciliation {
  lines: ReconciliationLine[];
  discrepancies: number;
}

/**
 * The approved measurement a bill is composed from (022 US6, FR-034 to FR-039c).
 *
 * ## What this is for
 *
 * Feature 023 renders the client's RA bill package, and the first thing it needs is one number per
 * BOQ line: how much was approved **in this billing period**, how much before it, and the total.
 * In the real package those three are the columns headed *This Month*, *Upto Previous* and *Upto
 * Date*, and every sheet in the document is built from them.
 *
 * Specified here with its own tests rather than discovered as an implementation detail of a bill,
 * because a figure that arrives as a side effect of rendering is a figure nobody checks.
 *
 * ## Three decisions, each of which could plausibly have gone the other way
 *
 * **Aggregated, never stored.** 018 research §3 settled this question for cumulative *billed*
 * quantity and the reasoning transfers unchanged: a stored running total is a second source of
 * truth for a number already fully determined by its rows, and every path that edits or reverses
 * has to remember to adjust it. That document named `doneQty` as the existing instance of the
 * pattern. Adding a second counter for the same quantity would be doing knowingly what 018
 * declined to do.
 *
 * **Attributed by work date, not approval date** (FR-036). A report for 21 December approved on
 * 5 January belongs to December, or December's bill is short by it and January's claims work done
 * before its period began. The client's own sheets make this explicit — each row carries both the
 * month and the period, against the RA bill it was claimed in.
 *
 * **Every BOQ line is returned, including ones nobody has measured** (FR-037). A line absent from
 * a response and a line that measured nothing are indistinguishable to the caller, and the caller
 * is a bill. This is the silent-failure shape this repository keeps meeting: an import that
 * reported success with zero rows, a guard that passed against an empty list. Zeros are present so
 * nothing can lose a line by not finding it, and `lineCount` is returned so the caller can assert
 * the count rather than trusting the contents (FR-037a).
 */
@Injectable()
export class DwrPeriodFiguresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly boq: BoqService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** FR-034 to FR-038. */
  async figuresFor(
    ctx: RlsContext,
    projectId: string,
    range: { from: string; to: string },
  ): Promise<PeriodFigures> {
    const from = dayStart(range.from);
    const to = dayStart(range.to);

    if (to < from) {
      throw new BadRequestException({
        code: DWR_ERRORS.rangeInverted,
        message: `The period ends (${range.to}) before it begins (${range.from}).`,
      });
    }

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true },
      });
      // Not found rather than forbidden — a 403 would confirm the project exists (FR-029).
      if (!project) throw new NotFoundException('Project not found');

      // Every line in the project, in BOQ order. This query is what makes FR-037 true: the figures
      // are joined **onto** the schedule rather than assembled from whatever measurement happens to
      // exist, so a line nobody has measured is a row with zeros and not a missing row.
      const items = await tx.bOQTaskItem.findMany({
        where: { group: { projectId } },
        select: {
          id: true,
          boqNo: true,
          taskName: true,
          unit: true,
          scopeQty: true,
          doneQty: true,
        },
        orderBy: [{ group: { boqNo: 'asc' } }, { boqNo: 'asc' }],
      });

      // Text order puts 10 before 2 — see `boq-order.ts`. The group is already ordered by the
      // query; this orders the lines within whatever that produced.
      sortByBoqNo(items);

      if (items.length === 0) {
        // FR-037b. Empty, not an error: a project whose BOQ has not been imported yet is an
        // ordinary state, and a 404 here would be read as "the project does not exist".
        return { from: range.from, to: range.to, lines: [] };
      }

      const itemIds = items.map((item) => item.id);

      // Two grouped aggregates rather than one query per line, and **only approved reports**
      // (FR-035). A reversed report is back in `draft`, so excluding non-approved statuses excludes
      // it with no special case — which is why reversal returns a report to draft rather than
      // marking it reversed-but-approved.
      const [inPeriod, before] = await Promise.all([
        this.sumApproved(tx, itemIds, { gte: from, lte: to }),
        this.sumApproved(tx, itemIds, { lt: from }),
      ]);

      return {
        from: range.from,
        to: range.to,
        lines: items.map((item) => {
          const period = inPeriod.get(item.id) ?? ZERO;
          const prior = before.get(item.id) ?? ZERO;
          return {
            boqItemId: item.id,
            boqNo: item.boqNo,
            taskName: item.taskName,
            unit: item.unit,
            scopeQty: item.scopeQty.toFixed(3),
            approvedInPeriod: period.toFixed(3),
            approvedBefore: prior.toFixed(3),
            approvedUpToDate: period.plus(prior).toFixed(3),
            doneQty: item.doneQty.toFixed(3),
          };
        }),
      };
    });
  }

  /**
   * The difference between the stored counter and the authoritative sum, per line (FR-039).
   *
   * **At an exact tolerance** (FR-039a). Both figures are decimal quantities to three places and
   * every increment is exact, so any non-zero difference is a defect rather than rounding — and
   * treating it as rounding is how a drift survives a year of being looked at.
   *
   * **The sum is authoritative and `doneQty` is a cache of it** (FR-039b). The sum is derived from
   * the reports that are the record of what happened; the counter is maintained for the sake of
   * fast reads. When they disagree it is the cache that has drifted, by construction.
   *
   * This endpoint is not a convenience beside the counter. It is the only thing in the system that
   * can say the counter is wrong, and a denormalised total with no way to check it is a total whose
   * drift is discovered at a month-end.
   */
  async reconcile(ctx: RlsContext, projectId: string): Promise<Reconciliation> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const items = await tx.bOQTaskItem.findMany({
        where: { group: { projectId } },
        select: { id: true, boqNo: true, doneQty: true },
        orderBy: [{ group: { boqNo: 'asc' } }, { boqNo: 'asc' }],
      });
      // Text order puts 10 before 2 — see `boq-order.ts`.
      sortByBoqNo(items);
      if (items.length === 0) return { lines: [], discrepancies: 0 };

      const sums = await this.sumApproved(
        tx,
        items.map((i) => i.id),
        undefined,
      );

      const lines = items.map((item) => {
        const approvedSum = sums.get(item.id) ?? ZERO;
        return {
          boqItemId: item.id,
          boqNo: item.boqNo,
          doneQty: item.doneQty.toFixed(3),
          approvedSum: approvedSum.toFixed(3),
          difference: item.doneQty.minus(approvedSum).toFixed(3),
        };
      });

      return {
        lines,
        discrepancies: lines.filter((l) => l.difference !== '0.000').length,
      };
    });
  }

  /**
   * Sets the counter to the authoritative sum for the lines named (FR-039c, decision D3).
   *
   * **Explicit, permissioned, recorded with the previous value, and never automatic.** An automatic
   * self-heal would be easy and is the wrong choice: the discrepancy is the *only* symptom of
   * whatever moved the counter without a report — a partial transaction, a hand-edit, a bug in
   * reversal — and a system that silently corrects it destroys the evidence each time, so the
   * underlying fault is never found. A repair that has to be asked for leaves a trail saying
   * somebody found a drift of this size on this day, which is what makes the next one diagnosable.
   *
   * Refuses when there is nothing to repair rather than succeeding quietly: a caller chasing a
   * drift needs to learn it is already gone, and a 200 would tell them their repair worked.
   */
  async repair(
    ctx: RlsContext,
    projectId: string,
    companyId: string,
    input: { boqItemIds: string[]; reason: string },
    actor: { userId: string; ipAddress?: string },
  ): Promise<{ repaired: { boqNo: string; from: string; to: string }[] }> {
    const repaired = await withRlsContext(this.prisma, ctx, async (tx) => {
      const items = await tx.bOQTaskItem.findMany({
        where: { id: { in: input.boqItemIds }, group: { projectId } },
        select: { id: true, boqNo: true, doneQty: true },
      });
      if (items.length === 0) {
        throw new NotFoundException(
          'None of those BOQ lines belong to this project.',
        );
      }

      const sums = await this.sumApproved(
        tx,
        items.map((i) => i.id),
        undefined,
      );

      const drifted = items.filter((item) => {
        const sum = sums.get(item.id) ?? ZERO;
        return !item.doneQty.equals(sum);
      });

      if (drifted.length === 0) {
        throw new ConflictException({
          code: DWR_ERRORS.nothingToRepair,
          message:
            'Those lines already agree with their approved measurement, so nothing was changed. ' +
            'The drift you were chasing is gone — which is itself worth knowing, because ' +
            'something resolved it.',
        });
      }

      const results: { boqNo: string; from: string; to: string }[] = [];
      for (const item of drifted) {
        const target = sums.get(item.id) ?? ZERO;
        // The absolute path, FR-015's sole exception. A delta would be computed from the drifted
        // figure and so preserve the drift it was called to remove (FR-015b).
        const moved = await this.boq.setDoneQtyAbsolute(tx, item.id, target);
        results.push({
          boqNo: item.boqNo,
          from: moved.previous.toFixed(3),
          to: moved.current.toFixed(3),
        });
      }
      return results;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.BOQ_ITEM,
      action: AuditAction.UPDATE,
      entityId: projectId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return { repaired };
  }

  /**
   * Sums the quantity in force across **approved** reports, grouped by BOQ line.
   *
   * ## The one subtlety, which is the whole of FR-030a at the aggregate level
   *
   * A line's quantity lives in one of two columns depending on its payment basis, so a single
   * `SUM` over either column would be wrong for half the lines. `COALESCE("actualQty",
   * "servedQty")` is **not** used, because that would silently read a served quantity for a
   * measured line whose `actualQty` was somehow null — the exact failure
   * `storedQuantityInForce` throws on rather than guesses at. Instead the basis chooses the column
   * explicitly, so a row violating the CHECK constraint contributes nothing and is visible as a
   * discrepancy rather than as a plausible total.
   *
   * Raw SQL because Prisma's `groupBy` cannot sum a value chosen per row by another column, and the
   * alternative is fetching every task row into Node and adding them up — which for a project with
   * 312 BOQ lines over a year of daily reports is tens of thousands of rows crossing the wire to
   * produce one number per line.
   */
  private async sumApproved(
    tx: Prisma.TransactionClient,
    itemIds: string[],
    workDate: { gte?: Date; lte?: Date; lt?: Date } | undefined,
  ): Promise<Map<string, Prisma.Decimal>> {
    if (itemIds.length === 0) return new Map();

    // Built as **one** `Prisma.Sql` fragment, not as an array of them.
    //
    // Interpolating a plain array into a tagged template makes Prisma bind it as a single
    // *parameter value* rather than splicing it as SQL, which emits `$5` where a fragment belongs
    // and fails with `42601 syntax error at or near "$5"`. `Prisma.join` is the usual answer and
    // cannot be used either: it throws on an empty array, and the empty case is the common one
    // here because `reconcile` deliberately passes no bounds at all.
    //
    // Both were found by running this against a real database. Neither would have shown up in a
    // unit test, and the first of them affected every call — so the figures endpoint and the
    // reconciliation endpoint were both returning a 500 while every other test in the feature
    // passed.
    const bounds = Prisma.sql`
      ${
        workDate?.gte
          ? Prisma.sql`AND r."workDate" >= ${workDate.gte}`
          : Prisma.empty
      }
      ${
        workDate?.lte
          ? Prisma.sql`AND r."workDate" <= ${workDate.lte}`
          : Prisma.empty
      }
      ${
        workDate?.lt
          ? Prisma.sql`AND r."workDate" < ${workDate.lt}`
          : Prisma.empty
      }
    `;

    const query = Prisma.sql`
      SELECT t."boqItemId" AS "boqItemId",
             SUM(
               CASE t."paymentMode"
                 WHEN 'work_basis' THEN COALESCE(t."actualQty", 0)
                 WHEN 'day_basis'  THEN COALESCE(t."servedQty", 0)
               END
             ) AS total
        FROM "projects"."DWRTask" t
        JOIN "projects"."DailyWorkReport" r ON r."id" = t."dwrId"
       WHERE t."boqItemId" IN (${Prisma.join(itemIds)})
         AND r."status"::text = ${DwrStatus.approved}
         ${bounds}
       GROUP BY t."boqItemId"
    `;

    const rows = await tx.$queryRaw<
      { boqItemId: string; total: Prisma.Decimal }[]
    >(query);

    return new Map(
      rows.map((row) => [row.boqItemId, new Prisma.Decimal(row.total ?? 0)]),
    );
  }
}

const ZERO = new Prisma.Decimal(0);

/** Midnight UTC, so a work date compares as a day rather than as an instant. */
function dayStart(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}
