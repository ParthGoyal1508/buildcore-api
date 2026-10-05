import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import config from '../../common/configs/config';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { BOQ_ERRORS } from './boq-error-codes';
import { BoqWorkbookReader, WorkbookRow } from './boq-workbook.reader';
import {
  IdentifiedSchedule,
  identifySchedule,
  ScheduleColumns,
} from './schedule-block';
import {
  BatchUnavailable,
  ImportBatchStore,
  StagedGroup,
  StagedItem,
} from './import-batch.store';
import { normaliseUnit, unitOrNull } from './unit-normalise';

const DEC = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

export interface RowProblem {
  row: number;
  column: string;
  reason: string;
}

export interface UnitSummary {
  asTyped: string;
  normalised: string;
  lines: number;
}

export interface ImportTotals {
  /** Sum of each line's rounded `quantity × rate` — ours, not the file's (FR-044). */
  scheduleDerived: string;
  /** What the workbook says its own schedule total is, where it says so. */
  scheduleStated: string | null;
  quotedDerived: string | null;
  quotedStated: string | null;
  scheduleDifference: string | null;
  quotedDifference: string | null;
  /** One paisa per line (FR-045) — derived from the rounding, not chosen. */
  tolerance: string;
  reconciles: boolean;
}

export interface ValidationReport {
  batchId: string;
  sheetName: string;
  groups: number;
  lines: number;
  units: UnitSummary[];
  totals: ImportTotals;
  /** Null, never 0, where the figure could not be located (FR-040). */
  quotedPercentage: string | null;
  quotedPercentageFound: boolean;
  /** True when this batch will be written as an internal estimate rather than the tender. */
  isEstimate: boolean;
  errors: RowProblem[];
  warnings: RowProblem[];
  /** Every imported line is unplanned until somebody plans it (FR-037, FR-048). */
  alerts: {
    today: number;
    delayed: number;
    toBeDelayed: number;
    unplanned: number;
  };
}

/**
 * A schedule's own item number, as the spreadsheet shows it (FR-041).
 *
 * **A numeric cell is formatted, not stringified.** These numbers are typically a fill series —
 * `=above+0.01` — so the cached result carries accumulated float error, and the client's own file
 * holds `88.02000000000001` where every human reading it sees `88.02`. Excel renders at fifteen
 * significant digits, which is exactly what hides the drift; `String()` does not, and 33 of the 231
 * lines in that file imported with a tail of noise onto a document sent to a client.
 *
 * A text cell passes through verbatim. Plenty of real item numbers are text — `3.19.1`, `88(a)` —
 * and reformatting those would be inventing a number the file does not contain.
 */
function itemNumber(cell: unknown, fallback: number): string {
  if (typeof cell !== 'number' || !Number.isFinite(cell)) {
    return String(cell ?? fallback);
  }
  const rendered = cell.toPrecision(15);
  // Exponent form means a magnitude no item number has; keep the plain spelling rather than
  // putting `8.8e+21` on a schedule.
  if (rendered.includes('e')) return String(cell);
  return rendered.includes('.')
    ? rendered.replace(/0+$/, '').replace(/\.$/, '')
    : rendered;
}

/** Exported for its unit test only — the rule is too easy to get right by accident in an e2e. */
export const itemNumberForTest = itemNumber;

function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/**
 * Turns a tender workbook into a batch somebody can review, and writes nothing (008 FR-036 –
 * FR-056).
 *
 * **Every decision is made here, before any row exists.** That is what the two-step flow is for:
 * the report is the review, and `confirm` only commits what this already decided. A rule enforced
 * at confirm time would be a rule the person never saw.
 */
