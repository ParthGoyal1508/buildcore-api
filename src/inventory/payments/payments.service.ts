import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  PaymentMode,
  Prisma,
  PurchaseBillStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { detectContentType } from '../../common/storage/file-type';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  JPEG,
  PDF,
  PNG,
  WEBP,
} from '../../common/uploads';
import { StorageService } from '../../common/storage/storage.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { InventoryRefsService } from '../inventory-refs.service';
import { toNumber } from '../stock/stock.types';
import { cashHiddenError, isCashHiddenTx } from '../../common/cash/cash-policy';
import {
  billStatusFilterTx,
  billWithoutHiddenCash,
  cashHiddenCompaniesTx,
  excludeHiddenCash,
  hiddenCashByBillTx,
} from './cash-hiding';
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
  /**
   * FR-021: whether the RTGS advice is attached.
   *
   * A boolean rather than the reference itself. The list needs to show which payments
   * lack proof; handing every row a storage key would put an internal identifier on a
   * screen for no reader's benefit.
   */
  hasProof: boolean;
  proofUploadedAt: Date | null;
  createdAt: Date;
}

/**
 * The create response: a `PaymentView` plus two additive fields (036 M10).
 *
 * `replayed` is true when an `Idempotency-Key` matched an earlier request and no new payment was
 * recorded. `warnings` carries non-blocking notices — today, a reference already used for the
 * same vendor.
 */
export interface CreatedPaymentView extends PaymentView {
  replayed: boolean;
  warnings: string[];
}

