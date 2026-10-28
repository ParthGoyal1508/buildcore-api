import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  BoqPricingBasis,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import config from '../../common/configs/config';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { BOQ_ERRORS } from './boq-error-codes';
import { BoqWorkbookReader, WorkbookRow } from './boq-workbook.reader';
import {
  IdentifiedSchedule,
  identifySchedules,
  ScheduleColumns,
  SchedulePricingBasis,
} from './schedule-block';
import {
  BatchUnavailable,
  ImportBatchStore,
  StagedGroup,
  StagedItem,
} from './import-batch.store';
import { summaryRowKind, SummaryRowKind } from './summary-rows';
import { normaliseUnit, unitOrNull } from './unit-normalise';

const DEC = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

/**
 * The most a portal workbook's own line amount may sit from ours and still count as its rounding
 * (047): half a rupee, which is what rounding a line to whole rupees can produce. Measured on the
 * client's files — Bundi Minority Hostel rounds 53 of 134 lines and states ₹1.68 above the
 * paisa-exact sum; Goynda and STMC 2024-25 do the same. A misread row moves a line by its whole
 * amount, far past this, so it still fails.
 */
const ROUNDING_DRIFT_PER_LINE = new Prisma.Decimal('0.50');

export interface RowProblem {
  /** The sheet the row is on (047) — a workbook can now hold more than one schedule. */
  sheet?: string;
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

/**
 * One schedule of the workbook, reported on its own (047).
 *
 * Each schedule is reconciled against **its own** footer, because each sheet states its own
 * totals — a combined figure could hide a ₹1 lakh error in one schedule behind rounding in the
 * other, and would tell the reader nothing about which sheet to look at.
 */
export interface ScheduleReport {
  sheetName: string;
  pricingBasis: SchedulePricingBasis;
  groups: number;
  lines: number;
  /** The percentage schedule's own quote; null on an item-rate schedule or where not found. */
  quotedPercentage: string | null;
  /**
   * Tax rows the schedule's stated total includes but which were not imported as lines (047) —
   * "Add GST @18%". Added to the derived total for reconciliation only.
   */
  excludedTaxAmount: string;
  totals: ImportTotals;
}

/** A row that was read and deliberately not imported as a line (047). */
export interface ExcludedRow {
  sheet: string;
  row: number;
  description: string;
  kind: SummaryRowKind;
  /** What the row itself carries, where it carries anything. */
  amount: string | null;
}

/** Why a batch cannot be confirmed (047). Present ⇒ no batch was issued. */
export interface ImportBlocker {
  code: string;
  sheet: string | null;
  message: string;
}

export interface ValidationReport {
  /** Null when `blockers` is non-empty: a batch that can never be confirmed is not issued (047). */
  batchId: string | null;
  confirmable: boolean;
  /** The first schedule's sheet — kept for callers that predate 047. */
  sheetName: string;
  groups: number;
  lines: number;
  units: UnitSummary[];
  /** Every schedule combined; `reconciles` is true only when every schedule reconciles. */
  totals: ImportTotals;
  schedules: ScheduleReport[];
  excludedRows: ExcludedRow[];
  blockers: ImportBlocker[];
  /** The workbook's figure. Null, never 0, where the figure could not be located (FR-040). */
  quotedPercentage: string | null;
  quotedPercentageFound: boolean;
  /** What the project holds now (047), so both can be shown side by side. */
  projectQuotedPercentage: string;
  /**
   * True when confirming must say which of the two figures the project keeps (047). Never true
   * for an estimate, which does not touch the project's percentage at all.
   */
  quotedPercentageDiffers: boolean;
  /** Non-null when the project already has lines of this variant and they can be replaced (047). */
  replace: {
    existingLines: number;
    existingGroups: number;
    replaceable: true;
  } | null;
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

/** What stands in the way of replacing a variant's BOQ (047). */
interface ReplaceCheck {
  lines: number;
  groups: number;
  measured: number;
  dwr: number;
  billed: number;
  awarded: number;
  /** The lines that block, by number, at most twenty — enough to find them. */
  boqNumbers: string[];
}

const BASIS_LABEL: Record<SchedulePricingBasis, string> = {
  percentage: 'Percentage',
  item_rate: 'Item rate',
};

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
export function itemNumber(cell: unknown, fallback: number): string {
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

/**
 * A heading row's own number, where it has one.
 *
 * Headings in a real tender are numbered like their lines — `85` above `85.01` and `85.02` — and
 * that number is the only thing in the file that says where the section **ends**. Null for a
 * heading with a blank number, which is common and must leave the old behaviour untouched.
 */
function headingNumber(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  const text =
    typeof cell === 'number' && Number.isFinite(cell)
      ? itemNumber(cell, 0)
      : String(cell).trim();
  return text === '' ? null : text;
}

/** `85.01` is under `85`; `86` and `850` are not. */
function isUnder(itemNo: string, headingNo: string): boolean {
  return itemNo.startsWith(`${headingNo}.`);
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

    // FR-049 at the validate step, amended by 047: a project that already has lines of this
    // variant is no longer refused outright. If nothing has been done against those lines they can
    // be **replaced** — the report says so and confirm must ask for it — and if something has, the
    // refusal names exactly what. Checked again inside confirm's transaction, because a line can be
    // billed between the two requests; this one is what tells the person before they read a
    // 231-line report.
    //
    // **Scoped to the variant** (T097): a project may hold both a tender and an estimate.
    const { existing, projectQuoted } = await withRlsContext(
      this.prisma,
      input.ctx,
      async (tx) => ({
        existing: await this.replaceCheck(tx, input.projectId, isEstimate),
        projectQuoted: (
          await tx.project.findFirst({
            where: { id: input.projectId },
            select: { quotedPercentage: true },
          })
        )?.quotedPercentage,
      }),
    );
    if (existing.lines > 0 && this.blocksReplace(existing)) {
      throw this.replaceBlocked(existing, isEstimate);
    }

    const sheets = await this.reader.read(input.buffer);

    const identified = identifySchedules(sheets);
    if (identified.length === 0) {
      throw refuse(
        BOQ_ERRORS.noScheduleBlock,
        'No schedule could be found in this workbook. A BOQ sheet needs a header row naming at ' +
          'least an item description, a quantity, a unit and a rate; none of the sheets here has one.',
      );
    }
    // A schedule sheet with a header and nothing under it is left out rather than refused, when
    // another sheet does carry lines — the template ships an empty `BoQ2` often enough.
    const schedules = identified.filter(
      (schedule) => schedule.candidates.length > 0,
    );
    if (schedules.length === 0) {
      throw refuse(
        BOQ_ERRORS.noScheduleRows,
        `The schedule on sheet "${identified[0].sheetName}" has a header row but no items beneath it.`,
      );
    }

    // The cap bounds the work the request does, so it counts every schedule's rows together.
    const { maxCandidateRows } = config().boqImport;
    const candidateRows = schedules.reduce(
      (count, schedule) => count + schedule.candidates.length,
      0,
    );
    if (candidateRows > maxCandidateRows) {
      throw refuse(
        BOQ_ERRORS.tooManyRows,
        `This workbook has ${candidateRows} schedule rows and the limit is ` +
          `${maxCandidateRows}. Split it into separate projects, or import the sections separately.`,
      );
    }

    const parsed = schedules.map((schedule) => ({
      schedule,
      ...this.parseRows(schedule),
    }));
    const errors = parsed.flatMap((entry) => entry.errors);

    // FR-051. A batch of nothing is a confirmable write of nothing, which is FR-036's prohibited
    // shape reached by a different route.
    if (parsed.every((entry) => entry.groups.length === 0)) {
      throw refuse(
        BOQ_ERRORS.noImportableRows,
        `All ${candidateRows} rows in this workbook were rejected, so there is ` +
          'nothing to import. The first few reasons: ' +
          errors
            .slice(0, 3)
            .map(
              (problem) =>
                `row ${problem.row}, ${problem.column}: ${problem.reason}`,
            )
            .join('; '),
      );
    }

    const reports: ScheduleReport[] = [];
    const blockers: ImportBlocker[] = [];
    const percentages: { sheet: string; value: number }[] = [];
    for (const entry of parsed) {
      const { schedule } = entry;
      // FR-039 / 047: only a percentage schedule has a quoted percentage. An item-rate schedule's
      // `Quoted Rate in Figures` row reads `Select` beside a 0, and is not a quote of anything.
      const percentage =
        schedule.basis === 'percentage'
          ? this.locatePercentage(schedule)
          : null;
      const totals = this.reconcile(
        entry.groups,
        schedule,
        percentage,
        entry.excludedTax,
        entry.roundingDrift,
      );
      const lines = entry.groups.reduce(
        (count, group) => count + group.items.length,
        0,
      );
      reports.push({
        sheetName: schedule.sheetName,
        pricingBasis: schedule.basis,
        groups: entry.groups.length,
        lines,
        quotedPercentage: percentage === null ? null : percentage.toFixed(6),
        excludedTaxAmount: entry.excludedTax.toFixed(2),
        totals,
      });
      if (lines > 0 && percentage !== null) {
        percentages.push({ sheet: schedule.sheetName, value: percentage });
      }
      // 047: a blocker, no longer a note. Until now a mismatch was reported and confirm went
      // ahead — which is how a GST row became a ₹21 crore line on a real project.
      if (lines > 0 && !totals.reconciles) {
        blockers.push({
          code: BOQ_ERRORS.notReconciled,
          sheet: schedule.sheetName,
          message: this.notReconciledMessage(schedule.sheetName, totals),
        });
      }
    }

    // A project holds one quoted percentage. Two schedules quoting the same figure is fine.
    const distinct = [...new Set(percentages.map((p) => p.value.toFixed(6)))];
    if (distinct.length > 1) {
      blockers.push({
        code: BOQ_ERRORS.quotedPercentagesConflict,
        sheet: null,
        message:
          'The percentage schedules in this workbook quote different percentages (' +
          percentages
            .map((p) => `${p.sheet}: ${(p.value * 100).toFixed(2)}%`)
            .join(', ') +
          '), and a project holds one. Import them as separate projects.',
      });
    }
    const fileQuoted = distinct.length === 1 ? distinct[0] : null;
    const projectQuotedText = (projectQuoted ?? new Prisma.Decimal(0)).toFixed(
      6,
    );

    const groups = this.numberAcrossSchedules(parsed);
    const lines = groups.reduce(
      (count, group) => count + group.items.length,
      0,
    );

    let batchId: string | null = null;
    if (blockers.length === 0) {
      const batch = this.batches.create({
        companyId: input.companyId,
        userId: input.userId,
        projectId: input.projectId,
        groups,
        isEstimate,
        // `!== null`, never truthiness: `At Par` locates a real percentage of **zero**.
        quotedPercentage: fileQuoted,
        schedules: reports
          .filter((report) => report.lines > 0)
          .map((report) => ({
            sheetName: report.sheetName,
            pricingBasis: report.pricingBasis,
            lines: report.lines,
          })),
        existingLines: existing.lines,
      });
      if (!batch) {
        throw refuse(
          BOQ_ERRORS.tooManyBatches,
          'Too many BOQ imports are waiting to be confirmed. Confirm or abandon one of them, or ' +
            'wait for it to expire, then upload this file again.',
        );
      }
      batchId = batch.id;
    }

    return {
      batchId,
      confirmable: batchId !== null,
      sheetName: reports[0].sheetName,
      groups: groups.length,
      lines,
      units: mergeUnits(parsed.map((entry) => entry.units)),
      totals: combineTotals(reports),
      schedules: reports,
      excludedRows: parsed.flatMap((entry) => entry.excluded),
      blockers,
      quotedPercentage: fileQuoted,
      quotedPercentageFound: fileQuoted !== null,
      projectQuotedPercentage: projectQuotedText,
      quotedPercentageDiffers:
        !isEstimate && fileQuoted !== null && fileQuoted !== projectQuotedText,
      replace:
        existing.lines > 0
          ? {
              existingLines: existing.lines,
              existingGroups: existing.groups,
              replaceable: true,
            }
          : null,
      // Restated on the report so the screen a person reads before confirming says which variant
      // they are about to write.
      isEstimate,
      errors,
      warnings: parsed.flatMap((entry) => entry.warnings),
      // Every line arrives unplanned, and says so rather than appearing on time (FR-048).
      alerts: { today: 0, delayed: 0, toBeDelayed: 0, unplanned: lines },
    };
  }

  /**
   * Section numbers run 1..n across the whole workbook, and in a workbook of more than one
   * schedule every line and section says which sheet it came from (047).
   *
   * Two schedules both number from `1.01`. Without the prefix a bill or a daily work report would
   * show two different "1.01" lines on one project with nothing to tell them apart. A single-
   * schedule workbook is numbered exactly as before.
   */
  private numberAcrossSchedules(
    parsed: { schedule: IdentifiedSchedule; groups: StagedGroup[] }[],
  ): StagedGroup[] {
    const withLines = parsed.filter((entry) => entry.groups.length > 0);
    const prefix = withLines.length > 1;
    let next = 0;
    return withLines.flatMap(({ schedule, groups }) =>
      groups.map((group) => {
        next += 1;
        return {
          ...group,
          boqNo: String(next),
          name: prefix
            ? `${schedule.sheetName} (${BASIS_LABEL[schedule.basis]}) › ${
                group.name
              }`
            : group.name,
          items: prefix
            ? group.items.map((item) => ({
                ...item,
                boqNo: `${schedule.sheetName}/${item.boqNo}`,
              }))
            : group.items,
        };
      }),
    );
  }

  private notReconciledMessage(sheet: string, totals: ImportTotals): string {
    const parts: string[] = [];
    if (
      totals.scheduleDifference !== null &&
      Number(totals.scheduleDifference) > Number(totals.tolerance)
    ) {
      parts.push(
        `its lines add up to ${inr(totals.scheduleDerived)} against the ` +
          `${inr(totals.scheduleStated)} the sheet states (a difference of ` +
          `${inr(totals.scheduleDifference)})`,
      );
    }
    if (
      totals.quotedDifference !== null &&
      Number(totals.quotedDifference) > Number(totals.tolerance)
    ) {
      parts.push(
        `the quoted total works out to ${inr(
          totals.quotedDerived,
        )} against the stated ` +
          `${inr(totals.quotedStated)} (a difference of ${inr(
            totals.quotedDifference,
          )})`,
      );
    }
    return (
      `Sheet "${sheet}" does not add up: ${parts.join('; and ')}, beyond the ` +
      `${inr(
        totals.tolerance,
      )} rounding allows. A row was read differently from how the sheet ` +
      'prices it — compare the rows below with the workbook.'
    );
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
    excluded: ExcludedRow[];
    /** The excluded tax rows' own amounts, which the sheet's stated total includes (047). */
    excludedTax: Prisma.Decimal;
    /** How far the file's own rounded line amounts sit from ours, summed (047). */
    roundingDrift: Prisma.Decimal;
  } {
    const { columns } = schedule;
    const excluded: ExcludedRow[] = [];
    let excludedTax = DEC(0);
    let roundingDrift = DEC(0);
    const groups: StagedGroup[] = [];
    const errors: RowProblem[] = [];
    const warnings: RowProblem[] = [];
    const unitCounts = new Map<string, number>();
    /** Heading text seen since the last group, for the deeper-than-two-levels fold (FR-038). */
    let pendingHeadings: string[] = [];
    /** The nearest pending heading's own number, where it had one. */
    let pendingHeadingNo: string | null = null;
    /** That number, carried onto the group it opened, until the first item decides what it means. */
    let openHeadingNo: string | null = null;
    /**
     * Set once a group's **first item** proves to be a dotted child of its heading's number —
     * `85.01` under `85`. From then on, a line that is not a child of it ends the section.
     *
     * Reported 2026-10-06: without this, a group ran until the *next heading*, so `86` and `87` —
     * lines with their own quantities, belonging to nobody — were swallowed into section `85`.
     *
     * Conditional on the first item, deliberately. Plenty of schedules number their lines `1, 2, 3`
     * under a heading numbered something else entirely, or under one with no number at all; in
     * those the prefix never establishes itself and the old rule stands untouched. The split only
     * happens where the file has already demonstrated that it nests by number.
     */
    let groupPrefix: string | null = null;

    for (const row of schedule.candidates) {
      const description = String(row.cells[columns.description] ?? '').trim();
      const quantity = numberAt(row, columns.quantity);

      // 047: a total or a tax row is arithmetic *about* the schedule — neither a line nor a
      // heading. Checked first, because "Add GST @18%" has a quantity (18) and a rate (the whole
      // schedule) and would otherwise become a ₹21 crore line, and "Total amount" has neither and
      // would otherwise open a section named after itself.
      const summary = summaryRowKind(description);
      if (summary !== null) {
        const amount = this.summaryRowAmount(row, columns, quantity);
        if (summary === 'tax' && amount !== null) {
          excludedTax = excludedTax.plus(amount);
        }
        excluded.push({
          sheet: schedule.sheetName,
          row: row.rowNumber,
          description,
          kind: summary,
          amount: amount?.toFixed(2) ?? null,
        });
        continue;
      }

      if (quantity === null) {
        // FR-038: a description with no quantity is a heading. Collected rather than applied
        // immediately, because a run of them is a nested section and the model holds two levels.
        pendingHeadings.push(description);
        // The nearest one wins: in a run, the last heading is the lines' actual parent.
        pendingHeadingNo = headingNumber(row.cells[0]);
        continue;
      }

      const boqNo = itemNumber(row.cells[0], row.rowNumber);
      const leavesSection =
        groupPrefix !== null && !isUnder(boqNo, groupPrefix);

      if (groups.length === 0 || pendingHeadings.length > 0 || leavesSection) {
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
        if (pendingHeadings.length === 0 && !leavesSection) {
          // FR-038: good rows, unstated structure. A warning, not an error — rejecting them would
          // discard real schedule lines over a missing heading.
          //
          // **`leavesSection` is deliberately not warned about.** A warning should name something
          // the reader has to decide or check, and that case is neither: the file stated its
          // structure by numbering the line outside the section above it, and the parser read
          // exactly what it said. Warning on it turned a correct import of the client's own tender
          // into ten notes — which is how a reader learns to scroll past the one note that matters,
          // the line that really did arrive before any heading at all.
          warnings.push({
            sheet: schedule.sheetName,
            row: row.rowNumber,
            column: 'Item Description',
            reason:
              'This line appears before any section heading, so it has been grouped under the ' +
              `sheet name ("${schedule.sheetName}").`,
          });
        }
        openHeadingNo = pendingHeadings.length > 0 ? pendingHeadingNo : null;
        groupPrefix = null;
        pendingHeadings = [];
        pendingHeadingNo = null;
      }

      const problem = this.rowProblem(row, columns, description, quantity);
      if (problem) {
        errors.push({ sheet: schedule.sheetName, ...problem });
        continue;
      }

      const unit = unitOrNull(row.cells[columns.unit]) as string;
      const rate = this.rateFor(row, columns) as number;
      unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1);

      const group = groups[groups.length - 1];
      // The first good line decides whether this section nests by number. A later line that is
      // not under the same number then starts a section of its own.
      if (
        group.items.length === 0 &&
        openHeadingNo !== null &&
        isUnder(boqNo, openHeadingNo)
      ) {
        groupPrefix = openHeadingNo;
      }

      const amount = DEC(quantity).times(DEC(rate)).toDecimalPlaces(2);
      // 047: many portal workbooks round each line's amount to whole rupees and state a total that
      // is the sum of those. That drift — at most half a rupee a line — is the file's rounding,
      // not a misread row; anything larger is not rounding and is left to fail reconciliation.
      const stated =
        columns.amount === null ? null : numberAt(row, columns.amount);
      if (stated !== null) {
        const drift = DEC(stated).minus(amount).abs();
        if (drift.lessThanOrEqualTo(ROUNDING_DRIFT_PER_LINE)) {
          roundingDrift = roundingDrift.plus(drift);
        }
      }

      group.items.push({
        boqNo,
        taskName: description,
        unit,
        scopeQty: DEC(quantity).toFixed(3),
        rate: DEC(rate).toFixed(2),
        // FR-044: computed, never read. The source's own figures carry accumulated float noise.
        amount: amount.toFixed(2),
        sourceRow: row.rowNumber,
        pricingBasis: schedule.basis,
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

    return {
      groups: populated,
      units,
      errors,
      warnings,
      excluded,
      excludedTax,
      roundingDrift,
    };
  }

  /**
   * What an excluded row carries (047): the file's own amount where it states one, else
   * `quantity × rate`, read as a percentage where the unit is `%` — which is how "Add GST @18%"
   * with quantity 18 and the schedule total as its rate is meant.
   */
  private summaryRowAmount(
    row: WorkbookRow,
    columns: ScheduleColumns,
    quantity: number | null,
  ): Prisma.Decimal | null {
    if (columns.amount !== null) {
      const stated = numberAt(row, columns.amount);
      if (stated !== null) return DEC(stated).toDecimalPlaces(2);
    }
    const rate = numberAt(row, columns.rate);
    if (quantity === null || rate === null) return null;
    const product = DEC(quantity).times(DEC(rate));
    const unit = String(row.cells[columns.unit] ?? '').trim();
    return (unit === '%' ? product.dividedBy(100) : product).toDecimalPlaces(2);
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
   * The workbook's own quoted percentage, **with its direction** (FR-039, FR-056).
   *
   * It sits where nothing else would put it: on the quoted-rate footer row, with the label in the
   * **units** column and the value in the **rate** column. Found by the label rather than by the
   * row, because a template revision moves rows and keeps labels.
   *
   * ## The label carries the sign, and the number does not
   *
   * Reported 2026-10-06 on `docs/BOQ_748359.xls`. A bidder quotes either above the estimate or
   * below it, and the workbook says which in words — `Excess (+)`, `Less (-)`, `At Par` — while the
   * cell beside it holds the bare magnitude. `10.7900%` reads as `0.1079` whichever way the tender
   * went. An earlier version of this method read that number alone, so a tender quoted 10.79%
   * **below** estimate was recorded as 10.79% **above** it: ₹4.12 crore of schedule became ₹4.57
   * crore instead of the ₹3.68 crore the file itself prints two cells away.
   *
   * That import was refused rather than accepted, because `reconcile` compares the derived quoted
   * total against the stated one and ₹88.96 lakh is some way outside a ₹1.23 tolerance. **The
   * refusal was the only thing standing between a sign error and every bill on that project being
   * raised about 21% high for the life of the contract** — on a workbook that stated no totals of
   * its own, nothing would have caught it.
   *
   * So the direction is read from the label and the magnitude taken as unsigned. Where the label
   * names no direction the figure is **not located**, rather than assumed positive: an unreported
   * percentage shows the reader a sentence about what a missing percentage costs, which is a far
   * better outcome than silently guessing which way a tender ran.
   */
  private locatePercentage(schedule: IdentifiedSchedule): number | null {
    const { columns } = schedule;
    for (const row of schedule.candidates.concat(schedule.footer)) {
      const direction = quoteDirection(String(row.cells[columns.unit] ?? ''));
      if (direction === null) continue;
      const magnitude = numberAt(row, columns.rate);
      if (magnitude === null) continue;
      // The label is authoritative over the cell's own sign: a file that writes `Less (-)` beside
      // `-10.79%` means the same thing as one that writes it beside `10.79%`.
      const value = direction * Math.abs(magnitude);
      // FR-056, amended: a figure outside ±100% is not a percentage we recognise. The floor is -1
      // because a quote cannot take more off than the whole schedule is worth.
      if (value >= -1 && value <= 1) return value;
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
    excludedTax: Prisma.Decimal = DEC(0),
    roundingDrift: Prisma.Decimal = DEC(0),
  ): ImportTotals {
    const lines = groups.reduce(
      (count, group) => count + group.items.length,
      0,
    );
    const derived = groups
      .flatMap((group) => group.items)
      .reduce((sum, item) => sum.plus(DEC(item.amount)), DEC(0))
      .toDecimalPlaces(2);

    // One paisa a line for our own rounding, plus the file's own per-line rounding where it has
    // any (047) — see `ROUNDING_DRIFT_PER_LINE`.
    const tolerance = DEC(config().boqImport.reconciliationPaisePerLine)
      .times(lines)
      .dividedBy(100)
      .plus(roundingDrift)
      .toDecimalPlaces(2);

    const statedSchedule = this.statedTotal(
      schedule,
      /total\s*in\s*figures|^total$/i,
    );
    // An item-rate schedule's quoted row is the template's `Select` beside a 0 — not a figure.
    const statedQuoted =
      schedule.basis === 'item_rate'
        ? null
        : this.statedTotal(schedule, /quoted\s*rate\s*in\s*figures/i);
    // The stated totals include any tax rows the sheet added under its lines, which were not
    // imported (047). Compared with them added back, so a correctly read sheet still reconciles.
    const withTax = derived.plus(excludedTax);
    const quotedDerived =
      percentage === null
        ? null
        : withTax.times(DEC(1).plus(DEC(percentage))).toDecimalPlaces(2);

    const scheduleDifference = statedSchedule
      ? withTax.minus(statedSchedule).abs()
      : null;
    const quotedDifference =
      statedQuoted && quotedDerived
        ? quotedDerived.minus(statedQuoted).abs()
        : null;

    const within = (
      difference: Prisma.Decimal | null,
      allowed: Prisma.Decimal = tolerance,
    ) => difference === null || difference.lessThanOrEqualTo(allowed);
    // The quoted total scales the schedule's rounding by the percentage, so its allowance does too.
    const quotedTolerance =
      percentage === null
        ? tolerance
        : tolerance
            .times(DEC(1).plus(DEC(Math.abs(percentage))))
            .toDecimalPlaces(2);

    return {
      scheduleDerived: derived.toFixed(2),
      scheduleStated: statedSchedule?.toFixed(2) ?? null,
      quotedDerived: quotedDerived?.toFixed(2) ?? null,
      quotedStated: statedQuoted?.toFixed(2) ?? null,
      scheduleDifference: scheduleDifference?.toFixed(2) ?? null,
      quotedDifference: quotedDifference?.toFixed(2) ?? null,
      tolerance: tolerance.toFixed(2),
      reconciles:
        within(scheduleDifference) && within(quotedDifference, quotedTolerance),
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
    /**
     * Which quoted percentage the project keeps when the workbook's differs from it (047).
     * Required in exactly that case; ignored otherwise.
     */
    quotedPercentageSource?: 'file' | 'project';
    /** Replace the project's existing lines of this variant (047). Required when there are any. */
    replaceExisting?: boolean;
  }): Promise<{
    groups: number;
    lines: number;
    isEstimate: boolean;
    /** False for an estimate always — see the note at the write. */
    quotedPercentageSet: boolean;
    /** What the project's quoted percentage is after this confirm. */
    quotedPercentage: string;
    /** Lines removed because this import replaced them (047). */
    replaced: number;
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

    let written: {
      groups: number;
      lines: number;
      replaced: number;
      quotedBefore: string;
      quotedAfter: string;
      quotedSource: 'file' | 'project' | null;
    };
    try {
      written = await withRlsContext(this.prisma, input.ctx, async (tx) => {
        // FR-049, inside the transaction so two imports racing cannot both find it empty — and,
        // since 047, so a line billed between validate and confirm still stops a replace.
        const existing = await this.replaceCheck(
          tx,
          input.projectId,
          batch.isEstimate,
        );
        if (existing.lines > 0) {
          if (input.replaceExisting !== true) {
            throw this.alreadyPopulated(existing.lines, batch.isEstimate);
          }
          if (this.blocksReplace(existing)) {
            throw this.replaceBlocked(existing, batch.isEstimate);
          }
          // Lines cascade with their sections. Scoped to the variant: replacing the tender leaves
          // the estimate alone, and the reverse.
          await tx.bOQTaskGroup.deleteMany({
            where: { projectId: input.projectId, isEstimate: batch.isEstimate },
          });
        }

        // 047: the project's figure is read here, not trusted from validate — somebody may have
        // corrected it in between, and the choice has to be made against what it is now.
        const project = await tx.project.findFirst({
          where: { id: input.projectId },
          select: { quotedPercentage: true },
        });
        const quotedBefore = (
          project?.quotedPercentage ?? new Prisma.Decimal(0)
        ).toFixed(6);
        let quotedAfter = quotedBefore;
        let quotedSource: 'file' | 'project' | null = null;
        // Never from an **estimate** (T097): an internal costing's percentage written onto the
        // project would reprice the whole tender at a figure the client never saw.
        if (!batch.isEstimate && batch.quotedPercentage !== null) {
          const differs = batch.quotedPercentage !== quotedBefore;
          if (differs && !input.quotedPercentageSource) {
            throw refuse(
              BOQ_ERRORS.quotedPercentageChoiceRequired,
              `This workbook quotes ${percentText(
                batch.quotedPercentage,
              )} and the project holds ` +
                `${percentText(
                  quotedBefore,
                )}. Say which one the project should keep — every ` +
                'bill on the project is priced with it.',
            );
          }
          if (differs) quotedSource = input.quotedPercentageSource;
          if (!differs || input.quotedPercentageSource === 'file') {
            // FR-040, the last place this could go wrong: written **only** when the figure was
            // located. A zero here would under-bill every percentage line on the project.
            await tx.project.update({
              where: { id: input.projectId },
              data: { quotedPercentage: batch.quotedPercentage },
            });
            quotedAfter = batch.quotedPercentage;
          }
        }

        // **Two statements, not two per group** (fixed 2026-10-04). This was a loop issuing a
        // `create` and a `createMany` for each group: 132 sequential round trips for the client's
        // own 66-group file, inside one interactive transaction whose budget is Prisma's default
        // **five seconds**, which expired mid-write against a hosted database with `P2028`.
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
        // wrong section.
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
            // 047: the schedule's basis decides whether the quoted percentage ever applies.
            pricingBasis: item.pricingBasis ?? BoqPricingBasis.percentage,
          }));
        });
        await tx.bOQTaskItem.createMany({ data: rows });

        return {
          groups: batch.groups.length,
          lines: rows.length,
          replaced: existing.lines,
          quotedBefore,
          quotedAfter,
          quotedSource,
        };
      });
    } catch (error) {
      // Nothing was written, so the batch is valid to retry — and losing it here would mean
      // re-uploading and re-reading the whole report for a failure that was not the operator's.
      this.batches.release(input.batchId);
      throw this.writeFailure(error);
    }

    this.batches.markConfirmed(input.batchId);

    // FR-014 and the constitution re-check: **one** entry. One import is one act. Since 047 it also
    // records what was replaced and which quoted percentage was kept — replacing deletes lines,
    // which Principle IV requires to be accountable.
    await this.audit.record({
      entityType: AuditEntityType.BOQ_IMPORT,
      action: written.replaced > 0 ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: input.projectId,
      changes: {
        batchId: input.batchId,
        groups: written.groups,
        lines: written.lines,
        schedules: batch.schedules.map(
          ({ sheetName, pricingBasis, lines }) => ({
            sheetName,
            pricingBasis,
            lines,
          }),
        ),
        quotedPercentage: batch.quotedPercentage,
        quotedPercentageBefore: written.quotedBefore,
        quotedPercentageAfter: written.quotedAfter,
        quotedPercentageSource: written.quotedSource,
        replacedLines: written.replaced,
        isEstimate: batch.isEstimate,
      },
      accountId: input.userId,
      companyId: input.companyId,
      ipAddress: input.ipAddress,
    });

    return {
      groups: written.groups,
      lines: written.lines,
      isEstimate: batch.isEstimate,
      // Written, not merely changed: confirming a figure equal to the project's still sets it.
      quotedPercentageSet:
        !batch.isEstimate &&
        batch.quotedPercentage !== null &&
        written.quotedSource !== 'project',
      quotedPercentage: written.quotedAfter,
      replaced: written.replaced,
    };
  }