@Injectable()
export class BoqImportService {
  constructor(
    private readonly reader: BoqWorkbookReader,
    private readonly batches: ImportBatchStore,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async validate(input: {
    buffer: Buffer;
    companyId: string;
    userId: string;
    projectId: string;
    ctx: RlsContext;
    /**
     * An internal **estimate** rather than the client's tender (US4 AC6, T097).
     *
     * The same pipeline, the same refusals, the same reconciliation — the whole of FR-036 – FR-056
     * applies unchanged. What differs is what the rows mean once written, and therefore three
     * things: an estimate is **not billable** to the client, it is **excluded from the alert
     * groups** because it carries no programme and nobody is delivering it, and it does **not** set
     * the project's quoted percentage, which is the bidder's figure against the client and not a
     * property of an internal costing.
     */
    isEstimate?: boolean;
  }): Promise<ValidationReport> {
    const isEstimate = input.isEstimate === true;

    // FR-049 **at the validate step, per FR-046.** Checked here as well as inside `confirm`'s
    // transaction, and the reason is not redundancy: without it somebody uploads a tender, waits
    // for a 231-line report, reads it, presses Confirm and *then* learns the project was already
    // populated. The transaction keeps its own check because the project can gain lines between
    // the two requests, and that one is what makes the rule true; this one is what makes it kind.
    // Found by walking quickstart pass 11 against a real instance rather than by reasoning.
    //
    // **Scoped to the variant** (T097). A project may legitimately hold both a tender and an
    // estimate — that is what the separate variant is *for* — so counting across both would make
    // importing the second one impossible, and the refusal would name a count the operator could
    // not reconcile with the screen they were looking at.
    const existing = await withRlsContext(this.prisma, input.ctx, (tx) =>
      tx.bOQTaskItem.count({
        where: { isEstimate, group: { projectId: input.projectId } },
      }),
    );
    if (existing > 0) throw this.alreadyPopulated(existing, isEstimate);

    const sheets = await this.reader.read(input.buffer);

    const schedule = identifySchedule(sheets);
    if (!schedule) {
      throw refuse(
        BOQ_ERRORS.noScheduleBlock,
        'No schedule could be found in this workbook. A BOQ sheet needs a header row naming at ' +
          'least an item description, a quantity, a unit and a rate; none of the sheets here has one.',
      );
    }
    if (schedule.candidates.length === 0) {
      throw refuse(
        BOQ_ERRORS.noScheduleRows,
        `The schedule on sheet "${schedule.sheetName}" has a header row but no items beneath it.`,
      );
    }

    const { maxCandidateRows } = config().boqImport;
    if (schedule.candidates.length > maxCandidateRows) {
      throw refuse(
        BOQ_ERRORS.tooManyRows,
        `This schedule has ${schedule.candidates.length} rows and the limit is ` +
          `${maxCandidateRows}. Split it into separate projects, or import the sections separately.`,
      );
    }

    const parsed = this.parseRows(schedule);

    // FR-051. A batch of nothing is a confirmable write of nothing, which is FR-036's prohibited
    // shape reached by a different route.
    if (parsed.groups.every((group) => group.items.length === 0)) {
      throw refuse(
        BOQ_ERRORS.noImportableRows,
        `All ${schedule.candidates.length} rows in this schedule were rejected, so there is ` +
          'nothing to import. The first few reasons: ' +
          parsed.errors
            .slice(0, 3)
            .map(
              (problem) =>
                `row ${problem.row}, ${problem.column}: ${problem.reason}`,
            )
            .join('; '),
      );
    }

    const percentage = this.locatePercentage(schedule);
    const lines = parsed.groups.reduce(
      (count, group) => count + group.items.length,
      0,
    );
    const totals = this.reconcile(parsed.groups, schedule, percentage);

    const batch = this.batches.create({
      companyId: input.companyId,
      userId: input.userId,
      projectId: input.projectId,
      groups: parsed.groups,
      // FR-040: only a percentage that was located *and* reconciles is carried. Never 0.
      isEstimate,
      quotedPercentage:
        totals.reconciles && percentage ? percentage.toFixed(6) : null,
    });
    if (!batch) {
      throw refuse(
        BOQ_ERRORS.tooManyBatches,
        'Too many BOQ imports are waiting to be confirmed. Confirm or abandon one of them, or ' +
          'wait for it to expire, then upload this file again.',
      );
    }

    return {
      batchId: batch.id,
      sheetName: schedule.sheetName,
      groups: parsed.groups.length,
      lines,
      units: parsed.units,
      totals,
      quotedPercentage: batch.quotedPercentage,
      quotedPercentageFound: batch.quotedPercentage !== null,
      // Restated on the report so the screen a person reads before confirming says which variant
      // they are about to write. A batch confirmed as the wrong one cannot happen — the flag lives
      // on the batch — but somebody reading a 231-line report deserves to be told which schedule
      // it is going to become.
      isEstimate,
      errors: parsed.errors,
      warnings: parsed.warnings,
      // Every line arrives unplanned, and says so rather than appearing on time (FR-048).
      alerts: { today: 0, delayed: 0, toBeDelayed: 0, unplanned: lines },
    };
  }

  /**
   * Hierarchy, units and arithmetic in one pass over the candidates (FR-038, FR-041, FR-044).
   *
   * One pass because the three are not independent: a row's *level* is decided by whether it has a
   * quantity, which is the same cell the arithmetic needs, and a heading has no unit to normalise.
   */
  private parseRows(schedule: IdentifiedSchedule): {
    groups: StagedGroup[];
    units: UnitSummary[];
    errors: RowProblem[];
    warnings: RowProblem[];
  } {
    const { columns } = schedule;
    const groups: StagedGroup[] = [];
    const errors: RowProblem[] = [];
    const warnings: RowProblem[] = [];
    const unitCounts = new Map<string, number>();
    /** Heading text seen since the last group, for the deeper-than-two-levels fold (FR-038). */
    let pendingHeadings: string[] = [];

    for (const row of schedule.candidates) {
      const description = String(row.cells[columns.description] ?? '').trim();
      const quantity = numberAt(row, columns.quantity);

      if (quantity === null) {
        // FR-038: a description with no quantity is a heading. Collected rather than applied
        // immediately, because a run of them is a nested section and the model holds two levels.
        pendingHeadings.push(description);
        continue;
      }

      if (groups.length === 0 || pendingHeadings.length > 0) {
        groups.push({
          // Folded, not dropped: "Electrical > Light fittings" keeps both facts in the one name
          // the schema has room for.
          name:
            pendingHeadings.length > 0
              ? pendingHeadings.join(' › ')
              : schedule.sheetName,
          boqNo: String(groups.length + 1),
          items: [],
        });
        if (pendingHeadings.length === 0) {
          // FR-038: good rows, unstated structure. A warning, not an error — rejecting them would
          // discard real schedule lines over a missing heading.
          warnings.push({
            row: row.rowNumber,
            column: 'Item Description',
            reason:
              'This line appears before any section heading, so it has been grouped under the ' +
              `sheet name ("${schedule.sheetName}").`,
          });
        }
        pendingHeadings = [];
      }

      const problem = this.rowProblem(row, columns, description, quantity);
      if (problem) {
        errors.push(problem);
        continue;
      }

      const unit = unitOrNull(row.cells[columns.unit]) as string;
      const rate = this.rateFor(row, columns) as number;
      unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1);

      groups[groups.length - 1].items.push({
        boqNo: itemNumber(row.cells[0], row.rowNumber),
        taskName: description,
        unit,
        scopeQty: DEC(quantity).toFixed(3),
        rate: DEC(rate).toFixed(2),
        // FR-044: computed, never read. The source's own figures carry accumulated float noise.
        amount: DEC(quantity).times(DEC(rate)).toDecimalPlaces(2).toFixed(2),
        sourceRow: row.rowNumber,
      } satisfies StagedItem);
    }

    const units: UnitSummary[] = [...unitCounts.entries()]
      .map(([asTyped, lines]) => ({
        asTyped,
        normalised: normaliseUnit(asTyped),
        lines,
      }))
      .sort((left, right) => right.lines - left.lines);

    // Numbered after the empty ones are dropped, not before: a heading with no items beneath it is
    // real in the source and meaningless here, and leaving its number behind would put gaps in the
    // schedule's numbering that correspond to nothing a reader can see.
    const populated = groups
      .filter((group) => group.items.length > 0)
      .map((group, index) => ({ ...group, boqNo: String(index + 1) }));

    return { groups: populated, units, errors, warnings };
  }

