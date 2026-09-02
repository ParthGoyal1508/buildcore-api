import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { callerFrom } from '../../hr/caller-context';
import { CreateLoanDto, ListLoansQueryDto } from './dto/create-loan.dto';
import { LoansService } from './loans.service';

/** Employee loans and their EMI schedules (005 US7). */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.LOANS)
@Controller('hr/loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

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
    summary: 'Loans with recovered and outstanding totals',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListLoansQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.loans.list(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One loan with its full schedule' })
  async getOne(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.loans.getOne(callerFrom(user, request), id);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a loan and generate its EMI schedule',
    description:
      'Created pending — payroll only deducts against approved loans. Recovery ' +
      'starts the month after disbursement unless a period is given. The final ' +
      'instalment is the remainder, never a full EMI.',
  })
  @ApiResponse({
    status: 400,
    description: 'EMI exceeds the amount, or the employee is inactive.',
  })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateLoanDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.loans.create(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      dto,
    );
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary: 'Approve a pending loan so payroll begins recovering it',
  })
  @ApiResponse({ status: 409, description: 'Loan is not pending.' })
  async approve(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.loans.approve(callerFrom(user, request), id);
  }

  @Patch(':id/close')
  @ApiOperation({
    summary: 'Close a loan early (settled outside payroll)',
    description:
      'Unrecovered schedule entries are dropped rather than marked paid — ' +
      'marking them paid would claim deductions that never happened.',
  })
  async close(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body('reason') reason: string,
  ) {
    return this.loans.close(callerFrom(user, request), id, reason ?? '');
  }
}
