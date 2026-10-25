import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
  PurchaseBillStatus,
  PurchaseSource,
  PurchaseStatus,
  StockLedgerType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { actorNameOf, actorNamesFor } from '../../common/actor-name';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { detectContentType } from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  IMAGE_TYPES,
  JPEG,
  PDF,
  PNG,
  WEBP,
} from '../../common/uploads';
import { VendorItemRateService } from '../rates/vendor-item-rate.service';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  GRN_CODE_INFIX,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { IndentFulfilmentService } from '../indents/indent-fulfilment.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { StockService } from '../stock/stock.service';
import { toNumber } from '../stock/stock.types';
import { cashHiddenError } from '../../common/cash/cash-policy';
import {
  billStatusFilterTx,
  billWithoutHiddenCash,
  cashHiddenCompaniesTx,
  hiddenCashByBillTx,
  hiddenCashPayment,
} from '../payments/cash-hiding';
import {
  CompletePurchaseDto,
  CreatePurchaseDto,
  GrnDetailsDto,
  ListPurchasesDto,
  UpdatePurchaseDto,
} from './dto/purchase.dto';
import { normaliseVehicleNo } from './vehicle-no';

/** Where bill uploads are stored. */
const BILL_NAMESPACE = 'purchase-bills';

/** What a bill may be: the vendor's PDF, or a photo of the paper bill (036 M11). */
const BILL_TYPES: readonly string[] = [PDF, JPEG, PNG, WEBP];

export interface PurchaseView {
  id: string;
  companyId: string;
  siteId: string;
  siteName: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  /** Null, with quantity, rate and amount, on a site entry Head Office has not completed (043). */
  vendorId: string | null;
  vendorName: string | null;
  date: Date;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  grnNumber: string | null;
  hasBillFile: boolean;
  paymentStatus: PurchaseBillStatus | null;
  paidAmount: number;
  indentLineId: string | null;
  /** The PO line received against, and the PO's reference and row, for the list (036 M9). */
  purchaseOrderLineId: string | null;
  purchaseOrderRef: string | null;
  purchaseOrderLineNo: number | null;
  /** Whether a delivery photograph is stored (036 M11) — `GET :id/photo`. */
  hasPhoto: boolean;
  /** How many delivery photos — `GET :id/photo?n=` serves each, from 1 (043: up to five). */
  photoCount: number;
  remarks: string | null;
  createdAt: Date;
  /** 043: a site entry waits as `partial_site` until Head Office completes it. */
  status: PurchaseStatus;
  source: PurchaseSource;
  vehicleNo: string | null;
  deliveredAt: Date | null;
  /** Where the site's photo was taken, as the server accepted it; null for Head Office purchases. */
  gps: {
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    capturedAt: Date | null;
    distanceMeters: number | null;
  } | null;
  createdByName: string | null;
  completedByName: string | null;
  completedAt: Date | null;
}

export interface PaginatedPurchases {
  purchases: PurchaseView[];
  /**
   * Across every page of the filter (036 M12): billed and paid, and the quantity only when one
   * item is filtered.
   */
  totals: { amount: number; paidAmount: number; quantity: number | null };
  total: number;
  page: number;
  pageSize: number;
}

/** The PO a purchase was received against, as the purchase list shows it (036 M9). */
function poRefOf(purchase: {
  purchaseOrderLineId: string | null;
  purchaseOrderLine?: {
    lineNo: number;
    purchaseOrder: { referenceNo: string | null };
  } | null;
}): Pick<
  PurchaseView,
  'purchaseOrderLineId' | 'purchaseOrderRef' | 'purchaseOrderLineNo'
> {
  return {
    purchaseOrderLineId: purchase.purchaseOrderLineId,
    purchaseOrderRef:
      purchase.purchaseOrderLine?.purchaseOrder.referenceNo ?? null,
    purchaseOrderLineNo: purchase.purchaseOrderLine?.lineNo ?? null,
  };
}

/** A purchase's delivery photos in the order taken — the first, then a site entry's others (043). */
function photoRefsOf(purchase: {
  photoFileRef: string | null;
  extraPhotoFileRefs: string[];
}): string[] {
  return [
    ...(purchase.photoFileRef ? [purchase.photoFileRef] : []),
    // `?? []`: the column is nullable in SQL (Prisma lists are), though every row gets `{}`.
    ...(purchase.extraPhotoFileRefs ?? []),
  ];
}