  /** Null when the row is importable. */
  private rowProblem(
    row: WorkbookRow,
    columns: ScheduleColumns,
    description: string,
    quantity: number,
  ): RowProblem | null {
    if (quantity <= 0) {
      return {
        row: row.rowNumber,
        column: 'Quantity',
        reason: `"${quantity}" is not a quantity that can be billed against.`,
      };
    }
    if (unitOrNull(row.cells[columns.unit]) === null) {
      return {
        row: row.rowNumber,
        column: 'Units',
        reason:
          'This line has a quantity but no unit, so there is no way to measure it.',
      };
    }
    const rate = this.rateFor(row, columns);
    if (rate === null) {
      return {
        row: row.rowNumber,
        column: 'Rate',
        reason:
          'This line has no rate. A line imported at zero would be billed as free work, so it ' +
          'is left out rather than priced at nothing.',
      };
    }
    if (description.length === 0) {
      return {
        row: row.rowNumber,
        column: 'Item Description',
        reason: 'No description.',
      };
    }
    return null;
  }

  /**
   * The rate, which column it comes from, and why that is not the obvious column (FR-039).
   *
   * **The bidder's own column wins where it is filled, and in the client's file it is empty.**
   * That is correct for a Percentage BoQ: the bidder quotes one percentage against the schedule of
   * rates and enters no per-line rate at all, so the rate is the schedule's reference figure. An
   * Item Rate BoQ — the same template, a different tender type — fills the bidder column instead,
   * and then it is the price and the schedule figure is only a reference.
   *
   * Reading only the bidder column, which this requirement originally said, would have imported
   * all 231 of the client's lines at no rate.
   */
  private rateFor(row: WorkbookRow, columns: ScheduleColumns): number | null {
    if (columns.bidderRate !== null) {
      const bidder = numberAt(row, columns.bidderRate);
      if (bidder !== null && bidder > 0) return bidder;
    }
    const scheduleRate = numberAt(row, columns.rate);
    return scheduleRate !== null && scheduleRate > 0 ? scheduleRate : null;
  }

