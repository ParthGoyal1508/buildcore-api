import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { ListRemindersDto } from './dto/list-reminders.dto';
import { SnoozeReminderDto } from './dto/snooze-reminder.dto';
import { RemindersService } from './reminders.service';

/**
 * The reminders centre (spec US9).
 *
 * Gated by the existing `DASHBOARD` permission, adding no new enum value — spec
 * FR-037, and the 2026-08-27 clarification that settled it for every endpoint in this
 * feature.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('dashboard/reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  @ApiOperation({
    summary: 'Every currently-due reminder, overdue first then soonest due',
    description:
      'Computed fresh on every request from the registered rules — there is no ' +
      'reminders table to page through. `unavailable` names the rules whose module ' +
      'is not built yet, so an empty list can be told apart from a list nothing ' +
      'could be computed for.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListRemindersDto,
  ) {
    return this.reminders.list(caller, query);
  }

  @Get('count')
  @ApiOperation({
    summary: 'Reminder counts by severity, for the header badge',
    description:
      'Accepts the same filters as the list, so a badge can count one module or ' +
      'one severity.',
  })
  async count(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListRemindersDto,
  ) {
    return this.reminders.count(caller, query);
  }

  @Patch(':id/snooze')
  @ApiOperation({
    summary: 'Suppress a reminder until a date',
    description:
      'The id is `<ruleKey>:<entityId>` as returned by the list. Snoozing hides the ' +
      'reminder from both the list and the notification ledger until the date given, ' +
      'and lapses on that date whether or not its severity escalated meanwhile. ' +
      'Audit-logged.',
  })
  async snooze(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SnoozeReminderDto,
    @Ip() ipAddress: string,
  ) {
    return this.reminders.snooze(caller, id, dto, ipAddress);
  }
}
