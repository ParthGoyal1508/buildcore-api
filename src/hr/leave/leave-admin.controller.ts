import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../caller-context';
import {
  LeaveApplicationQueryDto,
  LeaveDecisionDto,
} from './dto/leave-decision.dto';
import { LeaveService } from './leave.service';

/**
 * The approver's side of leave (FR-022a).
 *
 * Deliberately not under `/my/*`, for the same reason as the attendance-exception
 * routes: these act on *other* employees' records, which is exactly what the
 * `/my/*` prefix promises never to do. Gated on ATTENDANCE, with RLS confining
 * every result to the approver's own company.
 */
@ApiTags('Workspace Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('workspace-admin/leave-applications')
export class LeaveAdminController {
  constructor(private readonly leave: LeaveService) {}

  @Get()
  @ApiOperation({ summary: 'Leave applications awaiting a decision' })
  async listForReview(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: LeaveApplicationQueryDto,
  ) {
    return this.leave.listForReview(callerFrom(user, request), query.status);
  }

  @Post(':id/decide')
  @ApiOperation({ summary: 'Approve or reject a leave application' })
  @ApiResponse({
    status: 200,
    description:
      'Decision recorded. An approval debits the leave balance and makes the covered dates show as on-leave in the employee’s attendance history.',
  })
  @ApiResponse({
    status: 400,
    description: 'Rejection submitted without remarks.',
  })
  @ApiResponse({
    status: 409,
    description: 'The application has already been decided or cancelled.',
  })
  async decide(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: LeaveDecisionDto,
  ) {
    return this.leave.decide(callerFrom(user, request), id, dto);
  }
}