  /**
   * The workbook's own `Excess (+)` figure (FR-039, FR-056).
   *
   * It sits where nothing else would put it: on the quoted-rate footer row, with the label in the
   * **units** column and the value in the **rate** column. Found by the label rather than by the
   * row, because a template revision moves rows and keeps labels.
   */
  private locatePercentage(schedule: IdentifiedSchedule): number | null {
    const { columns } = schedule;
    for (const row of schedule.candidates.concat(schedule.footer)) {
      const label = String(row.cells[columns.unit] ?? '');
      if (!/excess|quoted\s*rate|less/i.test(label)) continue;
      const value = numberAt(row, columns.rate);
      // FR-056: a figure outside 0–1 is not a percentage we recognise, so it is not located.
      if (value !== null && value >= 0 && value <= 1) return value;
    }
    return null;
  }

  /**
   * Both totals, both of the file's own, and whether they agree (FR-045).
   *
   * **To one paisa per line, not exactly.** Rounding each line to two decimals can differ from the
   * source's unrounded sum by up to half a paisa a line, so exact equality fails a *correct*
   * import — measured at ₹0.01 across the client's 231 lines. Every structural error this check
   * exists to catch exceeds the tolerance by seven orders of magnitude.
   */
  private reconcile(
    groups: StagedGroup[],
    schedule: IdentifiedSchedule,
    percentage: number | null,
  ): ImportTotals {
    const lines = groups.reduce(
      (count, group) => count + group.items.length,
      0,
    );
    const derived = groups
      .flatMap((group) => group.items)
      .reduce((sum, item) => sum.plus(DEC(item.amount)), DEC(0))
      .toDecimalPlaces(2);

    const tolerance = DEC(config().boqImport.reconciliationPaisePerLine)
      .times(lines)
      .dividedBy(100)
      .toDecimalPlaces(2);

    const statedSchedule = this.statedTotal(
      schedule,
      /total\s*in\s*figures|^total$/i,
    );
    const statedQuoted = this.statedTotal(
      schedule,
      /quoted\s*rate\s*in\s*figures/i,
    );
    const quotedDerived =
      percentage === null
        ? null
        : derived.times(DEC(1).plus(DEC(percentage))).toDecimalPlaces(2);

    const scheduleDifference = statedSchedule
      ? derived.minus(statedSchedule).abs()
      : null;
    const quotedDifference =
      statedQuoted && quotedDerived
        ? quotedDerived.minus(statedQuoted).abs()
        : null;

    const within = (difference: Prisma.Decimal | null) =>
      difference === null || difference.lessThanOrEqualTo(tolerance);

    return {
      scheduleDerived: derived.toFixed(2),
      scheduleStated: statedSchedule?.toFixed(2) ?? null,
      quotedDerived: quotedDerived?.toFixed(2) ?? null,
      quotedStated: statedQuoted?.toFixed(2) ?? null,
      scheduleDifference: scheduleDifference?.toFixed(2) ?? null,
      quotedDifference: quotedDifference?.toFixed(2) ?? null,
      tolerance: tolerance.toFixed(2),
      reconciles: within(scheduleDifference) && within(quotedDifference),
    };
  }

