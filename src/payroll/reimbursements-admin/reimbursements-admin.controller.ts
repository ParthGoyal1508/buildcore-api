import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import {
  ApproveClaimDto,
  ListClaimsQueryDto,
  PayClaimDto,
  RejectClaimDto,
} from './dto/decide-claim.dto';
import { ReimbursementsAdminService } from './reimbursements-admin.service';

/** Reimbursement claim review and settlement (005 US12). */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/reimbursements')
export class ReimbursementsAdminController {
  constructor(private readonly claims: ReimbursementsAdminService) {}

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
    summary: 'Claims awaiting review, filterable',
    description:
      'Drafts are excluded — they belong to the employee until submitted.',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListClaimsQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.claims.listClaims(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Get('register')
  @ApiOperation({
    summary: 'The Reimbursement Register with status subtotals',
  })
  async register(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListClaimsQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.claims.getRegister(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve a submitted claim' })
  @ApiResponse({ status: 409, description: 'Claim is not submitted.' })
  async approve(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: ApproveClaimDto,
  ) {
    return this.claims.approveClaim(callerFrom(user, request), id, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({
    summary: 'Reject a submitted claim',
    description: 'Remarks are required — a rejection with no reason is not one.',
  })
  async reject(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: RejectClaimDto,
  ) {
    return this.claims.rejectClaim(callerFrom(user, request), id, dto);
  }

  @Patch(':id/pay')
  @ApiOperation({
    summary: 'Settle an approved claim',
    description:
      '`direct` requires a payment reference. `payroll` defers the money to the ' +
      'employee’s next run as an earnings line.',
  })
  async pay(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: PayClaimDto,
  ) {
    return this.claims.payClaim(callerFrom(user, request), id, dto);
  }
}
