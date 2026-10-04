import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  DwrPaymentMode,
  DwrStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import {
  contentDispositionFor,
  detectContentType,
} from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';
import { DWR_ERRORS, DWR_WARNINGS, DwrWarningCode } from './dwr-error-codes';
import {
  FULL_DAY,
  MeasurementLine,
  ZeroFactorError,
  quantityColumnsFor,
} from './dwr-quantity';
import { CreateDwrDto, CreateDwrLineDto } from './dto/create-dwr.dto';
import { UpdateDwrDto } from './dto/update-dwr.dto';

/** Separates the project code from the sequence in a report number (FR-002a). */
const DPR_SEPARATOR = '-DPR-';

/** How many times a number collision is retried before giving up (FR-002b). */
const DPR_COLLISION_RETRIES = 5;

/** The six factor fields, for refusing them on a presence line (FR-030b). */
const FACTOR_FIELDS = [
  'nos1',
  'nos2',
  'length',
  'breadth',
  'depth',
  'density',
] as const;

export interface DwrWarning {
  code: DwrWarningCode;
  message: string;
  /** Whatever the reader needs to act: a report number, a line's BOQ number, a date. */
  detail?: Record<string, unknown>;
}

export interface CreatedDwr {
  id: string;
  dprNumber: string;
  status: DwrStatus;
  /** Facts reported **alongside** success, never instead of it (FR-025, US1 AC8, FR-006). */
  warnings: DwrWarning[];
}

/**
 * Recording a day's work (022 Phase C — FR-001 to FR-009a, FR-025, FR-030c).
 *
 * ## What this service is for
 *
 * 008 specified daily work reports in August 2026, created their two tables, and never built the
 * module. The visible consequence was not a missing screen: **every BOQ line in the system reported
 * 0% executed**, because `doneQty` moves only when a report is approved and nothing could approve
 * one. This is the floor under that.
 *
 * ## Three rules this file keeps, each for a reason it has already cost something to learn
 *
 * **A quantity is computed here and nowhere else.** `quantityInForce` in `dwr-quantity.ts` is the
 * only thing that knows which of a line's two quantities governs it, and a client-supplied figure
 * has nowhere to arrive — the DTO has no field for it. Ignoring a value needs a test to prove;
 * having no field for it cannot fail.
 *
 * **A fact is reported, not used as grounds to refuse.** A work date before the project's start
 * date, a second report for a day already covered, a line past its BOQ scope — all three are
 * accepted and named in `warnings`. Refusing any of them would lose a real day's record to protect
 * a tidiness nobody asked for, and the site would go back to paper.
 *
 * **Lines are written in one statement, never in a loop.** On 2026-10-04 the BOQ import's confirm
 * step made 132 sequential round trips inside one interactive transaction whose default budget is
 * 5 000 ms. It passed every local run and returned a bare 500 on the deployment, where the round
 * trip is longer. Two statements replaced 132, and the rule is recorded here rather than rediscovered.
 */
