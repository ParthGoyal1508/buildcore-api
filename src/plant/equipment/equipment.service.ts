import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EquipmentOwnership,
  EquipmentStatus,
  MeterType,
  Prisma,
  RegistrationKind,
  RegistrationStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { DISPOSED_STATUSES } from '../disposal/in-service';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  DOCUMENT_TYPES,
} from '../../common/uploads';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TARGET_HOURS_PER_MONTH,
  MAX_PAGE_SIZE,
  REGISTRATION_PAPERS,
  SERVICE_DUE_SOON_MARGIN,
} from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import {
  namedCode,
  namedPrefixFor,
  namedSerialOf,
} from '../../settings/code-series/code-series.formats';
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

/** One registration paper as the register prints it (2026-10-15). */
export interface RegistrationPaperView {
  kind: RegistrationKind;
  status: RegistrationStatus;
  expiresAt: Date | null;
  number: string | null;
  /** Whether a document of the matching type has been uploaded — the register's "Doc" column. */
  hasDocument: boolean;
}

/**
 * Which registration paper a document type is, by its name — "INSURANCE" is insurance,
 * "POLLUTION CERTIFICATE" or "PUC" is pollution. Whole words, so "RC" never matches inside
 * another word.
 */
export function paperOfDocType(name: string): RegistrationKind | null {
  const upper = name.toUpperCase();
  const words = upper.split(/[^A-Z]+/).filter(Boolean);
  for (const paper of REGISTRATION_PAPERS) {
    const hit = paper.docWords.some((word) =>
      word.includes(' ') ? upper.includes(word) : words.includes(word),
    );
    if (hit) return paper.kind as RegistrationKind;
  }
  return null;
}

export interface EquipmentRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  manufacturingYear: number | null;
  make: string | null;
  model: string | null;
  registrationNo: string | null;
  engineNo: string | null;
  chassisNo: string | null;
  supplierName: string | null;
  registeredOwner: string | null;
  operatorName: string | null;
  remarks: string | null;
  lastServiceDate: Date | null;
  /** The six papers of the vehicle register, in its column order; a kind never recorded is absent. */
  registration: RegistrationPaperView[];
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
  /** The main photo (036 K14), or null for the placeholder. Its thumbnail is
   * `GET :id/photos/:mainPhotoId?size=thumb`. */
  mainPhotoId: string | null;
  createdAt: Date;
}

/** One photo in a machine's gallery (036 K14). */
export interface EquipmentPhotoView {
  id: string;
  isMain: boolean;
  fileName: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  uploadedAt: Date;
}

export interface EquipmentDetail extends EquipmentRow {
  documents: EquipmentDocumentView[];
  /** Main photo first, then newest first. */
  photos: EquipmentPhotoView[];
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
  include: {
    documents: true;
    registration: true;
    photos: { where: { isMain: true }; select: { id: true } };
  };
}>;

/** The main photo rides along as an id only (036 K14) — the list loads its thumbnail by id. */
const WITH_DOCS = {
  documents: true,
  registration: true,
  photos: { where: { isMain: true }, select: { id: true } },
} as const;

/** How far ahead a registration paper's expiry alerts — the register's amber window. */
const PAPER_ALERT_DAYS = 30;

