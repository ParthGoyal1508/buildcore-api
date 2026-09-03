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
  Prisma,
  PurchaseBillStatus,
  StockLedgerType,
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
  GRN_CODE_INFIX,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { IndentFulfilmentService } from '../indents/indent-fulfilment.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { StockService } from '../stock/stock.service';
import { toNumber } from '../stock/stock.types';
import {
  CreatePurchaseDto,
  ListPurchasesDto,
  UpdatePurchaseDto,
} from './dto/purchase.dto';

/** Where bill uploads are stored. */
const BILL_NAMESPACE = 'purchase-bills';

export interface PurchaseView {
  id: string;
  companyId: string;
  siteId: string;
  siteName: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  vendorId: string;
  vendorName: string;
  date: Date;
  quantity: number;
  rate: number;
  amount: number;
  grnNumber: string | null;
  hasBillFile: boolean;
  paymentStatus: PurchaseBillStatus | null;
  paidAmount: number;
  indentLineId: string | null;
  remarks: string | null;
  createdAt: Date;
}

export interface PaginatedPurchases {
  purchases: PurchaseView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Purchases: the only thing in this module that adds stock, and therefore the only
 * thing that moves the weighted average rate.
 *
 * Every write is a dual write (FR-002): a `StockLedgerEntry` recording what
 * happened, and a `StockBalance` update recording what it means for the current
 * position. Both inside one transaction with the `Purchase`, `PurchaseBill` and
 * `GoodsReceiptNote` rows, because a balance that moved without a ledger row behind
 * it can never be reconstructed, and a ledger row whose balance never moved is a
 * silent shortfall on the stock screen.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly stock: StockService,
    private readonly refs: InventoryRefsService,
    private readonly codeSeries: CodeSeriesService,
    private readonly storage: StorageService,
    private readonly indentFulfilment: IndentFulfilmentService,
  ) {}

  async create(
    caller: AuthenticatedUser,
    dto: CreatePurchaseDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<PurchaseView> {
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);

    // Cross-module validation happens before the transaction opens. Each of these
    // is a call into another module's service, and holding a database transaction
    // open across them would keep the stock row locked for the duration of three
    // unrelated queries.
    const [item, siteName, vendorName] = await Promise.all([
      this.refs.requireItem(caller, dto.itemId, targetCompanyId),
      this.refs.requireSiteName(caller, dto.siteId, targetCompanyId),
      this.refs.requireVendorName(caller, dto.vendorId),
    ]);
    if (!item.active) {
      throw new BadRequestException(
        `Item ${item.code} is retired and cannot be purchased.`,
      );
    }

    // Uploaded before the transaction for the same reason: object storage is a
    // network round trip, and a failed upload should not have opened a transaction
    // at all.
    //
    // TODO(VIRUS_SCAN): uploads are stored unscanned, the same gap 005's employee
    // documents and 007's contractor documents carry. The scan belongs between
    // decoding and `storage.put`, and is left explicit rather than faked.
    let billFileRef: string | null = null;
    if (dto.billFile) {
      const buffer = Buffer.from(dto.billFile, 'base64');
      if (buffer.length === 0) {
        throw new BadRequestException(
          'billFile must be non-empty base64 content.',
        );
      }
      billFileRef = await this.storage.put(
        BILL_NAMESPACE,
        buffer,
        dto.billContentType ?? 'application/octet-stream',
      );
    }

    const date = this.refs.parseDate(dto.date);
    // Rounded once, here, and stored: this is what the vendor billed, and
    // recomputing it on every read would let a rounding change restate history.
    const amount = Math.round(dto.quantity * dto.rate * 100) / 100;

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const purchase = await tx.purchase.create({
          data: {
            companyId: targetCompanyId,
            siteId: dto.siteId,
            itemId: dto.itemId,
            vendorId: dto.vendorId,
            date,
            quantity: dto.quantity,
            rate: dto.rate,
            amount,
            billFileRef,
            remarks: dto.remarks?.trim() || null,
            indentLineId: dto.indentLineId ?? null,
          },
        });

        await this.stock.appendLedgerEntry(tx, {
          companyId: targetCompanyId,
          itemId: dto.itemId,
          siteId: dto.siteId,
          type: StockLedgerType.purchase,
          quantity: dto.quantity,
          rate: dto.rate,
          referenceId: purchase.id,
          date,
        });

        await this.stock.upsertBalanceForPurchase(tx, {
          companyId: targetCompanyId,
          itemId: dto.itemId,
          siteId: dto.siteId,
          quantity: dto.quantity,
          rate: dto.rate,
        });

        await tx.purchaseBill.create({
          data: {
            companyId: targetCompanyId,
            purchaseId: purchase.id,
            vendorId: dto.vendorId,
            totalAmount: amount,
            billDate: date,
          },
        });

        // The GRN is created here, not by a later step, because FR-020 says "auto-
        // generated on purchase save": a purchase that committed without one would
        // be a receipt nobody can acknowledge.
        const grnNumber = await this.codeSeries.next(
          tx,
          targetCompanyId,
          CodeSeriesType.GRN,
          GRN_CODE_INFIX,
        );
        await tx.goodsReceiptNote.create({
          data: {
            companyId: targetCompanyId,
            purchaseId: purchase.id,
            grnNumber,
            siteId: dto.siteId,
          },
        });

        if (dto.indentLineId) {
          await this.indentFulfilment.applyFulfilment(tx, {
            companyId: targetCompanyId,
            indentLineId: dto.indentLineId,
            quantity: dto.quantity,
          });
        }

        return { purchase, grnNumber };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.CREATE,
      entityId: created.purchase.id,
      changes: {
        after: { quantity: dto.quantity, rate: dto.rate, amount },
      },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    // The GRN gets its own entry rather than being folded into the purchase's.
    // It is a receipt acknowledgement with its own number that other modules cite,
    // and an activity log filtered to `GOODS_RECEIPT_NOTE` should find it — which
    // is what the entity type exists for.
    await this.auditLog.record({
      entityType: AuditEntityType.GOODS_RECEIPT_NOTE,
      action: AuditAction.CREATE,
      entityId: created.purchase.id,
      changes: { after: { grnNumber: created.grnNumber } },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    return {
      id: created.purchase.id,
      companyId: targetCompanyId,
      siteId: dto.siteId,
      siteName,
      itemId: item.id,
      itemName: item.name,
      itemCode: item.code,
      unit: item.unit,
      vendorId: dto.vendorId,
      vendorName,
      date,
      quantity: dto.quantity,
      rate: dto.rate,
      amount,
      grnNumber: created.grnNumber,
      hasBillFile: billFileRef !== null,
      paymentStatus: PurchaseBillStatus.unpaid,
      paidAmount: 0,
      indentLineId: dto.indentLineId ?? null,
      remarks: created.purchase.remarks,
      createdAt: created.purchase.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListPurchasesDto,
  ): Promise<PaginatedPurchases> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.PurchaseWhereInput = {
      ...companyScope(caller, query.companyId),
      // Soft-deleted purchases are absent from every list. They exist so the ledger
      // reversal has something to point at, not so they can be browsed.
      deleted: false,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.itemId ? { itemId: query.itemId } : {}),
      ...(query.paymentStatus
        ? { bill: { paymentStatus: query.paymentStatus } }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom
                ? { gte: this.refs.parseDate(query.dateFrom) }
                : {}),
              ...(query.dateTo
                ? { lte: this.refs.parseDate(query.dateTo) }
                : {}),
            },
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.purchase.findMany({
            where,
            include: { bill: true, grn: true },
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.purchase.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const [items, siteNames, vendorNames] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        rows.map((row) => row.itemId),
      ),
      this.refs.siteNames(
        caller,
        rows.map((row) => row.siteId),
      ),
      this.refs.vendorNames(
        caller,
        rows.map((row) => row.vendorId),
      ),
    ]);

    return {
      purchases: rows.map((row) => {
        const item = items.get(row.itemId);
        return {
          id: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          siteName: siteNames.get(row.siteId) ?? 'Unknown store',
          itemId: row.itemId,
          itemName: item?.name ?? 'Unknown item',
          itemCode: item?.code ?? '',
          unit: item?.unit ?? '',
          vendorId: row.vendorId,
          vendorName: vendorNames.get(row.vendorId) ?? 'Unknown vendor',
          date: row.date,
          quantity: toNumber(row.quantity),
          rate: toNumber(row.rate),
          amount: toNumber(row.amount),
          grnNumber: row.grn?.grnNumber ?? null,
          hasBillFile: row.billFileRef !== null,
          paymentStatus: row.bill?.paymentStatus ?? null,
          paidAmount: row.bill ? toNumber(row.bill.paidAmount) : 0,
          indentLineId: row.indentLineId,
          remarks: row.remarks,
          createdAt: row.createdAt,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /** The stored bill, for download. */
  async getBillFile(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<{ buffer: Buffer; purchaseId: string }> {
    const purchase = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.purchase.findUnique({ where: { id } }),
    );
    if (!purchase || purchase.deleted) {
      throw new NotFoundException(`Purchase ${id} not found`);
    }
    assertInScope(caller, purchase, `Purchase ${id}`);
    if (!purchase.billFileRef) {
      throw new NotFoundException(`Purchase ${id} has no bill attached`);
    }
    return {
      buffer: await this.storage.get(purchase.billFileRef),
      purchaseId: purchase.id,
    };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdatePurchaseDto,
    ipAddress: string,
  ): Promise<PurchaseView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.purchase.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Purchase ${id} not found`);
        }
        assertInScope(caller, existing, `Purchase ${id}`);

        const date = dto.date ? this.refs.parseDate(dto.date) : undefined;

        // The ledger entry's date moves with the purchase, or the WAR replay would
        // fold the movements in an order the purchase list no longer shows.
        if (date) {
          await tx.stockLedgerEntry.updateMany({
            where: { referenceId: id },
            data: { date },
          });
          await tx.purchaseBill.updateMany({
            where: { purchaseId: id },
            data: { billDate: date },
          });
        }

        return tx.purchase.update({
          where: { id },
          data: {
            ...(date ? { date } : {}),
            ...(dto.remarks !== undefined
              ? { remarks: dto.remarks?.trim() || null }
              : {}),
          },
          include: { bill: true, grn: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { date: updated.date, remarks: updated.remarks } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });

    const [item, siteName, vendorName] = await Promise.all([
      this.refs.requireItem(caller, updated.itemId, updated.companyId),
      this.refs.requireSiteName(caller, updated.siteId, updated.companyId),
      this.refs.requireVendorName(caller, updated.vendorId),
    ]);

    return {
      id: updated.id,
      companyId: updated.companyId,
      siteId: updated.siteId,
      siteName,
      itemId: updated.itemId,
      itemName: item.name,
      itemCode: item.code,
      unit: item.unit,
      vendorId: updated.vendorId,
      vendorName,
      date: updated.date,
      quantity: toNumber(updated.quantity),
      rate: toNumber(updated.rate),
      amount: toNumber(updated.amount),
      grnNumber: updated.grn?.grnNumber ?? null,
      hasBillFile: updated.billFileRef !== null,
      paymentStatus: updated.bill?.paymentStatus ?? null,
      paidAmount: updated.bill ? toNumber(updated.bill.paidAmount) : 0,
      indentLineId: updated.indentLineId,
      remarks: updated.remarks,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Soft-deletes a purchase and reverses everything it did (FR-004, FR-007).
   *
   * Refused outright once any payment has been allocated against its bill: money has
   * moved, and unwinding a purchase under a payment would leave the payment
   * allocated to a bill that no longer exists. The caller must unallocate first,
   * which means deleting the payment.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.purchase.findUnique({
          where: { id },
          include: { bill: { include: { allocations: true } } },
        });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Purchase ${id} not found`);
        }
        assertInScope(caller, existing, `Purchase ${id}`);

        if (existing.bill && existing.bill.allocations.length > 0) {
          throw new ConflictException(
            'This bill has allocated payments. Delete the payment before deleting the purchase.',
          );
        }

        await tx.purchase.update({
          where: { id },
          data: { deleted: true, deletedAt: new Date() },
        });

        await this.stock.appendLedgerEntry(tx, {
          companyId: existing.companyId,
          itemId: existing.itemId,
          siteId: existing.siteId,
          type: StockLedgerType.purchase_reversal,
          quantity: toNumber(existing.quantity),
          rate: toNumber(existing.rate),
          // The *original* purchase's id, not a new one: `recomputeWAR()` pairs a
          // reversal to what it cancels by this column.
          referenceId: existing.id,
          date: existing.date,
        });

        await tx.stockBalance.updateMany({
          where: { itemId: existing.itemId, siteId: existing.siteId },
          data: { received: { decrement: existing.quantity } },
        });

        // After the balance moves, not before: the replay reads the ledger and
        // writes the rate, and doing it first would compute against a quantity the
        // decrement above was about to change.
        await this.stock.recomputeWAR(tx, {
          companyId: existing.companyId,
          itemId: existing.itemId,
          siteId: existing.siteId,
        });

        // The bill and GRN go with it. Both are 1:1 records *of* this purchase, so
        // leaving them would show an outstanding payable for material that was
        // never received.
        if (existing.bill) {
          await tx.purchaseBill.delete({ where: { id: existing.bill.id } });
        }
        await tx.goodsReceiptNote.deleteMany({ where: { purchaseId: id } });

        if (existing.indentLineId) {
          await this.indentFulfilment.reverseFulfilment(tx, {
            indentLineId: existing.indentLineId,
            quantity: toNumber(existing.quantity),
          });
        }

        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }

  /**
   * Total purchase value for a set of sites in a date range — the query behind
   * `InventoryService.getMaterialCostByProject()` (FR-009).
   */
  async materialCostForSites(
    siteIds: string[],
    companyId: string,
    range: { from: Date; to: Date },
  ): Promise<number> {
    if (siteIds.length === 0) return 0;
    const result = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.purchase.aggregate({
          where: {
            companyId,
            siteId: { in: siteIds },
            deleted: false,
            date: { gte: range.from, lte: range.to },
          },
          _sum: { amount: true },
        }),
    );
    return toNumber(result._sum.amount);
  }
}
