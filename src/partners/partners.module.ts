import { forwardRef, Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { StorageModule } from '../common/storage/storage.module';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { BOCWController } from './bocw/bocw.controller';
import { BOCWService } from './bocw/bocw.service';
import { ComplianceController } from './compliance/compliance.controller';
import { ComplianceStatusService } from './compliance/compliance-status.service';
import { ComplianceService } from './compliance/compliance.service';
import { ContractorsController } from './contractors/contractors.controller';
import { ContractorsService } from './contractors/contractors.service';
import { ComplianceCheckCron } from './cron/compliance-check.cron';
import { PartnersService } from './partners.service';
import { RagController } from './rag/rag.controller';
import { RagService } from './rag/rag.service';
import { VendorCategoriesController } from './vendor-categories/vendor-categories.controller';
import { PartnerVendorCategoriesService } from './vendor-categories/vendor-categories.service';
import { VendorsController } from './vendors/vendors.controller';
import { VendorsService } from './vendors/vendors.service';
import { VendorSearchSource } from './vendors/vendor-search.source';
import { VendorIdentitySource } from './vendors/vendor-identity.source';

/**
 * The `partners` module: vendors, the contractor compliance vault, monthly PF/ESIC
 * filings, the RAG matrix and BOCW cess.
 *
 * Imports rather than reaches: `SettingsModule` for vendor categories, the company
 * cess rate and code-series allocation; `ProjectsModule` for contract values and work
 * order totals, both still stubs; `StorageModule` for contractor documents. No
 * cross-schema query anywhere — Principle I.
 *
 * The dependency runs partners → projects directly, but projects now reaches partners back
 * through hr → payroll → plant → inventory, so the edge is a real cycle and takes
 * `forwardRef()`. Without it, loading the graph from `ProjectsModule` (as a spec does) reads
 * `ProjectsModule` here before it exists — `undefined` under ts-jest, an error under swc.
 */
@Module({
  imports: [SettingsModule, forwardRef(() => ProjectsModule), StorageModule],
  controllers: [
    VendorCategoriesController,
    VendorsController,
    ContractorsController,
    ComplianceController,
    RagController,
    BOCWController,
  ],
  providers: [
    // 021 US1 — see ProjectSearchSource.
    VendorSearchSource,
    // 023 FR-026. Registers itself with `ProjectSourcesRegistry` on init, so a bill's header can
    // print a subcontractor's statutory details without `projects` importing this module — which
    // would close the five-module cycle `WorkOrdersService` documents.
    VendorIdentitySource,
    PartnersService,
    VendorsService,
    PartnerVendorCategoriesService,
    ContractorsService,
    ComplianceService,
    ComplianceStatusService,
    RagService,
    BOCWService,
    ComplianceCheckCron,
    AuditLogService,
  ],
  // The outward contract: vendor lookup and TDS terms for Inventory and Machinery,
  // subcontractor cost for the Projects P&L.
  exports: [PartnersService],
})
export class PartnersModule {}
