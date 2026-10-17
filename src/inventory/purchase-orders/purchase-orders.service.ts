import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  IssuedLetterView,
  LettersService,
} from '../../letters/letters.service';
import { LineItem, parseLineItems } from '../../letters/line-items';
import { effectiveCompanyId } from '../../settings/company-scope';
import { ItemsService } from '../../settings/item-masters/items.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { toNumber } from '../stock/stock.types';

/** The letter kind a purchase order is (2026-10-15, `purchase-orders/page.tsx`). */
export const PURCHASE_ORDER_KIND = 'letter_purchase_order';

/** Refused when a delivery would take a PO line past what was ordered (036 M9). */
export const PO_LINE_OVER_RECEIPT = 'PO_LINE_OVER_RECEIPT';
/** Refused when a delivery names a PO line it cannot be received against (036 M9). */
export const PO_LINE_MISMATCH = 'PO_LINE_MISMATCH';

export type PurchaseOrderStatus =
  | 'not_received'
  | 'partly_received'
  | 'received';

export interface PurchaseOrderSummary {
  id: string;
  letterId: string;
  referenceNo: string | null;
  version: number;
  vendorId: string | null;
  vendorName: string | null;
  issuedAt: Date;
  gstPercent: number;
  lineCount: number;
  /** The PO's basic value — the sum of its lines, as it prints "Gross Price". */
  orderedValue: number;
  /** Basic plus GST at the PO's rate, as it prints "Total Order Value". */
  orderedTotal: number;
  /** Value of what has been received against it: the purchases' amounts. */
  receivedValue: number;
  /** What the vendor's bills for those receipts come to. */
  billedAmount: number;
  /** What has been paid against those bills. */
  paidAmount: number;
  status: PurchaseOrderStatus;
}

export interface PurchaseOrderPaymentView {
  paymentId: string;
  date: Date;
  paymentMode: string;
  referenceNumber: string;
  allocatedAmount: number;
}

export interface PurchaseOrderDeliveryView {
  purchaseId: string;
  grnNumber: string | null;
  date: Date;
  siteId: string;
  siteName: string;
  quantity: number;
  rate: number;
  amount: number;
  billedAmount: number;
  paidAmount: number;
  paymentStatus: string | null;
  payments: PurchaseOrderPaymentView[];
}

export interface PurchaseOrderLineView {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  gstPercent: number;
  receivedQuantity: number;
  /** Never negative: a reissue that cut a line below what had arrived shows 0 remaining. */
  remainingQuantity: number;
  billedAmount: number;
  paidAmount: number;
  deliveries: PurchaseOrderDeliveryView[];
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  lines: PurchaseOrderLineView[];
}

export interface OpenPurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  letterId: string;
  referenceNo: string | null;
  lineNo: number;
  itemId: string;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  receivedQuantity: number;
  remainingQuantity: number;
}

type Tx = Prisma.TransactionClient;

/** Thousandths, the quantity column's precision, so float sums compare exactly. */
const milli = (value: number) => Math.round(value * 1000);

/**
 * `gstRate` as `expandLineItems` reads it — the same cleaning, the same 18 when blank or unreadable —
 * so the structured GST is the GST the PO printed.
 */
function gstPercentOf(raw: string | undefined): number {
  const cleaned = (raw ?? '').replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return 18;
  return Number(cleaned);
}

/**
 * The item code a row prints, if it was picked from the item master: the composer writes such a
 * row as `CODE - Name` (`line-items-editor.tsx`, "Material No. / Description").
 */
function codeOf(description: string): string | null {
  const at = description.indexOf(' - ');
  return at > 0 ? description.slice(0, at).trim() : null;
}

