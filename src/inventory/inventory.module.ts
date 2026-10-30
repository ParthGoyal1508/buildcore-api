import { forwardRef, Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { LettersModule } from '../letters/letters.module';
import { LabourModule } from '../labour/labour.module';
import { PartnersModule } from '../partners/partners.module';
import { ProjectsModule } from '../projects/projects.module';
import { CompositeItemsService } from '../settings/item-masters/composite-items.service';
import { ItemCategoriesService } from '../settings/item-masters/item-categories.service';
import { ItemsService } from '../settings/item-masters/items.service';
import { SettingsModule } from '../settings/settings.module';
import { StoreDocumentsController } from './documents/store-documents.controller';
import { StoreDocumentsService } from './documents/store-documents.service';
import { CategoriesController } from './categories/categories.controller';
import { InventoryExportsController } from './exports/inventory-exports.controller';
import { IndentFulfilmentService } from './indents/indent-fulfilment.service';
import { IndentsController } from './indents/indents.controller';
import { IndentsService } from './indents/indents.service';
import { InventoryRefsService } from './inventory-refs.service';
import { InventoryService } from './inventory.service';
import { InventoryItemsService } from './items/inventory-items.service';
import { CompositeItemsController } from './items/composite-items.controller';
import { ItemsController } from './items/items.controller';
import { IssuesController } from './issues/issues.controller';
import { IssuesService } from './issues/issues.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';
import { DailyRatesController } from './rates/daily-rates.controller';
import { DailyRatesService } from './rates/daily-rates.service';
import { VendorItemRateService } from './rates/vendor-item-rate.service';
import { SiteEntriesController } from './site-entries/site-entries.controller';
import { SiteEntriesService } from './site-entries/site-entries.service';
import { StockController } from './stock/stock.controller';
import { StockQueryService } from './stock/stock-query.service';
import { StockService } from './stock/stock.service';
import { TransfersController } from './transfers/transfers.controller';
import { TransfersService } from './transfers/transfers.service';

/**
 * The `inventory` module: stock, purchases, issues, transfers, vendor payments and
 * material indents.
 *
 * Three modules are imported, one for each kind of reference this schema stores as
 * a plain id: `SettingsModule` for the item master and the code series,
 * `ProjectsModule` for stores and BOQ references, `PartnersModule` for vendors.
 * Every one of those reads goes through an exported service — Principle I forbids
 * this schema being joined to any of theirs, and `InventoryRefsService` is where
 * that rule is kept honest in one place rather than five.
 *
 * `ItemCategoriesService` and `ItemsService` are declared here as providers rather
 * than imported: they own `settings`-schema tables and `SettingsModule` does not
 * export them. Declaring a second instance is safe because both are stateless, and
 * it is the same treatment `AuditLogService` gets in every feature module.
 */
@Module({
  // `LettersModule` for 036 M9: a purchase order is a letter, and its lines are read through
  // `LettersService.listForSubject` — never from `shared.IssuedLetter` directly.
  // forwardRef: ProjectsModule reaches back here through hr → payroll → plant (039).
  imports: [
    SettingsModule,
    forwardRef(() => ProjectsModule),
    PartnersModule,
    LettersModule,
    // 043: a site entry's store is the caller's assigned site, which `labour` owns. forwardRef: labour
    // reaches back here through projects → hr → payroll → plant.
    forwardRef(() => LabourModule),
  ],
  controllers: [
    CategoriesController,
    ItemsController,
    CompositeItemsController,
    StockController,
    PurchasesController,
    SiteEntriesController,
    IssuesController,
    TransfersController,
    PaymentsController,
    IndentsController,
    StoreDocumentsController,
    PurchaseOrdersController,
    InventoryExportsController,
    DailyRatesController,
  ],
  providers: [
    StockService,
    StockQueryService,
    PurchasesService,
    SiteEntriesService,
    PurchaseOrdersService,
    VendorItemRateService,
    DailyRatesService,
    IssuesService,
    TransfersService,
    PaymentsService,
    IndentsService,
    IndentFulfilmentService,
    StoreDocumentsService,
    InventoryItemsService,
    InventoryRefsService,
    InventoryService,
    ItemCategoriesService,
    ItemsService,
    CompositeItemsService,
    AuditLogService,
  ],
  // Exported for 008's Project P&L, which sums material cost from this module
  // (FR-009). `ItemsService` goes with it so a future consumer of the item master
  // has a service to call rather than a table to query.
  // `DailyRatesService` for 050: Machinery's fuel entry is offered the diesel rate of its date.
  exports: [InventoryService, ItemsService, DailyRatesService],
})
export class InventoryModule {}