export interface PaginatedPayments {
  payments: PaymentView[];
  /** Across every page of the filter (036 M12). */
  totals: { amount: number; allocatedAmount: number };
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
    // 017 US7. The same encrypted blob path every other document in this product uses —
    // a second storage path for payment advices would be a second thing to encrypt,
    // back up and rotate.
    private readonly storage: StorageService,
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
    idempotencyKey?: string,
  ): Promise<CreatedPaymentView> {
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);

    // A repeat of a request already served (036 M10): answered with what the first one made,
    // before anything is validated or locked, so a double-click costs one read.
    if (idempotencyKey) {
      const replay = await this.replayOf(
        caller,
        targetCompanyId,
        idempotencyKey,
        dto,
      );
      if (replay) return replay;
    }

    const vendorName = await this.refs.requireActiveVendor(
      caller,
      dto.vendorId,
      targetCompanyId,
    );
    const date = this.refs.parseDate(dto.date);
    // Blank for a cash payment recorded without one (036 M10). The column stays NOT NULL and the
    // view keeps `referenceNumber: string`, so no reader has to learn a new null.
    const referenceNumber = dto.referenceNumber?.trim() ?? '';

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
            referenceNumber,
            allocatedAmount,
            idempotencyKey: idempotencyKey ?? null,
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
    ).catch(async (error: unknown) => {
      // Two requests with one key raced past the replay check above; the unique index let only
      // one commit. The loser's whole transaction rolled back — no bill was touched — and it
      // answers with the winner's payment, exactly as a later repeat would.
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.replayOf(
          caller,
          targetCompanyId,
          idempotencyKey,
          dto,
        );
        if (replay) return replay;
      }
      throw error;
    });
    if ('replayed' in created) return created;

    await this.auditLog.record({
      entityType: AuditEntityType.PAYMENT,
      action: AuditAction.CREATE,
      entityId: created.payment.id,
      changes: {
        after: {
          amount: dto.amount,
          // 038: lets the activity log recognise a cash payment after it is deleted.
          paymentMode: dto.paymentMode,
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
      hasProof: false,
      proofUploadedAt: null,
      createdAt: created.payment.createdAt,
      replayed: false,
      warnings: await this.duplicateReferenceWarnings(caller, {
        companyId: targetCompanyId,
        vendorId: dto.vendorId,
        referenceNumber,
        excludeId: created.payment.id,
      }),
    };
  }

  /**
   * The payment an `Idempotency-Key` already produced, as the create response — or null when the
   * key is new (036 M10).
   *
   * A key reused for a *different* payment is refused rather than replayed: answering "recorded"
   * for ₹50,000 to vendor B with the ₹5,000 payment to vendor A that first used the key would tell
   * the client a payment exists that does not. A key whose payment was since deleted is refused
   * too — replaying a deleted payment would report money that has been taken back.
   */
  private async replayOf(
    caller: AuthenticatedUser,
    companyId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ): Promise<CreatedPaymentView | null> {
    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.payment.findUnique({
          where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
          include: { _count: { select: { allocations: true } } },
        }),
    );
    if (!existing) return null;
    if (
      existing.vendorId !== dto.vendorId ||
      this.paise(toNumber(existing.amount)) !== this.paise(dto.amount)
    ) {
      throw new ConflictException(
        'This Idempotency-Key was already used for a different payment. Send a new key for a new payment.',
      );
    }
    if (existing.deleted) {
      throw new ConflictException(
        'The payment recorded with this Idempotency-Key has since been deleted. Send a new key to record it again.',
      );
    }
    const amount = toNumber(existing.amount);
    const allocated = toNumber(existing.allocatedAmount);
    const vendorNames = await this.refs.vendorNames(caller, [
      existing.vendorId,
    ]);
    return {
      id: existing.id,
      companyId: existing.companyId,
      vendorId: existing.vendorId,
      vendorName: vendorNames.get(existing.vendorId) ?? 'Unknown vendor',
      amount,
      date: existing.date,
      paymentMode: existing.paymentMode,
      referenceNumber: existing.referenceNumber,
      allocatedAmount: allocated,
      unallocatedBalance: this.paise(amount - allocated),
      allocatedBillCount: existing._count.allocations,
      hasProof: existing.proofRef !== null,
      proofUploadedAt: existing.proofUploadedAt,
      createdAt: existing.createdAt,
      replayed: true,
      warnings: [],
    };
  }

  /**
   * Warns — does not refuse — when the vendor already has a live payment with the same
   * reference (036 M10).
   *
   * Not a constraint: a cheque number or UPI reference can legitimately repeat (a reissued cheque,
   * a vendor's own numbering, a bank that recycles short references), so a hard unique would
   * block real payments. But the common case is a payment entered twice, and the person
   * recording it should be told while they can still delete one.
   */
  private async duplicateReferenceWarnings(
    caller: AuthenticatedUser,
    params: {
      companyId: string;
      vendorId: string;
      referenceNumber: string;
      excludeId: string;
    },
  ): Promise<string[]> {
    if (!params.referenceNumber) return [];
    const earlier = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) =>
        tx.payment.findFirst({
          where: {
            companyId: params.companyId,
            vendorId: params.vendorId,
            deleted: false,
            // 038: a hidden cash payment is not there to be warned about.
            ...excludeHiddenCash(
              await cashHiddenCompaniesTx(tx, { companyId: params.companyId }),
            ),
            id: { not: params.excludeId },
            referenceNumber: {
              equals: params.referenceNumber,
              mode: 'insensitive',
            },
          },
          orderBy: { createdAt: 'desc' },
          select: { date: true, amount: true },
        }),
    );
    if (!earlier) return [];
    const [y, m, d] = earlier.date.toISOString().slice(0, 10).split('-');
    return [
      `Reference ${params.referenceNumber} was already used for a payment of ` +
        `₹${toNumber(earlier.amount).toLocaleString(
          'en-IN',
        )} to this vendor on ${d}-${m}-${y}. ` +
        'Check this is not the same payment entered twice.',
    ];
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

    const scope = companyScope(caller, query.companyId);
    const filters: Prisma.PaymentWhereInput = {
      ...scope,
      deleted: false,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.paymentMode ? { paymentMode: query.paymentMode } : {}),
      // FR-021, as a filter rather than a count. "14 payments lack proof" makes somebody
      // scroll looking for them; `?missingProof=true` hands them the list.
      ...(query.missingProof === true ? { proofRef: null } : {}),
      ...(query.missingProof === false ? { proofRef: { not: null } } : {}),
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

    const { rows, total, sum } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // 038: cash payments of a company hiding cash are not listed, counted or summed — and a
        // `paymentMode=cash` filter there finds nothing.
        const where: Prisma.PaymentWhereInput = {
          ...filters,
          ...excludeHiddenCash(await cashHiddenCompaniesTx(tx, scope)),
        };
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
        const sum = await tx.payment.aggregate({
          where,
          _sum: { amount: true, allocatedAmount: true },
        });
        return { rows, total, sum };
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
          hasProof: row.proofRef !== null,
          proofUploadedAt: row.proofUploadedAt,
          createdAt: row.createdAt,
        };
      }),
      totals: {
        amount: toNumber(sum._sum.amount),
        allocatedAmount: toNumber(sum._sum.allocatedAmount),
      },
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
    const scope = companyScope(caller, query.companyId);
    const base: Prisma.PurchaseBillWhereInput = {
      ...scope,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    };
    const wanted = query.paymentStatus;

    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // 038: with cash hidden, a bill's paid figure leaves out its cash allocations — worked
        // out on read from the stored total, never written — and the status filter goes by that.
        const hidden = await cashHiddenCompaniesTx(tx, scope);
        const status = await billStatusFilterTx(tx, {
          base,
          hidden,
          matches: wanted
            ? { paymentStatus: wanted }
            : { paymentStatus: { not: PurchaseBillStatus.paid } },
          accepts: (s) =>
            wanted ? s === wanted : s !== PurchaseBillStatus.paid,
        });
        const bills = await tx.purchaseBill.findMany({
          where: { AND: [base, status] },
          orderBy: { billDate: 'asc' },
        });
        const cash = await hiddenCashByBillTx(
          tx,
          bills.map((bill) => bill.id),
          hidden,
        );
        return bills.map((bill) => billWithoutHiddenCash(bill, cash));
      },
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
        // 038: nobody deletes (and so reverses) a cash payment while the company hides cash.
        if (
          existing.paymentMode === PaymentMode.cash &&
          (await isCashHiddenTx(tx, existing.companyId))
        ) {
          throw cashHiddenError();
        }

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
      changes: { before: { paymentMode: removed.paymentMode } },
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }

  /**
   * A live payment by id, or null. For a cash payment while its company hides cash (038): null on
   * a read, so its proof answers 404 as if the payment had never been recorded, and 403
   * `CASH_HIDDEN` on a write (attaching a proof edits the payment).
   */
  private visiblePayment(
    ctx: ReturnType<typeof rlsContextFor>,
    paymentId: string,
    purpose: 'read' | 'write' = 'read',
  ) {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, deleted: false },
      });
      if (
        payment?.paymentMode === PaymentMode.cash &&
        (await isCashHiddenTx(tx, payment.companyId))
      ) {
        if (purpose === 'write') throw cashHiddenError();
        return null;
      }
      return payment;
    });
  }

  /**
   * Attach the transaction proof to a recorded payment (FR-020).
   *
   * Replacing an existing proof is allowed and the old blob is deliberately NOT deleted:
   * the first advice attached to a payment is itself a record of what somebody believed
   * at the time, and a bank re-issuing a corrected advice should not erase that.
   */
  async attachProof(
    caller: AuthenticatedUser,
    paymentId: string,
    input: { data: string },
    ipAddress: string,
  ): Promise<PaymentView> {
    const ctx = rlsContextFor(caller);
    const payment = await this.visiblePayment(ctx, paymentId, 'write');
    if (!payment) throw new NotFoundException(`Payment ${paymentId} not found`);
    assertInScope(caller, payment, `Payment ${paymentId}`);

    // 036 M11/B4-B6: the shared upload helpers — 413 past 10 MB, 415 for anything but a PDF or a
    // photo (read from the bytes; the declared `contentType` is no longer what is stored), and a
    // photographed advice compressed. These messages are what the screen now shows instead of a
    // generic failure.
    const bytes = decodeBase64Upload(input.data, 'The payment proof');
    const type = assertAllowedFileType(
      bytes,
      [PDF, JPEG, PNG, WEBP],
      'The payment proof',
    );
    const image = await compressImageUpload(bytes, type.contentType);
    const proofRef = await this.storage.put(
      `payment-proof/${payment.companyId}`,
      image?.main.data ?? bytes,
      image?.main.contentType ?? type.contentType,
    );

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.payment.update({
        where: { id: paymentId },
        data: { proofRef, proofUploadedAt: new Date() },
        include: { _count: { select: { allocations: true } } },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PAYMENT,
      action: AuditAction.UPDATE,
      entityId: paymentId,
      changes: {
        proofAttached: true,
        replaced: payment.proofRef !== null,
        paymentMode: payment.paymentMode,
      },
      accountId: caller.id,
      companyId: payment.companyId,
      ipAddress,
    });

    const vendorNames = await this.refs.vendorNames(caller, [updated.vendorId]);
    const amount = toNumber(updated.amount);
    const allocated = toNumber(updated.allocatedAmount);
    return {
      id: updated.id,
      companyId: updated.companyId,
      vendorId: updated.vendorId,
      vendorName: vendorNames.get(updated.vendorId) ?? 'Unknown vendor',
      amount,
      date: updated.date,
      paymentMode: updated.paymentMode,
      referenceNumber: updated.referenceNumber,
      allocatedAmount: allocated,
      unallocatedBalance: this.paise(amount - allocated),
      allocatedBillCount: updated._count.allocations,
      hasProof: true,
      proofUploadedAt: updated.proofUploadedAt,
      createdAt: updated.createdAt,
    };
  }

  /**
   * The proof itself (FR-020 scenario 3, FR-023).
   *
   * Audit-logged on READ, like every other restricted-document retrieval in 017: a
   * payment advice names an account number, and who looked at it is worth knowing.
   */
  async downloadProof(
    caller: AuthenticatedUser,
    paymentId: string,
    ipAddress: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const ctx = rlsContextFor(caller);
    const payment = await this.visiblePayment(ctx, paymentId);
    if (!payment) throw new NotFoundException(`Payment ${paymentId} not found`);
    assertInScope(caller, payment, `Payment ${paymentId}`);
    if (!payment.proofRef) {
      throw new NotFoundException(
        `Payment ${paymentId} has no transaction proof attached.`,
      );
    }

    // Written BEFORE the bytes, for the reason 017 US1 established: an entry that only
    // appears once the transfer succeeded cannot describe the retrieval that failed
    // halfway.
    await this.auditLog.record({
      entityType: AuditEntityType.PAYMENT,
      action: AuditAction.READ,
      entityId: paymentId,
      changes: { retrieved: 'proof', paymentMode: payment.paymentMode },
      accountId: caller.id,
      companyId: payment.companyId,
      ipAddress,
    });

    const data = await this.storage.get(payment.proofRef);
    // Typed from the bytes (036 M11), so the advice opens inline in the viewer.
    return {
      data,
      contentType:
        detectContentType(data)?.contentType ?? 'application/octet-stream',
    };
  }
}