  /**
   * Everything that would stop this variant's BOQ being replaced, in one read (047).
   *
   * Four things, the four ways a line stops being "just imported": progress recorded against it
   * (`doneQty`), a daily work report measuring it, a client bill line, a work-order award line.
   * Inventory issue tags are optional soft links in another module and are deliberately not read
   * here (Principle I; spec Clarifications).
   */
  private async replaceCheck(
    tx: Prisma.TransactionClient,
    projectId: string,
    isEstimate: boolean,
  ): Promise<ReplaceCheck> {
    const [items, groups] = await Promise.all([
      tx.bOQTaskItem.findMany({
        where: { isEstimate, group: { projectId, isEstimate } },
        select: {
          boqNo: true,
          doneQty: true,
          _count: {
            select: { dwrTasks: true, clientBillLines: true, awardLines: true },
          },
        },
      }),
      tx.bOQTaskGroup.count({ where: { projectId, isEstimate } }),
    ]);
    const check: ReplaceCheck = {
      lines: items.length,
      groups,
      measured: 0,
      dwr: 0,
      billed: 0,
      awarded: 0,
      boqNumbers: [],
    };
    for (const item of items) {
      const measured = !item.doneQty.isZero();
      const { dwrTasks, clientBillLines, awardLines } = item._count;
      if (measured) check.measured += 1;
      if (dwrTasks > 0) check.dwr += 1;
      if (clientBillLines > 0) check.billed += 1;
      if (awardLines > 0) check.awarded += 1;
      if (
        (measured || dwrTasks + clientBillLines + awardLines > 0) &&
        check.boqNumbers.length < 20
      ) {
        check.boqNumbers.push(item.boqNo);
      }
    }
    return check;
  }

