import { Module } from '@nestjs/common';
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
  providers: [SitesService],
  exports: [SitesService],
})
export class ProjectsModule {}
