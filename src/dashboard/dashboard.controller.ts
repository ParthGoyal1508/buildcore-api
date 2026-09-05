import { Controller, Get, Ip, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { buildDashboardContext } from './context';
import { DashboardService } from './dashboard.service';

/**
 * The company dashboard (feature 004, US1/US2). Every widget is self-describing:
 * a resolved value or an explicit `unavailable` state for a not-yet-built module
 * (spec FR-001, FR-003). Gated by the existing `DASHBOARD` permission — no new enum
 * value (spec FR-022, the 2026-08-27 clarification).
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('widgets')
  @ApiOperation({
    summary: 'Every company-dashboard widget, resolved or unavailable',
    description:
      'Computed fresh, in parallel, on every request. An entry either carries a ' +
      '`value` or an `unavailable` block naming the module it waits on — so a zero ' +
      'is told apart from "not built yet".',
  })
  async widgets(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.dashboard.companyWidgets(buildDashboardContext(user, ip));
  }
}
