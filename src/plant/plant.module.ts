import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PartnersModule } from '../partners/partners.module';
import { ProjectsModule } from '../projects/projects.module';
import { CodeSeriesService } from '../settings/code-series/code-series.service';
import { EquipmentCategoriesService } from '../settings/machinery-masters/equipment-categories.service';
import { EquipmentDocTypesService } from '../settings/machinery-masters/equipment-doc-types.service';
import { HireRatesService } from '../settings/machinery-masters/hire-rates.service';
import { SettingsModule } from '../settings/settings.module';
import { EquipmentCategoriesController } from './categories/equipment-categories.controller';
import { EquipmentDocTypesController } from './doc-types/equipment-doc-types.controller';
import { EquipmentController } from './equipment/equipment.controller';
import { EquipmentService } from './equipment/equipment.service';
import { FuelController } from './fuel/fuel.controller';
import { FuelService } from './fuel/fuel.service';
import { HireBillsController } from './hire-bills/hire-bills.controller';
import { HireBillsService } from './hire-bills/hire-bills.service';
import { LogbookController } from './logbook/logbook.controller';
import { LogbookService } from './logbook/logbook.service';
import { MaintenanceController } from './maintenance/maintenance.controller';
import { MaintenanceService } from './maintenance/maintenance.service';
import { PlantRefsService } from './plant-refs.service';
import { PlantService } from './plant.service';
import { HireRatesController } from './rates/hire-rates.controller';
import {
  EquipmentDocumentExpiryRule,
  EquipmentServiceDueRule,
} from './reminders/plant-reminder.rules';
import { ServiceBillsController } from './service-bills/service-bills.controller';
import { ServiceBillsService } from './service-bills/service-bills.service';
import { ServiceScheduleController } from './services/service-schedule.controller';
import { ServiceScheduleService } from './services/service-schedule.service';
import { SparePartsController } from './spare-parts/spare-parts.controller';
import { SparePartsService } from './spare-parts/spare-parts.service';

/**
 * The `plant` module: asset register, logbook, fuel, service schedules, maintenance
 * jobs, hire bills, spare parts and service bills.
 *
 * Five modules are imported, one for each kind of reference this schema stores as a
 * plain id: `SettingsModule` for the three machinery masters and the code series,
 * `ProjectsModule` for deployed sites, `PartnersModule` for vendors and their TDS,
 * `HrModule` for logbook operators, and `InventoryModule` for the linked-item
 * balance FR-024's reconciliation puts beside the workshop's own. Every one of those
 * reads goes through an exported service — Principle I forbids this schema being
 * joined to any of theirs, and `PlantRefsService` is where that rule is kept honest
 * in one place rather than eight.
 *
 * The three machinery-master services are declared here as providers rather than
 * imported: they own `settings`-schema tables and `SettingsModule` does not export
 * them. Declaring a second instance is safe because all three are stateless, and it
 * is the same treatment `AuditLogService` gets in every feature module and that
 * `ItemCategoriesService` gets in `InventoryModule`.
 *
 * The two reminder rules are ordinary providers. Nothing in `src/dashboard/` knows
 * they exist — the engine discovers them by decorator (004 FR-028), which is exactly
 * why registering them here required no edit there beyond deleting the placeholders
 * they replace.
 */
@Module({
  imports: [
    SettingsModule,
    ProjectsModule,
    PartnersModule,
    HrModule,
    InventoryModule,
  ],
  controllers: [
    EquipmentCategoriesController,
    EquipmentDocTypesController,
    HireRatesController,
    EquipmentController,
    LogbookController,
    FuelController,
    ServiceScheduleController,
    MaintenanceController,
    HireBillsController,
    SparePartsController,
    ServiceBillsController,
  ],
  providers: [
    PlantService,
    PlantRefsService,
    EquipmentService,
    LogbookService,
    FuelService,
    ServiceScheduleService,
    MaintenanceService,
    HireBillsService,
    SparePartsService,
    ServiceBillsService,
    EquipmentCategoriesService,
    EquipmentDocTypesService,
    HireRatesService,
    CodeSeriesService,
    AuditLogService,
    EquipmentDocumentExpiryRule,
    EquipmentServiceDueRule,
  ],
  // Exported for 008's Project P&L, which sums machinery and fuel cost from this
  // module (FR-008), and for its project-detail machinery tab. `MaintenanceService`
  // is exported for 004's Pending Approvals KPI, which counts open maintenance jobs
  // (FR-005, research.md §8).
  exports: [PlantService, MaintenanceService],
})
export class PlantModule {}