export function toPhotoView(photo: {
  id: string;
  isMain: boolean;
  fileName: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  uploadedAt: Date;
}): EquipmentPhotoView {
  return {
    id: photo.id,
    isMain: photo.isMain,
    fileName: photo.fileName,
    width: photo.width,
    height: photo.height,
    sizeBytes: photo.sizeBytes,
    uploadedAt: photo.uploadedAt,
  };
}

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
    private readonly storage: StorageService,
    private readonly codeSeries: CodeSeriesService,
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
      // Scrapped and sold machines appear only when asked for by status (2026-10-17).
      ...(query.status
        ? { status: query.status }
        : { status: { notIn: DISPOSED_STATUSES } }),
      ...(query.ownership ? { ownership: query.ownership } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              {
                registrationNo: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
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
            include: WITH_DOCS,
          }),
          tx.equipment.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const items = await this.decorate(caller, rows);
    return { items, total, page, pageSize };
  }

  /**
   * Every machine matching the filters, unpaged — for the vehicle register download (2026-10-15),
   * which prints the whole fleet on one sheet. Same filters and order as the paged list.
   */
  async findEvery(
    caller: AuthenticatedUser,
    query: Omit<ListEquipmentDto, 'page' | 'pageSize'>,
  ): Promise<EquipmentRow[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipment.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
            ...(query.siteId ? { deployedSiteId: query.siteId } : {}),
            // Scrapped and sold machines appear only when asked for by status (2026-10-17).
            ...(query.status
              ? { status: query.status }
              : { status: { notIn: DISPOSED_STATUSES } }),
            ...(query.ownership ? { ownership: query.ownership } : {}),
          },
          orderBy: { code: 'asc' },
          include: WITH_DOCS,
        }),
    );
    return this.decorate(caller, rows);
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
          include: WITH_DOCS,
        });
        if (!equipment) throw new NotFoundException('Equipment not found');
        assertInScope(caller, equipment, 'Equipment');

        const [schedules, openJob, photos] = await Promise.all([
          tx.serviceSchedule.findMany({
            where: { equipmentId },
            orderBy: { nextDueReading: 'asc' },
          }),
          tx.maintenanceJob.findFirst({
            where: { equipmentId, status: 'open' },
            select: { id: true },
          }),
          tx.equipmentPhoto.findMany({
            where: { equipmentId },
            orderBy: [{ isMain: 'desc' }, { uploadedAt: 'desc' }],
          }),
        ]);
        return { equipment, schedules, openJob, photos };
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
      photos: found.photos.map(toPhotoView),
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
      const lapsingPapers = row.registration.flatMap((item) =>
        item.status === RegistrationStatus.held &&
        item.expiresAt &&
        this.isExpiring(item.expiresAt, PAPER_ALERT_DAYS, today)
          ? [
              REGISTRATION_PAPERS.find((paper) => paper.kind === item.kind)
                ?.label ?? item.kind,
            ]
          : [],
      );
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
        manufacturingYear: row.manufacturingYear,
        make: row.make,
        model: row.model,
        registrationNo: row.registrationNo,
        engineNo: row.engineNo,
        chassisNo: row.chassisNo,
        supplierName: row.supplierName,
        registeredOwner: row.registeredOwner,
        operatorName: row.operatorName,
        remarks: row.remarks,
        lastServiceDate: row.lastServiceDate,
        registration: this.papersOf(row, docTypes),
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
        // A registration paper lapsing within 30 days, or lapsed, alerts as an expiring
        // document does (2026-10-15) — the register shades the same dates.
        expiryAlert: alerting.length > 0 || lapsingPapers.length > 0,
        alertDocumentTypes: [
          ...new Set([
            ...alerting.map(
              (document) =>
                docTypes.get(document.docTypeId)?.name ?? 'Unknown type',
            ),
            ...lapsingPapers,
          ]),
        ],
        mainPhotoId: row.photos[0]?.id ?? null,
        createdAt: row.createdAt,
      };
    });
  }

  /** The register's six papers for a machine, with the "Doc" column read off its uploads. */
  private papersOf(
    row: EquipmentWithDocs,
    docTypes: Map<string, { name: string }>,
  ): RegistrationPaperView[] {
    const uploaded = new Set(
      row.documents.flatMap((document) => {
        const kind = paperOfDocType(
          docTypes.get(document.docTypeId)?.name ?? '',
        );
        return kind ? [kind] : [];
      }),
    );
    const byKind = new Map(row.registration.map((item) => [item.kind, item]));
    return REGISTRATION_PAPERS.flatMap((paper) => {
      const kind = paper.kind as RegistrationKind;
      const item = byKind.get(kind);
      if (!item && !uploaded.has(kind)) return [];
      return [
        {
          kind,
          status: item?.status ?? RegistrationStatus.held,
          expiresAt: item?.expiresAt ?? null,
          number: item?.number ?? null,
          hasDocument: uploaded.has(kind),
        },
      ];
    });
  }

  /** The registration details of a create or update, as columns. Undefined keys are left alone. */
  private detailsOf(dto: UpdateEquipmentDto) {
    const text = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() || null;
    const data = {
      make: text(dto.make),
      model: text(dto.model),
      registrationNo:
        dto.registrationNo === undefined
          ? undefined
          : dto.registrationNo.trim().toUpperCase() || null,
      engineNo: text(dto.engineNo),
      chassisNo: text(dto.chassisNo),
      supplierName: text(dto.supplierName),
      registeredOwner: text(dto.registeredOwner),
      operatorName: text(dto.operatorName),
      remarks: text(dto.remarks),
      lastServiceDate:
        dto.lastServiceDate === undefined
          ? undefined
          : dto.lastServiceDate
          ? this.refs.parseDate(dto.lastServiceDate)
          : null,
    };
    return Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );
  }

  /** Writes the papers given, one row per kind; kinds not given are left as they are. */
  private async writeRegistration(
    tx: Prisma.TransactionClient,
    companyId: string,
    equipmentId: string,
    items: UpdateEquipmentDto['registration'],
  ): Promise<void> {
    for (const item of items ?? []) {
      // Not applicable and life-time papers have no expiry to remember.
      const expiresAt =
        item.status === RegistrationStatus.held && item.expiresAt
          ? this.refs.parseDate(item.expiresAt)
          : null;
      const data = {
        status: item.status,
        expiresAt,
        number: item.number?.trim() || null,
      };
      await tx.equipmentRegistrationItem.upsert({
        where: { equipmentId_kind: { equipmentId, kind: item.kind } },
        create: { companyId, equipmentId, kind: item.kind, ...data },
        update: data,
      });
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * The next code for a machine of this name: `JCB01/2027` (2026-10-11).
   *
   * The serial counts **per prefix**, not per company, so JCB01 and TM01 coexist. That
   * is why this does not use `CodeSeriesService`, whose counter is keyed by company and
   * series and would have given the second machine JCB02 only if it were also a JCB.
   *
   * Derived from what is already stored rather than from a counter row: the highest
   * serial currently in use under this prefix, plus one. No new table, no new
   * migration, and the register stays the single source of truth for what is taken.
   *
   * ponytail: a MAX over the prefix's rows, not a counter — two simultaneous
   * registrations of the same machine type can both read the same high-water mark. The
   * loser hits the `@@unique([companyId, code])` clash the caller below already reports
   * as a 409, and registering a machine is a deliberate, infrequent act at a desk. Move
   * to a `(companyId, prefix)` counter table if that 409 is ever actually seen.
   */
  private async nextEquipmentCode(
    tx: Prisma.TransactionClient,
    companyId: string,
    name: string,
    year: number,
  ): Promise<string> {
    // The serial width and separator the company set in Settings → Numbering (2026-10-15).
    const format = await this.codeSeries.namedFormat(
      tx,
      companyId,
      'EQUIPMENT',
    );
    const prefix = namedPrefixFor(name);
    // `startsWith` narrows in the database; `serialOf` is what decides, because the
    // prefix alone would let `TMX-44` — a plate number somebody typed — move TM's
    // series, and would count `TM01/2024` towards `T`.
    const existing = await tx.equipment.findMany({
      where: { companyId, code: { startsWith: prefix } },
      select: { code: true },
    });
    const highest = existing.reduce(
      (max, row) => Math.max(max, namedSerialOf(format, row.code, prefix) ?? 0),
      0,
    );
    return namedCode(format, prefix, highest + 1, year);
  }

  /**
   * The code a machine would be given, for the registration form to show before saving
   * (2026-10-15) — a preview, drawn again on save.
   */
  async nextCode(
    caller: AuthenticatedUser,
    name: string,
    year: number | null,
    requestedCompanyId?: string,
  ): Promise<{ code: string }> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => ({
      code: await this.nextEquipmentCode(
        tx,
        companyId,
        name,
        year ?? new Date().getFullYear(),
      ),
    }));
  }

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
        const manufacturingYear =
          dto.manufacturingYear ??
          (dto.purchaseDate
            ? this.refs.parseDate(dto.purchaseDate).getFullYear()
            : new Date().getFullYear());

        // Always built, never typed (2026-10-15): the client's "aise rahenga automatically".
        const code = await this.nextEquipmentCode(
          tx,
          companyId,
          dto.name,
          manufacturingYear,
        );

        const clash = await tx.equipment.findFirst({
          where: { companyId, code },
        });
        if (clash) {
          throw new ConflictException(
            `Equipment code ${code} is already in use in this company.`,
          );
        }

        const machine = await tx.equipment.create({
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
            manufacturingYear: dto.manufacturingYear ?? null,
            depreciationRate: dto.depreciationRate ?? null,
            // Copied from the category rather than joined at read time: changing a
            // category's meter type must not silently reinterpret readings already
            // recorded against machines under it.
            meterType: category.meterType,
            currentReading: dto.currentReading ?? 0,
            deployedSiteId: dto.deployedSiteId ?? null,
            ...this.detailsOf(dto),
          },
        });
        await this.writeRegistration(
          tx,
          companyId,
          machine.id,
          dto.registration,
        );
        // The master list's "Service Schedule": a periodic service from today's reading.
        if (dto.serviceInterval) {
          const reading = dto.currentReading ?? 0;
          await tx.serviceSchedule.create({
            data: {
              companyId,
              equipmentId: machine.id,
              serviceType: 'Periodic service',
              ...(category.meterType === MeterType.km
                ? { intervalKm: dto.serviceInterval }
                : { intervalHours: dto.serviceInterval }),
              lastDoneReading: reading,
              nextDueReading: reading + dto.serviceInterval,
            },
          });
        }
        return tx.equipment.findUniqueOrThrow({
          where: { id: machine.id },
          include: WITH_DOCS,
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
    if (dto.status && DISPOSED_STATUSES.includes(dto.status)) {
      throw new BadRequestException(
        'A machine is scrapped or sold through Dispose, which records who approved it and why.',
      );
    }
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

    // A disposed machine is out of service until the disposal is reversed (2026-10-17): no status
    // change and no deployment by editing the row.
    if (
      DISPOSED_STATUSES.includes(existing.status) &&
      (dto.status !== undefined || dto.deployedSiteId)
    ) {
      throw new ConflictException(
        `This machine is ${existing.status}. Reverse the disposal before changing its status or deploying it.`,
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
      async (tx) => {
        await this.writeRegistration(
          tx,
          existing.companyId,
          equipmentId,
          dto.registration,
        );
        return tx.equipment.update({
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
            ...(dto.manufacturingYear !== undefined
              ? { manufacturingYear: dto.manufacturingYear }
              : {}),
            ...this.detailsOf(dto),
          },
          include: WITH_DOCS,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.UPDATE,
      entityId: equipmentId,
      accountId: caller.id,
      companyId: existing.companyId,
      ipAddress,
      // A plain copy: the nested registration rows are class instances, not JSON.
      changes: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonObject,
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
    //
    // 036 K13: the file's own bytes decide its type, from the document allow-list (PDF, photos,
    // xlsx/docx), and the **detected** type is what is stored and served back. The client's
    // `contentType` used to be stored as given, so an HTML page declared as a PDF came back as
    // HTML. A photographed paper is compressed on the way in (036 B6).
    const bytes = decodeBase64Upload(dto.file, 'The document');
    const detected = assertAllowedFileType(bytes, DOCUMENT_TYPES, 'The document');
    const image = await compressImageUpload(bytes, detected.contentType);
    const storedType = image?.main.contentType ?? detected.contentType;

    const fileRef = await this.storage.put(
      'equipment-documents',
      image?.main.data ?? bytes,
      storedType,
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
            mimeType: storedType,
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
