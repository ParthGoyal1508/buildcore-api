import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  EquipmentOwnership,
  EquipmentStatus,
  MeterType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TARGET_HOURS_PER_MONTH,
  EQUIPMENT_CODE_INFIX,
  MAX_DOCUMENT_BYTES,
  MAX_PAGE_SIZE,
  SERVICE_DUE_SOON_MARGIN,
} from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  CreateEquipmentDto,
  ListEquipmentDto,
  UpdateEquipmentDto,
  UploadEquipmentDocumentDto,
} from './dto/equipment.dto';

export interface EquipmentDocumentView {
  id: string;
  docTypeId: string;
  docTypeName: string;
  fileName: string | null;
  expiresAt: Date | null;
  /** True when this document is inside its own type's alert window, or already
   * lapsed. Computed, never stored — a stored flag is wrong the day after it is
   * written. */
  expiring: boolean;
  expired: boolean;
  uploadedAt: Date;
}

export interface EquipmentRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  categoryId: string;
  categoryName: string;
  ownership: EquipmentOwnership;
  vendorId: string | null;
  vendorName: string | null;
  powerSource: string;
  meterType: MeterType;
  currentReading: number;
  deployedSiteId: string | null;
  siteName: string | null;
  status: EquipmentStatus;
  utilizationPercent: number;
  purchaseDate: Date | null;
  purchaseCost: number | null;
  depreciationRate: number | null;
  /** SC-001: the register answers "is any paperwork about to lapse?" in the same
   * response as the list, with no second call. */
  expiryAlert: boolean;
  alertDocumentTypes: string[];
  createdAt: Date;
}

export interface EquipmentDetail extends EquipmentRow {
  documents: EquipmentDocumentView[];
  serviceSchedules: {
    id: string;
    serviceType: string;
    intervalHours: number | null;
    intervalKm: number | null;
    lastDoneReading: number;
    nextDueReading: number;
    status: 'ok' | 'due_soon' | 'overdue';
  }[];
  openMaintenanceJobId: string | null;
}

type EquipmentWithDocs = Prisma.EquipmentGetPayload<{
  include: { documents: true };
}>;

/** Midnight today, in the server's own zone — the reference point every expiry
 * comparison uses. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The asset register (006 US2).
 *
 * Two things here are worth knowing before reading the code:
 *
 * 1. `expiryAlert` is computed on read from each document's *own* doc type's
 *    `alertDays` (FR-010). The original spec hardcoded 30 days for everything;
 *    research.md §10 corrected it, and the correction is why this service resolves
 *    doc types in a batch rather than comparing against a constant.
 *
 * 2. `status` cannot be set to `under_maintenance` through this service at all
 *    (FR-002). That value belongs to the maintenance job lifecycle, and letting a
 *    PATCH set it would let the register and the job list disagree about whether a
 *    machine is down.
 */