  private blocksReplace(check: ReplaceCheck): boolean {
    return check.measured + check.dwr + check.billed + check.awarded > 0;
  }

  private replaceBlocked(
    check: ReplaceCheck,
    isEstimate: boolean,
  ): BadRequestException {
    const what = isEstimate ? 'estimate' : 'BOQ';
    const reasons = [
      check.measured > 0 && `${check.measured} with progress recorded`,
      check.dwr > 0 && `${check.dwr} in daily work reports`,
      check.billed > 0 && `${check.billed} on client bills`,
      check.awarded > 0 && `${check.awarded} awarded in work orders`,
    ].filter(Boolean);
    return new BadRequestException({
      statusCode: 400,
      code: BOQ_ERRORS.replaceBlocked,
      message:
        `This project's ${what} (${check.lines} lines) cannot be replaced, because work has ` +
        `already been recorded against some of its lines: ${reasons.join(
          ', ',
        )}. ` +
        `Lines: ${check.boqNumbers.join(', ')}${
          check.boqNumbers.length < check.lines &&
          check.boqNumbers.length === 20
            ? ', …'
            : ''
        }. Add or revise lines on the project instead.`,
      blockedBy: {
        measured: check.measured,
        dwr: check.dwr,
        billed: check.billed,
        awarded: check.awarded,
        boqNumbers: check.boqNumbers,
      },
    });
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

  /** FR-049, amended by 047: raised by confirm when replacing was not asked for. */
  private alreadyPopulated(
    existing: number,
    isEstimate = false,
  ): BadRequestException {
    // Names the **variant**, not just the count — see `replaceCheck`.
    const what = isEstimate ? 'estimate lines' : 'BOQ lines';
    return refuse(
      BOQ_ERRORS.alreadyPopulated,
      `This project already has ${existing} ${what}. Importing would replace them — confirm ` +
        'again with "Replace existing BOQ" ticked (replaceExisting) if that is what you mean.',
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

/**
 * Which way a tender's quote runs, read from the label beside the figure.
 *
 * `-1` under estimate, `+1` over it, `0` at par, and **null where the label does not say** — see
 * `locatePercentage`. A label naming two directions at once is the template's own instruction cell
 * ("Select, At Par, Excess (+), Less (-)"), not a value, and is refused for the same reason.
 */
function quoteDirection(label: string): -1 | 0 | 1 | null {
  const under = /less/i.test(label);
  const over = /excess/i.test(label);
  const par = /at\s*par/i.test(label);
  if (Number(under) + Number(over) + Number(par) !== 1) return null;
  if (under) return -1;
  if (over) return 1;
  return 0;
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

/** `9752823` → `₹97,52,823.00`, as the reader's own documents write it. */
function inr(value: string | null): string {
  return `₹${Number(value ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `-0.191200` → `19.12% below estimate`. */
function percentText(fraction: string): string {
  const value = Number(fraction);
  if (value === 0) return 'at par (0%)';
  return `${Math.abs(value * 100).toFixed(2)}% ${
    value < 0 ? 'below' : 'above'
  } estimate`;
}

function mergeUnits(lists: UnitSummary[][]): UnitSummary[] {
  const merged = new Map<string, UnitSummary>();
  for (const unit of lists.flat()) {
    const known = merged.get(unit.asTyped);
    if (known) known.lines += unit.lines;
    else merged.set(unit.asTyped, { ...unit });
  }
  return [...merged.values()].sort((left, right) => right.lines - left.lines);
}

/**
 * Every schedule's totals as one figure, for the headline (047).
 *
 * A stated figure is combined only when **every** schedule states one — a sum of some stated
 * totals against all derived ones would report a difference that is just the missing sheet. The
 * quoted figure is the price of the whole tender: an item-rate schedule's own total (it has no
 * percentage) plus each percentage schedule's quoted total.
 */
function combineTotals(reports: ScheduleReport[]): ImportTotals {
  const sum = (values: (string | null)[]): Prisma.Decimal | null =>
    values.some((value) => value === null)
      ? null
      : values.reduce((total, value) => total.plus(DEC(value)), DEC(0));
  const live = reports.filter((report) => report.lines > 0);
  const derived = sum(live.map((r) => r.totals.scheduleDerived));
  const stated = sum(live.map((r) => r.totals.scheduleStated));
  const tax = sum(live.map((r) => r.excludedTaxAmount));
  const quotedDerived = sum(
    live.map((r) =>
      r.pricingBasis === 'item_rate'
        ? DEC(r.totals.scheduleDerived)
            .plus(DEC(r.excludedTaxAmount))
            .toFixed(2)
        : r.totals.quotedDerived,
    ),
  );
  const quotedStated = sum(
    live.map((r) =>
      r.pricingBasis === 'item_rate'
        ? r.totals.scheduleStated
        : r.totals.quotedStated,
    ),
  );
  const tolerance = sum(live.map((r) => r.totals.tolerance));
  return {
    scheduleDerived: derived.toFixed(2),
    scheduleStated: stated?.toFixed(2) ?? null,
    quotedDerived: quotedDerived?.toFixed(2) ?? null,
    quotedStated: quotedStated?.toFixed(2) ?? null,
    scheduleDifference:
      stated === null ? null : derived.plus(tax).minus(stated).abs().toFixed(2),
    quotedDifference:
      quotedDerived === null || quotedStated === null
        ? null
        : quotedDerived.minus(quotedStated).abs().toFixed(2),
    tolerance: tolerance.toFixed(2),
    reconciles: live.every((r) => r.totals.reconciles),
  };
}
