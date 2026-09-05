import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  ActivityLogService,
  type ActivityLogExportRow,
} from './activity-log.service';
import { ActivityLogQueryDto } from './dto/activity-log-query.dto';

/** One CSV cell, quoted and inner-quote-doubled per RFC 4180. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The Activity Log (feature 004, US3) — a read/query view over the shared audit
 * trail, plus a CSV export of the same filtered result set (spec FR-024). Gated by
 * the existing `DASHBOARD` permission (spec FR-022).
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('activity-log')
export class ActivityLogController {
  constructor(private readonly activityLog: ActivityLogService) {}

  @Get()
  @ApiOperation({
    summary:
      'The audit feed, newest first, filterable by module and time range',
  })
  async feed(
    @UserEntity() user: AuthenticatedUser,
    @Query() query: ActivityLogQueryDto,
  ) {
    return this.activityLog.feed(user, query);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="activity-log.csv"')
  @ApiOperation({
    summary: 'The same filtered feed as a CSV download',
    description:
      'Columns: Timestamp, User, Action, Module, Entity, Before, After. Same ' +
      'module / time-range filters and company scoping as the feed, no pagination.',
  })
  async export(
    @UserEntity() user: AuthenticatedUser,
    @Query() query: ActivityLogQueryDto,
  ): Promise<string> {
    const rows = await this.activityLog.exportRows(user, query);
    const header = [
      'Timestamp',
      'User',
      'Action',
      'Module',
      'Entity',
      'Before',
      'After',
    ];
    const lines = [
      header.map(csvCell).join(','),
      ...rows.map((r: ActivityLogExportRow) =>
        [r.timestamp, r.user, r.action, r.module, r.entity, r.before, r.after]
          .map(csvCell)
          .join(','),
      ),
    ];
    return lines.join('\r\n');
  }
}
