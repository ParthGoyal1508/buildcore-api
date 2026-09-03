import { Module } from '@nestjs/common';
import { ProjectsService } from './portfolio/projects.service';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';

/**
 * The `projects` module. Feature 003 (My Workspace) needs only the geofence and
 * calendar slice of Site, so that is all this module owns today; a later Projects
 * feature fills in the rest.
 *
 * `SitesService` is exported because `hr` must read a site's geofence to validate a
 * punch, and Principle I requires that to be an in-process service call rather than
 * a cross-schema query.
 */
@Module({
  controllers: [SitesController],
  providers: [SitesService, ProjectsService],
  // `ProjectsService` is exported for 007's BOCW cess and subcontractor cost, both of
  // which need Project data this module does not hold yet. Exporting the stub now is
  // what lets 007 be written against the real seam instead of around it.
  exports: [SitesService, ProjectsService],
})
export class ProjectsModule {}
