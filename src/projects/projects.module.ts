import { forwardRef, Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { SettingsModule } from '../settings/settings.module';
import { ClientsController } from './clients/clients.controller';
import { ClientsService } from './clients/clients.service';
import { ProjectDocumentsController } from './documents/project-documents.controller';
import { ProjectDocumentsService } from './documents/project-documents.service';
import { ProjectLockGuard } from './guards/project-lock.guard';
import { ProjectsController } from './portfolio/projects.controller';
import { ProjectSearchSource } from './portfolio/project-search.source';
import { ProjectSourcesRegistry } from './portfolio/project-sources.registry';
import { ClientBillsController } from './billing/client-bills.controller';
import { ClientBillsService } from './billing/client-bills.service';
import { RaBillsController } from './billing/ra-bills.controller';
import { RaBillsService } from './billing/ra-bills.service';
import { ProjectPnlController } from './pnl/project-pnl.controller';
import { ProjectPnlService } from './pnl/project-pnl.service';
import { WorkOrdersController } from './billing/work-orders.controller';
import { WorkOrdersService } from './billing/work-orders.service';
import { PnlDrillDownService } from './pnl/pnl-drill-down.service';
import { ProjectPositionExportService } from './pnl/position-export.service';
import { ProjectsService } from './portfolio/projects.service';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';
import { ProjectDocumentUploadController } from './documents/project-document-upload.controller';

/**
 * The `projects` module.
 *
 * Feature 003 created it for the geofence slice of Site alone. Feature 008 fills in
 * the rest: Client and Site masters, and the Project portfolio (US1–US3). BOQ, DWR,
 * revenue, RA bills, work orders, budget, P&L and documents (US4–US8) are specified
 * but not yet built — their tables exist, their endpoints do not.
 *
 * `HrModule` is imported behind `forwardRef` because the dependency genuinely runs
 * both ways: `hr` needs `SitesService.getGeofence()` to validate a punch, and this
 * module needs `EmployeesService` to answer two questions it may not answer itself —
 * whether anyone is still posted to a site being deleted, and who is on a project's
 * roster. `partners.module.ts` predicted this edge and said it would need
 * `forwardRef()` on both sides; it does. The alternative is a cross-schema query,
 * which Principle I forbids outright.
 */
@Module({
  // `ApprovalsModule` for 018 Phase 4 (FR-009): an RA bill's certification is the 016 spine's, and
  // revising a certified bill's quantities raises a fresh instance rather than editing a completed
  // decision. `src/projects` keeps no approval mechanism of its own — `fr-022-unmigrated-modules`
  // still asserts that per file.
  imports: [SettingsModule, ApprovalsModule, forwardRef(() => HrModule)],
  // `ProjectDocumentsController` is FIRST on purpose. Nest matches routes in
  // registration order, and its path `/projects/document-requirements` is a literal
  // that `ProjectsController`'s `GET /projects/:id` would otherwise swallow — the
  // request would be answered with "project document-requirements not found", which
  // looks like a data problem rather than a routing one. `test/project-documents.e2e-spec.ts`
  // asserts the order holds rather than trusting this comment to be read.
  controllers: [
    WorkOrdersController,
    // 018 US1 (`bugs.md` item 11). Bills measured against the BOQ, which is what makes Note 12's
    // "reconciliation against BOQ amounts and quantities" answerable at all.
    ClientBillsController,
    // 018 US2 (`bugs.md` item 12). Subcontractor bills measured against the award, which is a separate
    // set of rates from the client's BOQ — the margin between them is what the P&L shows.
    RaBillsController,
    // 018 US3 (`bugs.md` item 11). The P&L and budget summary, reading every other module's costs
    // through `ProjectSourcesRegistry` rather than by joining into their schemas.
    ProjectPnlController,
    // 017 FR-008a, FR-009b. Registered before ProjectsController for the route-order reason
    // the note below gives: `projects/document-uploads` is a literal segment that
    // `GET /projects/:id` would otherwise swallow.
    ProjectDocumentUploadController,
    ProjectDocumentsController,
    ClientsController,
    SitesController,
    ProjectsController,
  ],
  providers: [
    // 021 US1: registers this register with `SearchSourcesRegistry` on init. The query
    // lives here because `projects` owns the table (Principle I).
    ProjectSearchSource,
    ClientsService,
    SitesService,
    ProjectsService,
    ProjectDocumentsService,
    ClientBillsService,
    RaBillsService,
    // 018 US2. Feature 008 US6's surface, delivered in the smallest form that makes an RA bill
    // reachable — nothing had ever written to the `WorkOrder` table. See the service comment.
    WorkOrdersService,
    ProjectPnlService,
    // 018 FR-011a (`bugs.md` item 14): the month's position as a document, over the same
    // renderer the dashboard's reports use.
    ProjectPositionExportService,
    // 018 FR-012: opening a figure on the summary and seeing the records behind it.
    PnlDrillDownService,
    ProjectSourcesRegistry,
    ProjectLockGuard,
    // Declared here rather than imported from AuthModule, matching every other
    // feature module: the service is stateless, and AuthModule does not export it.
    AuditLogService,
  ],
  // `SitesService` is exported because `hr` must read a site's geofence to validate
  // a punch. `ProjectsService` is exported for 007's BOCW cess and subcontractor
  // cost. `ProjectLockGuard` is exported so US4–US8's controllers can mount it
  // without each re-declaring the provider.
  // `ProjectSourcesRegistry` is exported so 006 and 009 can register the machinery
  // and materials they contribute to a project page — the inversion that keeps the
  // dependency between those modules and this one pointing one way.
  // `ProjectDocumentsService` is exported (017 T022) so the dashboard and any other
  // module can ask how far a project is from fully papered through a service method.
  // `projects.ProjectDocumentRequirement` is this module's table and Principle I means
  // nobody else may read it directly.
  exports: [
    SitesService,
    ProjectsService,
    ProjectDocumentsService,
    ProjectLockGuard,
    ProjectSourcesRegistry,
  ],
})
export class ProjectsModule {}
