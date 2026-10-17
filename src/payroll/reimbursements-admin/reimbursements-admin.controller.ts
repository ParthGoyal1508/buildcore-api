import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';
import { contentDispositionFor } from '../../common/storage/file-type';

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
import { resolveCompanyId } from '../../settings/company-scope';

/** Reimbursement claim review and settlement (005 US12). */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
// Reading the queue: EMPLOYEES or PAYROLL (either passes). Deciding and paying move money and are
// PAYROLL's alone — each of those routes overrides this (036 F18). They used to be EMPLOYEES too,
// so anyone who could edit an employee record could approve and pay claims.
@RequirePermissions(Permission.EMPLOYEES, Permission.PAYROLL)
@Controller('hr/reimbursements')
export class ReimbursementsAdminController {
  constructor(private readonly claims: ReimbursementsAdminService) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    // 036 stream 3b (17-10-2026): `resolveCompanyId`, not `user.companyId ?? requested`. The old
    // order let a Super Admin's *home* company win over the one they asked for, and ignored the
    // company selected in the switcher (which arrives on the RLS context, not on `user`), so a
    // Super Admin working in company B read and wrote company A's rows.
    return resolveCompanyId(user, requested);
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

  @Get(':id/receipt')
  @ApiOperation({
    summary: "Open a claim's receipt (036 F17)",
    description:
      'A photo or a PDF, served with its detected type, so the approver can see what they are ' +
      'approving. 404 when the claim has none.',
  })
  async receipt(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, filename, contentType } = await this.claims.receipt(
      callerFrom(user, request),
      id,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.PAYROLL)
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
  @RequirePermissions(Permission.PAYROLL)
  @ApiOperation({
    summary: 'Reject a submitted claim',
    description:
      'Remarks are required — a rejection with no reason is not one.',
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
  @RequirePermissions(Permission.PAYROLL)
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
