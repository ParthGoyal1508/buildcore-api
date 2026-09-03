import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  StockLedgerType,
  TransferStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { InventoryRefsService } from '../inventory-refs.service';
import { StockService } from '../stock/stock.service';
import { toNumber } from '../stock/stock.types';
import {
  CreateTransferDto,
  ListTransfersDto,
  UpdateTransferDto,
} from './dto/transfer.dto';

export interface TransferView {
  id: string;
  companyId: string;
  fromSiteId: string;
  fromSiteName: string;
  toSiteId: string;
  toSiteName: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  date: Date;
  quantity: number;
  status: TransferStatus;
  remarks: string | null;
  createdAt: Date;
}

export interface PaginatedTransfers {
  transfers: TransferView[];
  total: number;
  page: number;
  pageSize: number;
}

/** `pending → in_transit → received`, and nothing else. A map rather than a chain
 * of ifs so the whole state machine is readable in one place. */
const NEXT_STATUS: Record<TransferStatus, TransferStatus[]> = {
  [TransferStatus.pending]: [
    TransferStatus.in_transit,
    TransferStatus.received,
  ],
  [TransferStatus.in_transit]: [TransferStatus.received],
  [TransferStatus.received]: [],
};

/**
 * Inter-site transfers.
 *
 * Both balances move at creation, not on receipt. The material has left the source
 * store the moment the transfer is recorded, and holding the decrement until
 * someone confirms receipt would leave the same units issuable from the source
 * store while they are on a truck. `status` tracks the physical movement only.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly stock: StockService,
    private readonly refs: InventoryRefsService,
  ) {}

  async create(
    caller: AuthenticatedUser,
    dto: CreateTransferDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<TransferView> {
    if (dto.fromSiteId === dto.toSiteId) {
      // 400, not 422: a transfer to the same store is a malformed request, not one
      // the current stock happens to forbid.
      throw new BadRequestException(
        'Source and destination stores cannot be the same.',
      );
    }
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);

    const [item, fromSiteName, toSiteName] = await Promise.all([
      this.refs.requireItem(caller, dto.itemId, targetCompanyId),
      this.refs.requireSiteName(caller, dto.fromSiteId, targetCompanyId),
      this.refs.requireSiteName(caller, dto.toSiteId, targetCompanyId),
    ]);

    const date = this.refs.parseDate(dto.date);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.stock.validateAndLockStock(tx, {
          itemId: dto.itemId,
          siteId: dto.fromSiteId,
          quantity: dto.quantity,
          label: fromSiteName,
        });

        const transfer = await tx.stockTransfer.create({
          data: {
            companyId: targetCompanyId,
            fromSiteId: dto.fromSiteId,
            toSiteId: dto.toSiteId,
            itemId: dto.itemId,
            date,
            quantity: dto.quantity,
            remarks: dto.remarks?.trim() || null,
          },
        });

        await this.stock.appendLedgerEntry(tx, {
          companyId: targetCompanyId,
          itemId: dto.itemId,
          siteId: dto.fromSiteId,
          type: StockLedgerType.transfer_out,
          quantity: dto.quantity,
          referenceId: transfer.id,
          date,
        });
        await this.stock.appendLedgerEntry(tx, {
          companyId: targetCompanyId,
          itemId: dto.itemId,
          siteId: dto.toSiteId,
          type: StockLedgerType.transfer_in,
          quantity: dto.quantity,
          referenceId: transfer.id,
          date,
        });

        await tx.stockBalance.updateMany({
          where: { itemId: dto.itemId, siteId: dto.fromSiteId },
          data: { transferOut: { increment: dto.quantity } },
        });

        // Upsert, not update: the destination may never have received this item, in
        // which case it has no balance row at all (H-001). An update would silently
        // affect zero rows and the material would vanish in transit.
        await this.stock.ensureBalance(tx, {
          companyId: targetCompanyId,
          itemId: dto.itemId,
          siteId: dto.toSiteId,
        });
        await tx.stockBalance.updateMany({
          where: { itemId: dto.itemId, siteId: dto.toSiteId },
          data: { transferIn: { increment: dto.quantity } },
        });

        return transfer;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.STOCK_TRANSFER,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        after: {
          quantity: dto.quantity,
          fromSiteId: dto.fromSiteId,
          toSiteId: dto.toSiteId,
        },
      },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    return {
      id: created.id,
      companyId: targetCompanyId,
      fromSiteId: dto.fromSiteId,
      fromSiteName,
      toSiteId: dto.toSiteId,
      toSiteName,
      itemId: item.id,
      itemName: item.name,
      itemCode: item.code,
      unit: item.unit,
      date,
      quantity: dto.quantity,
      status: created.status,
      remarks: created.remarks,
      createdAt: created.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListTransfersDto,
  ): Promise<PaginatedTransfers> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.StockTransferWhereInput = {
      ...companyScope(caller, query.companyId),
      deleted: false,
      ...(query.fromSiteId ? { fromSiteId: query.fromSiteId } : {}),
      ...(query.toSiteId ? { toSiteId: query.toSiteId } : {}),
      ...(query.itemId ? { itemId: query.itemId } : {}),
      ...(query.status ? { status: query.status } : {}),
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
          tx.stockTransfer.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.stockTransfer.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const [items, siteNames] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        rows.map((row) => row.itemId),
      ),
      this.refs.siteNames(caller, [
        ...rows.map((row) => row.fromSiteId),
        ...rows.map((row) => row.toSiteId),
      ]),
    ]);

    return {
      transfers: rows.map((row) => {
        const item = items.get(row.itemId);
        return {
          id: row.id,
          companyId: row.companyId,
          fromSiteId: row.fromSiteId,
          fromSiteName: siteNames.get(row.fromSiteId) ?? 'Unknown store',
          toSiteId: row.toSiteId,
          toSiteName: siteNames.get(row.toSiteId) ?? 'Unknown store',
          itemId: row.itemId,
          itemName: item?.name ?? 'Unknown item',
          itemCode: item?.code ?? '',
          unit: item?.unit ?? '',
          date: row.date,
          quantity: toNumber(row.quantity),
          status: row.status,
          remarks: row.remarks,
          createdAt: row.createdAt,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async updateStatus(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateTransferDto,
    ipAddress: string,
  ): Promise<{ id: string; status: TransferStatus }> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.stockTransfer.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Transfer ${id} not found`);
        }
        assertInScope(caller, existing, `Transfer ${id}`);

        if (!NEXT_STATUS[existing.status].includes(dto.status)) {
          throw new ConflictException(
            `A transfer cannot go from ${existing.status} to ${dto.status}.`,
          );
        }

        return tx.stockTransfer.update({
          where: { id },
          data: { status: dto.status },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.STOCK_TRANSFER,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { status: updated.status } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return { id: updated.id, status: updated.status };
  }

  /**
   * Soft-deletes a transfer and reverts both balances.
   *
   * Refused once the destination has confirmed receipt: at that point the material
   * is physically at the other store, and a reversal would claim it is back where
   * it started.
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
        const existing = await tx.stockTransfer.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Transfer ${id} not found`);
        }
        assertInScope(caller, existing, `Transfer ${id}`);

        if (existing.status === TransferStatus.received) {
          throw new ConflictException(
            'This transfer has been received at the destination and can no longer be deleted.',
          );
        }

        const quantity = toNumber(existing.quantity);

        // The destination's stock is locked before anything is written: the
        // material has to still be there to send back, and another issue at the
        // destination may have consumed it in the meantime.
        await this.stock.validateAndLockStock(tx, {
          itemId: existing.itemId,
          siteId: existing.toSiteId,
          quantity,
          label: 'the destination store',
        });

        await tx.stockTransfer.update({
          where: { id },
          data: { deleted: true, deletedAt: new Date() },
        });

        await this.stock.appendLedgerEntry(tx, {
          companyId: existing.companyId,
          itemId: existing.itemId,
          siteId: existing.fromSiteId,
          type: StockLedgerType.transfer_out_reversal,
          quantity,
          referenceId: existing.id,
          date: existing.date,
        });
        await this.stock.appendLedgerEntry(tx, {
          companyId: existing.companyId,
          itemId: existing.itemId,
          siteId: existing.toSiteId,
          type: StockLedgerType.transfer_in_reversal,
          quantity,
          referenceId: existing.id,
          date: existing.date,
        });

        await tx.stockBalance.updateMany({
          where: { itemId: existing.itemId, siteId: existing.fromSiteId },
          data: { transferOut: { decrement: quantity } },
        });
        await tx.stockBalance.updateMany({
          where: { itemId: existing.itemId, siteId: existing.toSiteId },
          data: { transferIn: { decrement: quantity } },
        });

        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.STOCK_TRANSFER,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
