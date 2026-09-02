import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LeaveApplicationStatus, Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../caller-context';
import { LeaveService } from './leave.service';

/**
 * The HR admin leave surface (005 US4).
 *
 * Deliberately a thin read layer over 003's `LeaveService` — the approve/reject
 * decision logic already lives there and is reached through
 * `/workspace-admin/leave-applications`. Duplicating it under `/hr/*` would give
 * the system two places where a leave balance can be debited.
 */
@ApiTags('HR — Leave')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/leave')
export class LeaveHrAdminController {
  constructor(private readonly leave: LeaveService) {}

  @Get('applications')
  @ApiOperation({
    summary: 'Every employee’s leave applications, filterable by status',
  })
  async applications(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('status') status?: LeaveApplicationStatus,
  ) {
    return this.leave.listForReview(
      callerFrom(user, request),
      status ?? LeaveApplicationStatus.pending,
    );
  }

  @Get('balances')
  @ApiOperation({
    summary: 'Leave balances for one employee',
    description:
      'Opening / accrued / used / balance per leave type, zero-filled for types ' +
      'with no row yet — the same projection the employee sees.',
  })
  async balances(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('employeeId') employeeId: string,
    @Query('financialYear') financialYear?: string,
  ) {
    return this.leave.getBalanceForEmployee(
      callerFrom(user, request),
      employeeId,
      financialYear,
    );
  }
}