@Injectable()
export class DwrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  async create(
    ctx: RlsContext,
    projectId: string,
    companyId: string,
    input: CreateDwrDto,
    actor: { userId: string; ipAddress?: string },
  ): Promise<CreatedDwr> {
    const warnings: DwrWarning[] = [];
    const workDate = startOfDay(new Date(input.workDate));

    // Refused before anything else, because a report describes a day that happened (FR-025).
    if (workDate.getTime() > startOfDay(new Date()).getTime()) {
      throw new BadRequestException({
        code: DWR_ERRORS.workDateInFuture,
        message: `The work date ${input.workDate} is in the future. A report describes a day that has happened.`,
      });
    }

    const lines = (input.lines ?? []).map((line, index) =>
      narrowLine(line, index),
    );

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, code: true, startDate: true },
      });
      // Not found rather than forbidden: a 403 would confirm the project exists (FR-029).
      if (!project) throw new NotFoundException('Project not found');

      if (project.startDate && workDate < startOfDay(project.startDate)) {
        // Accepted. A start date corrected after the fact is far more common than invented work
        // (FR-025), so the discrepancy is reported and the day is kept.
        warnings.push({
          code: DWR_WARNINGS.workDateBeforeProjectStart,
          message: `The work date precedes this project's start date of ${project.startDate
            .toISOString()
            .slice(0, 10)}.`,
          detail: { projectStartDate: project.startDate },
        });
      }

      // US1 AC8. Two crews on two stretches of one highway is ordinary; refusing the second report
      // would simply lose it. The existing one is named so the author can merge if they meant to.
      const sameDay = await tx.dailyWorkReport.findMany({
        where: { projectId, workDate },
        select: { id: true, dprNumber: true },
        take: 5,
      });
      if (sameDay.length > 0) {
        warnings.push({
          code: DWR_WARNINGS.dateAlreadyReported,
          message: `${sameDay.length} report(s) already cover this project and date.`,
          detail: { existingReports: sameDay },
        });
      }

      const boqItems = await this.resolveBoqItems(
        tx,
        projectId,
        input.lines ?? [],
      );

      const report = await this.createWithNumber(
        tx,
        project.code,
        async (dprNumber) =>
          tx.dailyWorkReport.create({
            data: {
              companyId,
              projectId,
              workDate,
              dprNumber,
              supervisorEmployeeId: input.supervisorEmployeeId ?? null,
              weather: input.weather ?? undefined,
              status: DwrStatus.draft,
              workerCount: input.workerCount ?? 0,
              machineryCount: input.machineryCount ?? 0,
              progress: input.progress ?? 0,
              location: input.location ?? null,
              description: input.description ?? null,
              contractFor: input.contractFor ?? 'self',
              contractNumber: input.contractNumber ?? null,
              rfiNo: input.rfiNo ?? null,
              layer: input.layer ?? null,
            },
            select: { id: true, dprNumber: true, status: true },
          }),
      );

      if (lines.length > 0) {
        // One statement, not one per line (research §8). See this class's docblock.
        await tx.dWRTask.createMany({
          data: lines.map((line, index) =>
            this.lineRow(report.id, line, input.lines![index], boqItems),
          ),
        });

        for (const [index, line] of lines.entries()) {
          const raw = input.lines![index];
          if (!raw.boqItemId) {
            warnings.push({
              code: DWR_WARNINGS.lineWithoutBoqItem,
              message: `Line ${
                index + 1
              } references no BOQ line, so it moves no executed quantity and feeds no billing period.`,
              detail: { lineIndex: index },
            });
            continue;
          }
          const boq = boqItems.get(raw.boqItemId)!;
          if (exceedsScope(line, boq)) {
            warnings.push({
              code: DWR_WARNINGS.exceedsScope,
              message: `Line ${index + 1} (${
                boq.boqNo
              }) takes this BOQ line past its scope quantity.`,
              detail: { boqNo: boq.boqNo, scopeQty: boq.scopeQty.toFixed(3) },
            });
          }
        }
      }

      return report;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return { ...created, warnings };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Update
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Edits a draft (FR-018, US3 AC1).
   *
   * An approved report is refused rather than edited, and the message names the reversal path. The
   * reason is not tidiness: approving it moved executed quantities that a bill may already have
   * been built from, so an edit would change a figure somebody has been invoiced against with
   * nothing recording that it moved. Reversal exists for that, and says so.
   */
  async update(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    input: UpdateDwrDto,
    actor: { userId: string; ipAddress?: string },
  ): Promise<{ id: string; status: DwrStatus; warnings: DwrWarning[] }> {
    const warnings: DwrWarning[] = [];

    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: { id: true, projectId: true, status: true },
      });
      if (!report) throw new NotFoundException('Daily work report not found');

      if (report.status === DwrStatus.approved) {
        throw new ConflictException({
          code: DWR_ERRORS.approvedNotEditable,
          message:
            'This report is approved, and approving it moved executed quantities a bill may ' +
            'depend on. Reverse it first, with a reason — editing it would move those figures ' +
            'with nothing recording that they moved.',
        });
      }

      if (input.lines) {
        const lines = input.lines.map((line, index) => narrowLine(line, index));
        const boqItems = await this.resolveBoqItems(
          tx,
          report.projectId,
          input.lines,
        );

        // Replaced wholesale rather than diffed. A draft's lines are not referenced by anything —
        // only approval creates references — so a diff would be machinery with no beneficiary.
        await tx.dWRTask.deleteMany({ where: { dwrId } });
        if (lines.length > 0) {
          await tx.dWRTask.createMany({
            data: lines.map((line, index) =>
              this.lineRow(dwrId, line, input.lines![index], boqItems),
            ),
          });
        }

        for (const [index, line] of lines.entries()) {
          const raw = input.lines[index];
          if (!raw.boqItemId) continue;
          const boq = boqItems.get(raw.boqItemId)!;
          if (exceedsScope(line, boq)) {
            warnings.push({
              code: DWR_WARNINGS.exceedsScope,
              message: `Line ${index + 1} (${
                boq.boqNo
              }) takes this BOQ line past its scope quantity.`,
              detail: { boqNo: boq.boqNo },
            });
          }
        }
      }

      return tx.dailyWorkReport.update({
        where: { id: dwrId },
        data: {
          supervisorEmployeeId: input.supervisorEmployeeId ?? undefined,
          weather: input.weather ?? undefined,
          workerCount: input.workerCount ?? undefined,
          machineryCount: input.machineryCount ?? undefined,
          progress: input.progress ?? undefined,
          location: input.location ?? undefined,
          description: input.description ?? undefined,
          contractFor: input.contractFor ?? undefined,
          contractNumber: input.contractNumber ?? undefined,
          rfiNo: input.rfiNo ?? undefined,
          layer: input.layer ?? undefined,
        },
        select: { id: true, status: true },
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.UPDATE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return { ...result, warnings };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Attachments (FR-009, FR-009a)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Stores a file against a report.
   *
   * The content type comes from `detectContentType` reading the **bytes**, not from the client's
   * claim: a browser that is told `application/octet-stream` offers a download rather than opening
   * the photograph somebody wants to look at, and a client's `Content-Type` is a guess made from an
   * extension. The name is stored as the uploader spelled it (FR-009a), because 017 already fixed
   * the alternative — files arriving as a bare UUID that nothing would open.
   */
  async addAttachment(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    file: { buffer: Buffer; originalname: string },
    actor: { userId: string; ipAddress?: string },
  ): Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const exists = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: { id: true },
      }),
    );
    if (!exists) throw new NotFoundException('Daily work report not found');

    // From the **bytes**, not from the client's `Content-Type` — which is a guess made from a file
    // extension, and which a browser then honours by offering a download instead of opening the
    // photograph somebody wants to look at.
    const mimeType =
      detectContentType(file.buffer)?.contentType ?? 'application/octet-stream';

    const fileRef = await this.storage.put(
      `dwr-attachments/${companyId}`,
      file.buffer,
      mimeType,
    );

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.dWRAttachment.create({
        data: {
          companyId,
          dwrId,
          fileRef,
          fileName: file.originalname,
          mimeType,
          sizeBytes: file.buffer.length,
          uploadedByUserId: actor.userId,
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
        },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.UPDATE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return created;
  }

  /** Reads a file back, named and typed so a browser can open it (FR-009). */
  async readAttachment(
    ctx: RlsContext,
    attachmentId: string,
  ): Promise<{
    data: Buffer;
    mimeType: string;
    contentDisposition: string;
  }> {
    const attachment = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.dWRAttachment.findFirst({
        where: { id: attachmentId },
        select: { fileRef: true, fileName: true, mimeType: true },
      }),
    );
    if (!attachment) throw new NotFoundException('Attachment not found');

    const data = await this.storage.get(attachment.fileRef);

    return {
      data,
      mimeType: attachment.mimeType,
      // `contentDispositionFor` rather than a hand-built header: a file name carrying a character
      // outside latin1 makes `res.setHeader` throw `ERR_INVALID_CHAR`, which is a 500 on a
      // download — a defect this repository shipped and fixed on 2026-10-04.
      contentDisposition: contentDispositionFor(attachment.fileName),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generates the report number and retries a collision (FR-002, FR-002a, FR-002b).
   *
   * **The sequence is read, not held.** Two creations for one project at the same instant can both
   * read the same maximum, and the loser meets `@@unique([companyId, dprNumber])` — so the
   * collision is retried rather than surfaced, and neither attempt is lost. A lock would serialise
   * every report in a company behind one row for the sake of a number that is allowed to have gaps.
   *
   * Gaps are permitted and mean nothing (FR-002c): a refused creation consumes a candidate, and a
   * deleted draft leaves one behind. Said out loud because a gap in a numbered site register is
   * otherwise the first thing an auditor asks about.
   */
  private async createWithNumber<T>(
    tx: Prisma.TransactionClient,
    projectCode: string,
    create: (dprNumber: string) => Promise<T>,
  ): Promise<T> {
    const prefix = `${projectCode}${DPR_SEPARATOR}`;

    for (let attempt = 0; attempt < DPR_COLLISION_RETRIES; attempt += 1) {
      const latest = await tx.dailyWorkReport.findFirst({
        where: { dprNumber: { startsWith: prefix } },
        orderBy: { dprNumber: 'desc' },
        select: { dprNumber: true },
      });

      const next = sequenceAfter(latest?.dprNumber, prefix) + attempt;

      try {
        return await create(`${prefix}${String(next).padStart(4, '0')}`);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Somebody else took this number between the read and the write. Try the next one.
      }
    }

    throw new ConflictException(
      'Could not allocate a report number after several attempts. Try again.',
    );
  }

  /**
   * Loads every BOQ line a report references, in **one** query, and refuses any that belongs to
   * another project (T019).
   *
   * The check is not paranoia about forged ids. BOQ line ids are opaque and a supervisor working on
   * two projects has both open; a mistyped reference would file a measurement against a schedule
   * its author cannot see, and the quantity would surface months later in somebody else's bill.
   * Naming **both** projects in the refusal is what makes that a two-second fix rather than a
   * mystery.
   *
   * One query rather than one per line, for the reason this class's docblock gives.
   */
  private async resolveBoqItems(
    tx: Prisma.TransactionClient,
    projectId: string,
    rawLines: { boqItemId?: string }[],
  ): Promise<Map<string, BoqItemForLine>> {
    const ids = [
      ...new Set(
        rawLines
          .map((line) => line.boqItemId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (ids.length === 0) return new Map();

    const items = await tx.bOQTaskItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        boqNo: true,
        scopeQty: true,
        doneQty: true,
        group: { select: { projectId: true } },
      },
    });

    const found = new Map<string, BoqItemForLine>();
    const foreign: { boqItemId: string; belongsToProjectId: string }[] = [];

    for (const item of items) {
      if (item.group.projectId !== projectId) {
        foreign.push({
          boqItemId: item.id,
          belongsToProjectId: item.group.projectId,
        });
        continue;
      }
      found.set(item.id, {
        id: item.id,
        boqNo: item.boqNo,
        scopeQty: item.scopeQty,
        doneQty: item.doneQty,
      });
    }

    if (foreign.length > 0) {
      throw new BadRequestException({
        code: DWR_ERRORS.boqItemOtherProject,
        message:
          `${foreign.length} measured line(s) reference a BOQ line belonging to a different ` +
          'project. A measurement filed against a schedule its author cannot see surfaces months ' +
          "later in somebody else's bill.",
        detail: { reportingProjectId: projectId, lines: foreign },
      });
    }

    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      // Not found rather than forbidden — the same reasoning as FR-029: these may be another
      // company's lines, which RLS has already hidden, and saying "forbidden" would confirm them.
      throw new NotFoundException(
        `${missing.length} referenced BOQ line(s) do not exist on this project.`,
      );
    }

    return found;
  }

  /** Builds one `DWRTask` row. */
  private lineRow(
    dwrId: string,
    line: MeasurementLine,
    raw: CreateDwrLineDto,
    boqItems: Map<string, BoqItemForLine>,
  ): Prisma.DWRTaskCreateManyInput {
    const quantities = quantityColumnsFor(line);
    const boq = raw.boqItemId ? boqItems.get(raw.boqItemId) : undefined;

    return {
      dwrId,
      boqItemId: raw.boqItemId ?? null,
      paymentMode: line.paymentMode,
      actualQty: quantities.actualQty,
      servedQty: quantities.servedQty,
      equipmentId: raw.equipmentId ?? null,
      // The six factors are written as supplied for a measured line, and left at their defaults
      // for a presence line — where nothing reads them (FR-030b, FR-030d).
      nos1: raw.nos1 ?? undefined,
      nos2: raw.nos2 ?? undefined,
      length: raw.length ?? undefined,
      breadth: raw.breadth ?? undefined,
      depth: raw.depth ?? undefined,
      density: raw.density ?? undefined,
      chainageFrom: raw.chainageFrom ?? null,
      chainageTo: raw.chainageTo ?? null,
      layer: raw.layer ?? null,
      roadSide: raw.roadSide ?? null,
      section: raw.section ?? null,
      layerNo: raw.layerNo ?? null,
      engineerName: raw.engineerName ?? null,
      remark: raw.remark ?? null,
      exceedsScope: boq ? exceedsScope(line, boq) : false,
    };
  }
}

