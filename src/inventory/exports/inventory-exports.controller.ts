import {
  Controller,
  Get,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, PurchaseStatus } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { ListIssuesDto } from '../issues/dto/issue.dto';
import { IssuesService } from '../issues/issues.service';
import { ListPaymentsDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { ListPurchasesDto } from '../purchases/dto/purchase.dto';
import { PurchasesService } from '../purchases/purchases.service';
import { ListStockDto, StockLedgerExportDto } from '../stock/dto/stock.dto';
import { StockQueryService } from '../stock/stock-query.service';
import {
  allPages,
  buildWorkbook,
  dateCell,
  XLSX_TYPE,
} from './inventory-workbook';

const file = (data: Buffer, name: string) =>
  new StreamableFile(data, {
    type: XLSX_TYPE,
    disposition: contentDispositionFor(name),
  });

/**
 * The inventory registers as Excel (036 M12, M13) — each list's own filters, every page (up to
 * 5,000 rows), with a total row. Throttled as every export is (036 B9): each call reads the whole
 * filter.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/exports')
export class InventoryExportsController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly payments: PaymentsService,
    private readonly issues: IssuesService,
    private readonly stock: StockQueryService,
  ) {}

  @Get('purchases.xlsx')
  @ExportThrottle()
  @ApiOperation({ summary: 'Purchases (the list filters) as Excel' })
  async purchasesXlsx(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPurchasesDto,
  ): Promise<StreamableFile> {
    let totals = { amount: 0, paidAmount: 0 };
    const rows = await allPages(async (page, pageSize) => {
      const res = await this.purchases.findAll(caller, {
        ...query,
        page,
        pageSize,
      });
      totals = res.totals;
      return { rows: res.purchases, total: res.total };
    });
    const data = await buildWorkbook(
      'Purchases',
      [
        {
          header: 'Date',
          format: 'date',
          width: 12,
          value: (r) => dateCell(r.date),
        },
        { header: 'GRN', value: (r) => r.grnNumber },
        { header: 'PO', value: (r) => r.purchaseOrderRef },
        { header: 'Store', width: 22, value: (r) => r.siteName },
        { header: 'Item code', value: (r) => r.itemCode },
        { header: 'Item', width: 28, value: (r) => r.itemName },
        { header: 'Unit', width: 8, value: (r) => r.unit },
        { header: 'Quantity', format: 'quantity', value: (r) => r.quantity },
        { header: 'Rate', format: 'money', value: (r) => r.rate },
        { header: 'Amount', format: 'money', value: (r) => r.amount },
        { header: 'Vendor', width: 26, value: (r) => r.vendorName },
        { header: 'Paid', format: 'money', value: (r) => r.paidAmount },
        { header: 'Bill status', value: (r) => r.paymentStatus },
        {
          header: 'Status',
          value: (r) =>
            r.status === PurchaseStatus.partial_site
              ? 'Partially filled (Site)'
              : 'Completed',
        },
      ],
      rows,
      { Amount: totals.amount, Paid: totals.paidAmount },
    );
    return file(data, 'purchases.xlsx');
  }

  @Get('payments.xlsx')
  @ExportThrottle()
  @ApiOperation({ summary: 'Vendor payments (the list filters) as Excel' })
  async paymentsXlsx(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPaymentsDto,
  ): Promise<StreamableFile> {
    let totals = { amount: 0, allocatedAmount: 0 };
    const rows = await allPages(async (page, pageSize) => {
      const res = await this.payments.findAll(caller, {
        ...query,
        page,
        pageSize,
      });
      totals = res.totals;
      return { rows: res.payments, total: res.total };
    });
    const data = await buildWorkbook(
      'Payments',
      [
        {
          header: 'Date',
          format: 'date',
          width: 12,
          value: (r) => dateCell(r.date),
        },
        { header: 'Vendor', width: 26, value: (r) => r.vendorName },
        { header: 'Mode', value: (r) => r.paymentMode },
        { header: 'Reference', width: 20, value: (r) => r.referenceNumber },
        { header: 'Amount', format: 'money', value: (r) => r.amount },
        {
          header: 'Allocated',
          format: 'money',
          value: (r) => r.allocatedAmount,
        },
        {
          header: 'Unallocated',
          format: 'money',
          value: (r) => r.unallocatedBalance,
        },
        { header: 'Proof', value: (r) => (r.hasProof ? 'Yes' : 'No') },
      ],
      rows,
      { Amount: totals.amount, Allocated: totals.allocatedAmount },
    );
    return file(data, 'vendor-payments.xlsx');
  }

  @Get('issues.xlsx')
  @ExportThrottle()
  @ApiOperation({ summary: 'Material issues (the list filters) as Excel' })
  async issuesXlsx(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListIssuesDto,
  ): Promise<StreamableFile> {
    let quantity: number | null = null;
    const rows = await allPages(async (page, pageSize) => {
      const res = await this.issues.findAll(caller, {
        ...query,
        page,
        pageSize,
      });
      quantity = res.totals.quantity;
      return { rows: res.issues, total: res.total };
    });
    const data = await buildWorkbook(
      'Issues',
      [
        {
          header: 'Date',
          format: 'date',
          width: 12,
          value: (r) => dateCell(r.date),
        },
        { header: 'Slip no.', value: (r) => r.slipNo },
        { header: 'Store', width: 22, value: (r) => r.siteName },
        { header: 'Item code', value: (r) => r.itemCode },
        { header: 'Item', width: 28, value: (r) => r.itemName },
        { header: 'Unit', width: 8, value: (r) => r.unit },
        { header: 'Quantity', format: 'quantity', value: (r) => r.quantity },
        // 039: the mix a sub-item row was issued as part of, "DLC Concrete · 10 CUM".
        {
          header: 'Composite',
          width: 26,
          value: (r) =>
            r.compositeItemName
              ? `${r.compositeItemName} · ${r.compositeQuantity} ${
                  r.compositeUnit ?? ''
                }`.trim()
              : null,
        },
        {
          header: 'Returned',
          format: 'quantity',
          value: (r) => r.returnedQuantity,
        },
        { header: 'Issued to', width: 22, value: (r) => r.issuedTo },
        { header: 'Project', width: 24, value: (r) => r.projectName },
        { header: 'Vendor', width: 24, value: (r) => r.vendorName },
        { header: 'Equipment', value: (r) => r.equipmentNo },
      ],
      rows,
      quantity === null ? undefined : { Quantity: quantity },
    );
    return file(data, 'material-issues.xlsx');
  }

  @Get('stock.xlsx')
  @ExportThrottle()
  @ApiOperation({
    summary: 'Stock by item and store, with valuation, as Excel',
  })
  async stockXlsx(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListStockDto,
  ): Promise<StreamableFile> {
    let stockValue = 0;
    const rows = await allPages(async (page, pageSize) => {
      const res = await this.stock.list(caller, { ...query, page, pageSize });
      stockValue = res.totals.stockValue;
      return { rows: res.rows, total: res.total };
    });
    const data = await buildWorkbook(
      'Stock',
      [
        { header: 'Item code', value: (r) => r.itemCode },
        { header: 'Item', width: 28, value: (r) => r.itemName },
        { header: 'Category', value: (r) => r.category },
        { header: 'Store', width: 22, value: (r) => r.siteName },
        { header: 'Unit', width: 8, value: (r) => r.unit },
        { header: 'Received', format: 'quantity', value: (r) => r.received },
        { header: 'Issued', format: 'quantity', value: (r) => r.issued },
        {
          header: 'Transfer in',
          format: 'quantity',
          value: (r) => r.transferIn,
        },
        {
          header: 'Transfer out',
          format: 'quantity',
          value: (r) => r.transferOut,
        },
        { header: 'In stock', format: 'quantity', value: (r) => r.inStock },
        { header: 'Avg rate', format: 'money', value: (r) => r.avgRate },
        { header: 'Value', format: 'money', value: (r) => r.stockValue },
        {
          header: 'Reorder level',
          format: 'quantity',
          value: (r) => r.reorderLevel,
        },
      ],
      rows,
      { Value: stockValue },
    );
    return file(data, 'stock.xlsx');
  }

  @Get('stock-ledger.xlsx')
  @ExportThrottle()
  @ApiOperation({
    summary: 'One item at one store, movement by movement, as Excel',
  })
  async ledgerXlsx(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: StockLedgerExportDto,
  ): Promise<StreamableFile> {
    const ledger = await this.stock.ledger(
      caller,
      query.itemId,
      query.siteId,
      query,
    );
    const data = await buildWorkbook(
      'Ledger',
      [
        {
          header: 'Date',
          format: 'date',
          width: 12,
          value: (r) => (r.date ? dateCell(r.date) : null),
        },
        { header: 'Movement', width: 22, value: (r) => r.label },
        { header: 'Reference', width: 18, value: (r) => r.reference },
        { header: 'From / to', width: 26, value: (r) => r.counterparty },
        {
          header: 'In',
          format: 'quantity',
          value: (r) => r.quantityIn || null,
        },
        {
          header: 'Out',
          format: 'quantity',
          value: (r) => r.quantityOut || null,
        },
        { header: 'Rate', format: 'money', value: (r) => r.rate },
        { header: 'Balance', format: 'quantity', value: (r) => r.balance },
      ],
      [
        {
          date: null,
          label: `Opening balance — ${ledger.itemCode} ${ledger.itemName} at ${ledger.siteName}`,
          reference: null,
          counterparty: null,
          quantityIn: 0,
          quantityOut: 0,
          rate: null,
          balance: ledger.openingQuantity,
        },
        ...ledger.entries,
      ],
      {
        In: ledger.inQuantity,
        Out: ledger.outQuantity,
        Balance: ledger.closingQuantity,
      },
    );
    return file(data, `stock-ledger-${ledger.itemCode}.xlsx`);
  }
}