/** The 043 fields every purchase view carries, with the creator and completer named. */
function siteFieldsOf(
  purchase: {
    status: PurchaseStatus;
    source: PurchaseSource;
    vehicleNo: string | null;
    deliveredAt: Date | null;
    gpsLatitude: Prisma.Decimal | null;
    gpsLongitude: Prisma.Decimal | null;
    gpsAccuracyMeters: Prisma.Decimal | null;
    gpsCapturedAt: Date | null;
    geofenceDistanceMeters: Prisma.Decimal | null;
    createdByUserId: string | null;
    completedByUserId: string | null;
    completedAt: Date | null;
  },
  names: Map<string, string>,
): Pick<
  PurchaseView,
  | 'status'
  | 'source'
  | 'vehicleNo'
  | 'deliveredAt'
  | 'gps'
  | 'createdByName'
  | 'completedByName'
  | 'completedAt'
> {
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null);
  return {
    status: purchase.status,
    source: purchase.source,
    vehicleNo: purchase.vehicleNo,
    deliveredAt: purchase.deliveredAt,
    gps:
      purchase.gpsLatitude && purchase.gpsLongitude
        ? {
            latitude: toNumber(purchase.gpsLatitude),
            longitude: toNumber(purchase.gpsLongitude),
            accuracyMeters: purchase.gpsAccuracyMeters
              ? toNumber(purchase.gpsAccuracyMeters)
              : null,
            capturedAt: purchase.gpsCapturedAt,
            distanceMeters: purchase.geofenceDistanceMeters
              ? toNumber(purchase.geofenceDistanceMeters)
              : null,
          }
        : null,
    createdByName: nameOf(purchase.createdByUserId),
    completedByName: nameOf(purchase.completedByUserId),
    completedAt: purchase.completedAt,
  };
}

/** What a purchase's stock, bill and GRN are computed from — the create form's, or a completion's. */
interface ReceiptTerms {
  companyId: string;
  siteId: string;
  itemId: string;
  vendorId: string;
  quantity: number;
  rate: number;
  amount: number;
  date: Date;
  indentLineId: string | null;
  purchaseOrderLineId: string | null;
}

