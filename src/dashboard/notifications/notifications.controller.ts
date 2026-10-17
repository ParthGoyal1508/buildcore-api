import {
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequireLevel } from '../../common/decorators/access-level.decorator';
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
    summary: 'The unread-notification count, for the bell badge (036 D6)',
    description:
      '`count` is unread notifications; `total` is every active one, read or not.',
  })
  async count(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.notifications.count(buildDashboardContext(user, ip));
  }

  // 036 D6 — marking read changes only the caller's own inbox, so it needs no more than reaching
  // the bell: read level, the same as listing.
  @Post('read-all')
  @HttpCode(200)
  @RequireLevel(AccessLevel.read)
  @ApiOperation({ summary: "Mark all of the caller's notifications read" })
  async markAllRead(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.notifications.markAllRead(buildDashboardContext(user, ip));
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequireLevel(AccessLevel.read)
  @ApiOperation({ summary: 'Mark one of the caller’s notifications read' })
  async markRead(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(buildDashboardContext(user, ip), id);
  }
}