  /**
   * Commits a reviewed batch, in one transaction, once (008 FR-049 – FR-052).
   *
   * Everything was decided by `validate`. This writes what the person read and nothing else — a
   * rule enforced here instead would be a rule they never saw.
   */
  async confirm(input: {
    batchId: string;
    companyId: string;
    userId: string;
    projectId: string;
    ctx: RlsContext;
    ipAddress: string;
  }): Promise<{
    groups: number;
    lines: number;
    isEstimate: boolean;
    /** False for an estimate always — see the note at the write. */
    quotedPercentageSet: boolean;
  }> {
    const found = this.batches.lookup(input.batchId);
    if (!found.batch) throw this.batchRefusal(found.reason);

    // FR-050. The report is the review, so the person who accepts a 231-line write must be the
    // person who read it — and against the project they read it for.
    if (
      found.batch.userId !== input.userId ||
      found.batch.projectId !== input.projectId
    ) {
      throw refuse(
        BOQ_ERRORS.batchNotYours,
        'This import was prepared by someone else, or for a different project. Upload the file ' +
          'again on the project you want it on.',
      );
    }

    // FR-052. Claimed **before** the transaction opens, and released if it fails. Committing
    // first and consuming after leaves a window where a second confirm reads it as ready and
    // writes the schedule twice; consuming first loses the schedule when the transaction fails.
    const claimed = this.batches.claim(input.batchId);
    if (!claimed.batch) throw this.batchRefusal(claimed.reason);
    const batch = claimed.batch;

    let written: { groups: number; lines: number };
    try {
      written = await withRlsContext(this.prisma, input.ctx, async (tx) => {
        // FR-049, inside the transaction so two imports racing cannot both find it empty.
        // Appending is the same silent doubling FR-042 guards against, reached by uploading twice
        // rather than by reading the wrong columns — and replacing is impossible, because lines
        // may already be referenced by a client bill, a DWR task or a work-order award.
        // Scoped to the variant, for the reason `validate` gives: a project may hold both a
        // tender and an estimate, and that is what the variant is for.
        const existing = await tx.bOQTaskItem.count({
          where: {
            isEstimate: batch.isEstimate,
            group: { projectId: input.projectId },
          },
        });
        if (existing > 0)
          throw this.alreadyPopulated(existing, batch.isEstimate);

        // **Two statements, not two per group** (fixed 2026-10-04). This was a loop issuing a
        // `create` and a `createMany` for each group: 132 sequential round trips for the client's
        // own 66-group file, inside one interactive transaction whose budget is Prisma's default
        // **five seconds**. On a local database that is 0.17s and invisible. Against a hosted one
        // at 35-50ms of round-trip latency it is 5-7s, and the transaction expires mid-write with
        // `P2028` — which reached the browser as a bare `{"statusCode":500,"message":"Internal
        // server error"}` and nothing else.
        //
        // The number of round trips scaled with the file, so the bigger the tender the likelier
        // it was to fail: the schedules most worth importing were the ones that could not be.
        const created = await tx.bOQTaskGroup.createManyAndReturn({
          data: batch.groups.map((group) => ({
            companyId: input.companyId,
            projectId: input.projectId,
            boqNo: group.boqNo,
            name: group.name,
            isEstimate: batch.isEstimate,
            // The group's scope is the sum of its lines; a tender states no group quantity.
            scopeQty: group.items
              .reduce(
                (sum, item) => sum.plus(new Prisma.Decimal(item.scopeQty)),
                new Prisma.Decimal(0),
              )
              .toFixed(3),
          })),
          select: { id: true, boqNo: true },
        });

        // A single multi-row `INSERT ... RETURNING` gives its rows back in the order they were
        // supplied, which is what makes the positional match below correct. It is **checked**
        // rather than assumed: if that ever stopped holding, every line would be filed under the
        // wrong section — a schedule that imports successfully and is quietly wrong, which is the
        // one outcome this whole feature is built to refuse.
        if (created.length !== batch.groups.length) {
          throw new Error(
            `BOQ import wrote ${created.length} groups for ${batch.groups.length} staged — refusing to attach lines.`,
          );
        }
        const rows = created.flatMap((group, index) => {
          const staged = batch.groups[index];
          if (group.boqNo !== staged.boqNo) {
            throw new Error(
              `BOQ import groups came back out of order at ${index} (${group.boqNo} for ${staged.boqNo}) — refusing to attach lines.`,
            );
          }
          return staged.items.map((item) => ({
            companyId: input.companyId,
            groupId: group.id,
            boqNo: item.boqNo,
            taskName: item.taskName,
            unit: item.unit,
            scopeQty: item.scopeQty,
            rate: item.rate,
            isEstimate: batch.isEstimate,
          }));
        });
        await tx.bOQTaskItem.createMany({ data: rows });
        const lines = rows.length;

        // FR-040, the last place this could go wrong: written **only** when the figure was
        // located. A zero here would under-bill every line on the project by the real percentage,
        // and nothing downstream would contradict it.
        //
        // And never from an **estimate** (T097). `Project.quotedPercentage` is the bidder's quote
        // against the client's schedule and every client bill is priced with it; an internal
        // costing's own percentage written there would reprice the whole tender at a figure the
        // client never saw. An estimate's percentage is reported on the validation report and goes
        // no further.
        if (!batch.isEstimate && batch.quotedPercentage !== null) {
          await tx.project.update({
            where: { id: input.projectId },
            data: { quotedPercentage: batch.quotedPercentage },
          });
        }

        return { groups: batch.groups.length, lines };
      });
    } catch (error) {
      // Nothing was written, so the batch is valid to retry — and losing it here would mean
      // re-uploading and re-reading the whole report for a failure that was not the operator's.
      this.batches.release(input.batchId);
      throw this.writeFailure(error);
    }

    this.batches.markConfirmed(input.batchId);

    // FR-014 and the constitution re-check: **one** entry. One import is one act, and 231 rows in
    // the log would bury whatever came next.
    await this.audit.record({
      entityType: AuditEntityType.BOQ_IMPORT,
      action: AuditAction.CREATE,
      entityId: input.projectId,
      changes: {
        batchId: input.batchId,
        groups: written.groups,
        lines: written.lines,
        quotedPercentage: batch.quotedPercentage,
        isEstimate: batch.isEstimate,
      },
      accountId: input.userId,
      companyId: input.companyId,
      ipAddress: input.ipAddress,
    });

    return {
      ...written,
      isEstimate: batch.isEstimate,
      quotedPercentageSet: !batch.isEstimate && batch.quotedPercentage !== null,
    };
  }

