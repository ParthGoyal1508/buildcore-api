import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { PartnersModule } from '../partners/partners.module';
import { ProjectsModule } from '../projects/projects.module';
import { ItemCategoriesService } from '../settings/item-masters/item-categories.service';
import { ItemsService } from '../settings/item-masters/items.service';
import { SettingsModule } from '../settings/settings.module';
import { CategoriesController } from './categories/categories.controller';
import { IndentFulfilmentService } from './indents/indent-fulfilment.service';
import { IndentsController } from './indents/indents.controller';
import { IndentsService } from './indents/indents.service';
import { InventoryRefsService } from './inventory-refs.service';
import { InventoryService } from './inventory.service';
import { InventoryItemsService } from './items/inventory-items.service';
import { ItemsController } from './items/items.controller';
import { IssuesController } from './issues/issues.controller';
import { IssuesService } from './issues/issues.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';
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
  imports: [SettingsModule, ProjectsModule, PartnersModule],
  controllers: [
    CategoriesController,
    ItemsController,
    StockController,
    PurchasesController,
    IssuesController,
    TransfersController,
    PaymentsController,
    IndentsController,
  ],
  providers: [
    StockService,
    StockQueryService,
    PurchasesService,
    IssuesService,
    TransfersService,
    PaymentsService,
    IndentsService,
    IndentFulfilmentService,
    InventoryItemsService,
    InventoryRefsService,
    InventoryService,
    ItemCategoriesService,
    ItemsService,
    AuditLogService,
  ],
  // Exported for 008's Project P&L, which sums material cost from this module
  // (FR-009). `ItemsService` goes with it so a future consumer of the item master
  // has a service to call rather than a table to query.
  exports: [InventoryService, ItemsService],
})
export class InventoryModule {}
