import {
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { rlsContextFor } from '../common/prisma/rls-context';
import { SitesService } from '../projects/sites/sites.service';
import { buildDashboardContext } from './context';
import { DashboardService } from './dashboard.service';
import { SiteWidgetsQueryDto } from './dto/site-widgets-query.dto';

/**
 * The site dashboard (feature 004, US5). A site selector plus site-scoped widgets;
 * requesting a site outside the caller's company is a 403 (spec FR-013, FR-022).
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('site-dashboard')
export class SiteDashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly sites: SitesService,
  ) {}

  @Get('sites')
  @ApiOperation({ summary: "The caller's company's sites, for the selector" })
  async listSites(@UserEntity() user: AuthenticatedUser) {
    return this.sites.listForCompany(rlsContextFor(user), user.companyId ?? '');
  }

  @Get('widgets')
  @ApiOperation({
    summary: 'Site-scoped widgets for the selected site',
    description:
      'Workers Today and the site attendance table resolve; machinery, fuel and ' +
      'material widgets are unavailable until their modules are built.',
  })
  async widgets(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
    @Query() query: SiteWidgetsQueryDto,
  ) {
    const ctx = buildDashboardContext(user, ip, query.siteId);
    // RLS scopes the lookup to the caller's company, so a cross-company site is not
    // found — surfaced as a 403 rather than leaking its existence (FR-022).
    try {
      await this.sites.getSiteById(ctx.rls, query.siteId);
    } catch {
      throw new ForbiddenException('Site not accessible');
    }
    return this.dashboard.siteWidgets(ctx);
  }
}
