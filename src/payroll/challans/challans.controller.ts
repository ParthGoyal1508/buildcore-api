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
import { ChallanQueryDto } from './dto/challan-query.dto';
import { contentDispositionFor } from '../../common/storage/file-type';
import { resolveCompanyId } from '../../settings/company-scope';
import { ExportThrottle } from '../../common/throttle/app-throttle';

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
    // 036 stream 3b (17-10-2026): `resolveCompanyId`, not `user.companyId ?? requested`. The old
    // order let a Super Admin's *home* company win over the one they asked for, and ignored the
    // company selected in the switcher (which arrives on the RLS context, not on `user`), so a
    // Super Admin working in company B read and wrote company A's rows.
    return resolveCompanyId(user, requested);
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
    @Query() query: ChallanQueryDto,
  ) {
    return this.challans.get(
      callerFrom(user, request),
      this.companyOf(user, query.companyId),
      this.assertType(type),
      query.period,
      query.branchId,
    );
  }

  @Get(':type/export')
  // Each export renders a whole run to XLSX (036 stream 3b, the B9 export limit).
  @ExportThrottle()
  @ApiParam({ name: 'type', enum: TYPES })
  @ApiOperation({ summary: 'The same challan as an XLSX for filing' })
  async export(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('type') type: string,
    @Query() query: ChallanQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.challans.export(
      callerFrom(user, request),
      this.companyOf(user, query.companyId),
      this.assertType(type),
      query.period,
      query.branchId,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', contentDispositionFor(filename));
    response.send(buffer);
  }
}