interface BoqItemForLine {
  id: string;
  boqNo: string;
  scopeQty: Prisma.Decimal;
  doneQty: Prisma.Decimal;
}

/** Midnight, so a work date compares as a day rather than as an instant. */
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/** Whether a line takes its BOQ line past scope. Flagged, never refused (FR-006). */
function exceedsScope(line: MeasurementLine, boq: BoqItemForLine): boolean {
  const { actualQty, servedQty } = quantityColumnsFor(line);
  const quantity = actualQty ?? servedQty!;
  return boq.doneQty.plus(quantity).greaterThan(boq.scopeQty);
}

/** The next sequence number after an existing report number, or 1. */
function sequenceAfter(latest: string | undefined, prefix: string): number {
  if (!latest) return 1;
  const tail = latest.slice(prefix.length);
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed + 1 : 1;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Narrows one submitted line to the shape its payment basis permits (FR-030b).
 *
 * `class-validator` cannot discriminate a union by a property value, so the DTO accepts the
 * superset and this refuses the forbidden combinations by name. The refusals matter more than they
 * look: a presence line carrying factors would otherwise be stored with them, and because all six
 * default to 1 — product 1, indistinguishable from one day served — any later code that read them
 * would be right by coincidence until one of them changed.
 */
export function narrowLine(
  line: CreateDwrLineDto,
  index: number,
): MeasurementLine {
  if (line.paymentMode === DwrPaymentMode.day_basis) {
    const supplied = FACTOR_FIELDS.filter(
      (field) => line[field] !== undefined && line[field] !== null,
    );
    if (supplied.length > 0) {
      throw new BadRequestException({
        code: DWR_ERRORS.factorsOnPresenceLine,
        message:
          `Line ${
            index + 1
          } is paid for presence, so it is measured in days served, not by ` +
          `dimensions. Remove: ${supplied.join(', ')}.`,
      });
    }
    if (line.servedQty === undefined || line.servedQty === null) {
      throw new BadRequestException({
        code: DWR_ERRORS.shortDayNeedsRemark,
        message: `Line ${
          index + 1
        } is paid for presence and must say how much of the day was served.`,
      });
    }

    const served = new Prisma.Decimal(line.servedQty);
    if (served.isNegative()) {
      throw new BadRequestException(
        `Line ${index + 1} has a negative served quantity.`,
      );
    }
    // FR-030c. The shortfall is the fact a client's deduction is later argued from, so the reason
    // is captured when it is known rather than reconstructed at bill time by somebody guessing.
    if (served.lessThan(FULL_DAY) && !line.remark?.trim()) {
      throw new BadRequestException({
        code: DWR_ERRORS.shortDayNeedsRemark,
        message:
          `Line ${index + 1} claims less than a full day (${served.toFixed(
            3,
          )}). Say why — that ` +
          'shortfall is what a deduction on the bill will be argued from.',
      });
    }

    return { paymentMode: 'day_basis', servedQty: line.servedQty };
  }

  if (line.servedQty !== undefined && line.servedQty !== null) {
    throw new BadRequestException({
      code: DWR_ERRORS.factorsOnPresenceLine,
      message:
        `Line ${
          index + 1
        } is measured by dimensions, so its quantity is computed from them. ` +
        'Remove servedQty.',
    });
  }

  const measured: MeasurementLine = {
    paymentMode: 'work_basis',
    nos1: line.nos1,
    nos2: line.nos2,
    length: line.length,
    breadth: line.breadth,
    depth: line.depth,
    density: line.density,
  };

  // Validated here rather than at write time so the refusal names the line as well as the factor.
  try {
    quantityColumnsFor(measured);
  } catch (error) {
    if (error instanceof ZeroFactorError) {
      throw new BadRequestException({
        code: DWR_ERRORS.factorZero,
        message:
          `Line ${index + 1}: the factor "${
            error.factor
          }" was given as 0, which would zero the ` +
          'whole line. Leave an unused dimension out instead — omitted means 1.',
      });
    }
    throw error;
  }

  return measured;
}
