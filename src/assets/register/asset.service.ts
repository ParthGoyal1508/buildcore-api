import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetStatus,
  AssetTrackingMode,
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { assertTransition } from '../asset-status';
import { AssetsRefsService } from '../assets-refs.service';
import { todayUtc } from '../dates';
import {
  ASSET_CODE_INFIX,
  ASSET_DOCUMENT_PREFIX,
  DEFAULT_PAGE_SIZE,
  MAX_DOCUMENT_BYTES,
  MAX_PAGE_SIZE,
  MS_PER_DAY,
} from '../constants/assets.constants';
import { accumulatedDepreciation, bookValue } from '../depreciation';
import {
  CreateAssetDto,
  ListAssetsDto,
  UpdateAssetDto,
  UploadAssetDocumentDto,
} from './dto/asset.dto';

export interface AssetDocumentView {
  id: string;
  docTypeId: string;
  docTypeName: string;
  fileName: string | null;
  documentNumber: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  /** Inside its own doc type's alert window, or already lapsed. Computed, never
   * stored — a stored flag is wrong the day after it is written. */
  expiring: boolean;
  expired: boolean;
  uploadedAt: Date;
}

export interface AssetRow {
  id: string;
  companyId: string;
  assetCode: string;
  name: string;
  categoryId: string;
  categoryName: string;
  trackingMode: AssetTrackingMode;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  quantity: number;
  unitOfMeasure: string | null;
  purchaseDate: Date | null;
  purchaseCost: number;
  capitalisationDate: Date;
  depreciationRatePercent: number;
  usefulLifeYears: number;
  salvageValue: number;
  /** Computed on read (FR-019). Nothing here is posted — see `depreciation.ts`. */
  accumulatedDepreciation: number;
  bookValue: number;
  vendorId: string | null;
  vendorName: string | null;
  purchaseId: string | null;
  currentSiteId: string;
  siteName: string;
  currentCustodianId: string | null;
  custodianName: string | null;
  currentConditionGradeId: string | null;
  conditionGradeName: string | null;
  status: AssetStatus;
  nextInspectionDue: Date | null;
  /** The inspection is due today or overdue (FR-017). */
  inspectionDue: boolean;
  /**
   * Any document on this asset is inside its own doc type's alert window, or has
   * already lapsed (spec FR-025).
   *
   * Answered in the list rather than only on the detail, for the reason
   * `EquipmentRow.expiryAlert` documents: "is any paperwork about to lapse?" is the
   * question the register exists to answer, and making someone open each asset to
   * find out means nobody does.
   */
  expiryAlert: boolean;
  /** Which types are alerting — "something is expiring" sends someone to open the
   * asset to find out what. */
  alertDocumentTypes: string[];
  disposalDate: Date | null;
  createdAt: Date;
}

export interface AssetDetail extends AssetRow {
  documents: AssetDocumentView[];
  stock: {
    siteId: string;
    siteName: string;
    onHand: number;
    allocated: number;
    inTransit: number;
  }[];
}

type AssetWithDocs = Prisma.AssetGetPayload<{
  include: { documents: true; stock: true };
}>;

/**
 * The asset register (spec US2).
 *
 * Three things are worth knowing before reading the code:
 *
 * 1. `trackingMode` is copied from the category at registration and never read back
 *    across the schema boundary afterwards. That copy is what makes a row
 *    self-describing, and FR-003's freeze on the category's mode is what keeps the
 *    copy permanently truthful.
 *
 * 2. A bulk asset gets an opening `AssetStock` row at its home site in the same
 *    transaction as the asset itself. A serialised asset gets one too, with a
 *    quantity of 1 — carrying both kinds in the same table is what lets the stock
 *    view answer "where is everything?" without a union of two shapes.
 *
 * 3. Depreciation is computed on read from the asset's own columns. Nothing is
 *    posted, nothing is stored, and the salvage floor is applied inside
 *    `depreciation.ts` so every caller agrees on the figure.
 */
