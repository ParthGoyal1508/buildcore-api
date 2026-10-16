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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { ReimbursementService } from './reimbursement.service';

export class TeamClaimDecisionDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  /** Required on rejection — enforced by the service. */
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/**
 * A reporting manager's expense-claim queue (2026-10-16: "first go to reporting manager and then
 * HR"). Self-service, for the reason `LeaveTeamController` gives: the authority is the reporting
 * line stamped on the claim, which no permission expresses.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/team/reimbursements')
export class ReimbursementTeamController {
  constructor(private readonly claims: ReimbursementService) {}

  @Get()
  @ApiOperation({
    summary: 'Expense claims waiting on the caller as reporting manager',
  })
  async list(@UserEntity() user: AuthenticatedUser, @Req() request: Request) {
    return this.claims.listForManager(callerFrom(user, request));
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
    @Body() dto: TeamClaimDecisionDto,
  ) {
    return this.claims.managerDecide(
      callerFrom(user, request),
      id,
      dto.decision,
      dto.remarks,
    );
  }
}
