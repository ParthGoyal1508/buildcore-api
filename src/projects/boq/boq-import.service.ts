import { BadRequestException, Injectable } from '@nestjs/common';
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
  }): Promise<ValidationReport> {
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
        boqNo: String(row.cells[0] ?? row.rowNumber),
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
  }): Promise<{ groups: number; lines: number; quotedPercentageSet: boolean }> {
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
        const existing = await tx.bOQTaskItem.count({
          where: { group: { projectId: input.projectId } },
        });
        if (existing > 0) {
          throw refuse(
            BOQ_ERRORS.alreadyPopulated,
            `This project already has ${existing} BOQ lines. Importing again would add a second ` +
              'copy of the schedule rather than replace the first. Add or revise lines on the ' +
              'project instead.',
          );
        }

        let lines = 0;
        for (const group of batch.groups) {
          const created = await tx.bOQTaskGroup.create({
            data: {
              companyId: input.companyId,
              projectId: input.projectId,
              boqNo: group.boqNo,
              name: group.name,
              // The group's scope is the sum of its lines; a tender states no group quantity.
              scopeQty: group.items
                .reduce(
                  (sum, item) => sum.plus(new Prisma.Decimal(item.scopeQty)),
                  new Prisma.Decimal(0),
                )
                .toFixed(3),
            },
            select: { id: true },
          });
          await tx.bOQTaskItem.createMany({
            data: group.items.map((item) => ({
              companyId: input.companyId,
              groupId: created.id,
              boqNo: item.boqNo,
              taskName: item.taskName,
              unit: item.unit,
              scopeQty: item.scopeQty,
              rate: item.rate,
            })),
          });
          lines += group.items.length;
        }

        // FR-040, the last place this could go wrong: written **only** when the figure was
        // located. A zero here would under-bill every line on the project by the real percentage,
        // and nothing downstream would contradict it.
        if (batch.quotedPercentage !== null) {
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
      throw error;
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
      },
      accountId: input.userId,
      companyId: input.companyId,
      ipAddress: input.ipAddress,
    });

    return { ...written, quotedPercentageSet: batch.quotedPercentage !== null };
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