  /**
   * A database-level failure during the write, turned into a sentence (2026-10-04).
   *
   * Only two Prisma codes are translated, and the rest are re-thrown untouched: a bug in this
   * service must keep surfacing as a 500 with a stack trace in the log, because that is what gets
   * it fixed. These two are not bugs in the write — they are the database declining to finish it.
   *
   * - **P2028** the interactive transaction expired. What a deployed confirm hit on 2026-10-04:
   *   132 sequential round trips against Prisma's five-second default.
   * - **P2024** no connection could be taken from the pool in time, which the same write
   *   provokes by holding one for seconds at a stretch.
   *
   * Both roll the transaction back, so "nothing was written" is a fact rather than a hope — and
   * saying so is the whole value, since the operator's real question is whether half a tender is
   * now sitting on the project.
   */
  private writeFailure(error: unknown): unknown {
    const code = (error as { code?: string } | null)?.code;
    if (code !== 'P2028' && code !== 'P2024') return error;

    return new ServiceUnavailableException({
      statusCode: 503,
      code: BOQ_ERRORS.writeInterrupted,
      message:
        'The database did not finish writing this schedule in time, so nothing was saved — ' +
        'the project is exactly as it was. The import is still held: press Confirm again. If it ' +
        'fails a second time, the schedule is too large for one write and its sections should be ' +
        'imported separately.',
    });
  }

