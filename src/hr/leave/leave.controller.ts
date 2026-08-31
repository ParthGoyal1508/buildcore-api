import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import {
  CreateLeaveApplicationDto,
  LeaveBalanceQueryDto,
} from './dto/leave-application.dto';
import { LeaveService } from './leave.service';

/**
 * The employee's own leave surface (US4).
 *
 * No route here takes an employee identifier — like every `/my/*` controller, the
 * employee is derived from the token (FR-028), so there is no parameter through
 * which one worker could read or cancel another's leave.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('my/leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('balance')
  @ApiOperation({
    summary: "The caller's leave entitlement for a financial year",
  })
  @ApiResponse({
    status: 200,
    description:
      'One entry per leave type, including types with no granted entitlement (balance 0). Defaults to the financial year containing today.',
  })
  async balance(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: LeaveBalanceQueryDto,
  ) {
    return this.leave.getBalance(
      callerFrom(user, request),
      query.financialYear,
    );
  }

  @Get('applications')
  @ApiOperation({ summary: "The caller's own leave applications" })
  async listMine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.leave.listMine(callerFrom(user, request));
  }

  @Post('applications')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Apply for leave' })
  @ApiResponse({
    status: 201,
    description:
      'Application created as pending. `dayCount` is computed server-side, excluding weekly offs and site holidays (FR-019).',
  })
  @ApiResponse({
    status: 400,
    description:
      'Range is inverted, contains no working days, or exceeds the available balance for a non-LWP type.',
  })
  @ApiResponse({
    status: 423,
    description: 'The range falls in an already-locked payroll period.',
  })
  async apply(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateLeaveApplicationDto,
  ) {
    return this.leave.apply(callerFrom(user, request), dto);
  }

  @Post('applications/:id/cancel')
  @ApiOperation({ summary: 'Cancel a pending application' })
  @ApiResponse({
    status: 409,
    description: 'The application is no longer pending.',
  })
  async cancel(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.leave.cancel(callerFrom(user, request), id);
  }
}
