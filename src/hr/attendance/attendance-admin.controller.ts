import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { AttendanceAdminService } from './attendance-admin.service';
import {
  DailyAttendanceQueryDto,
  MarkAttendanceDto,
  ModificationsQueryDto,
} from './dto/mark-attendance.dto';

/** Admin attendance administration (005 US3). */
@ApiTags('HR — Attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/attendance')
export class AttendanceAdminController {
  constructor(private readonly attendance: AttendanceAdminService) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    const companyId = user.companyId ?? requested;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  @Get()
  @ApiOperation({
    summary: 'Daily attendance for a date, optionally narrowed to a site',
  })
  async daily(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: DailyAttendanceQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.attendance.daily(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Mark or correct one employee-day',
    description:
      'Subject to the same payroll lock and mandatory-document rules the ' +
      'self-service punch obeys — an admin route that bypassed them would make ' +
      'both trivially avoidable. Every edit appends a Modifications audit row.',
  })
  @ApiResponse({ status: 423, description: 'Payroll period already locked.' })
  @ApiResponse({
    status: 400,
    description: 'Mandatory employee documents missing.',
  })
  async mark(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: MarkAttendanceDto,
  ) {
    return this.attendance.mark(callerFrom(user, request), dto);
  }

  @Get('exceptions')
  @ApiOperation({ summary: 'Unresolved face-match / geofence exceptions' })
  async exceptions(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ) {
    return this.attendance.exceptions(
      callerFrom(user, request),
      this.companyOf(user, companyId),
    );
  }

  @Get('late-coming')
  @ApiOperation({
    summary: 'Late arrivals, early departures and short hours for a month',
    description:
      'Measured against the shift in force on each date. Days with no shift ' +
      'configured or no punch times are reported with an explicit marker rather ' +
      'than as zero — unconfigured data must not read as punctuality. ' +
      'Informational only: lateness never deducts pay.',
  })
  async lateComing(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('departmentId') departmentId?: string,
    @Query('siteId') siteId?: string,
    @Query('companyId') companyId?: string,
  ) {
    const m = Number(month);
    const y = Number(year);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1-12.');
    }
    if (!Number.isInteger(y)) {
      throw new BadRequestException('year is required.');
    }
    return this.attendance.lateComingReport(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      m,
      y,
      { departmentId, siteId },
    );
  }

  @Get('modifications')
  @ApiOperation({
    summary: 'The attendance Modifications audit trail',
    description:
      'Carries the specific before/after values the Modifications Modal renders ' +
      'as a diff — distinct from the general activity log.',
  })
  async modifications(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ModificationsQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.attendance.modifications(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }
}