/** The GRN form's fields, with the vehicle number already normalised by the caller. */
type GrnFields = Omit<GrnDetailsDto, 'vehicleNo'> & {
  vehicleNo: string | null;
};

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
    private readonly rates: VendorItemRateService,
    private readonly purchaseOrders: PurchaseOrdersService,
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
      this.refs.requireActiveVendor(caller, dto.vendorId, targetCompanyId),
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
    // 036 M11/B4-B6: through the shared upload helpers — the 10 MB limit, the type read from
    // the bytes (the declared `billContentType` is no longer trusted: an HTML page declared as
    // a PDF was stored and served as whatever was claimed), and photos compressed. The bill may
    // be a PDF or a photo of the paper bill; the delivery photo must be a photo.
    //
    // TODO(VIRUS_SCAN): uploads are stored unscanned, the same gap 005's employee
    // documents and 007's contractor documents carry. The scan belongs between
    // decoding and `storage.put`, and is left explicit rather than faked.
    const billFileRef = dto.billFile
      ? await this.storeUpload(dto.billFile, BILL_TYPES, 'The bill')
      : null;

    // The delivery photograph (028 FR-017), stored exactly as the bill beside it. Optional today
    // because a purchase has no approval step to make it compulsory *before* — see the DTO's note.
    const photoFileRef = dto.photoFile
      ? await this.storeUpload(dto.photoFile, IMAGE_TYPES, 'The delivery photo')
      : null;

    const date = this.refs.parseDate(dto.date);
    // Rounded once, here, and stored: this is what the vendor billed, and
    // recomputing it on every read would let a rounding change restate history.
    const amount = Math.round(dto.quantity * dto.rate * 100) / 100;

    const terms: ReceiptTerms = {
      companyId: targetCompanyId,
      siteId: dto.siteId,
      itemId: dto.itemId,
      vendorId: dto.vendorId,
      quantity: dto.quantity,
      rate: dto.rate,
      amount,
      date,
      indentLineId: dto.indentLineId ?? null,
      purchaseOrderLineId: dto.purchaseOrderLineId ?? null,
    };

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const agreed = await this.assertReceivable(tx, terms);

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
            photoFileRef,
            remarks: dto.remarks?.trim() || null,
            indentLineId: dto.indentLineId ?? null,
            purchaseOrderLineId: dto.purchaseOrderLineId ?? null,
            createdByUserId: caller.id,
          },
          include: {
            purchaseOrderLine: { include: { purchaseOrder: true } },
          },
        });

        const grnNumber = await this.postReceipt(tx, purchase.id, terms, {
          agreed,
          grn: {
            ...dto.grn,
            vehicleNo: dto.grn?.vehicleNo?.trim().toUpperCase() || null,
          },
        });

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
      ...poRefOf(created.purchase),
      hasPhoto: photoFileRef !== null,
      photoCount: photoFileRef !== null ? 1 : 0,
      remarks: created.purchase.remarks,
      createdAt: created.purchase.createdAt,
      ...siteFieldsOf(
        created.purchase,
        new Map([[caller.id, actorNameOf(caller)]]),
      ),
    };
  }

  /**
   * Head Office completing a site entry (043): the vendor, quantity, rate and bill are added, and
   * only now does the delivery move stock — through exactly the steps `create` takes, so a completed
   * site entry is indistinguishable from a purchase recorded at the office.
   *
   * The row is locked first. A second completion racing this one waits, then finds it completed and
   * gets a 409; without the lock both would post the receipt and the stock would double.
   */
  async complete(
    caller: AuthenticatedUser,
    id: string,
    dto: CompletePurchaseDto,
    ipAddress: string,
  ): Promise<PurchaseView> {
    // Read outside the transaction only to resolve the company and validate references against it;
    // the status is checked again under the lock.
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.purchase.findUnique({ where: { id } }),
    );
    if (!found || found.deleted) {
      throw new NotFoundException(`Purchase ${id} not found`);
    }
    assertInScope(caller, found, `Purchase ${id}`);
    if (found.status !== PurchaseStatus.partial_site) {
      throw new ConflictException('This purchase is already completed.');
    }

    const [item] = await Promise.all([
      this.refs.requireItem(caller, dto.itemId, found.companyId),
      this.refs.requireActiveVendor(caller, dto.vendorId, found.companyId),
    ]);
    if (!item.active) {
      throw new BadRequestException(
        `Item ${item.code} is retired and cannot be purchased.`,
      );
    }
    const billFileRef = dto.billFile
      ? await this.storeUpload(dto.billFile, BILL_TYPES, 'The bill')
      : null;

    const date = this.refs.parseDate(dto.date);
    const amount = Math.round(dto.quantity * dto.rate * 100) / 100;
    // A vehicle typed on the GRN corrects the site's; left blank, the site's stands.
    const typedVehicleNo = dto.grn?.vehicleNo
      ? normaliseVehicleNo(dto.grn.vehicleNo) || null
      : null;
    const terms: ReceiptTerms = {
      companyId: found.companyId,
      siteId: found.siteId,
      itemId: dto.itemId,
      vendorId: dto.vendorId,
      quantity: dto.quantity,
      rate: dto.rate,
      amount,
      date,
      indentLineId: dto.indentLineId ?? null,
      purchaseOrderLineId: dto.purchaseOrderLineId ?? null,
    };

    const completed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "inventory"."Purchase" WHERE "id" = ${id} FOR UPDATE`;
        const locked = await tx.purchase.findUnique({ where: { id } });
        if (!locked || locked.deleted) {
          throw new NotFoundException(`Purchase ${id} not found`);
        }
        if (locked.status !== PurchaseStatus.partial_site) {
          throw new ConflictException('This purchase is already completed.');
        }

        const vehicleNo = typedVehicleNo ?? locked.vehicleNo;
        const agreed = await this.assertReceivable(tx, terms);
        const purchase = await tx.purchase.update({
          where: { id },
          data: {
            status: PurchaseStatus.completed,
            itemId: dto.itemId,
            vendorId: dto.vendorId,
            date,
            quantity: dto.quantity,
            rate: dto.rate,
            amount,
            vehicleNo,
            ...(billFileRef ? { billFileRef } : {}),
            remarks: dto.remarks?.trim() || locked.remarks,
            indentLineId: dto.indentLineId ?? null,
            purchaseOrderLineId: dto.purchaseOrderLineId ?? null,
            completedByUserId: caller.id,
            completedAt: new Date(),
          },
        });
        const grnNumber = await this.postReceipt(tx, id, terms, {
          agreed,
          grn: { ...dto.grn, vehicleNo },
        });
        return { before: locked, purchase, grnNumber, vehicleNo };
      },
    );

    // The site's item, date and vehicle as they were, beside what Head Office completed it with, so
    // a correction made while completing is in the history like one made through `update`.
    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        event: 'completed',
        before: {
          status: completed.before.status,
          itemId: completed.before.itemId,
          date: completed.before.date,
          vehicleNo: completed.before.vehicleNo,
        },
        after: {
          status: PurchaseStatus.completed,
          itemId: dto.itemId,
          date,
          vehicleNo: completed.vehicleNo,
          vendorId: dto.vendorId,
          quantity: dto.quantity,
          rate: dto.rate,
          amount,
        },
      },
      accountId: caller.id,
      companyId: found.companyId,
      ipAddress,
    });
    await this.auditLog.record({
      entityType: AuditEntityType.GOODS_RECEIPT_NOTE,
      action: AuditAction.CREATE,
      entityId: id,
      changes: { after: { grnNumber: completed.grnNumber } },
      accountId: caller.id,
      companyId: found.companyId,
      ipAddress,
    });

    return this.viewOf(caller, id);
  }

  /**
   * The checks a receipt must pass before its quantity is written (028 FR-012/FR-013, 036 M9).
   * Before the row is written, not after: the PO line's remaining quantity is summed from the
   * purchases already received against it, and this one must not count itself.
   */
  private async assertReceivable(
    tx: Prisma.TransactionClient,
    terms: ReceiptTerms,
  ): Promise<{ rate: Prisma.Decimal } | null> {
    // Inside the transaction so a concurrent first purchase of the same pair cannot slip between the
    // read and the write. A pair with an agreed rate must match it; a pair with none establishes one
    // in `postReceipt`. A known item from a vendor who has not supplied it before has no agreed
    // rate, so it is a first purchase — the contract is per vendor.
    const agreed = await this.rates.currentFor(
      tx,
      terms.companyId,
      terms.vendorId,
      terms.itemId,
    );
    this.rates.assertMatchesAgreed(agreed, terms.rate);

    // Received against a PO line, the line caps it — same item, the PO's vendor, and no more than is
    // left of what was ordered. Locked inside this transaction, so two deliveries racing for the last
    // of a line cannot both pass.
    if (terms.purchaseOrderLineId) {
      await this.purchaseOrders.assertReceivable(tx, {
        companyId: terms.companyId,
        purchaseOrderLineId: terms.purchaseOrderLineId,
        itemId: terms.itemId,
        vendorId: terms.vendorId,
        quantity: terms.quantity,
      });
    }
    return agreed;
  }

  /**
   * Everything a received purchase moves, in the caller's transaction: the agreed rate on a first
   * purchase, the ledger entry and stock balance, the unpaid bill, the GRN and the indent line.
   * Returns the GRN number.
   */
  private async postReceipt(
    tx: Prisma.TransactionClient,
    purchaseId: string,
    terms: ReceiptTerms,
    options: { agreed: { rate: Prisma.Decimal } | null; grn: GrnFields },
  ): Promise<string> {
    // The first purchase of a pair is what establishes the agreed rate (FR-012). Recorded after the
    // row exists, so the rate points at the purchase that set it — which is what makes FR-016's
    // first-purchase report answerable without inferring it from dates.
    if (!options.agreed) {
      await this.rates.establish(tx, {
        companyId: terms.companyId,
        vendorId: terms.vendorId,
        itemId: terms.itemId,
        rate: terms.rate,
        effectiveFrom: terms.date,
        purchaseId,
      });
    }

    await this.stock.appendLedgerEntry(tx, {
      companyId: terms.companyId,
      itemId: terms.itemId,
      siteId: terms.siteId,
      type: StockLedgerType.purchase,
      quantity: terms.quantity,
      rate: terms.rate,
      referenceId: purchaseId,
      date: terms.date,
    });

    await this.stock.upsertBalanceForPurchase(tx, {
      companyId: terms.companyId,
      itemId: terms.itemId,
      siteId: terms.siteId,
      quantity: terms.quantity,
      rate: terms.rate,
    });

    await tx.purchaseBill.create({
      data: {
        companyId: terms.companyId,
        purchaseId,
        vendorId: terms.vendorId,
        totalAmount: terms.amount,
        billDate: terms.date,
      },
    });

    // The GRN is created here, not by a later step, because FR-020 says "auto-generated on purchase
    // save": a purchase that committed without one would be a receipt nobody can acknowledge.
    const grnNumber = await this.codeSeries.next(
      tx,
      terms.companyId,
      CodeSeriesType.GRN,
      GRN_CODE_INFIX,
    );
    const grn = options.grn;
    await tx.goodsReceiptNote.create({
      data: {
        companyId: terms.companyId,
        purchaseId,
        grnNumber,
        siteId: terms.siteId,
        challanNo: grn.challanNo?.trim() || null,
        vehicleNo: grn.vehicleNo,
        receivedQuantity: grn.receivedQuantity ?? null,
        acceptedQuantity: grn.acceptedQuantity ?? null,
        rejectedQuantity: grn.rejectedQuantity ?? null,
        condition: grn.condition ?? null,
        batchDetails: grn.batchDetails?.trim() || null,
        discrepancy: grn.discrepancy?.trim() || null,
      },
    });

    if (terms.indentLineId) {
      await this.indentFulfilment.applyFulfilment(tx, {
        companyId: terms.companyId,
        indentLineId: terms.indentLineId,
        quantity: terms.quantity,
        itemId: terms.itemId,
        siteId: terms.siteId,
      });
    }
    return grnNumber;
  }

  /**
   * A purchase's change history, oldest first (043): created, every correction with what each field
   * was and became, and the completion. Read from the activity log, which is where it is kept.
   */
  async history(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<
    {
      action: AuditAction;
      at: Date;
      byName: string | null;
      changes: Prisma.JsonValue;
    }[]
  > {
    const purchase = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.purchase.findUnique({ where: { id } }),
    );
    if (!purchase) throw new NotFoundException(`Purchase ${id} not found`);
    assertInScope(caller, purchase, `Purchase ${id}`);

    const entries = await this.auditLog.listForEntity(
      AuditEntityType.PURCHASE,
      id,
    );
    const names = await actorNamesFor(
      this.prisma,
      entries.map((entry) => entry.accountId),
    );
    return entries.map((entry) => ({
      action: entry.action,
      at: entry.createdAt,
      byName: entry.accountId ? names.get(entry.accountId) ?? null : null,
      changes: entry.changes,
    }));
  }

  /** One purchase as the list shows it — what `complete` and `update` hand back. */
  private async viewOf(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<PurchaseView> {
    const page = await this.findAll(caller, {}, { id });
    const view = page.purchases[0];
    if (!view) throw new NotFoundException(`Purchase ${id} not found`);
    return view;
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListPurchasesDto,
    only?: { id: string },
  ): Promise<PaginatedPurchases> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const scope = companyScope(caller, query.companyId);
    const filters: Prisma.PurchaseWhereInput = {
      ...scope,
      // Soft-deleted purchases are absent from every list. They exist so the ledger
      // reversal has something to point at, not so they can be browsed.
      deleted: false,
      ...(only ? { id: only.id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.itemId ? { itemId: query.itemId } : {}),
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

    const { rows, total, sum, paid } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // 038: with cash hidden, a bill's paid figure (and its status) leaves out what cash paid
        // — worked out here from the stored total, never written back.
        const hidden = await cashHiddenCompaniesTx(tx, scope);
        const wanted = query.paymentStatus;
        const where: Prisma.PurchaseWhereInput = wanted
          ? {
              ...filters,
              bill: await billStatusFilterTx(tx, {
                base: { purchase: filters },
                hidden,
                matches: { paymentStatus: wanted },
                accepts: (status) => status === wanted,
              }),
            }
          : filters;
        const [found, total] = await Promise.all([
          tx.purchase.findMany({
            where,
            include: {
              bill: true,
              grn: true,
              purchaseOrderLine: { include: { purchaseOrder: true } },
            },
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.purchase.count({ where }),
        ]);
        const [sum, storedPaid, hiddenCash] = await Promise.all([
          tx.purchase.aggregate({
            where,
            _sum: { amount: true, quantity: true },
          }),
          tx.purchaseBill.aggregate({
            where: { purchase: where },
            _sum: { paidAmount: true },
          }),
          hidden.length > 0
            ? tx.paymentAllocation.aggregate({
                where: {
                  bill: { purchase: where },
                  payment: hiddenCashPayment(hidden),
                },
                _sum: { allocatedAmount: true },
              })
            : null,
        ]);
        const cash = await hiddenCashByBillTx(
          tx,
          found.flatMap((row) => (row.bill ? [row.bill.id] : [])),
          hidden,
        );
        const rows = found.map((row) =>
          row.bill
            ? { ...row, bill: billWithoutHiddenCash(row.bill, cash) }
            : row,
        );
        const paid =
          Math.round(
            (toNumber(storedPaid._sum.paidAmount) -
              toNumber(hiddenCash?._sum.allocatedAmount ?? null)) *
              100,
          ) / 100;
        return { rows, total, sum, paid };
      },
    );

    const [items, siteNames, vendorNames, people] = await Promise.all([
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
        rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
      ),
      actorNamesFor(
        this.prisma,
        rows.flatMap((row) => [row.createdByUserId, row.completedByUserId]),
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
          vendorName: row.vendorId
            ? vendorNames.get(row.vendorId) ?? 'Unknown vendor'
            : null,
          date: row.date,
          quantity: row.quantity === null ? null : toNumber(row.quantity),
          rate: row.rate === null ? null : toNumber(row.rate),
          amount: row.amount === null ? null : toNumber(row.amount),
          grnNumber: row.grn?.grnNumber ?? null,
          hasBillFile: row.billFileRef !== null,
          paymentStatus: row.bill?.paymentStatus ?? null,
          paidAmount: row.bill ? toNumber(row.bill.paidAmount) : 0,
          indentLineId: row.indentLineId,
          ...poRefOf(row),
          hasPhoto: row.photoFileRef !== null,
          photoCount: photoRefsOf(row).length,
          remarks: row.remarks,
          createdAt: row.createdAt,
          ...siteFieldsOf(row, people),
        };
      }),
      totals: {
        amount: toNumber(sum._sum.amount),
        paidAmount: paid,
        quantity: query.itemId ? toNumber(sum._sum.quantity) : null,
      },
      total,
      page,
      pageSize,
    };
  }

  /** The stored bill, for download, with the type read from its bytes (036 M11). */
  async getBillFile(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<{ buffer: Buffer; contentType: string; purchaseId: string }> {
    return this.storedFile(caller, id, 'bill');
  }

  /**
   * The delivery photograph (036 M11). It was stored from 028 on and could never be opened —
   * there was no route — so a photo taken at the gate as evidence was evidence nobody could see.
   */
  async getPhotoFile(
    caller: AuthenticatedUser,
    id: string,
    /** Which photo, from 1 — a site entry may carry up to five (043). */
    n = 1,
  ): Promise<{ buffer: Buffer; contentType: string; purchaseId: string }> {
    return this.storedFile(caller, id, 'photo', n);
  }

  private async storedFile(
    caller: AuthenticatedUser,
    id: string,
    which: 'bill' | 'photo',
    n = 1,
  ): Promise<{ buffer: Buffer; contentType: string; purchaseId: string }> {
    const purchase = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.purchase.findUnique({ where: { id } }),
    );
    if (!purchase || purchase.deleted) {
      throw new NotFoundException(`Purchase ${id} not found`);
    }
    assertInScope(caller, purchase, `Purchase ${id}`);
    const ref =
      which === 'bill'
        ? purchase.billFileRef
        : photoRefsOf(purchase)[n - 1] ?? null;
    if (!ref) {
      throw new NotFoundException(
        which === 'bill'
          ? `Purchase ${id} has no bill attached`
          : `Purchase ${id} has no delivery photo`,
      );
    }
    const buffer = await this.storage.get(ref);
    return {
      buffer,
      // Served as what the bytes are, never as `application/octet-stream`: the browser then
      // shows a PDF or a photo inline instead of downloading an unnamed file.
      contentType:
        detectContentType(buffer)?.contentType ?? 'application/octet-stream',
      purchaseId: purchase.id,
    };
  }

  /** Decode, check, compress and store one upload; returns its storage ref (036 B4-B6). */
  async storeUpload(
    payload: string,
    allowed: readonly string[],
    label: string,
  ): Promise<string> {
    const bytes = decodeBase64Upload(payload, label);
    const type = assertAllowedFileType(bytes, allowed, label);
    const image = await compressImageUpload(bytes, type.contentType);
    return this.storage.put(
      BILL_NAMESPACE,
      image?.main.data ?? bytes,
      image?.main.contentType ?? type.contentType,
    );
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdatePurchaseDto,
    ipAddress: string,
  ): Promise<PurchaseView> {
    const vehicleNo =
      dto.vehicleNo === undefined
        ? undefined
        : normaliseVehicleNo(dto.vehicleNo);
    if (vehicleNo === '') {
      throw new BadRequestException('Enter the vehicle number.');
    }

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.purchase.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Purchase ${id} not found`);
        }
        assertInScope(caller, existing, `Purchase ${id}`);

        // 043: a site entry has moved no stock yet, so its item and vehicle are still the site's
        // guesses to correct. Once completed, the item is what the ledger was computed from.
        const partial = existing.status === PurchaseStatus.partial_site;
        if (!partial && (dto.itemId !== undefined || vehicleNo !== undefined)) {
          throw new BadRequestException(
            'Only a site entry waiting for Head Office can have its item or vehicle number changed. ' +
              'Correcting a completed purchase is delete plus re-create.',
          );
        }
        if (dto.itemId !== undefined && dto.itemId !== existing.itemId) {
          const item = await this.refs.requireItem(
            caller,
            dto.itemId,
            existing.companyId,
          );
          if (!item.active) {
            throw new BadRequestException(
              `Item ${item.code} is retired and cannot be purchased.`,
            );
          }
        }

        // No rate check here, and that is not an omission (028 FR-013).
        //
        // `UpdatePurchaseDto` carries only `date` and `remarks`: quantity, rate, item, site and
        // vendor are absent **by design**, because the stock ledger and the bill were computed from
        // them and editing one in place would leave both restating history. Correcting a purchase
        // is delete plus re-create. Under the global pipe's `forbidNonWhitelisted` a caller sending
        // a rate here receives a 400 before this method runs.
        //
        // 028's research §5 claimed this endpoint accepted a rate from any caller and was wrong —
        // corrected there. The enforcement point is `create`, and the reason to hold it in the
        // service rather than the DTO still stands: a DTO can require a number, and only the
        // service can require *this* number.

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

        const saved = await tx.purchase.update({
          where: { id },
          data: {
            ...(date ? { date } : {}),
            ...(dto.remarks !== undefined
              ? { remarks: dto.remarks?.trim() || null }
              : {}),
            ...(dto.itemId !== undefined ? { itemId: dto.itemId } : {}),
            ...(vehicleNo !== undefined ? { vehicleNo } : {}),
          },
        });
        return { before: existing, saved };
      },
    );

    // The change history (043): what each changed field was and became, so a correction to what the
    // site recorded can be read back against what it originally said.
    const fields = ['date', 'remarks', 'itemId', 'vehicleNo'] as const;
    const changed = fields.filter(
      (field) => String(updated.before[field]) !== String(updated.saved[field]),
    );
    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        before: Object.fromEntries(
          changed.map((field) => [field, updated.before[field]]),
        ),
        after: {
          date: updated.saved.date,
          remarks: updated.saved.remarks,
          ...Object.fromEntries(
            changed.map((field) => [field, updated.saved[field]]),
          ),
        },
      },
      accountId: caller.id,
      companyId: updated.saved.companyId,
      ipAddress,
    });

    // 038: the paid figure handed back reads without hidden cash, as the list does — the list is
    // what builds it.
    return this.viewOf(caller, id);
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

        // 043: a site entry Head Office has not completed moved nothing — no ledger entry, balance,
        // bill or GRN — so deleting it is only the mark. Conditional for the same reason as below.
        if (existing.status === PurchaseStatus.partial_site) {
          const marked = await tx.purchase.updateMany({
            where: { id, deleted: false, status: PurchaseStatus.partial_site },
            data: { deleted: true, deletedAt: new Date() },
          });
          if (marked.count === 0) {
            throw new NotFoundException(`Purchase ${id} not found`);
          }
          return existing;
        }

        if (existing.bill && existing.bill.allocations.length > 0) {
          // 038: a bill paid in hidden cash would answer "delete the payment" about a payment the
          // caller cannot see or delete — it is refused as the cash it is.
          const hidden = await cashHiddenCompaniesTx(tx, {
            companyId: existing.companyId,
          });
          const cash = await hiddenCashByBillTx(tx, [existing.bill.id], hidden);
          if (cash.size > 0) throw cashHiddenError();
          throw new ConflictException(
            'This bill has allocated payments. Delete the payment before deleting the purchase.',
          );
        }

        // 036 M1: the received units must still be in the store to un-receive them. Without
        // this, deleting a purchase whose material had already been issued or transferred took
        // the balance negative — stock nobody could find, valued at a rate nobody paid. Locked
        // rather than read, so an issue racing this delete cannot consume the same units between
        // the check and the decrement.
        const quantity = toNumber(existing.quantity);
        const available = await this.stock.lockAvailable(tx, {
          itemId: existing.itemId,
          siteId: existing.siteId,
        });
        // Compared in thousandths — the column's own precision — so a float sum such as
        // 0.1 + 0.2 cannot refuse a delete that is exactly covered.
        if (Math.round(quantity * 1000) > Math.round(available * 1000)) {
          throw new UnprocessableEntityException({
            message:
              `This purchase cannot be deleted: ${quantity} was received but only ${available} ` +
              'is still in stock at this store — the rest has been issued or transferred. ' +
              'Return or reverse those movements first.',
            availableStock: available,
          });
        }

        // Conditional, so two simultaneous deletes cannot both reverse the same purchase: the
        // second waits on the balance lock above, then finds the row already deleted.
        const marked = await tx.purchase.updateMany({
          where: { id, deleted: false },
          data: { deleted: true, deletedAt: new Date() },
        });
        if (marked.count === 0) {
          throw new NotFoundException(`Purchase ${id} not found`);
        }

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
          data: { received: { decrement: quantity } },
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

    // 036 M11: the delivery photo goes with the purchase, after the delete has committed. It was
    // left behind in storage — an orphan nothing pointed at. Best effort: a storage hiccup must not
    // turn a completed delete into an error. The bill is kept, deliberately: it is the vendor's
    // document of a transaction that happened and was then reversed, and the soft-deleted row
    // still points at it for whoever audits the reversal.
    const photos = photoRefsOf(removed);
    if (photos.length > 0) {
      await this.storage.deleteMany(photos).catch(() => undefined);
    }
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
            status: PurchaseStatus.completed,
            date: { gte: range.from, lte: range.to },
          },
          _sum: { amount: true },
        }),
    );
    return toNumber(result._sum.amount);
  }

  /**
   * What the whole company spent on materials in one calendar month (2026-10-12).
   *
   * Added for the dashboard's Materials Cost card, which stood as a "waiting on the
   * inventory module" placeholder for the whole of the time the inventory module has
   * existed. It lives here rather than in `src/dashboard` because the query is
   * inventory's — the dashboard may not read `inventory.Purchase` itself (Principle I),
   * and `materialCostForSites` above is the same reasoning for the project P&L.
   *
   * Scoped through `companyScope`, so a cross-company caller who has selected a company
   * gets that company's figure rather than their own account's.
   *
   * Excludes soft-deleted purchases, exactly as every list does: a reversed purchase is
   * kept so the ledger entry has something to point at, not so it can be counted twice.
   */
  async monthlySpend(
    caller: AuthenticatedUser,
    month: { from: Date; to: Date },
    companyId?: string,
  ): Promise<number> {
    const result = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.purchase.aggregate({
          where: {
            ...companyScope(caller, companyId),
            deleted: false,
            status: PurchaseStatus.completed,
            date: { gte: month.from, lte: month.to },
          },
          _sum: { amount: true },
        }),
    );
    return toNumber(result._sum.amount);
  }
}
