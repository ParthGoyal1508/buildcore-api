import { Controller, Get, Ip, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { buildDashboardContext } from '../context';
import { NotificationsService } from './notifications.service';

/**
 * The notifications centre (feature 004, US4). Lists currently-active,
 * system-generated notifications and a bell-badge count. Gated by the existing
 * `DASHBOARD` permission (spec FR-022).
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Currently-active notifications, computed fresh' })
  async list(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.notifications.list(buildDashboardContext(user, ip));
  }

  @Get('count')
  @ApiOperation({
    summary: 'The active-notification count, for the bell badge',
  })
  async count(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.notifications.count(buildDashboardContext(user, ip));
  }
}
