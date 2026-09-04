import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  MaintenanceStatus,
  Prisma,
  SparePartMovementType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { InventoryService } from '../../inventory/inventory.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  ConsumeSparePartDto,
  CreateSparePartDto,
  ListSparePartsDto,
  ReceiveSparePartDto,
  ReverseConsumptionDto,
  UpdateSparePartDto,
} from './dto/spare-part.dto';

export interface SparePartRow {
  id: string;
  companyId: string;
  partNumber: string;
  name: string;
  unitOfMeasure: string;
  reorderLevel: number | null;
  compatibleCategoryIds: string[];
  compatibleCategoryNames: string[];
  linkedInventoryItemId: string | null;
  stockQuantity: number;
  avgRate: number;
  /** `stockQuantity × avgRate`. Never stored — it is a product of two columns. */
  stockValue: number;
  /** False when the part has no reorder level at all: a part without a floor
   * cannot be below one. */
  belowReorderLevel: boolean;
  active: boolean;
  createdAt: Date;
}

export interface SparePartMovementRow {
  id: string;
  sparePartId: string;
  partNumber: string;
  partName: string;
  type: SparePartMovementType;
  quantity: number;
  rate: number;
  amount: number;
  movementDate: Date;
  maintenanceJobId: string | null;
  vendorId: string | null;
  billReference: string | null;
  incompatiblePart: boolean;
  reversalOfId: string | null;
  reversed: boolean;
  reason: string | null;
  createdAt: Date;
}

/** Rupees, rounded to paise. */
function paise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The weighted average rate after a receipt (FR-017), by the same formula 009
 * FR-008 applies to inventory items:
 *
 *   newWAR = (existingStock × existingWAR + newQty × newRate) / (existingStock + newQty)
 *
 * `existingStock` is the *current* balance, not the total ever received, so parts
 * already consumed stop weighting the average.
 *
 * A denominator of zero is possible and is not an error: a part received and then
 * fully consumed is at zero stock, and the next receipt simply sets the rate
 * outright rather than dividing by nothing.
 */
export function weightedAverageRate(params: {
  existingStock: number;
  existingRate: number;
  receivedQuantity: number;
  receivedRate: number;
}): number {
  const denominator = params.existingStock + params.receivedQuantity;
  if (denominator === 0) return params.receivedRate;
  return (
    (params.existingStock * params.existingRate +
      params.receivedQuantity * params.receivedRate) /
    denominator
  );
}

/**
 * Spare parts stock and its consumption against maintenance jobs (006 US9, US10).
 *
 * Deliberately *not* feature 009's inventory: an inventory item is consumed against
 * a BOQ activity and costed to a project, a spare part is consumed against a machine
 * and costed to that machine's maintenance history. Different stock location,
 * different costing dimension, different consumer. Where one physical thing is
 * registered in both, `linkedInventoryItemId` declares it so the reconciliation view
 * can show the divergence rather than the two silently double-counting (FR-024).
 *
 * Consumption holds a `SELECT ... FOR UPDATE` on the part row for the rest of the
 * transaction (FR-018). Two mechanics taking the last filter would otherwise both
 * read the same balance, both pass validation, and both commit — leaving stock
 * negative. The lock is the same device 009 uses for issues, for the same reason.
 */
