import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { BoqService } from '../boq/boq.service';
import {
  EquipmentLogbookDay,
  ProjectSourcesRegistry,
} from '../portfolio/project-sources.registry';
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
  storedQuantityInForce,
} from './dwr-quantity';
import { CreateDwrDto, CreateDwrLineDto } from './dto/create-dwr.dto';
import { ReverseDwrDto } from './dto/dwr-lifecycle.dto';
import {
  DWR_PAGE_SIZE_DEFAULT,
  DWR_PAGE_SIZE_MAX,
  ListDwrDto,
} from './dto/dwr-query.dto';
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

/** One report as its detail screen reads it. Shapes rather than Prisma rows, so the wire is typed. */
export interface DwrDetail {
  id: string;
  dprNumber: string;
  workDate: string;
  status: DwrStatus;
  lines: {
    id: string;
    boqItemId: string | null;
    boqNo: string | null;
    quantityInForce: string;
    logbook: EquipmentLogbookDay | null;
    logbookMissing: boolean;
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
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
    private readonly boq: BoqService,
    private readonly sources: ProjectSourcesRegistry,
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
              createdByUserId: actor.userId,
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
    file: { data: Buffer; fileName: string },
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
      detectContentType(file.data)?.contentType ?? 'application/octet-stream';

    const fileRef = await this.storage.put(
      `dwr-attachments/${companyId}`,
      file.data,
      mimeType,
    );

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.dWRAttachment.create({
        data: {
          companyId,
          dwrId,
          fileRef,
          fileName: file.fileName,
          mimeType,
          sizeBytes: file.data.length,
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
  // Reading (Phase E — FR-026, FR-027, FR-032, FR-033)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A project's reports, filtered and paginated (FR-026).
   *
   * The total comes from a separate `count` over the same filter, so it does **not** depend on the
   * page returned — a total equal to the page length is the classic way a paginated list tells a
   * reader there are 25 reports when there are 300.
   */
  async list(
    ctx: RlsContext,
    query: ListDwrDto,
  ): Promise<{
    items: {
      id: string;
      dprNumber: string;
      workDate: Date;
      status: DwrStatus;
      workerCount: number;
      machineryCount: number;
      progress: number;
      lineCount: number;
      /**
       * Carried so a caller can show FR-012a **before** the action rather than after it (025
       * FR-006). The rule — the author of a report may not approve it — is enforced here and was
       * invisible on every screen, so each submitted report offered an Approve button that would be
       * refused, and the author learnt the rule by pressing it.
       */
      createdByUserId: string | null;
      submittedByUserId: string | null;
    }[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      DWR_PAGE_SIZE_MAX,
      Math.max(1, query.pageSize ?? DWR_PAGE_SIZE_DEFAULT),
    );

    const where: Prisma.DailyWorkReportWhereInput = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            workDate: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: startOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.dailyWorkReport.findMany({
          where,
          orderBy: [{ workDate: 'desc' }, { dprNumber: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            dprNumber: true,
            workDate: true,
            status: true,
            workerCount: true,
            machineryCount: true,
            progress: true,
            createdByUserId: true,
            submittedByUserId: true,
            _count: { select: { tasks: true } },
          },
        }),
        tx.dailyWorkReport.count({ where }),
      ]);

      return {
        items: rows.map(({ _count, ...row }) => ({
          ...row,
          lineCount: _count.tasks,
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  /**
   * One report, with each line beside its BOQ line's position and its equipment's logbook day
   * (FR-027, FR-032, FR-033).
   *
   * The logbook comes through `ProjectSourcesRegistry`, never by querying `plant.LogbookEntry` —
   * Principle I, and research §5's reason for the direction. A date the equipment has no entry for
   * is reported as **missing**, not as a run of zero: an unrecorded day and a day the machine did
   * nothing are different facts, and only one of them is somebody to go and ask.
   */
  async findOne(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
  ): Promise<DwrDetail> {
    const report = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: {
          id: true,
          projectId: true,
          dprNumber: true,
          workDate: true,
          status: true,
          supervisorEmployeeId: true,
          weather: true,
          workerCount: true,
          machineryCount: true,
          progress: true,
          location: true,
          description: true,
          contractFor: true,
          contractNumber: true,
          rfiNo: true,
          layer: true,
          createdByUserId: true,
          submittedByUserId: true,
          submittedAt: true,
          approvedByUserId: true,
          approvedAt: true,
          reversedAt: true,
          reversedByUserId: true,
          reversalReason: true,
          reversalCount: true,
          attachments: {
            select: {
              id: true,
              fileName: true,
              mimeType: true,
              sizeBytes: true,
              uploadedAt: true,
            },
          },
          tasks: {
            select: {
              id: true,
              boqItemId: true,
              paymentMode: true,
              actualQty: true,
              servedQty: true,
              // The six factors the quantity was computed from (FR-030).
              //
              // Selected because the arithmetic is the record. `actualQty` alone says a line
              // measured 117; only these say it was 30 × 15 × 0.26, which is the half somebody
              // disputes and the half an engineer checks. Omitting them left the detail screen
              // able to print nothing but "no factors entered" for every measured line in the
              // product — a sentence that was never true of a line the server had computed.
              nos1: true,
              nos2: true,
              length: true,
              breadth: true,
              depth: true,
              density: true,
              equipmentId: true,
              chainageFrom: true,
              chainageTo: true,
              layer: true,
              roadSide: true,
              section: true,
              layerNo: true,
              engineerName: true,
              remark: true,
              exceedsScope: true,
              boqItem: {
                select: {
                  boqNo: true,
                  taskName: true,
                  unit: true,
                  scopeQty: true,
                  doneQty: true,
                  perDayQty: true,
                },
              },
            },
          },
        },
      }),
    );
    if (!report) throw new NotFoundException('Daily work report not found');

    const workDate = report.workDate.toISOString().slice(0, 10);
    const logbook = await this.logbookFor(report.tasks, companyId, workDate);

    // `tasks` is destructured out rather than spread: it is the raw rows, carrying the BOQ line
    // nested under `boqItem` and no flattened `boqNo`, and returning it beside `lines` gave the
    // response two arrays of the same thing with different shapes. The contract only ever named
    // `lines`; `tasks` arrived by accident, and the detail screen picked the accidental one and
    // showed "BOQ —" against every line in the product.
    const { tasks, ...header } = report;

    return {
      ...header,
      workDate,
      lines: tasks.map((task) => {
        const scopeQty = task.boqItem?.scopeQty ?? null;
        const doneQty = task.boqItem?.doneQty ?? null;
        const measured = task.paymentMode === DwrPaymentMode.work_basis;
        const entry = task.equipmentId
          ? logbook.get(task.equipmentId)
          : undefined;

        return {
          id: task.id,
          boqItemId: task.boqItemId,
          boqNo: task.boqItem?.boqNo ?? null,
          taskName: task.boqItem?.taskName ?? null,
          unit: task.boqItem?.unit ?? null,
          paymentMode: task.paymentMode,
          quantityInForce: storedQuantityInForce(task).toFixed(3),
          // How that quantity was arrived at. Null on a presence-paid line, where there was no
          // multiplication — not 1, which would read as a factor somebody entered.
          nos1: measured ? task.nos1.toFixed(3) : null,
          nos2: measured ? task.nos2.toFixed(3) : null,
          length: measured ? task.length.toFixed(3) : null,
          breadth: measured ? task.breadth.toFixed(3) : null,
          depth: measured ? task.depth.toFixed(3) : null,
          density: measured ? task.density.toFixed(3) : null,
          // The BOQ line's own position (FR-027), from `BoqService`'s projection rather than
          // recomputed: pending is scope less done, and two definitions of it would diverge.
          scopeQty: scopeQty?.toFixed(3) ?? null,
          doneQty: doneQty?.toFixed(3) ?? null,
          pendingQty:
            scopeQty && doneQty ? scopeQty.minus(doneQty).toFixed(3) : null,
          targetQty: task.boqItem?.perDayQty?.toFixed(3) ?? null,
          chainageFrom: task.chainageFrom?.toFixed(3) ?? null,
          chainageTo: task.chainageTo?.toFixed(3) ?? null,
          layer: task.layer,
          roadSide: task.roadSide,
          section: task.section,
          layerNo: task.layerNo,
          engineerName: task.engineerName,
          remark: task.remark,
          exceedsScope: task.exceedsScope,
          equipmentId: task.equipmentId,
          logbook: entry ?? null,
          // FR-033. Three states, not two: no equipment named, an entry found, or an entry
          // genuinely absent for that date. Collapsing the last two into `logbook: null` would
          // make "nobody recorded it" look like "this line is not about a machine".
          logbookMissing: Boolean(task.equipmentId) && !entry,
        };
      }),
    };
  }

  /** The logbook day for every equipment a report's lines name, in one call per machine. */
  private async logbookFor(
    tasks: { equipmentId: string | null }[],
    companyId: string,
    workDate: string,
  ): Promise<Map<string, EquipmentLogbookDay>> {
    const source = this.sources.logbookSource();
    const equipmentIds = [
      ...new Set(
        tasks
          .map((t) => t.equipmentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!source || equipmentIds.length === 0) return new Map();

    const found = new Map<string, EquipmentLogbookDay>();
    await Promise.all(
      equipmentIds.map(async (equipmentId) => {
        const days = await source.getLogbookDays(equipmentId, companyId, [
          workDate,
        ]);
        const day = days.get(workDate);
        if (day) found.set(equipmentId, day);
      }),
    );
    return found;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle (Phase D — FR-010 to FR-024)
  // ───────────────────────────────────────────────────────────────────────────

  /** `draft` → `submitted`. Moves no executed quantity (FR-011). */
  async submit(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    actor: { userId: string; ipAddress?: string },
  ): Promise<{ id: string; status: DwrStatus }> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: { id: true, status: true, _count: { select: { tasks: true } } },
      });
      if (!report) throw new NotFoundException('Daily work report not found');

      assertStatus(report.status, DwrStatus.draft, 'submit');

      // FR-024. A day's report asserting nothing is a form somebody abandoned, and submitting it
      // would put it in a reviewer's queue to be approved into no effect at all.
      if (report._count.tasks === 0) {
        throw new BadRequestException({
          code: DWR_ERRORS.noLines,
          message:
            'This report has no measured lines, so there is nothing to review. Add the work done, ' +
            'or leave it as a draft.',
        });
      }

      // The transition is conditional on the status, so a concurrent second submit loses.
      const updated = await tx.dailyWorkReport.updateMany({
        where: { id: dwrId, status: DwrStatus.draft },
        data: {
          status: DwrStatus.submitted,
          submittedByUserId: actor.userId,
          submittedAt: new Date(),
        },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          code: DWR_ERRORS.wrongStatus,
          message:
            'Somebody else moved this report while you were submitting it.',
        });
      }

      return { id: dwrId, status: DwrStatus.submitted };
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.UPDATE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return result;
  }

  /**
   * `submitted` → `approved`, and the only path in the system that increases a BOQ line's executed
   * quantity (FR-012 to FR-016, FR-012a).
   *
   * ## Four properties, and each of them is load-bearing
   *
   * **All of a report's increments or none** (FR-013). One transaction, and the row count returned
   * by `applyDoneQtyDeltas` is compared against the number asked for — a shortfall throws, so the
   * transaction rolls back and the report stays submitted. "Stays submitted" is the only permitted
   * outcome of a failure, not one of several: a report that half-approved would leave the BOQ
   * showing work nobody approved with nothing to say which lines moved.
   *
   * **At most once** (FR-014, FR-014a). The status transition is a conditional `updateMany` inside
   * the same transaction as the increments, so two concurrent approvals of one report serialise on
   * the row and exactly one sees `count === 1`. Approving twice must not bill twice.
   *
   * **Relative increments only** (FR-015, FR-015a). Deltas are grouped per BOQ line and applied by
   * one statement that adds to the row as it stands. Two *different* reports measuring the same
   * line, approved at the same moment, both land — which a read-then-write would silently lose.
   *
   * **The approver is not the author** (FR-012a, decision D2). Approval is a direct transition
   * rather than a routed chain action, because one report a day per project makes routing
   * disproportionate and a chain nobody has configured would block the site's measurement rather
   * than review it. Segregation of duty is the control that remains, so a site engineer still
   * cannot certify their own claim.
   *
   * ## The override, and what it costs (025 FR-040)
   *
   * A caller holding `CROSS_COMPANY_ACCESS` **may** approve a report they submitted. The client
   * asked for it in those words — a super admin should not be blocked by their own report — and on
   * a small site the person who records the day is often the only person who can approve it, so
   * the rule as written could leave a day's measurement stuck behind nobody.
   *
   * **Keyed to a permission, never to the role name "Super Admin".** This repository already made
   * that mistake and fixed it: `users-admin.service.ts` records why a capability keyed to a display
   * string silently disappears the day an administrator tidies up a role name. `CROSS_COMPANY_ACCESS`
   * is what `rlsContextFor` already treats as super admin, and it is held by exactly one seeded
   * role — so this means "super admin" today and stays configurable tomorrow.
   *
   * **It is recorded, not silent.** Segregation of duty is the only control on a transition that
   * moves the quantities a bill is later built from, and an override nobody can see afterwards is
   * an override that cannot be reviewed. The audit entry says the approval was a self-approval, so
   * the question "who checked this?" has an answer — even when the answer is "nobody else".
   */
  async approve(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    actor: {
      userId: string;
      ipAddress?: string;
      /**
       * Whether this caller may approve their own report (025 FR-040).
       *
       * Passed in rather than read from a `Permission` here, so the service keeps taking an actor
       * it is told about rather than an `AuthenticatedUser` it has to interpret — the same shape
       * every other method on this class uses.
       */
      mayApproveOwn?: boolean;
    },
  ): Promise<{
    id: string;
    status: DwrStatus;
    moved: { boqNo: string; delta: string }[];
    /** True where FR-012a was overridden — the caller approved what they submitted. */
    selfApproved: boolean;
  }> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: {
          id: true,
          status: true,
          submittedByUserId: true,
          tasks: {
            select: {
              id: true,
              boqItemId: true,
              paymentMode: true,
              actualQty: true,
              servedQty: true,
              boqItem: { select: { boqNo: true } },
            },
          },
        },
      });
      if (!report) throw new NotFoundException('Daily work report not found');

      if (report.status === DwrStatus.approved) {
        throw new ConflictException({
          code: DWR_ERRORS.alreadyApproved,
          message:
            'This report is already approved. Its quantities have been counted once and will not ' +
            'be counted again.',
        });
      }
      assertStatus(report.status, DwrStatus.submitted, 'approve');

      const isOwnReport = Boolean(
        report.submittedByUserId && report.submittedByUserId === actor.userId,
      );

      if (isOwnReport && !actor.mayApproveOwn) {
        throw new ForbiddenException({
          code: DWR_ERRORS.approverIsAuthor,
          message:
            'You submitted this report, so somebody else has to approve it. Approving it moves ' +
            'the executed quantities a bill is later built from.',
        });
      }

      // Recorded below whether or not it was overridden, so a reviewer can tell a self-approval
      // from an ordinary one without reconstructing who submitted what.
      const selfApproved = isOwnReport;

      const deltas = groupDeltas(report.tasks);

      // One statement, relative, with the non-negative floor inside it (FR-015, FR-021).
      const moved = await this.boq.applyDoneQtyDeltas(tx, deltas);

      if (moved !== deltas.length) {
        // FR-013a. Named rather than counted: an all-or-nothing rule that reports nothing leaves
        // an operator retrying a write that will fail again for a reason nobody has been told.
        throw new ConflictException({
          code: DWR_ERRORS.approvalIncomplete,
          message:
            `${deltas.length - moved} of ${
              deltas.length
            } measured BOQ line(s) could not be ` +
            'updated, so none were. A line has been deleted, or the increment would have driven ' +
            'its executed quantity below zero — which only happens when the counter has already ' +
            'drifted. Check the project reconciliation.',
          detail: { asked: deltas.length, applied: moved },
        });
      }

      const transitioned = await tx.dailyWorkReport.updateMany({
        where: { id: dwrId, status: DwrStatus.submitted },
        data: {
          status: DwrStatus.approved,
          approvedByUserId: actor.userId,
          approvedAt: new Date(),
        },
      });
      // FR-014a. Two concurrent approvals serialise on this row; the loser sees no rows and throws,
      // rolling its own increments back. The counter moves once.
      if (transitioned.count === 0) {
        throw new ConflictException({
          code: DWR_ERRORS.alreadyApproved,
          message:
            'Somebody else approved this report while you were approving it.',
        });
      }

      return {
        id: dwrId,
        status: DwrStatus.approved,
        selfApproved,
        moved: deltas.map((d) => ({
          boqNo:
            report.tasks.find((t) => t.boqItemId === d.itemId)?.boqItem
              ?.boqNo ?? d.itemId,
          delta: d.delta.toFixed(3),
        })),
      };
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      // `AuditAction` has no APPROVE: the enum is CREATE/UPDATE/DELETE/READ plus login events, and
      // adding a value would change a shared enum for one caller. The entity type and the entry's
      // own timestamp say which transition this was, and `approvedByUserId`/`approvedAt` on the row
      // are the durable record of the approval itself.
      action: AuditAction.UPDATE,
      entityId: dwrId,
      // 025 FR-040. A self-approval is recorded as one. Segregation of duty is the only control on
      // a transition that moves the quantities a bill is built from, so where it is overridden the
      // override has to be visible — an exception nobody can find afterwards is an exception that
      // cannot be reviewed. Written on every approval, not only the overridden ones: a field that
      // appears only when something irregular happened is a field whose absence proves nothing,
      // because absence is also what an older entry looks like.
      changes: { selfApproved: result.selfApproved },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return result;
  }

  /** `submitted` → `draft`. Nothing moves, because submission never moved anything (US3 AC2). */
  async returnToDraft(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    actor: { userId: string; ipAddress?: string },
  ): Promise<{ id: string; status: DwrStatus }> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: { id: true, status: true },
      });
      if (!report) throw new NotFoundException('Daily work report not found');
      assertStatus(report.status, DwrStatus.submitted, 'return to draft');

      await tx.dailyWorkReport.update({
        where: { id: dwrId },
        data: { status: DwrStatus.draft },
      });
      return { id: dwrId, status: DwrStatus.draft };
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.UPDATE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return result;
  }

  /**
   * `approved` → `draft`, taking back **exactly** what the approval added (FR-019 to FR-021).
   *
   * ## What makes this safe, and what it refuses
   *
   * The quantities subtracted are the ones **stored on the lines**, read rather than recomputed —
   * `storedQuantityInForce`, not `quantityInForce`. A measured line's factors may have been edited
   * since, and recomputing from them would subtract a figure the approval never added, leaving the
   * counter wrong in a way nothing would notice.
   *
   * **FR-020 is a floor, not provenance, and the message says so.** Nothing in this schema links a
   * bill line to the measurement it consumed, so "has this report been billed" is not a question
   * the database can answer. What it can answer is whether this reversal would drop a BOQ line's
   * executed quantity below the quantity already billed against it on a bill that has left draft —
   * a client bill that is submitted or certified, or a subcontractor bill that is submitted or
   * approved, including one reaching the line through a work-order award line. That protects the
   * arithmetic rather than the provenance, which is the stronger of the two guarantees and the one
   * available now. Research §4 records what is deferred to feature 023.
   *
   * `approvedAt` and `approvedByUserId` are **not** cleared. The approval happened; erasing it
   * leaves a reversal reason referring to an approval nobody can see.
   */
  async reverse(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    input: ReverseDwrDto,
    actor: { userId: string; ipAddress?: string },
  ): Promise<{ id: string; status: DwrStatus; reversalCount: number }> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: {
          id: true,
          status: true,
          reversalCount: true,
          tasks: {
            select: {
              boqItemId: true,
              paymentMode: true,
              actualQty: true,
              servedQty: true,
              boqItem: { select: { boqNo: true } },
            },
          },
        },
      });
      if (!report) throw new NotFoundException('Daily work report not found');
      assertStatus(report.status, DwrStatus.approved, 'reverse');

      const deltas = groupDeltas(report.tasks);
      await this.assertNotBilledBelow(tx, deltas);

      const moved = await this.boq.applyDoneQtyDeltas(
        tx,
        deltas.map((d) => ({ itemId: d.itemId, delta: d.delta.negated() })),
      );
      if (moved !== deltas.length) {
        // The floor inside the statement refused at least one row (FR-021). Only drift can cause
        // this — a reversal subtracts exactly what its own approval added — so the message says
        // where to look rather than just that something failed.
        throw new ConflictException({
          code: DWR_ERRORS.reversalBelowZero,
          message:
            "Reversing this report would drive at least one BOQ line's executed quantity below " +
            'zero, so nothing was changed. That can only happen if the counter has already ' +
            'drifted from the approved measurement — run the project reconciliation.',
          detail: { asked: deltas.length, applied: moved },
        });
      }

      const updated = await tx.dailyWorkReport.updateMany({
        where: { id: dwrId, status: DwrStatus.approved },
        data: {
          status: DwrStatus.draft,
          reversedAt: new Date(),
          reversedByUserId: actor.userId,
          reversalReason: input.reason.trim(),
          reversalCount: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          code: DWR_ERRORS.wrongStatus,
          message:
            'Somebody else moved this report while you were reversing it.',
        });
      }

      return {
        id: dwrId,
        status: DwrStatus.draft,
        reversalCount: report.reversalCount + 1,
      };
    });

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.UPDATE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return result;
  }

  /** Deletes a draft. A submitted or approved report is refused (FR-023). */
  async remove(
    ctx: RlsContext,
    dwrId: string,
    companyId: string,
    actor: { userId: string; ipAddress?: string },
  ): Promise<void> {
    const refs = await withRlsContext(this.prisma, ctx, async (tx) => {
      const report = await tx.dailyWorkReport.findFirst({
        where: { id: dwrId },
        select: {
          id: true,
          status: true,
          attachments: { select: { fileRef: true } },
        },
      });
      if (!report) throw new NotFoundException('Daily work report not found');

      if (report.status !== DwrStatus.draft) {
        throw new ConflictException({
          code: DWR_ERRORS.wrongStatus,
          message:
            `This report is ${report.status}. Only a draft can be deleted — ` +
            (report.status === DwrStatus.approved
              ? 'reverse it first, which takes its quantities back out and says why.'
              : 'return it to draft first.'),
        });
      }

      await tx.dailyWorkReport.delete({ where: { id: dwrId } });
      return report.attachments.map((a) => a.fileRef);
    });

    // After the transaction, deliberately: a blob deleted inside one that then rolls back is gone
    // while its row survives, which is the worse of the two inconsistencies. `deleteMany` is
    // best-effort and never throws for a missing reference.
    if (refs.length > 0) await this.storage.deleteMany(refs);

    await this.auditLog.record({
      entityType: AuditEntityType.DWR,
      action: AuditAction.DELETE,
      entityId: dwrId,
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
  }

  /**
   * Refuses a reversal that would take a line's executed quantity below what has already been
   * billed against it (FR-020).
   *
   * One query per bill side, both grouped — not one per line. The figures come from the same
   * aggregate 018 composes bills with (`ClientBillLine` grouped by `boqTaskItemId`), which 018
   * research §3 chose over a stored counter precisely so that two implementations could not
   * disagree about one number. A second aggregate here would be that disagreement.
   */
  private async assertNotBilledBelow(
    tx: Prisma.TransactionClient,
    deltas: { itemId: string; delta: Prisma.Decimal }[],
  ): Promise<void> {
    const itemIds = deltas.map((d) => d.itemId);
    if (itemIds.length === 0) return;

    const [current, clientBilled, subBilled] = await Promise.all([
      tx.bOQTaskItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, boqNo: true, doneQty: true },
      }),
      tx.clientBillLine.groupBy({
        by: ['boqTaskItemId'],
        where: {
          boqTaskItemId: { in: itemIds },
          clientBill: { status: { in: ['submitted', 'certified'] } },
        },
        _sum: { quantity: true },
      }),
      tx.rABillLine.groupBy({
        by: ['workOrderBoqItemId'],
        where: {
          workOrderBoqItem: { boqTaskItemId: { in: itemIds } },
          raBill: { status: { in: ['submitted', 'approved'] } },
        },
        _sum: { quantity: true },
      }),
    ]);

    const billed = new Map<string, Prisma.Decimal>();
    for (const row of clientBilled) {
      billed.set(
        row.boqTaskItemId,
        (billed.get(row.boqTaskItemId) ?? new Prisma.Decimal(0)).plus(
          row._sum.quantity ?? 0,
        ),
      );
    }
    if (subBilled.length > 0) {
      const awards = await tx.workOrderBOQItem.findMany({
        where: { id: { in: subBilled.map((r) => r.workOrderBoqItemId) } },
        select: { id: true, boqTaskItemId: true },
      });
      const awardToItem = new Map(awards.map((a) => [a.id, a.boqTaskItemId]));
      for (const row of subBilled) {
        const itemId = awardToItem.get(row.workOrderBoqItemId);
        if (!itemId) continue;
        billed.set(
          itemId,
          (billed.get(itemId) ?? new Prisma.Decimal(0)).plus(
            row._sum.quantity ?? 0,
          ),
        );
      }
    }

    const blocked: { boqNo: string; billed: string; wouldLeave: string }[] = [];
    for (const delta of deltas) {
      const item = current.find((i) => i.id === delta.itemId);
      if (!item) continue;
      const billedQty = billed.get(delta.itemId);
      if (!billedQty || billedQty.isZero()) continue;

      const wouldLeave = item.doneQty.minus(delta.delta);
      if (wouldLeave.lessThan(billedQty)) {
        blocked.push({
          boqNo: item.boqNo,
          billed: billedQty.toFixed(3),
          wouldLeave: wouldLeave.toFixed(3),
        });
      }
    }

    if (blocked.length > 0) {
      throw new ConflictException({
        code: DWR_ERRORS.measurementBilled,
        message:
          `Reversing this report would leave ${blocked.length} BOQ line(s) with less executed ` +
          'quantity than has already been billed against them on a bill that has left draft. ' +
          'Revise the bill first. (This checks the totals, not which bill line consumed which ' +
          'report — nothing in the data records that, so it cannot be checked.)',
        detail: { lines: blocked },
      });
    }
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
        isEstimate: true,
        group: { select: { projectId: true, isEstimate: true } },
      },
    });

    const found = new Map<string, BoqItemForLine>();
    const foreign: { boqItemId: string; belongsToProjectId: string }[] = [];
    const costing: { boqItemId: string; boqNo: string }[] = [];

    for (const item of items) {
      if (item.group.projectId !== projectId) {
        foreign.push({
          boqItemId: item.id,
          belongsToProjectId: item.group.projectId,
        });
        continue;
      }
      // The costing schedule, not the contract one. Checked on both the line and its section
      // because the estimate import sets both, and a line moved between them must not slip through.
      if (item.isEstimate || item.group.isEstimate) {
        costing.push({ boqItemId: item.id, boqNo: item.boqNo });
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

    if (costing.length > 0) {
      // Named by BOQ number, because the costing line and the contract line it twins are the same
      // sentence in a picker — "one of your lines is wrong" leaves somebody comparing two schedules
      // of 231 rows each.
      throw new BadRequestException({
        code: DWR_ERRORS.boqItemIsEstimate,
        message:
          `${costing.length} measured line(s) reference the internal estimate rather than the ` +
          'contract schedule: ' +
          costing.map((line) => line.boqNo).join(', ') +
          '. Work recorded against a costing line is never billed and never appears in progress. ' +
          'Pick the same item from the contract schedule.',
        detail: { reportingProjectId: projectId, lines: costing },
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

/**
 * Sums a report's lines into one delta per BOQ line (FR-015).
 *
 * Grouped rather than applied per line, for two reasons that happen to coincide: one statement
 * instead of many (research §8), and a report measuring the same BOQ line twice — two stretches of
 * one item, which the client's sheets do — must move the counter by the total rather than racing
 * itself. Lines referencing no BOQ line are dropped here, which is FR-007's "moves nothing".
 */
function groupDeltas(
  tasks: {
    boqItemId: string | null;
    paymentMode: DwrPaymentMode;
    actualQty: Prisma.Decimal | null;
    servedQty: Prisma.Decimal | null;
  }[],
): { itemId: string; delta: Prisma.Decimal }[] {
  const totals = new Map<string, Prisma.Decimal>();

  for (const task of tasks) {
    if (!task.boqItemId) continue;
    // Read, never recomputed. A reversal must subtract exactly what its approval added, and a
    // measured line's factors may have been edited in between.
    const quantity = storedQuantityInForce(task);
    totals.set(
      task.boqItemId,
      (totals.get(task.boqItemId) ?? new Prisma.Decimal(0)).plus(quantity),
    );
  }

  return [...totals].map(([itemId, delta]) => ({ itemId, delta }));
}

/** Refuses a transition from the wrong status, naming the status the report is actually in. */
function assertStatus(
  actual: DwrStatus,
  required: DwrStatus,
  action: string,
): void {
  if (actual === required) return;
  throw new ConflictException({
    code: DWR_ERRORS.wrongStatus,
    message: `This report is ${actual}, so it cannot ${action}. It must be ${required}.`,
  });
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