@Injectable()
export class AssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: AssetsRefsService,
    private readonly codeSeries: CodeSeriesService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  private isExpiring(
    expiryDate: Date | null,
    alertDays: number,
    today: Date,
  ): boolean {
    if (!expiryDate) return false;
    const daysLeft = Math.floor(
      (expiryDate.getTime() - today.getTime()) / MS_PER_DAY,
    );
    return daysLeft <= alertDays;
  }

  /**
   * Fills in every cross-module name in one batch per reference kind.
   *
   * The alternative — resolving per row — is the N+1 that would make a 500-asset
   * register issue two thousand lookups. Same shape `EquipmentService.decorate()`
   * uses.
   */
  private async decorate(
    caller: AuthenticatedUser,
    rows: AssetWithDocs[],
  ): Promise<AssetRow[]> {
    if (rows.length === 0) return [];
    const today = todayUtc();

    const [
      categories,
      siteNames,
      vendorNames,
      custodianNames,
      grades,
      docTypes,
    ] = await Promise.all([
      this.refs.categoriesByIds(
        caller,
        rows.map((row) => row.categoryId),
      ),
      this.refs.siteNames(
        caller,
        rows.map((row) => row.currentSiteId),
      ),
      this.refs.vendorNames(
        caller,
        rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
      ),
      this.refs.employeeNames(
        caller,
        rows.flatMap((row) =>
          row.currentCustodianId ? [row.currentCustodianId] : [],
        ),
      ),
      this.refs.gradesByIds(
        caller,
        rows.flatMap((row) =>
          row.currentConditionGradeId ? [row.currentConditionGradeId] : [],
        ),
      ),
      this.refs.docTypesByIds(
        caller,
        rows.flatMap((row) =>
          row.documents.map((document) => document.docTypeId),
        ),
      ),
    ]);

    return rows.map((row) => {
      // Each document against its *own* type's window, never a module-wide constant:
      // an insurance policy and a calibration certificate are not renewed on the
      // same notice, which is why `alertDays` is a column on the doc type.
      const alerting = row.documents.filter((document) =>
        this.isExpiring(
          document.expiryDate,
          docTypes.get(document.docTypeId)?.alertDays ?? 0,
          today,
        ),
      );
      const depreciable = {
        purchaseCost: Number(row.purchaseCost),
        depreciationRatePercent: Number(row.depreciationRatePercent),
        salvageValue: Number(row.salvageValue),
        capitalisationDate: row.capitalisationDate,
      };
      return {
        id: row.id,
        companyId: row.companyId,
        assetCode: row.assetCode,
        name: row.name,
        categoryId: row.categoryId,
        categoryName:
          categories.get(row.categoryId)?.name ?? 'Unknown category',
        trackingMode: row.trackingMode,
        manufacturer: row.manufacturer,
        modelNumber: row.modelNumber,
        serialNumber: row.serialNumber,
        quantity: Number(row.quantity),
        unitOfMeasure: row.unitOfMeasure,
        purchaseDate: row.purchaseDate,
        purchaseCost: Number(row.purchaseCost),
        capitalisationDate: row.capitalisationDate,
        depreciationRatePercent: Number(row.depreciationRatePercent),
        usefulLifeYears: row.usefulLifeYears,
        salvageValue: Number(row.salvageValue),
        accumulatedDepreciation: accumulatedDepreciation(depreciable, today),
        bookValue: bookValue(depreciable, today),
        vendorId: row.vendorId,
        vendorName: row.vendorId
          ? vendorNames.get(row.vendorId) ?? 'Unknown vendor'
          : null,
        purchaseId: row.purchaseId,
        currentSiteId: row.currentSiteId,
        siteName: siteNames.get(row.currentSiteId) ?? 'Unknown site',
        currentCustodianId: row.currentCustodianId,
        custodianName: row.currentCustodianId
          ? custodianNames.get(row.currentCustodianId) ?? 'Unknown employee'
          : null,
        currentConditionGradeId: row.currentConditionGradeId,
        conditionGradeName: row.currentConditionGradeId
          ? grades.get(row.currentConditionGradeId)?.name ?? 'Unknown grade'
          : null,
        status: row.status,
        nextInspectionDue: row.nextInspectionDue,
        inspectionDue:
          row.nextInspectionDue !== null && row.nextInspectionDue <= today,
        expiryAlert: alerting.length > 0,
        alertDocumentTypes: [
          ...new Set(
            alerting.map(
              (document) =>
                docTypes.get(document.docTypeId)?.name ?? 'Unknown type',
            ),
          ),
        ],
        disposalDate: row.disposalDate,
        createdAt: row.createdAt,
      };
    });
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListAssetsDto,
  ): Promise<{
    items: AssetRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.AssetWhereInput = {
      ...companyScope(caller, query.companyId),
      // Soft-deleted assets never appear in a list (FR-031). Their history is
      // still reachable by id for the audit trail that outlives them.
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.siteId ? { currentSiteId: query.siteId } : {}),
      ...(query.custodianId ? { currentCustodianId: query.custodianId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.inspectionDue
        ? { nextInspectionDue: { not: null, lte: todayUtc() } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { assetCode: { contains: query.search, mode: 'insensitive' } },
              { serialNumber: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.asset.findMany({
            where,
            orderBy: { assetCode: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { documents: true, stock: true },
          }),
          tx.asset.count({ where }),
        ]);
        return { rows, total };
      },
    );

    return {
      items: await this.decorate(caller, rows),
      total,
      page,
      pageSize,
    };
  }

  async findOne(
    caller: AuthenticatedUser,
    assetId: string,
  ): Promise<AssetDetail> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.asset.findUnique({
        where: { id: assetId },
        include: { documents: true, stock: true },
      }),
    );
    if (!row) throw new NotFoundException('Asset not found');
    assertInScope(caller, row, 'Asset');

    const [base] = await this.decorate(caller, [row]);
    const today = todayUtc();
    const [docTypes, siteNames] = await Promise.all([
      this.refs.docTypesByIds(
        caller,
        row.documents.map((document) => document.docTypeId),
      ),
      this.refs.siteNames(
        caller,
        row.stock.map((entry) => entry.siteId),
      ),
    ]);

    return {
      ...base,
      documents: row.documents.map((document) => {
        const docType = docTypes.get(document.docTypeId);
        return {
          id: document.id,
          docTypeId: document.docTypeId,
          docTypeName: docType?.name ?? 'Unknown type',
          fileName: document.fileName,
          documentNumber: document.documentNumber,
          issueDate: document.issueDate,
          expiryDate: document.expiryDate,
          expiring: this.isExpiring(
            document.expiryDate,
            docType?.alertDays ?? 0,
            today,
          ),
          expired: document.expiryDate !== null && document.expiryDate < today,
          uploadedAt: document.uploadedAt,
        };
      }),
      stock: row.stock.map((entry) => ({
        siteId: entry.siteId,
        siteName: siteNames.get(entry.siteId) ?? 'Unknown site',
        onHand: Number(entry.quantityOnHand),
        allocated: Number(entry.quantityAllocated),
        inTransit: Number(entry.quantityInTransit),
      })),
    };
  }

  // ── Cross-boundary guards, for the settings-side masters ──────────────────

  /**
   * How many assets sit under each of the given categories.
   *
   * Lives here rather than in `AssetCategoriesService` because it counts rows in
   * *this* schema and Principle I forbids that service reading them — see its class
   * comment. One grouped query, never one per category.
   */
  async countByCategory(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    const unique = [...new Set(categoryIds)];
    if (unique.length === 0) return new Map();
    const groups = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.asset.groupBy({
          by: ['categoryId'],
          where: {
            categoryId: { in: unique },
            deletedAt: null,
            ...companyScope(caller),
          },
          _count: { _all: true },
        }),
    );
    return new Map(
      groups.map((group) => [group.categoryId, group._count._all]),
    );
  }

  /** Total book value per category, for the master list's second column. */
  async bookValueByCategory(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    const unique = [...new Set(categoryIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.asset.findMany({
          where: {
            categoryId: { in: unique },
            deletedAt: null,
            ...companyScope(caller),
          },
          select: {
            categoryId: true,
            purchaseCost: true,
            depreciationRatePercent: true,
            salvageValue: true,
            capitalisationDate: true,
          },
        }),
    );
    const today = todayUtc();
    const totals = new Map<string, number>();
    for (const row of rows) {
      const value = bookValue(
        {
          purchaseCost: Number(row.purchaseCost),
          depreciationRatePercent: Number(row.depreciationRatePercent),
          salvageValue: Number(row.salvageValue),
          capitalisationDate: row.capitalisationDate,
        },
        today,
      );
      totals.set(row.categoryId, (totals.get(row.categoryId) ?? 0) + value);
    }
    for (const [categoryId, total] of totals) {
      totals.set(categoryId, Math.round(total * 100) / 100);
    }
    return totals;
  }

  /** 409 once any asset references the category — retire it instead, so historical
   * rows still resolve a category name. */
  async assertCategoryUnused(
    caller: AuthenticatedUser,
    categoryId: string,
  ): Promise<void> {
    const counts = await this.countByCategory(caller, [categoryId]);
    const count = counts.get(categoryId) ?? 0;
    if (count > 0) {
      throw new ConflictException(
        `This category has ${count} asset(s) registered under it. ` +
          'Retire it instead so their history still resolves a category name.',
      );
    }
  }

  /**
   * FR-003: a category's tracking mode is frozen once anything is registered under
   * it, because serialised and bulk rows have structurally different allocation
   * semantics and a flip would reinterpret every existing row.
   */
  async assertTrackingModeChangeable(
    caller: AuthenticatedUser,
    categoryId: string,
    nextMode: AssetTrackingMode,
  ): Promise<void> {
    const category = await this.refs
      .requireCategory(caller, categoryId, caller.companyId ?? '')
      .catch(() => null);
    if (category && category.trackingMode === nextMode) return;

    const counts = await this.countByCategory(caller, [categoryId]);
    const count = counts.get(categoryId) ?? 0;
    if (count > 0) {
      throw new ConflictException(
        `This category already has ${count} asset(s) registered, so its tracking ` +
          'mode is fixed. Create a new category for the other mode.',
      );
    }
  }

  /** 409 once any document is filed under the doc type. */
  async assertDocTypeUnused(
    caller: AuthenticatedUser,
    docTypeId: string,
  ): Promise<void> {
    const count = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetDocument.count({
          where: { docTypeId, ...companyScope(caller) },
        }),
    );
    if (count > 0) {
      throw new ConflictException(
        `This document type has ${count} document(s) filed under it. ` +
          'Retire it instead so they still resolve a type name.',
      );
    }
  }

  /**
   * 409 once anything is graded at the condition grade.
   *
   * Five columns across four tables can cite a grade, and all of them matter: a
   * grade deleted out from under a closed allocation would leave the return record
   * unable to say what came back.
   */
  async assertGradeUnused(
    caller: AuthenticatedUser,
    gradeId: string,
  ): Promise<void> {
    const scope = companyScope(caller);
    const count = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [assets, allocations, transfers, inspections, repairs] =
          await Promise.all([
            tx.asset.count({
              where: { currentConditionGradeId: gradeId, ...scope },
            }),
            tx.assetAllocation.count({
              where: { conditionOnReturnId: gradeId, ...scope },
            }),
            tx.assetTransfer.count({
              where: {
                OR: [
                  { dispatchConditionId: gradeId },
                  { conditionOnReceiptId: gradeId },
                ],
                ...scope,
              },
            }),
            tx.assetInspection.count({
              where: { conditionGradeId: gradeId, ...scope },
            }),
            tx.assetRepair.count({
              where: { resultingConditionGradeId: gradeId, ...scope },
            }),
          ]);
        return assets + allocations + transfers + inspections + repairs;
      },
    );
    if (count > 0) {
      throw new ConflictException(
        `This condition grade is cited by ${count} record(s). Retire it instead, ` +
          'so their history still resolves a grade name.',
      );
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(
    caller: AuthenticatedUser,
    dto: CreateAssetDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<AssetRow> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const category = await this.refs.requireCategory(
      caller,
      dto.categoryId,
      companyId,
    );
    await this.refs.requireSite(caller, dto.currentSiteId, companyId);
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);
    if (dto.purchaseId) {
      await this.refs.requirePurchase(caller, dto.purchaseId, companyId);
    }
    if (dto.currentConditionGradeId) {
      await this.refs.requireGrade(
        caller,
        dto.currentConditionGradeId,
        companyId,
      );
    }

    const serialised = category.trackingMode === AssetTrackingMode.serialised;
    const quantity = dto.quantity ?? 1;
    if (serialised && quantity !== 1) {
      throw new BadRequestException(
        `${category.name} is a serialised category: one asset row is one physical ` +
          'unit, so quantity must be 1. Register each unit separately.',
      );
    }
    if (!serialised && dto.serialNumber) {
      throw new BadRequestException(
        `${category.name} is a bulk category: its units are fungible and cannot ` +
          'carry a serial number.',
      );
    }

    const purchaseDate = dto.purchaseDate
      ? this.refs.parseDate(dto.purchaseDate)
      : null;
    const capitalisationDate = this.refs.parseDate(dto.capitalisationDate);
    if (purchaseDate && capitalisationDate < purchaseDate) {
      throw new BadRequestException(
        'capitalisationDate cannot precede purchaseDate — depreciation would ' +
          'start before the asset was owned.',
      );
    }

    const today = todayUtc();
    // An asset registered ahead of its capitalisation date is on the register but
    // out of service: excluded from allocation and from depreciation until the date
    // arrives (spec Edge Cases).
    const status =
      capitalisationDate > today
        ? AssetStatus.not_in_service
        : AssetStatus.idle;

    const nextInspectionDue =
      category.inspectionRequired && category.inspectionIntervalDays
        ? new Date(
            capitalisationDate.getTime() +
              category.inspectionIntervalDays * MS_PER_DAY,
          )
        : null;

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const assetCode =
          dto.assetCode?.trim() ||
          (await this.codeSeries.next(
            tx,
            companyId,
            CodeSeriesType.ASSETS,
            ASSET_CODE_INFIX,
          ));

        const clash = await tx.asset.findFirst({
          where: { companyId, assetCode },
        });
        if (clash) {
          throw new ConflictException(
            `Asset code ${assetCode} is already in use in this company.`,
          );
        }

        if (dto.serialNumber) {
          const serialClash = await tx.asset.findFirst({
            where: { companyId, serialNumber: dto.serialNumber },
          });
          if (serialClash) {
            throw new ConflictException(
              `Serial number ${dto.serialNumber} is already registered as ` +
                `${serialClash.assetCode}.`,
            );
          }
        }

        const asset = await tx.asset.create({
          data: {
            companyId,
            assetCode,
            name: dto.name.trim(),
            categoryId: dto.categoryId,
            // Copied, never joined at read time — see the class comment.
            trackingMode: category.trackingMode,
            manufacturer: dto.manufacturer?.trim() ?? null,
            modelNumber: dto.modelNumber?.trim() ?? null,
            serialNumber: dto.serialNumber?.trim() ?? null,
            quantity,
            unitOfMeasure: dto.unitOfMeasure?.trim() ?? null,
            purchaseDate,
            purchaseCost: dto.purchaseCost ?? 0,
            capitalisationDate,
            // The category supplies the default; the asset keeps its own copy so a
            // later policy change does not restate book values already reported.
            depreciationRatePercent:
              dto.depreciationRatePercent ?? category.depreciationRatePercent,
            usefulLifeYears: dto.usefulLifeYears ?? category.usefulLifeYears,
            salvageValue: dto.salvageValue ?? 0,
            vendorId: dto.vendorId ?? null,
            purchaseId: dto.purchaseId ?? null,
            currentSiteId: dto.currentSiteId,
            currentConditionGradeId: dto.currentConditionGradeId ?? null,
            status,
            nextInspectionDue,
            createdBy: caller.id,
          },
        });

        // The opening balance, in the same transaction as the asset. A serialised
        // asset gets one too, at quantity 1, so the stock view is one shape.
        await tx.assetStock.create({
          data: {
            companyId,
            assetId: asset.id,
            siteId: dto.currentSiteId,
            quantityOnHand: quantity,
          },
        });

        return tx.asset.findUniqueOrThrow({
          where: { id: asset.id },
          include: { documents: true, stock: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes: {
        assetCode: created.assetCode,
        name: created.name,
        categoryId: created.categoryId,
        trackingMode: created.trackingMode,
        quantity: Number(created.quantity),
      },
    });

    const [row] = await this.decorate(caller, [created]);
    return row;
  }

  async update(
    caller: AuthenticatedUser,
    assetId: string,
    dto: UpdateAssetDto,
    ipAddress: string,
  ): Promise<AssetRow> {
    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.asset.findUnique({ where: { id: assetId } }),
    );
    if (!existing || existing.deletedAt) {
      throw new NotFoundException('Asset not found');
    }
    assertInScope(caller, existing, 'Asset');

    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      throw new BadRequestException(
        'An asset cannot change category: its tracking mode, depreciation policy ' +
          'and inspection schedule were all fixed from the original one.',
      );
    }
    if (dto.status) {
      if (
        dto.status === AssetStatus.allocated ||
        dto.status === AssetStatus.in_transit
      ) {
        throw new BadRequestException(
          `${existing.assetCode} cannot be set to ${dto.status} directly — that ` +
            'status belongs to the allocation and transfer flows, which also ' +
            'move the stock behind it.',
        );
      }
      assertTransition(existing.status, dto.status, existing.assetCode);
    }
    if (dto.currentSiteId && dto.currentSiteId !== existing.currentSiteId) {
      throw new BadRequestException(
        'An asset moves site through a transfer, never through an edit — a direct ' +
          'change would leave its per-site stock pointing at the old location.',
      );
    }
    if (dto.serialNumber && dto.serialNumber !== existing.serialNumber) {
      if (existing.trackingMode === AssetTrackingMode.bulk) {
        throw new BadRequestException(
          'A bulk asset cannot carry a serial number.',
        );
      }
    }
    if (dto.currentConditionGradeId) {
      await this.refs.requireGrade(
        caller,
        dto.currentConditionGradeId,
        existing.companyId,
      );
    }
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);

    const purchaseDate = dto.purchaseDate
      ? this.refs.parseDate(dto.purchaseDate)
      : existing.purchaseDate;
    const capitalisationDate = dto.capitalisationDate
      ? this.refs.parseDate(dto.capitalisationDate)
      : existing.capitalisationDate;
    if (purchaseDate && capitalisationDate < purchaseDate) {
      throw new BadRequestException(
        'capitalisationDate cannot precede purchaseDate.',
      );
    }

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (dto.serialNumber && dto.serialNumber !== existing.serialNumber) {
          const serialClash = await tx.asset.findFirst({
            where: {
              companyId: existing.companyId,
              serialNumber: dto.serialNumber,
              id: { not: assetId },
            },
          });
          if (serialClash) {
            throw new ConflictException(
              `Serial number ${dto.serialNumber} is already registered as ` +
                `${serialClash.assetCode}.`,
            );
          }
        }

        return tx.asset.update({
          where: { id: assetId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.manufacturer !== undefined
              ? { manufacturer: dto.manufacturer }
              : {}),
            ...(dto.modelNumber !== undefined
              ? { modelNumber: dto.modelNumber }
              : {}),
            ...(dto.serialNumber !== undefined
              ? { serialNumber: dto.serialNumber }
              : {}),
            ...(dto.unitOfMeasure !== undefined
              ? { unitOfMeasure: dto.unitOfMeasure }
              : {}),
            ...(dto.purchaseDate !== undefined ? { purchaseDate } : {}),
            ...(dto.purchaseCost !== undefined
              ? { purchaseCost: dto.purchaseCost }
              : {}),
            ...(dto.capitalisationDate !== undefined
              ? { capitalisationDate }
              : {}),
            ...(dto.depreciationRatePercent !== undefined
              ? { depreciationRatePercent: dto.depreciationRatePercent }
              : {}),
            ...(dto.usefulLifeYears !== undefined
              ? { usefulLifeYears: dto.usefulLifeYears }
              : {}),
            ...(dto.salvageValue !== undefined
              ? { salvageValue: dto.salvageValue }
              : {}),
            ...(dto.vendorId !== undefined ? { vendorId: dto.vendorId } : {}),
            ...(dto.purchaseId !== undefined
              ? { purchaseId: dto.purchaseId }
              : {}),
            ...(dto.currentConditionGradeId !== undefined
              ? { currentConditionGradeId: dto.currentConditionGradeId }
              : {}),
            ...(dto.status !== undefined
              ? {
                  status: dto.status,
                  // FR-018: a condemnation dates the disposal, so the register can
                  // say when the asset left it.
                  ...(dto.status === AssetStatus.scrapped
                    ? { disposalDate: todayUtc() }
                    : {}),
                }
              : {}),
          },
          include: { documents: true, stock: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET,
      action: AuditAction.UPDATE,
      entityId: assetId,
      accountId: caller.id,
      companyId: existing.companyId,
      ipAddress,
      changes: { ...dto },
    });

    const [row] = await this.decorate(caller, [updated]);
    return row;
  }

  /**
   * Soft delete (spec FR-031).
   *
   * Never a hard delete: an asset's movement and custody history outlives the asset,
   * and a row removed from under a closed allocation would leave the return record
   * unable to say what came back. An asset with an open allocation is refused
   * outright — deleting it would leave a custodian accountable for nothing.
   */
  async remove(
    caller: AuthenticatedUser,
    assetId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.asset.findUnique({ where: { id: assetId } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException('Asset not found');
        }
        assertInScope(caller, existing, 'Asset');

        const open = await tx.assetAllocation.count({
          where: { assetId, status: 'open', deletedAt: null },
        });
        if (open > 0) {
          throw new ConflictException(
            `${existing.assetCode} is still allocated. Return it first, so the ` +
              'custody record closes against a real asset.',
          );
        }
        const inTransit = await tx.assetTransfer.count({
          where: { assetId, status: 'in_transit', deletedAt: null },
        });
        if (inTransit > 0) {
          throw new ConflictException(
            `${existing.assetCode} is in transit. Acknowledge or cancel the ` +
              'transfer first.',
          );
        }

        await tx.asset.update({
          where: { id: assetId },
          data: { deletedAt: new Date(), deletedBy: caller.id },
        });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET,
      action: AuditAction.DELETE,
      entityId: assetId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
      changes: { assetCode: removed.assetCode, name: removed.name },
    });
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async uploadDocument(
    caller: AuthenticatedUser,
    assetId: string,
    dto: UploadAssetDocumentDto,
    ipAddress: string,
  ): Promise<AssetDocumentView> {
    const asset = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.asset.findUnique({ where: { id: assetId } }),
    );
    if (!asset || asset.deletedAt)
      throw new NotFoundException('Asset not found');
    assertInScope(caller, asset, 'Asset');

    const docType = await this.refs.requireDocType(
      caller,
      dto.docTypeId,
      asset.companyId,
    );

    // TODO(VIRUS_SCAN): uploads are stored unscanned, the same gap 005's employee,
    // 006's equipment and 007's contractor documents carry. The scan belongs
    // between decoding and `storage.put`, and is left explicit rather than faked —
    // a no-op scanner reads as protection that is not there.
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
      ASSET_DOCUMENT_PREFIX,
      buffer,
      dto.contentType ?? 'application/octet-stream',
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetDocument.create({
          data: {
            companyId: asset.companyId,
            assetId,
            docTypeId: dto.docTypeId,
            fileRef,
            fileName: dto.fileName ?? null,
            mimeType: dto.contentType ?? null,
            documentNumber: dto.documentNumber ?? null,
            issueDate: dto.issueDate
              ? this.refs.parseDate(dto.issueDate)
              : null,
            expiryDate: dto.expiryDate
              ? this.refs.parseDate(dto.expiryDate)
              : null,
            uploadedByUserId: caller.id,
          },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: asset.companyId,
      ipAddress,
      changes: { assetId, docType: docType.name },
    });

    const today = todayUtc();
    return {
      id: created.id,
      docTypeId: created.docTypeId,
      docTypeName: docType.name,
      fileName: created.fileName,
      documentNumber: created.documentNumber,
      issueDate: created.issueDate,
      expiryDate: created.expiryDate,
      expiring: this.isExpiring(created.expiryDate, docType.alertDays, today),
      expired: created.expiryDate !== null && created.expiryDate < today,
      uploadedAt: created.uploadedAt,
    };
  }

  /** Streams a stored document back, for the register's download control. */
  async downloadDocument(
    caller: AuthenticatedUser,
    assetId: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    const document = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetDocument.findFirst({
          where: { id: documentId, assetId },
        }),
    );
    if (!document) throw new NotFoundException('Document not found');
    assertInScope(caller, document, 'Document');

    return {
      buffer: await this.storage.get(document.fileRef),
      fileName: document.fileName ?? 'document',
      contentType: document.mimeType ?? 'application/octet-stream',
    };
  }
}
