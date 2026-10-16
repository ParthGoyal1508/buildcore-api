import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { LeaveDecisionDto } from './dto/leave-decision.dto';
import { LeaveService } from './leave.service';

/**
 * A reporting manager's leave queue (2026-10-16: "first go to reporting manager and then HR").
 *
 * Self-service, like every `/my/*` route: the authority is the reporting line stamped on each
 * application at submission, and the service only ever reads rows naming the caller as manager.
 * No permission would express that — a site supervisor holding nothing but My Workspace may
 * manage a team.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/team/leave-applications')
export class LeaveTeamController {
  constructor(private readonly leave: LeaveService) {}

  @Get()
  @ApiOperation({
    summary: 'Leave applications waiting on the caller as reporting manager',
  })
  async list(@UserEntity() user: AuthenticatedUser, @Req() request: Request) {
    return this.leave.listForManager(callerFrom(user, request));
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The reporting manager's decision: approve on to HR, or reject (final, remarks required)",
  })
  async decide(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: LeaveDecisionDto,
  ) {
    return this.leave.managerDecide(callerFrom(user, request), id, dto);
  }
}