@Injectable()
export class SparePartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly inventory: InventoryService,
  ) {}

  // ── Catalogue ─────────────────────────────────────────────────────────────

  private async toRows(
    caller: AuthenticatedUser,
    rows: Prisma.SparePartGetPayload<object>[],
  ): Promise<SparePartRow[]> {
    const categories = await this.refs.categoriesByIds(
      caller,
      rows.flatMap((row) => row.compatibleCategoryIds),
    );
    return rows.map((row) => {
      const stockQuantity = Number(row.stockQuantity);
      const avgRate = Number(row.avgRate);
      const reorderLevel =
        row.reorderLevel === null ? null : Number(row.reorderLevel);
      return {
        id: row.id,
        companyId: row.companyId,
        partNumber: row.partNumber,
        name: row.name,
        unitOfMeasure: row.unitOfMeasure,
        reorderLevel,
        compatibleCategoryIds: row.compatibleCategoryIds,
        compatibleCategoryNames: row.compatibleCategoryIds.map(
          (id) => categories.get(id)?.name ?? 'Unknown category',
        ),
        linkedInventoryItemId: row.linkedInventoryItemId,
        stockQuantity,
        avgRate,
        stockValue: paise(stockQuantity * avgRate),
        belowReorderLevel:
          reorderLevel !== null && stockQuantity <= reorderLevel,
        active: row.active,
        createdAt: row.createdAt,
      };
    });
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListSparePartsDto,
  ): Promise<{
    items: SparePartRow[];
    total: number;
    page: number;
    pageSize: number;
    belowReorderCount: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.SparePartWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.categoryId
        ? { compatibleCategoryIds: { has: query.categoryId } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { partNumber: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      // `stockQuantity <= reorderLevel` compares two columns, which Prisma cannot
      // express. Resolved as an id set *before* paging rather than by filtering the
      // page after fetching it: filtering afterwards returns a short page and a
      // wrong total, which is exactly the defect 009's equivalent filter shipped
      // with and had to be corrected.
      let belowIds: string[] | null = null;
      if (query.belowReorder === 'true') {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "plant"."SparePart"
          WHERE "reorderLevel" IS NOT NULL
            AND "stockQuantity" <= "reorderLevel"
        `;
        belowIds = rows.map((row) => row.id);
        if (belowIds.length === 0) {
          return {
            items: [],
            total: 0,
            page,
            pageSize,
            belowReorderCount: 0,
          };
        }
      }

      const scopedWhere: Prisma.SparePartWhereInput = {
        ...where,
        ...(belowIds ? { id: { in: belowIds } } : {}),
      };

      const [rows, total, belowCount] = await Promise.all([
        tx.sparePart.findMany({
          where: scopedWhere,
          orderBy: { partNumber: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.sparePart.count({ where: scopedWhere }),
        tx.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count FROM "plant"."SparePart"
          WHERE "reorderLevel" IS NOT NULL
            AND "stockQuantity" <= "reorderLevel"
        `,
      ]);

      return {
        items: await this.toRows(caller, rows),
        total,
        page,
        pageSize,
        belowReorderCount: Number(belowCount[0]?.count ?? 0),
      };
    });
  }

  async findOne(
    caller: AuthenticatedUser,
    partId: string,
  ): Promise<SparePartRow> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.sparePart.findUnique({ where: { id: partId } }),
    );
    if (!row) throw new NotFoundException('Spare part not found');
    assertInScope(caller, row, 'Spare part');
    const [view] = await this.toRows(caller, [row]);
    return view;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateSparePartDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<SparePartRow> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const partNumber = dto.partNumber.trim().toUpperCase();

    for (const categoryId of dto.compatibleCategoryIds ?? []) {
      await this.refs.requireCategory(caller, categoryId, companyId);
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.sparePart.findFirst({
          where: { companyId, partNumber },
        });
        if (clash) {
          throw new ConflictException(
            `Part number ${partNumber} is already registered in this company.`,
          );
        }
        return tx.sparePart.create({
          data: {
            companyId,
            partNumber,
            name: dto.name.trim(),
            unitOfMeasure: dto.unitOfMeasure.trim().toUpperCase(),
            reorderLevel: dto.reorderLevel ?? null,
            compatibleCategoryIds: dto.compatibleCategoryIds ?? [],
            linkedInventoryItemId: dto.linkedInventoryItemId ?? null,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes: { partNumber: created.partNumber, name: created.name },
    });
    const [view] = await this.toRows(caller, [created]);
    return view;
  }

  async update(
    caller: AuthenticatedUser,
    partId: string,
    dto: UpdateSparePartDto,
    ipAddress: string,
  ): Promise<SparePartRow> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.sparePart.findUnique({
          where: { id: partId },
        });
        if (!existing) throw new NotFoundException('Spare part not found');
        assertInScope(caller, existing, 'Spare part');

        const partNumber = dto.partNumber
          ? dto.partNumber.trim().toUpperCase()
          : undefined;
        if (partNumber && partNumber !== existing.partNumber) {
          const clash = await tx.sparePart.findFirst({
            where: { companyId: existing.companyId, partNumber },
          });
          if (clash) {
            throw new ConflictException(
              `Part number ${partNumber} is already registered in this company.`,
            );
          }
        }

        return tx.sparePart.update({
          where: { id: partId },
          data: {
            ...(partNumber ? { partNumber } : {}),
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.unitOfMeasure !== undefined
              ? { unitOfMeasure: dto.unitOfMeasure.trim().toUpperCase() }
              : {}),
            ...(dto.reorderLevel !== undefined
              ? { reorderLevel: dto.reorderLevel }
              : {}),
            ...(dto.compatibleCategoryIds !== undefined
              ? { compatibleCategoryIds: dto.compatibleCategoryIds }
              : {}),
            ...(dto.linkedInventoryItemId !== undefined
              ? { linkedInventoryItemId: dto.linkedInventoryItemId }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART,
      action: AuditAction.UPDATE,
      entityId: partId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    const [view] = await this.toRows(caller, [updated]);
    return view;
  }

  /**
   * Deletes a part that has never moved.
   *
   * Anything with movement history is refused (US9 scenario 5) and must be retired
   * instead: deleting it would take the stock and cost history of every machine it
   * was ever fitted to with it.
   */
  async remove(
    caller: AuthenticatedUser,
    partId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.sparePart.findUnique({
          where: { id: partId },
        });
        if (!existing) throw new NotFoundException('Spare part not found');
        assertInScope(caller, existing, 'Spare part');

        const movements = await tx.sparePartMovement.count({
          where: { sparePartId: partId },
        });
        if (movements > 0) {
          throw new ConflictException(
            `This part has ${movements} stock movement(s) recorded against it. ` +
              'Retire it instead so the machines it was fitted to keep their history.',
          );
        }
        await tx.sparePart.delete({ where: { id: partId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART,
      action: AuditAction.DELETE,
      entityId: partId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
      changes: { partNumber: removed.partNumber },
    });
  }

  // ── Movements ─────────────────────────────────────────────────────────────

  async receive(
    caller: AuthenticatedUser,
    partId: string,
    dto: ReceiveSparePartDto,
    ipAddress: string,
  ): Promise<SparePartRow> {
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);
    const receiptDate = this.refs.parseDate(dto.receiptDate);

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const part = await this.lockPart(tx, partId);
        if (!part) throw new NotFoundException('Spare part not found');
        assertInScope(caller, part, 'Spare part');

        const newRate = weightedAverageRate({
          existingStock: part.stockQuantity,
          existingRate: part.avgRate,
          receivedQuantity: dto.quantity,
          receivedRate: dto.rate,
        });

        await tx.sparePartMovement.create({
          data: {
            companyId: part.companyId,
            sparePartId: partId,
            type: SparePartMovementType.receipt,
            quantity: dto.quantity,
            rate: dto.rate,
            amount: paise(dto.quantity * dto.rate),
            movementDate: receiptDate,
            vendorId: dto.vendorId ?? null,
            billReference: dto.billReference ?? null,
            createdByUserId: caller.id,
          },
        });

        return tx.sparePart.update({
          where: { id: partId },
          data: {
            stockQuantity: { increment: dto.quantity },
            avgRate: newRate,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART_MOVEMENT,
      action: AuditAction.CREATE,
      entityId: partId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: {
        type: 'receipt',
        quantity: dto.quantity,
        rate: dto.rate,
        newAvgRate: Number(updated.avgRate),
      },
    });
    const [view] = await this.toRows(caller, [updated]);
    return view;
  }

  /**
   * Consumes a part against an open maintenance job (US10).
   *
   * Four rules meet here, and the order matters:
   *
   * 1. The job must be open — a closed job is history, and adding to it would
   *    restate a cost already reported (FR-019, 409).
   * 2. The part row is locked before its balance is read (FR-018).
   * 3. The consumption is valued at the rate in force *now* and that rate is
   *    written onto the movement, never re-read later (FR-017). A receipt next week
   *    moves the average; it must not move what this repair cost.
   * 4. Incompatibility flags, it never blocks (FR-020) — the yard sometimes has to
   *    fit what it has, and a system that refuses simply gets worked around.
   */
  async consume(
    caller: AuthenticatedUser,
    jobId: string,
    dto: ConsumeSparePartDto,
    ipAddress: string,
  ): Promise<SparePartMovementRow> {
    const movementDate = dto.consumedOn
      ? this.refs.parseDate(dto.consumedOn)
      : this.refs.parseDate(new Date().toISOString());

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const job = await tx.maintenanceJob.findUnique({
          where: { id: jobId },
          include: {
            equipment: { select: { categoryId: true, ownership: true } },
          },
        });
        if (!job) throw new NotFoundException('Maintenance job not found');
        assertInScope(caller, job, 'Maintenance job');
        if (job.status === MaintenanceStatus.closed) {
          throw new ConflictException(
            'This maintenance job is closed. Parts cannot be added to a job whose ' +
              'cost has already been reported — reopen the work as a new job.',
          );
        }

        const part = await this.lockPart(tx, dto.sparePartId);
        if (!part) {
          throw new BadRequestException(
            `Spare part ${dto.sparePartId} does not exist.`,
          );
        }
        assertInScope(caller, part, 'Spare part');

        if (dto.quantity > part.stockQuantity) {
          // 400 rather than 009's 422 because the spec names it explicitly
          // (US10 scenario 2). `availableStock` travels in the body either way, so
          // the form can show the figure against the quantity field rather than a
          // generic validation error.
          throw new BadRequestException({
            message: `Only ${part.stockQuantity} ${part.unitOfMeasure} of ${part.partNumber} in stock; ${dto.quantity} requested.`,
            availableStock: part.stockQuantity,
          });
        }

        // Empty means unrestricted — a part nobody has classified fits anything.
        const incompatiblePart =
          part.compatibleCategoryIds.length > 0 &&
          !part.compatibleCategoryIds.includes(job.equipment.categoryId);

        const amount = paise(dto.quantity * part.avgRate);

        const movement = await tx.sparePartMovement.create({
          data: {
            companyId: part.companyId,
            sparePartId: dto.sparePartId,
            type: SparePartMovementType.consumption,
            quantity: dto.quantity,
            rate: part.avgRate,
            amount,
            movementDate,
            maintenanceJobId: jobId,
            incompatiblePart,
            createdByUserId: caller.id,
          },
          include: {
            sparePart: { select: { partNumber: true, name: true } },
            reversedBy: { select: { id: true } },
          },
        });

        await tx.sparePart.update({
          where: { id: dto.sparePartId },
          data: { stockQuantity: { decrement: dto.quantity } },
        });
        await tx.maintenanceJob.update({
          where: { id: jobId },
          data: { partsCost: { increment: amount } },
        });

        return movement;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART_MOVEMENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        type: 'consumption',
        maintenanceJobId: jobId,
        sparePartId: dto.sparePartId,
        quantity: dto.quantity,
        amount: Number(created.amount),
        // Recorded rather than merely flagged on the row: FR-020 requires the
        // decision to fit an out-of-category part to be accountable, not silent.
        incompatiblePart: created.incompatiblePart,
      },
    });
    return this.toMovementRow(created);
  }

  /**
   * Reverses a consumption (FR-019).
   *
   * Stock restoration and the job's `partsCost` adjustment happen in the same
   * transaction as the reversal row, so a crash cannot leave a part back on the
   * shelf while the job still carries its cost.
   *
   * Restored at the *original* movement's rate, not the current average: the
   * reversal has to undo exactly what the consumption did, and undoing it at
   * today's rate would leave the job's cost off by the difference.
   */
  async reverseConsumption(
    caller: AuthenticatedUser,
    movementId: string,
    dto: ReverseConsumptionDto,
    ipAddress: string,
  ): Promise<SparePartMovementRow> {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const original = await tx.sparePartMovement.findUnique({
          where: { id: movementId },
          include: { reversedBy: { select: { id: true } } },
        });
        if (!original) throw new NotFoundException('Movement not found');
        assertInScope(caller, original, 'Movement');
        if (original.type !== SparePartMovementType.consumption) {
          throw new ConflictException(
            'Only a consumption can be reversed. Correct a receipt by recording a ' +
              'fresh one.',
          );
        }
        if (original.reversedBy) {
          throw new ConflictException(
            'This consumption has already been reversed.',
          );
        }

        // Lock before restoring, for the same reason consumption locks before
        // deducting.
        await this.lockPart(tx, original.sparePartId);

        const quantity = Number(original.quantity);
        const amount = Number(original.amount);

        const reversal = await tx.sparePartMovement.create({
          data: {
            companyId: original.companyId,
            sparePartId: original.sparePartId,
            type: SparePartMovementType.reversal,
            quantity,
            rate: original.rate,
            amount,
            movementDate: original.movementDate,
            maintenanceJobId: original.maintenanceJobId,
            reversalOfId: original.id,
            reason: dto.reason.trim(),
            createdByUserId: caller.id,
          },
          include: {
            sparePart: { select: { partNumber: true, name: true } },
            reversedBy: { select: { id: true } },
          },
        });

        await tx.sparePart.update({
          where: { id: original.sparePartId },
          data: { stockQuantity: { increment: quantity } },
        });
        if (original.maintenanceJobId) {
          await tx.maintenanceJob.update({
            where: { id: original.maintenanceJobId },
            data: { partsCost: { decrement: amount } },
          });
        }

        return reversal;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SPARE_PART_MOVEMENT,
      action: AuditAction.DELETE,
      entityId: movementId,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: { reversalId: created.id, reason: dto.reason },
    });
    return this.toMovementRow(created);
  }

  /** The movement history for one part, or for one maintenance job. */
  async listMovements(
    caller: AuthenticatedUser,
    filters: { sparePartId?: string; maintenanceJobId?: string },
  ): Promise<SparePartMovementRow[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.sparePartMovement.findMany({
          where: {
            ...companyScope(caller),
            deletedAt: null,
            ...(filters.sparePartId
              ? { sparePartId: filters.sparePartId }
              : {}),
            ...(filters.maintenanceJobId
              ? { maintenanceJobId: filters.maintenanceJobId }
              : {}),
          },
          orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
          include: {
            sparePart: { select: { partNumber: true, name: true } },
            reversedBy: { select: { id: true } },
          },
        }),
    );
    return rows.map((row) => this.toMovementRow(row));
  }

  /**
   * The FR-024 reconciliation view.
   *
   * Lists every part that declares an inventory-item link, with both balances side
   * by side. The two are independent by design — they are different stocks in
   * different places — so the point of the view is not to make them agree, it is to
   * make a divergence visible instead of letting the same physical shelf be counted
   * twice in two modules and noticed by nobody.
   */
  async reconciliation(caller: AuthenticatedUser): Promise<{
    items: {
      sparePartId: string;
      partNumber: string;
      partName: string;
      plantStock: number;
      plantAvgRate: number;
      linkedInventoryItemId: string;
      inventoryItemName: string | null;
      inventoryStock: number | null;
      inventoryAvgRate: number | null;
      /** `plantStock − inventoryStock`, or null when inventory could not answer. */
      difference: number | null;
    }[];
  }> {
    const parts = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.sparePart.findMany({
          where: {
            ...companyScope(caller),
            linkedInventoryItemId: { not: null },
          },
          orderBy: { partNumber: 'asc' },
        }),
    );

    const itemIds = parts.flatMap((part) =>
      part.linkedInventoryItemId ? [part.linkedInventoryItemId] : [],
    );
    // Through the owning module's exported service, never a join into `inventory`
    // (Principle I).
    const balances = await this.inventory.getItemStockTotals(caller, itemIds);

    return {
      items: parts.map((part) => {
        const linkedInventoryItemId = part.linkedInventoryItemId as string;
        const balance = balances.get(linkedInventoryItemId) ?? null;
        const plantStock = Number(part.stockQuantity);
        return {
          sparePartId: part.id,
          partNumber: part.partNumber,
          partName: part.name,
          plantStock,
          plantAvgRate: Number(part.avgRate),
          linkedInventoryItemId,
          inventoryItemName: balance?.itemName ?? null,
          inventoryStock: balance?.inStock ?? null,
          inventoryAvgRate: balance?.avgRate ?? null,
          difference:
            balance === null
              ? null
              : Math.round((plantStock - balance.inStock) * 1000) / 1000,
        };
      }),
    };
  }

  /**
   * Locks one spare part row for the rest of the caller's transaction.
   *
   * `SELECT ... FOR UPDATE` rather than a plain read: the balance this returns is
   * about to be compared against a requested quantity and then decremented, and
   * without the lock two concurrent consumptions both read the same figure, both
   * pass, and both commit.
   */
  private async lockPart(
    tx: Prisma.TransactionClient,
    partId: string,
  ): Promise<{
    id: string;
    companyId: string;
    partNumber: string;
    unitOfMeasure: string;
    stockQuantity: number;
    avgRate: number;
    compatibleCategoryIds: string[];
  } | null> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        companyId: string;
        partNumber: string;
        unitOfMeasure: string;
        stockQuantity: Prisma.Decimal;
        avgRate: Prisma.Decimal;
        compatibleCategoryIds: string[];
      }[]
    >`
      SELECT "id", "companyId", "partNumber", "unitOfMeasure",
             "stockQuantity", "avgRate", "compatibleCategoryIds"
      FROM "plant"."SparePart"
      WHERE "id" = ${partId}
      FOR UPDATE
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      companyId: row.companyId,
      partNumber: row.partNumber,
      unitOfMeasure: row.unitOfMeasure,
      stockQuantity: Number(row.stockQuantity),
      avgRate: Number(row.avgRate),
      compatibleCategoryIds: row.compatibleCategoryIds,
    };
  }

  private toMovementRow(
    row: Prisma.SparePartMovementGetPayload<{
      include: {
        sparePart: { select: { partNumber: true; name: true } };
        reversedBy: { select: { id: true } };
      };
    }>,
  ): SparePartMovementRow {
    return {
      id: row.id,
      sparePartId: row.sparePartId,
      partNumber: row.sparePart.partNumber,
      partName: row.sparePart.name,
      type: row.type,
      quantity: Number(row.quantity),
      rate: Number(row.rate),
      amount: Number(row.amount),
      movementDate: row.movementDate,
      maintenanceJobId: row.maintenanceJobId,
      vendorId: row.vendorId,
      billReference: row.billReference,
      incompatiblePart: row.incompatiblePart,
      reversalOfId: row.reversalOfId,
      reversed: row.reversedBy !== null,
      reason: row.reason,
      createdAt: row.createdAt,
    };
  }
}
