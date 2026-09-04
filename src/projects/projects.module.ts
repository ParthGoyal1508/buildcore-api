import { forwardRef, Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { SettingsModule } from '../settings/settings.module';
import { ClientsController } from './clients/clients.controller';
import { ClientsService } from './clients/clients.service';
import { ProjectLockGuard } from './guards/project-lock.guard';
import { ProjectsController } from './portfolio/projects.controller';
import { ProjectSourcesRegistry } from './portfolio/project-sources.registry';
import { ProjectsService } from './portfolio/projects.service';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';

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
  imports: [SettingsModule, forwardRef(() => HrModule)],
  controllers: [ClientsController, SitesController, ProjectsController],
  providers: [
    ClientsService,
    SitesService,
    ProjectsService,
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
  exports: [
    SitesService,
    ProjectsService,
    ProjectLockGuard,
    ProjectSourcesRegistry,
  ],
})
export class ProjectsModule {}