@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly codeSeries: CodeSeriesService,
    private readonly storage: StorageService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async findAll(
    caller: AuthenticatedUser,
    query: ListEquipmentDto,
  ): Promise<{
    items: EquipmentRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.EquipmentWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.siteId ? { deployedSiteId: query.siteId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.ownership ? { ownership: query.ownership } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.equipment.findMany({
            where,
            orderBy: { code: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { documents: true },
          }),
          tx.equipment.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const items = await this.decorate(caller, rows);
    return { items, total, page, pageSize };
  }

  async findOne(
    caller: AuthenticatedUser,
    equipmentId: string,
  ): Promise<EquipmentDetail> {
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { id: equipmentId },
          include: { documents: true },
        });
        if (!equipment) throw new NotFoundException('Equipment not found');
        assertInScope(caller, equipment, 'Equipment');

        const [schedules, openJob] = await Promise.all([
          tx.serviceSchedule.findMany({
            where: { equipmentId },
            orderBy: { nextDueReading: 'asc' },
          }),
          tx.maintenanceJob.findFirst({
            where: { equipmentId, status: 'open' },
            select: { id: true },
          }),
        ]);
        return { equipment, schedules, openJob };
      },
    );

    const [row] = await this.decorate(caller, [found.equipment]);
    const docTypes = await this.refs.docTypesByIds(
      caller,
      found.equipment.documents.map((document) => document.docTypeId),
    );
    const today = startOfToday();
    const currentReading = Number(found.equipment.currentReading);

    return {
      ...row,
      documents: found.equipment.documents.map((document) => {
        const docType = docTypes.get(document.docTypeId);
        return {
          id: document.id,
          docTypeId: document.docTypeId,
          docTypeName: docType?.name ?? 'Unknown type',
          fileName: document.fileName,
          expiresAt: document.expiresAt,
          expiring: this.isExpiring(
            document.expiresAt,
            docType?.alertDays ?? 0,
            today,
          ),
          expired: document.expiresAt !== null && document.expiresAt < today,
          uploadedAt: document.uploadedAt,
        };
      }),
      serviceSchedules: found.schedules.map((schedule) => ({
        id: schedule.id,
        serviceType: schedule.serviceType,
        intervalHours:
          schedule.intervalHours === null
            ? null
            : Number(schedule.intervalHours),
        intervalKm:
          schedule.intervalKm === null ? null : Number(schedule.intervalKm),
        lastDoneReading: Number(schedule.lastDoneReading),
        nextDueReading: Number(schedule.nextDueReading),
        status: serviceScheduleStatus(
          currentReading,
          Number(schedule.nextDueReading),
        ),
      })),
      openMaintenanceJobId: found.openJob?.id ?? null,
    };
  }

  /**
   * True when a document is inside its type's alert window, or has already lapsed.
   *
   * A lapsed document counts: the point of the flag is "this needs attention", and
   * a certificate that expired last week needs more of it than one expiring next
   * week, not less.
   */
  private isExpiring(
    expiresAt: Date | null,
    alertDays: number,
    today: Date,
  ): boolean {
    if (expiresAt === null) return false;
    const threshold = new Date(today);
    threshold.setDate(threshold.getDate() + alertDays);
    return expiresAt <= threshold;
  }

  /** Resolves the cross-module names and computes `expiryAlert` for a page of
   * rows — one lookup per reference kind for the whole page, never per row. */
  private async decorate(
    caller: AuthenticatedUser,
    rows: EquipmentWithDocs[],
  ): Promise<EquipmentRow[]> {
    if (rows.length === 0) return [];

    const [categories, siteNames, vendorNames, docTypes] = await Promise.all([
      this.refs.categoriesByIds(
        caller,
        rows.map((row) => row.categoryId),
      ),
      this.refs.siteNames(
        caller,
        rows.flatMap((row) => (row.deployedSiteId ? [row.deployedSiteId] : [])),
      ),
      this.refs.vendorNames(
        caller,
        rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
      ),
      this.refs.docTypesByIds(
        caller,
        rows.flatMap((row) => row.documents.map((doc) => doc.docTypeId)),
      ),
    ]);

    const today = startOfToday();

    return rows.map((row) => {
      const alerting = row.documents.filter((document) =>
        this.isExpiring(
          document.expiresAt,
          docTypes.get(document.docTypeId)?.alertDays ?? 0,
          today,
        ),
      );
      return {
        id: row.id,
        companyId: row.companyId,
        code: row.code,
        name: row.name,
        categoryId: row.categoryId,
        categoryName:
          categories.get(row.categoryId)?.name ?? 'Unknown category',
        ownership: row.ownership,
        vendorId: row.vendorId,
        vendorName: row.vendorId
          ? vendorNames.get(row.vendorId) ?? 'Unknown vendor'
          : null,
        powerSource: row.powerSource,
        meterType: row.meterType,
        currentReading: Number(row.currentReading),
        deployedSiteId: row.deployedSiteId,
        siteName: row.deployedSiteId
          ? siteNames.get(row.deployedSiteId) ?? 'Unknown site'
          : null,
        status: row.status,
        utilizationPercent: Number(row.utilizationPercent),
        purchaseDate: row.purchaseDate,
        purchaseCost:
          row.purchaseCost === null ? null : Number(row.purchaseCost),
        depreciationRate:
          row.depreciationRate === null ? null : Number(row.depreciationRate),
        expiryAlert: alerting.length > 0,
        alertDocumentTypes: [
          ...new Set(
            alerting.map(
              (document) =>
                docTypes.get(document.docTypeId)?.name ?? 'Unknown type',
            ),
          ),
        ],
        createdAt: row.createdAt,
      };
    });
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(
    caller: AuthenticatedUser,
    dto: CreateEquipmentDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<EquipmentRow> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const category = await this.refs.requireCategory(
      caller,
      dto.categoryId,
      companyId,
    );

    if (dto.ownership === EquipmentOwnership.hired && !dto.vendorId) {
      throw new BadRequestException(
        'A hired machine needs a vendorId — otherwise there is nobody to raise a hire bill against.',
      );
    }
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);
    if (dto.deployedSiteId) {
      await this.refs.requireSiteName(caller, dto.deployedSiteId, companyId);
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const code =
          dto.code?.trim() ||
          (await this.codeSeries.next(
            tx,
            companyId,
            CodeSeriesType.EQUIPMENT,
            EQUIPMENT_CODE_INFIX,
          ));

        const clash = await tx.equipment.findFirst({
          where: { companyId, code },
        });
        if (clash) {
          throw new ConflictException(
            `Equipment code ${code} is already in use in this company.`,
          );
        }

        return tx.equipment.create({
          data: {
            companyId,
            code,
            name: dto.name.trim(),
            categoryId: dto.categoryId,
            ownership: dto.ownership,
            vendorId: dto.vendorId ?? null,
            powerSource: dto.powerSource,
            purchaseDate: dto.purchaseDate
              ? this.refs.parseDate(dto.purchaseDate)
              : null,
            purchaseCost: dto.purchaseCost ?? null,
            depreciationRate: dto.depreciationRate ?? null,
            // Copied from the category rather than joined at read time: changing a
            // category's meter type must not silently reinterpret readings already
            // recorded against machines under it.
            meterType: category.meterType,
            currentReading: dto.currentReading ?? 0,
            deployedSiteId: dto.deployedSiteId ?? null,
          },
          include: { documents: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes: { code: created.code, name: created.name },
    });

    const [row] = await this.decorate(caller, [created]);
    return row;
  }

  async update(
    caller: AuthenticatedUser,
    equipmentId: string,
    dto: UpdateEquipmentDto,
    ipAddress: string,
  ): Promise<EquipmentRow> {
    // FR-002. Checked before anything else so the refusal is about the intent, not
    // about whichever validation happened to run first.
    if (dto.status === EquipmentStatus.under_maintenance) {
      throw new BadRequestException(
        'A machine is put under maintenance by opening a maintenance job, not by ' +
          'editing its status — otherwise the register and the job list can disagree.',
      );
    }

    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.equipment.findUnique({ where: { id: equipmentId } }),
    );
    if (!existing) throw new NotFoundException('Equipment not found');
    assertInScope(caller, existing, 'Equipment');

    if (dto.categoryId) {
      await this.refs.requireCategory(
        caller,
        dto.categoryId,
        existing.companyId,
      );
    }
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);
    if (dto.deployedSiteId) {
      await this.refs.requireSiteName(
        caller,
        dto.deployedSiteId,
        existing.companyId,
      );
    }

    // Leaving `under_maintenance` by editing the row is refused for the same reason
    // entering it is: the job is what owns the transition.
    if (
      dto.status !== undefined &&
      existing.status === EquipmentStatus.under_maintenance
    ) {
      throw new ConflictException(
        'This machine has an open maintenance job. Close the job to return it to service.',
      );
    }

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipment.update({
          where: { id: equipmentId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.categoryId !== undefined
              ? { categoryId: dto.categoryId }
              : {}),
            ...(dto.ownership !== undefined
              ? { ownership: dto.ownership }
              : {}),
            ...(dto.vendorId !== undefined ? { vendorId: dto.vendorId } : {}),
            ...(dto.powerSource !== undefined
              ? { powerSource: dto.powerSource }
              : {}),
            ...(dto.purchaseDate !== undefined
              ? { purchaseDate: this.refs.parseDate(dto.purchaseDate) }
              : {}),
            ...(dto.purchaseCost !== undefined
              ? { purchaseCost: dto.purchaseCost }
              : {}),
            ...(dto.depreciationRate !== undefined
              ? { depreciationRate: dto.depreciationRate }
              : {}),
            ...(dto.deployedSiteId !== undefined
              ? { deployedSiteId: dto.deployedSiteId }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          },
          include: { documents: true },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.UPDATE,
      entityId: equipmentId,
      accountId: caller.id,
      companyId: existing.companyId,
      ipAddress,
      changes: { ...dto },
    });

    const [row] = await this.decorate(caller, [updated]);
    return row;
  }

  async uploadDocument(
    caller: AuthenticatedUser,
    equipmentId: string,
    dto: UploadEquipmentDocumentDto,
    ipAddress: string,
  ): Promise<EquipmentDocumentView> {
    const equipment = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.equipment.findUnique({ where: { id: equipmentId } }),
    );
    if (!equipment) throw new NotFoundException('Equipment not found');
    assertInScope(caller, equipment, 'Equipment');

    const docType = await this.refs.requireDocType(
      caller,
      dto.docTypeId,
      equipment.companyId,
    );

    // TODO(VIRUS_SCAN): uploads are stored unscanned, the same gap 005's employee
    // and 007's contractor documents carry. The scan belongs between decoding and
    // `storage.put`, and is left explicit rather than faked — a no-op scanner reads
    // as protection that is not there.
    const buffer = Buffer.from(dto.file, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('file must be non-empty base64 content.');
    }
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(
        `file exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit.`,
      );
    }

    const fileRef = await this.storage.put(
      'equipment-documents',
      buffer,
      dto.contentType ?? 'application/octet-stream',
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDocument.create({
          data: {
            companyId: equipment.companyId,
            equipmentId,
            docTypeId: dto.docTypeId,
            fileRef,
            fileName: dto.fileName ?? null,
            mimeType: dto.contentType ?? null,
            expiresAt: dto.expiresAt
              ? this.refs.parseDate(dto.expiresAt)
              : null,
            uploadedByUserId: caller.id,
          },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_DOCUMENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: equipment.companyId,
      ipAddress,
      changes: { equipmentId, docType: docType.name },
    });

    const today = startOfToday();
    return {
      id: created.id,
      docTypeId: created.docTypeId,
      docTypeName: docType.name,
      fileName: created.fileName,
      expiresAt: created.expiresAt,
      expiring: this.isExpiring(created.expiresAt, docType.alertDays, today),
      expired: created.expiresAt !== null && created.expiresAt < today,
      uploadedAt: created.uploadedAt,
    };
  }

  /** Streams a stored document back, for the register's download control. */
  async downloadDocument(
    caller: AuthenticatedUser,
    equipmentId: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    const document = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDocument.findFirst({
          where: { id: documentId, equipmentId },
        }),
    );
    if (!document) throw new NotFoundException('Document not found');
    assertInScope(caller, document, 'Document');

    return {
      buffer: await this.storage.get(document.fileRef),
      fileName: document.fileName ?? `${documentId}.bin`,
      contentType: document.mimeType ?? 'application/octet-stream',
    };
  }

  async deleteDocument(
    caller: AuthenticatedUser,
    equipmentId: string,
    documentId: string,
    ipAddress: string,
  ): Promise<void> {
    const document = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDocument.findFirst({
          where: { id: documentId, equipmentId },
        }),
    );
    if (!document) throw new NotFoundException('Document not found');
    assertInScope(caller, document, 'Document');

    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentDocument.delete({ where: { id: documentId } }),
    );
    // Blob removal after the row, never before: an orphaned blob is a cleanup job,
    // an orphaned row is a broken download.
    await this.storage.delete(document.fileRef).catch(() => undefined);

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_DOCUMENT,
      action: AuditAction.DELETE,
      entityId: documentId,
      accountId: caller.id,
      companyId: document.companyId,
      ipAddress,
    });
  }

  /**
   * How many machines sit under each of the given categories.
   *
   * Lives here rather than on `EquipmentCategoriesService` for the reason the
   * delete guard below does: counting `plant.Equipment` from a `settings` service is
   * the cross-schema query Principle I forbids.
   */
  async countByCategory(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    if (categoryIds.length === 0) return new Map();
    const grouped = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipment.groupBy({
          by: ['categoryId'],
          where: { categoryId: { in: categoryIds }, ...companyScope(caller) },
          _count: { _all: true },
        }),
    );
    return new Map(grouped.map((row) => [row.categoryId, row._count._all]));
  }

  /**
   * The delete guard `EquipmentCategoriesService` cannot run itself.
   *
   * Counting `plant.Equipment` from a `settings` service is the cross-schema query
   * Principle I forbids, so the plant side answers it — the same split
   * `InventoryItemsService` makes for item deletion.
   */
  async assertCategoryUnused(
    caller: AuthenticatedUser,
    categoryId: string,
  ): Promise<void> {
    const count = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.equipment.count({ where: { categoryId } }),
    );
    if (count > 0) {
      throw new ConflictException(
        `This category has ${count} machine(s) registered against it. ` +
          'Retire it instead so their history still resolves a category name.',
      );
    }
  }

  /**
   * Lifetime maintenance cost for one machine, split three ways (FR-026).
   *
   * Parts, internal labour and third-party service bills are separated because they
   * are three different decisions: what the stores issued, what the workshop spent
   * its own hours on, and what was paid outside. A single total hides which of the
   * three is growing.
   */
  async maintenanceCost(
    caller: AuthenticatedUser,
    equipmentId: string,
  ): Promise<{
    equipmentId: string;
    partsCost: number;
    labourCost: number;
    serviceBillCost: number;
    totalCost: number;
    jobCount: number;
  }> {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const equipment = await tx.equipment.findUnique({
        where: { id: equipmentId },
      });
      if (!equipment) throw new NotFoundException('Equipment not found');
      assertInScope(caller, equipment, 'Equipment');

      const jobs = await tx.maintenanceJob.findMany({
        where: { equipmentId },
        select: { id: true, partsCost: true, labourCost: true },
      });
      const jobIds = jobs.map((job) => job.id);

      // Only verified bills count. An unverified invoice is a claim, not a cost —
      // the same rule the P&L applies to hire bills.
      const bills =
        jobIds.length === 0
          ? []
          : await tx.serviceBill.findMany({
              where: {
                maintenanceJobId: { in: jobIds },
                status: 'verified',
                deletedAt: null,
              },
              select: { netPayable: true },
            });

      const partsCost = jobs.reduce(
        (sum, job) => sum + Number(job.partsCost),
        0,
      );
      const labourCost = jobs.reduce(
        (sum, job) => sum + Number(job.labourCost ?? 0),
        0,
      );
      const serviceBillCost = bills.reduce(
        (sum, bill) => sum + Number(bill.netPayable),
        0,
      );

      return {
        equipmentId,
        partsCost,
        labourCost,
        serviceBillCost,
        totalCost: partsCost + labourCost + serviceBillCost,
        jobCount: jobs.length,
      };
    });
  }

  /**
   * Recomputes and stores utilisation % for the calendar month a logbook entry
   * falls in (FR-007).
   *
   * Called from `LogbookService` inside its own transaction. Stored rather than
   * derived because the register lists 500 machines with a utilisation column and
   * deriving it would mean 500 aggregates per page; recomputed on write because
   * logbook entries are the only thing that can change it (research.md §6).
   *
   * Only the *current* month is stored — the column is "how is this machine doing
   * now", not a history. An entry backdated into a previous month therefore updates
   * nothing, which is correct: it should not restate this month's figure.
   */
  async recomputeUtilisation(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    equipmentId: string,
    categoryTargetHours: number,
  ): Promise<number> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const aggregate = await tx.logbookEntry.aggregate({
      where: { equipmentId, date: { gte: monthStart } },
      _sum: { totalHours: true },
    });

    const target = categoryTargetHours || DEFAULT_TARGET_HOURS_PER_MONTH;
    const hours = Number(aggregate._sum.totalHours ?? 0);
    const percent = Math.round((hours / target) * 100 * 100) / 100;

    await tx.equipment.update({
      where: { id: equipmentId },
      data: { utilizationPercent: percent },
    });
    return percent;
  }
}

/**
 * A service schedule's status, derived from the machine's current reading
 * (FR-006, research.md §4).
 *
 * Exported because `ServiceScheduleService` needs the same derivation and two
 * copies of a threshold comparison is how the register and the schedule list end up
 * disagreeing about whether a service is due.
 */
export function serviceScheduleStatus(
  currentReading: number,
  nextDueReading: number,
): 'ok' | 'due_soon' | 'overdue' {
  if (currentReading >= nextDueReading) return 'overdue';
  if (nextDueReading - currentReading <= SERVICE_DUE_SOON_MARGIN) {
    return 'due_soon';
  }
  return 'ok';
}