  /** FR-049, worded once and raised from both steps. */
  private alreadyPopulated(
    existing: number,
    isEstimate = false,
  ): BadRequestException {
    // Names the **variant**, not just the count. A project holding a tender and an estimate can
    // legitimately refuse a second estimate while admitting nothing about the tender, and
    // "this project already has 231 BOQ lines" on a project whose estimate has 12 is a figure the
    // operator cannot reconcile with the screen in front of them.
    const what = isEstimate ? 'estimate lines' : 'BOQ lines';
    return refuse(
      BOQ_ERRORS.alreadyPopulated,
      `This project already has ${existing} ${what}. Importing again would add a second copy ` +
        'of the schedule rather than replace the first — and the existing lines cannot be removed ' +
        'automatically, because bills and work reports may already measure against them. Add or ' +
        'revise lines on the project instead.',
    );
  }

  /**
   * Turns a batch's situation into the sentence that fits it (FR-052).
   *
   * Four outcomes, four messages. One "not found" covering all of them cannot be explained to
   * whoever pressed the button: "it already worked" and "it never existed" need opposite actions.
   */
  private batchRefusal(reason: BatchUnavailable): BadRequestException {
    switch (reason) {
      case 'confirmed':
        return refuse(
          BOQ_ERRORS.batchAlreadyConfirmed,
          'This schedule has already been imported. Nothing further is needed.',
        );
      case 'committing':
        return refuse(
          BOQ_ERRORS.batchInProgress,
          'This schedule is being imported right now. Wait a moment and reload the project.',
        );
      case 'expired':
        return refuse(
          BOQ_ERRORS.batchExpired,
          `This import was prepared more than ${
            config().boqImport.batchTtlMinutes
          } minutes ago ` +
            'and has expired. Upload the file again — nothing was imported.',
        );
      default:
        return refuse(
          BOQ_ERRORS.batchNotFound,
          'There is no import waiting under that reference. Upload the file again.',
        );
    }
  }

  /** A footer figure, found by its label and read from the amount column. */
  private statedTotal(
    schedule: IdentifiedSchedule,
    label: RegExp,
  ): Prisma.Decimal | null {
    if (schedule.columns.amount === null) return null;
    for (const row of schedule.footer) {
      const first = String(
        row.cells.find((cell) => typeof cell === 'string' && cell.trim()) ?? '',
      );
      if (!label.test(first.replace(/\s+/g, ' ').trim())) continue;
      const value = numberAt(row, schedule.columns.amount);
      if (value !== null) return DEC(value).toDecimalPlaces(2);
    }
    return null;
  }
}

function numberAt(row: WorkbookRow, column: number): number | null {
  const cell = row.cells[column];
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'string') {
    // Thousands separators and a stray currency symbol are the common hand-edit.
    const cleaned = cell.replace(/[,\s₹]/g, '');
    if (cleaned.length === 0) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