/**
 * Purchase orders, structured behind the unchanged PO letter (036 M9, 2026-10-17).
 *
 * The PO stays a letter: composed on the Purchase orders page, approved through its chain, issued as
 * the client's PDF — none of which this touches (`purchase-order-document.snapshot.spec.ts` fences
 * the printed document). What this adds is the structure behind it: the issued letter's lines,
 * stored as `PurchaseOrderLine` rows, so a delivery can be received against a line, receiving more
 * than was ordered is refused, and each PO can be followed to its GRNs, bills and payments.
 *
 * **Materialised on read.** The lines are read out of the issued letters the first time this
 * module is asked about purchase orders after they were issued (the PO list, a PO, or the line
 * picker on the purchase form), through `LettersService.listForSubject` — the letters module's
 * exported read; this module never queries `shared.IssuedLetter` (`letters-boundary.spec.ts`).
 * Doing it on read rather than from a hook inside the letters module keeps that module untouched
 * and opaque, and an issued letter cannot change afterwards, so reading it late reads the same
 * lines. A reissue is a new letter under the same reference: it is picked up the same way and
 * refreshes the lines in place (see `refresh`).
 *
 * Only issued, current versions are structured. A composed PO still in its approval chain is not an
 * order yet, and nothing may be received against it.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly letters: LettersService,
    private readonly items: ItemsService,
    private readonly refs: InventoryRefsService,
  ) {}

  /** Every structured PO of the selected company, with its ordered / received / billed / paid. */
  async list(
    caller: AuthenticatedUser,
    filters: { vendorId?: string } = {},
  ): Promise<PurchaseOrderSummary[]> {
    const companyId = this.companyOf(caller);
    await this.sync(caller, companyId);
    const orders = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.purchaseOrder.findMany({
          where: {
            companyId,
            ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
          },
          include: {
            lines: {
              include: {
                purchases: {
                  where: { deleted: false },
                  include: { bill: true },
                },
              },
            },
          },
          orderBy: [{ issuedAt: 'desc' }],
        }),
    );
    const vendorNames = await this.refs.vendorNames(
      caller,
      orders.flatMap((order) => (order.vendorId ? [order.vendorId] : [])),
    );
    return orders.map((order) =>
      this.summarise(
        order,
        order.vendorId ? vendorNames.get(order.vendorId) : null,
      ),
    );
  }

  /**
   * One PO, traced: each line with what was received against it — the purchase, its GRN number,
   * its bill — and the payments allocated to those bills. Found by the letter's id, which is what
   * the Purchase orders page lists, or by the PO row's own id.
   */
  async detail(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<PurchaseOrderDetail> {
    const companyId = this.companyOf(caller);
    await this.sync(caller, companyId);
    const order = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.purchaseOrder.findFirst({
          where: { companyId, OR: [{ id }, { letterId: id }] },
          include: {
            lines: {
              orderBy: { lineNo: 'asc' },
              include: {
                purchases: {
                  where: { deleted: false },
                  orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
                  include: {
                    grn: true,
                    bill: {
                      include: {
                        allocations: {
                          where: { payment: { deleted: false } },
                          include: { payment: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
    );
    if (!order) {
      // An issued PO this caller can see is always structured by the sync above, so "not found"
      // here means not issued yet, superseded, or not a PO at all.
      throw new NotFoundException(
        'No issued purchase order found. A PO is structured once it is issued; a superseded ' +
          'version is traced through the version that replaced it.',
      );
    }
    const vendorName = order.vendorId
      ? (await this.refs.vendorNames(caller, [order.vendorId])).get(
          order.vendorId,
        ) ?? null
      : null;
    const siteNames = await this.refs.siteNames(
      caller,
      order.lines.flatMap((line) => line.purchases.map((p) => p.siteId)),
    );

    return {
      ...this.summarise(order, vendorName),
      lines: order.lines.map((line) => {
        const totals = this.lineTotals(line);
        return {
          id: line.id,
          lineNo: line.lineNo,
          itemId: line.itemId,
          description: line.description,
          unit: line.unit,
          quantity: toNumber(line.quantity),
          rate: toNumber(line.rate),
          amount: toNumber(line.amount),
          gstPercent: toNumber(line.gstPercent),
          ...totals,
          deliveries: line.purchases.map((purchase) => ({
            purchaseId: purchase.id,
            grnNumber: purchase.grn?.grnNumber ?? null,
            date: purchase.date,
            siteId: purchase.siteId,
            siteName: siteNames.get(purchase.siteId) ?? 'Unknown store',
            quantity: toNumber(purchase.quantity),
            rate: toNumber(purchase.rate),
            amount: toNumber(purchase.amount),
            billedAmount: purchase.bill
              ? toNumber(purchase.bill.totalAmount)
              : 0,
            paidAmount: purchase.bill ? toNumber(purchase.bill.paidAmount) : 0,
            paymentStatus: purchase.bill?.paymentStatus ?? null,
            payments: (purchase.bill?.allocations ?? []).map((allocation) => ({
              paymentId: allocation.paymentId,
              date: allocation.payment.date,
              paymentMode: allocation.payment.paymentMode,
              referenceNumber: allocation.payment.referenceNumber,
              allocatedAmount: toNumber(allocation.allocatedAmount),
            })),
          })),
        };
      }),
    };
  }

  /**
   * The lines a delivery can still be received against — for the purchase form's PO picker. Item
   * lines of current issued POs with something left to receive, narrowed to a vendor and an item
   * when given.
   */
  async openLines(
    caller: AuthenticatedUser,
    filters: { vendorId?: string; itemId?: string },
  ): Promise<OpenPurchaseOrderLine[]> {
    const companyId = this.companyOf(caller);
    await this.sync(caller, companyId);
    const lines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.purchaseOrderLine.findMany({
          where: {
            companyId,
            itemId: filters.itemId ? filters.itemId : { not: null },
            ...(filters.vendorId
              ? { purchaseOrder: { vendorId: filters.vendorId } }
              : {}),
          },
          include: {
            purchaseOrder: true,
            purchases: { where: { deleted: false }, include: { bill: true } },
          },
          orderBy: [{ purchaseOrder: { issuedAt: 'desc' } }, { lineNo: 'asc' }],
        }),
    );
    return lines
      .map((line) => ({ line, totals: this.lineTotals(line) }))
      .filter(({ totals }) => totals.remainingQuantity > 0)
      .map(({ line, totals }) => ({
        id: line.id,
        purchaseOrderId: line.purchaseOrderId,
        letterId: line.purchaseOrder.letterId,
        referenceNo: line.purchaseOrder.referenceNo,
        lineNo: line.lineNo,
        itemId: line.itemId as string,
        description: line.description,
        unit: line.unit,
        quantity: toNumber(line.quantity),
        rate: toNumber(line.rate),
        receivedQuantity: totals.receivedQuantity,
        remainingQuantity: totals.remainingQuantity,
      }));
  }

  /**
   * Refuses a delivery the PO line cannot take (036 M9) — called by `PurchasesService.create` inside
   * its transaction, before the purchase row is written.
   *
   * The line is locked first, so two deliveries racing for the last of a line cannot both pass the
   * check: the second waits, then counts the first. Then: the line must be an item-master line of
   * this company's PO, for the same item and the PO's vendor, with at least `quantity` left.
   */
  async assertReceivable(
    tx: Tx,
    input: {
      companyId: string;
      purchaseOrderLineId: string;
      itemId: string;
      vendorId: string;
      quantity: number;
    },
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "inventory"."PurchaseOrderLine" WHERE "id" = ${input.purchaseOrderLineId} FOR UPDATE`;
    const line = await tx.purchaseOrderLine.findFirst({
      where: { id: input.purchaseOrderLineId, companyId: input.companyId },
      include: { purchaseOrder: true },
    });
    const po = line?.purchaseOrder.referenceNo ?? 'the purchase order';
    if (!line) {
      throw new BadRequestException({
        statusCode: 400,
        code: PO_LINE_MISMATCH,
        message: 'That purchase order line does not exist in this company.',
      });
    }
    if (line.itemId !== input.itemId) {
      throw new BadRequestException({
        statusCode: 400,
        code: PO_LINE_MISMATCH,
        message: line.itemId
          ? `Line ${line.lineNo} of ${po} orders "${line.description}", not the item on this purchase.`
          : `Line ${line.lineNo} of ${po} ("${line.description}") was typed rather than picked from ` +
            'the item master, so material cannot be received against it.',
      });
    }
    if (
      line.purchaseOrder.vendorId &&
      line.purchaseOrder.vendorId !== input.vendorId
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: PO_LINE_MISMATCH,
        message: `${po} was placed on another vendor. Receive it from the vendor it was ordered from.`,
      });
    }
    const received = await tx.purchase.aggregate({
      where: { purchaseOrderLineId: line.id, deleted: false },
      _sum: { quantity: true },
    });
    const ordered = toNumber(line.quantity);
    const remaining = Math.max(
      0,
      (milli(ordered) - milli(toNumber(received._sum.quantity))) / 1000,
    );
    if (milli(input.quantity) > milli(remaining)) {
      throw new BadRequestException({
        statusCode: 400,
        code: PO_LINE_OVER_RECEIPT,
        message:
          remaining === 0
            ? `Line ${line.lineNo} of ${po} is fully received (${ordered} ${line.unit} ordered).`
            : `Line ${line.lineNo} of ${po} has ${remaining} ${line.unit} left to receive of ` +
              `${ordered} ordered — at most ${remaining} more.`,
        remainingQuantity: remaining,
      });
    }
  }

  /** The selected company before the home one — the company the letters module lists POs for. */
  private companyOf(caller: AuthenticatedUser): string {
    const companyId = effectiveCompanyId(caller);
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  /**
   * Structures every issued, current PO letter not yet structured — and the newest version of one
   * that was reissued. Cheap when there is nothing new: one list of letters and one of known ids.
   */
  private async sync(
    caller: AuthenticatedUser,
    companyId: string,
  ): Promise<void> {
    const issued = (
      await this.letters.listForSubject(caller, {
        letterKindKey: PURCHASE_ORDER_KIND,
      })
    ).filter((letter) => letter.issuedAt !== null && !letter.isSuperseded);
    if (issued.length === 0) return;

    const ctx = rlsContextFor(caller);
    const known = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.purchaseOrder.findMany({
        where: { companyId, letterId: { in: issued.map((l) => l.id) } },
        select: { letterId: true },
      }),
    );
    const knownIds = new Set(known.map((row) => row.letterId));
    const pending = issued.filter((letter) => !knownIds.has(letter.id));
    if (pending.length === 0) return;

    const parsed = pending.map((letter) => ({
      letter,
      lines: this.linesOf(letter),
      gstPercent: gstPercentOf(letter.composedVariables.gstRate),
    }));
    const itemIdByCode = await this.itemIdsByCode(
      caller,
      companyId,
      parsed.flatMap(({ lines }) =>
        lines.flatMap((line) => {
          const code = codeOf(line.description);
          return code ? [code] : [];
        }),
      ),
    );

    await withRlsContext(this.prisma, ctx, async (tx) => {
      // One structuring at a time per company, so two screens opening at once cannot both create
      // the same PO (the unique letter id would refuse the second with a 500).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase-order-sync:${companyId}`}))`;
      for (const { letter, lines, gstPercent } of parsed) {
        await this.refresh(
          tx,
          companyId,
          letter,
          lines,
          gstPercent,
          itemIdByCode,
        );
      }
    });
  }

  /**
   * Creates the PO row for an issued letter, or moves an existing one (same reference, older
   * version) onto it. Lines are matched by their row number: a reissue that corrects a quantity
   * updates that line, keeping the deliveries already received against it; a row the reissue
   * dropped is deleted when nothing was received against it, and kept at quantity 0 when something
   * was, so the receipt stays traceable and nothing more can arrive.
   */
  private async refresh(
    tx: Tx,
    companyId: string,
    letter: IssuedLetterView,
    lines: LineItem[],
    gstPercent: number,
    itemIdByCode: Map<string, string>,
  ): Promise<void> {
    if (await tx.purchaseOrder.findUnique({ where: { letterId: letter.id } })) {
      return; // structured by a concurrent request while this one waited on the lock
    }
    const existing = letter.referenceNo
      ? await tx.purchaseOrder.findFirst({
          where: { companyId, referenceNo: letter.referenceNo },
          include: {
            lines: { include: { _count: { select: { purchases: true } } } },
          },
        })
      : null;
    if (existing && existing.version > letter.version) return;

    const header = {
      letterId: letter.id,
      referenceNo: letter.referenceNo,
      version: letter.version,
      vendorId: letter.subjectType === 'vendor' ? letter.subjectId : null,
      issuedAt: letter.issuedAt as Date,
      gstPercent,
    };
    const order = existing
      ? await tx.purchaseOrder.update({
          where: { id: existing.id },
          data: header,
        })
      : await tx.purchaseOrder.create({ data: { companyId, ...header } });

    const rows = lines.map((line, index) => {
      const code = codeOf(line.description);
      return {
        lineNo: index + 1,
        itemId: (code && itemIdByCode.get(code.toLowerCase())) || null,
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        rate: line.rate,
        amount: line.amount,
        gstPercent,
      };
    });
    for (const row of rows) {
      await tx.purchaseOrderLine.upsert({
        where: {
          purchaseOrderId_lineNo: {
            purchaseOrderId: order.id,
            lineNo: row.lineNo,
          },
        },
        create: { companyId, purchaseOrderId: order.id, ...row },
        update: row,
      });
    }
    for (const dropped of (existing?.lines ?? []).filter(
      (line) => line.lineNo > rows.length,
    )) {
      if (dropped._count.purchases > 0) {
        await tx.purchaseOrderLine.update({
          where: { id: dropped.id },
          data: { quantity: 0, amount: 0 },
        });
      } else {
        await tx.purchaseOrderLine.delete({ where: { id: dropped.id } });
      }
    }
  }

  /**
   * The letter's lines through the parser that drew its table. Compose refuses unreadable lines,
   * so a throw here can only be a letter from before that check; it is structured with no lines
   * rather than blocking every other PO.
   */
  private linesOf(letter: IssuedLetterView): LineItem[] {
    try {
      return parseLineItems(letter.composedVariables.lineItems ?? '');
    } catch {
      return [];
    }
  }

  /** Item-master ids for the codes the rows print, matched exactly and ignoring case. */
  private async itemIdsByCode(
    caller: AuthenticatedUser,
    companyId: string,
    codes: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const code of new Set(codes.map((c) => c.toLowerCase()))) {
      const page = await this.items.findAll(caller, {
        search: code,
        companyId,
        page: 1,
        pageSize: 50,
      });
      const match = page.items.find(
        (item) =>
          item.companyId === companyId && item.code.toLowerCase() === code,
      );
      if (match) out.set(code, match.id);
    }
    return out;
  }

  private lineTotals(line: {
    quantity: Prisma.Decimal;
    purchases: {
      quantity: Prisma.Decimal;
      bill: { totalAmount: Prisma.Decimal; paidAmount: Prisma.Decimal } | null;
    }[];
  }) {
    const received = line.purchases.reduce(
      (sum, p) => sum + milli(toNumber(p.quantity)),
      0,
    );
    const billed = line.purchases.reduce(
      (sum, p) => sum + (p.bill ? toNumber(p.bill.totalAmount) : 0),
      0,
    );
    const paid = line.purchases.reduce(
      (sum, p) => sum + (p.bill ? toNumber(p.bill.paidAmount) : 0),
      0,
    );
    return {
      receivedQuantity: received / 1000,
      remainingQuantity:
        Math.max(0, milli(toNumber(line.quantity)) - received) / 1000,
      billedAmount: Math.round(billed * 100) / 100,
      paidAmount: Math.round(paid * 100) / 100,
    };
  }

  private summarise(
    order: {
      id: string;
      letterId: string;
      referenceNo: string | null;
      version: number;
      vendorId: string | null;
      issuedAt: Date;
      gstPercent: Prisma.Decimal;
      lines: {
        quantity: Prisma.Decimal;
        amount: Prisma.Decimal;
        purchases: {
          quantity: Prisma.Decimal;
          amount: Prisma.Decimal;
          bill: {
            totalAmount: Prisma.Decimal;
            paidAmount: Prisma.Decimal;
          } | null;
        }[];
      }[];
    },
    vendorName: string | null | undefined,
  ): PurchaseOrderSummary {
    const gstPercent = toNumber(order.gstPercent);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const orderedValue = round2(
      order.lines.reduce((sum, line) => sum + toNumber(line.amount), 0),
    );
    const totals = order.lines.map((line) => this.lineTotals(line));
    const receivedValue = round2(
      order.lines.reduce(
        (sum, line) =>
          sum + line.purchases.reduce((s, p) => s + toNumber(p.amount), 0),
        0,
      ),
    );
    const ordered = order.lines.filter((line) => toNumber(line.quantity) > 0);
    const anyReceived = totals.some((t) => t.receivedQuantity > 0);
    const allReceived =
      ordered.length > 0 &&
      order.lines.every(
        (line, i) =>
          toNumber(line.quantity) === 0 || totals[i].remainingQuantity === 0,
      );
    return {
      id: order.id,
      letterId: order.letterId,
      referenceNo: order.referenceNo,
      version: order.version,
      vendorId: order.vendorId,
      vendorName: vendorName ?? null,
      issuedAt: order.issuedAt,
      gstPercent,
      lineCount: order.lines.length,
      orderedValue,
      // Worked as the PO works it: GST on the basic total, each rounded to the paisa.
      orderedTotal: round2(
        orderedValue + round2((orderedValue * gstPercent) / 100),
      ),
      receivedValue,
      billedAmount: round2(totals.reduce((s, t) => s + t.billedAmount, 0)),
      paidAmount: round2(totals.reduce((s, t) => s + t.paidAmount, 0)),
      status: allReceived
        ? 'received'
        : anyReceived
        ? 'partly_received'
        : 'not_received',
    };
  }
}
