import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { ClaimQueryDto, CreateClaimDto, UpdateClaimDto } from './dto/claim.dto';
import { ReimbursementService } from './reimbursement.service';

/**
 * The employee's own reimbursement claims (US8).
 *
 * Authentication only, no extra permission — matching the contract's rule that
 * `/my/*` routes are gated on being signed in and scoped to the caller, while only
 * the admin-side routes carry a permission requirement.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('my/reimbursements')
export class ReimbursementController {
  constructor(private readonly reimbursements: ReimbursementService) {}

  @Get()
  @ApiOperation({ summary: "The caller's own claims" })
  async listMine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ClaimQueryDto,
  ) {
    return this.reimbursements.listOwnClaims(
      callerFrom(user, request),
      query.status,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'File a reimbursement claim' })
  @ApiResponse({
    status: 400,
    description:
      'Unknown or inactive category, or a receipt is missing above the category’s threshold (FR-030).',
  })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateClaimDto,
  ) {
    return this.reimbursements.createClaim(callerFrom(user, request), dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft claim' })
  @ApiResponse({
    status: 409,
    description: 'The claim is no longer a draft.',
  })
  async update(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateClaimDto,
  ) {
    return this.reimbursements.updateClaim(callerFrom(user, request), id, dto);
  }

  @Post(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw a claim still awaiting review' })
  @ApiResponse({
    status: 409,
    description: 'The claim has already been decided.',
  })
  async withdraw(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.reimbursements.withdrawClaim(callerFrom(user, request), id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft claim' })
  @ApiResponse({
    status: 409,
    description:
      'The claim has been submitted. Withdraw it instead — a claim an approver has already seen leaves a trace.',
  })
  async remove(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<void> {
    await this.reimbursements.deleteDraftClaim(callerFrom(user, request), id);
  }
}
