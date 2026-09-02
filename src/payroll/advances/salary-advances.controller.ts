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
import {
  CreateSalaryAdvanceDto,
  ListAdvancesQueryDto,
} from './dto/salary-advance.dto';
import { SalaryAdvancesService } from './salary-advances.service';

/**
 * Salary advances (005 amendment US15).
 *
 * A separate route from `/hr/loans` on purpose: an advance has no interest and no
 * schedule, and putting the two behind one screen is how they get confused.
 */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/salary-advances')
export class SalaryAdvancesController {
  constructor(private readonly advances: SalaryAdvancesService) {}

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
  @ApiOperation({ summary: 'Advances with recovered and outstanding amounts' })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListAdvancesQueryDto,
  ) {
    return this.advances.list(
      callerFrom(user, request),
      this.companyOf(user, query.companyId),
      query,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Request an advance',
    description:
      'At most one open advance per employee. An amount above the configured ' +
      'multiple of monthly net is flagged rather than blocked — that is a ' +
      'business call, not a system rule.',
  })
  @ApiResponse({ status: 409, description: 'An open advance already exists.' })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateSalaryAdvanceDto,
  ) {
    return this.advances.create(
      callerFrom(user, request),
      this.companyOf(user, dto.companyId),
      dto,
    );
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary: 'Approve and disburse an advance',
    description:
      'Recovery is attempted in the nominated month. If net pay cannot cover it, ' +
      'the remainder stays outstanding and is retried — never written off.',
  })
  async approve(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.advances.approve(callerFrom(user, request), id);
  }
}
