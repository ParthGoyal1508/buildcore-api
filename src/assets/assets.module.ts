import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PartnersModule } from '../partners/partners.module';
import { ProjectsModule } from '../projects/projects.module';
import { AssetCategoriesService } from '../settings/asset-masters/asset-categories.service';
import { AssetDocTypesService } from '../settings/asset-masters/asset-doc-types.service';
import { ConditionGradesService } from '../settings/asset-masters/condition-grades.service';
import { CodeSeriesService } from '../settings/code-series/code-series.service';
import { SettingsModule } from '../settings/settings.module';
import { AllocationController } from './allocations/allocation.controller';
import { AllocationService } from './allocations/allocation.service';
import { AssetsRefsService } from './assets-refs.service';
import { AssetsService } from './assets.service';
import { AssetCategoriesController } from './masters/asset-categories.controller';
import { AssetDocTypesController } from './masters/asset-doc-types.controller';
import { ConditionGradesController } from './masters/condition-grades.controller';
import { AssetController } from './register/asset.controller';
import { AssetService } from './register/asset.service';
import { AssetStockController } from './stock/asset-stock.controller';
import { AssetStockService } from './stock/asset-stock.service';
import { AssetSummaryService } from './summary/asset-summary.service';

/**
 * The `assets` module: register, per-site stock, allocation and custody, and the
 * register summary and export.
 *
 * Five modules are imported, one for each kind of reference this schema stores as a
 * plain id: `SettingsModule` for the code series, `ProjectsModule` for sites,
 * `PartnersModule` for vendors, `HrModule` for custodians, and `InventoryModule` for
 * the purchase an asset was acquired through. Every one of those reads goes through
 * an exported service — Principle I forbids this schema being joined to any of
 * theirs, and `AssetsRefsService` is where that rule is kept honest in one place
 * rather than at each service that needs it.
 *
 * The three asset-master services are declared here as providers rather than
 * imported: they own `settings`-schema tables and `SettingsModule` does not export
 * them. Declaring a second instance is safe because all three are stateless, and it
 * is the same treatment the machinery masters get in `PlantModule`.
 */
@Module({
  imports: [
    SettingsModule,
    ProjectsModule,
    PartnersModule,
    HrModule,
    InventoryModule,
  ],
  // Order matters here. `AssetController` owns `GET /assets/:id`, which will match
  // `/assets/allocations` and `/assets/stock` if it is registered first — Nest
  // resolves routes in controller declaration order, so every controller with a
  // literal segment under `/assets` must come before it.
  controllers: [
    AssetCategoriesController,
    AssetDocTypesController,
    ConditionGradesController,
    AllocationController,
    AssetStockController,
    AssetController,
  ],
  providers: [
    AssetsService,
    AssetsRefsService,
    AssetService,
    AssetStockService,
    AllocationService,
    AssetSummaryService,
    AssetCategoriesService,
    AssetDocTypesService,
    ConditionGradesService,
    CodeSeriesService,
    AuditLogService,
  ],
  // Exported for 008's Project P&L once the asset-cost slice ships — see
  // `AssetsService` for why it currently reports itself unavailable.
  exports: [AssetsService],
})
export class AssetsModule {}
