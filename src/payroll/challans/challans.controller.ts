import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { ChallansService, type ChallanType } from './challans.service';

const TYPES: ChallanType[] = ['pf', 'esic', 'pt'];

/**
 * Statutory challans (005 US6).
 *
 * Derived from a processed payroll run at request time — there is no challan
 * table, so these figures cannot drift from the run they came from.
 */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.CHALLANS)
@Controller('hr/challans')
export class ChallansController {
  constructor(private readonly challans: ChallansService) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    const companyId = user.companyId ?? requested;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  private assertType(type: string): ChallanType {
    if (!TYPES.includes(type as ChallanType)) {
      throw new BadRequestException(`type must be one of ${TYPES.join(', ')}.`);
    }
    return type as ChallanType;
  }

  @Get(':type')
  @ApiParam({ name: 'type', enum: TYPES })
  @ApiOperation({
    summary: 'PF / ESIC / PT challan for a period',
    description:
      'Reshapes a processed run’s line items into the scheme’s column set. ' +
      'Employees missing the statutory number the filing requires are reported ' +
      'separately rather than silently omitted.',
  })
  @ApiResponse({ status: 400, description: 'That period is still a draft.' })
  @ApiResponse({ status: 404, description: 'No payroll run for that period.' })
  async get(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('type') type: string,
    @Query('period') period: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.challans.get(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      this.assertType(type),
      period,
    );
  }

  @Get(':type/export')
  @ApiParam({ name: 'type', enum: TYPES })
  @ApiOperation({ summary: 'The same challan as an XLSX for filing' })
  async export(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('type') type: string,
    @Query('period') period: string,
    @Res() response: Response,
    @Query('companyId') companyId?: string,
  ): Promise<void> {
    const { buffer, filename } = await this.challans.export(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      this.assertType(type),
      period,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.send(buffer);
  }
}
