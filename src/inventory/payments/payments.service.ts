import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  PaymentMode,
  Prisma,
  PurchaseBillStatus,
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
import { toNumber } from '../stock/stock.types';
import {
  CreatePaymentDto,
  ListBillsDto,
  ListPaymentsDto,
} from './dto/payment.dto';

export interface PaymentView {
  id: string;
  companyId: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  date: Date;
  paymentMode: PaymentMode;
  referenceNumber: string;
  allocatedAmount: number;
  /** `amount − allocatedAmount`. Positive when the payment exceeded what was owed. */
  unallocatedBalance: number;
  allocatedBillCount: number;
  createdAt: Date;
}

export interface PaginatedPayments {
  payments: PaymentView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BillView {
  id: string;
  purchaseId: string;
  vendorId: string;
  vendorName: string;
  billDate: Date;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  paymentStatus: PurchaseBillStatus;
}

/** A bill row as the FIFO walk needs it, straight from the locking query. */
interface LockedBill {
  id: string;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
}

/**
 * Vendor payments, allocated across bills automatically and oldest-first
 * (FR-005, research.md §7).
 *
 * The whole allocation is one transaction: the payment row, every
 * `PaymentAllocation`, and every `PurchaseBill` update. A partial allocation that
 * committed would leave money recorded as paid against bills that were never
 * updated, and no read afterwards could tell which.
 *
 * Bills are locked with `SELECT ... FOR UPDATE` in the same order every caller
 * takes them (oldest first), which is also what prevents deadlock between two
 * concurrent payments to the same vendor.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: InventoryRefsService,
  ) {}

  /** Rounds to paise. Every allocation arithmetic result goes through this, so a
   * repeating third decimal cannot accumulate across a long bill list. */
  private paise(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private statusFor(total: number, paid: number): PurchaseBillStatus {
    if (paid <= 0) return PurchaseBillStatus.unpaid;
    return paid >= total
      ? PurchaseBillStatus.paid
      : PurchaseBillStatus.part_paid;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreatePaymentDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<PaymentView> {
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);
    const vendorName = await this.refs.requireVendorName(caller, dto.vendorId);
    const date = this.refs.parseDate(dto.date);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // Oldest first, and locked in that order. Ordering by `billDate` and then
        // by `id` makes the sequence total: two bills dated the same day would
        // otherwise be locked in whatever order the planner chose, which is exactly
        // the condition two concurrent payments need to deadlock.
        const bills = await tx.$queryRaw<LockedBill[]>`
          SELECT "id", "totalAmount", "paidAmount"
          FROM "inventory"."PurchaseBill"
          WHERE "companyId" = ${targetCompanyId}
            AND "vendorId" = ${dto.vendorId}
            AND "paymentStatus" <> 'paid'::"inventory"."PurchaseBillStatus"
          ORDER BY "billDate" ASC, "id" ASC
          FOR UPDATE
        `;

        let remaining = dto.amount;
        const allocations: { billId: string; amount: number }[] = [];

        for (const bill of bills) {
          if (remaining <= 0) break;
          const outstanding = this.paise(
            toNumber(bill.totalAmount) - toNumber(bill.paidAmount),
          );
          if (outstanding <= 0) continue;

          const applied = this.paise(Math.min(remaining, outstanding));
          const paid = this.paise(toNumber(bill.paidAmount) + applied);

          await tx.purchaseBill.update({
            where: { id: bill.id },
            data: {
              paidAmount: paid,
              paymentStatus: this.statusFor(toNumber(bill.totalAmount), paid),
            },
          });

          allocations.push({ billId: bill.id, amount: applied });
          remaining = this.paise(remaining - applied);
        }

        const allocatedAmount = this.paise(dto.amount - remaining);

        const payment = await tx.payment.create({
          data: {
            companyId: targetCompanyId,
            vendorId: dto.vendorId,
            amount: dto.amount,
            date,
            paymentMode: dto.paymentMode,
            referenceNumber: dto.referenceNumber.trim(),
            allocatedAmount,
          },
        });

        if (allocations.length > 0) {
          await tx.paymentAllocation.createMany({
            data: allocations.map((allocation) => ({
              companyId: targetCompanyId,
              paymentId: payment.id,
              billId: allocation.billId,
              allocatedAmount: allocation.amount,
            })),
          });
        }

        return { payment, allocatedAmount, count: allocations.length };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PAYMENT,
      action: AuditAction.CREATE,
      entityId: created.payment.id,
      changes: {
        after: {
          amount: dto.amount,
          allocatedAmount: created.allocatedAmount,
          billsAllocated: created.count,
        },
      },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    return {
      id: created.payment.id,
      companyId: targetCompanyId,
      vendorId: dto.vendorId,
      vendorName,
      amount: dto.amount,
      date,
      paymentMode: dto.paymentMode,
      referenceNumber: created.payment.referenceNumber,
      allocatedAmount: created.allocatedAmount,
      // Over-payment is allowed and recorded, not refused: a vendor paid in advance
      // of billing is ordinary, and the balance sits here until the next purchase
      // is billed.
      unallocatedBalance: this.paise(dto.amount - created.allocatedAmount),
      allocatedBillCount: created.count,
      createdAt: created.payment.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListPaymentsDto,
  ): Promise<PaginatedPayments> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.PaymentWhereInput = {
      ...companyScope(caller, query.companyId),
      deleted: false,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.paymentMode ? { paymentMode: query.paymentMode } : {}),
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
          tx.payment.findMany({
            where,
            include: { _count: { select: { allocations: true } } },
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.payment.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const vendorNames = await this.refs.vendorNames(
      caller,
      rows.map((row) => row.vendorId),
    );

    return {
      payments: rows.map((row) => {
        const amount = toNumber(row.amount);
        const allocated = toNumber(row.allocatedAmount);
        return {
          id: row.id,
          companyId: row.companyId,
          vendorId: row.vendorId,
          vendorName: vendorNames.get(row.vendorId) ?? 'Unknown vendor',
          amount,
          date: row.date,
          paymentMode: row.paymentMode,
          referenceNumber: row.referenceNumber,
          allocatedAmount: allocated,
          unallocatedBalance: this.paise(amount - allocated),
          allocatedBillCount: row._count.allocations,
          createdAt: row.createdAt,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Outstanding bills for a vendor — what the payment form shows as an
   * informational balance before the amount is typed.
   */
  async findBills(
    caller: AuthenticatedUser,
    query: ListBillsDto,
  ): Promise<{ bills: BillView[]; totalOutstanding: number }> {
    const where: Prisma.PurchaseBillWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.paymentStatus
        ? { paymentStatus: query.paymentStatus }
        : { paymentStatus: { not: PurchaseBillStatus.paid } }),
    };

    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.purchaseBill.findMany({ where, orderBy: { billDate: 'asc' } }),
    );

    const vendorNames = await this.refs.vendorNames(
      caller,
      rows.map((row) => row.vendorId),
    );

    const bills = rows.map((row) => {
      const total = toNumber(row.totalAmount);
      const paid = toNumber(row.paidAmount);
      return {
        id: row.id,
        purchaseId: row.purchaseId,
        vendorId: row.vendorId,
        vendorName: vendorNames.get(row.vendorId) ?? 'Unknown vendor',
        billDate: row.billDate,
        totalAmount: total,
        paidAmount: paid,
        outstanding: this.paise(total - paid),
        paymentStatus: row.paymentStatus,
      };
    });

    return {
      bills,
      totalOutstanding: this.paise(
        bills.reduce((sum, bill) => sum + bill.outstanding, 0),
      ),
    };
  }

  /**
   * Deletes a payment and gives every bill its allocation back.
   *
   * Bills are locked before anything is written, in the same id order the
   * allocations are read in, so this cannot deadlock against a concurrent payment
   * to the same vendor.
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
        const existing = await tx.payment.findUnique({
          where: { id },
          include: { allocations: { orderBy: { billId: 'asc' } } },
        });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Payment ${id} not found`);
        }
        assertInScope(caller, existing, `Payment ${id}`);

        for (const allocation of existing.allocations) {
          const [bill] = await tx.$queryRaw<LockedBill[]>`
            SELECT "id", "totalAmount", "paidAmount"
            FROM "inventory"."PurchaseBill"
            WHERE "id" = ${allocation.billId}
            FOR UPDATE
          `;
          // The bill may already be gone if its purchase was deleted — which the
          // purchase delete refuses while an allocation exists, so this is a
          // belt-and-braces skip rather than an expected path.
          if (!bill) continue;

          const paid = Math.max(
            0,
            this.paise(
              toNumber(bill.paidAmount) - toNumber(allocation.allocatedAmount),
            ),
          );
          await tx.purchaseBill.update({
            where: { id: bill.id },
            data: {
              paidAmount: paid,
              paymentStatus: this.statusFor(toNumber(bill.totalAmount), paid),
            },
          });
        }

        await tx.paymentAllocation.deleteMany({ where: { paymentId: id } });
        await tx.payment.update({
          where: { id },
          data: { deleted: true, deletedAt: new Date(), allocatedAmount: 0 },
        });

        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PAYMENT,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
