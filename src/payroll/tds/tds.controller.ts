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
import { Permission, TaxRegime } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import {
  DeclareTaxDto,
  QuarterlyQueryDto,
  SetTaxSlabsDto,
} from './dto/tds.dto';
import { TdsService } from './tds.service';

/** Income tax: slabs, declarations and returns (005 amendment US14). */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/tds')
export class TdsController {
  constructor(private readonly tds: TdsService) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    const companyId = user.companyId ?? requested;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  @Get('slabs')
  @ApiOperation({ summary: 'The slab set for a financial year and regime' })
  async getSlabs(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('financialYear') financialYear: string,
    @Query('regime') regime: TaxRegime,
    @Query('companyId') companyId?: string,
  ) {
    return this.tds.getSlabs(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      financialYear,
      regime,
    );
  }

  @Post('slabs')
  @ApiOperation({
    summary: 'Replace a financial year’s slab set',
    description:
      'Replaced as a whole, not edited band by band — a set is only meaningful ' +
      'complete, and a gap or overlap would let income fall through or be taxed ' +
      'twice. Both are rejected with the offending boundary named.',
  })
  @ApiResponse({
    status: 400,
    description: 'Slabs are gapped, overlapping, or not open-ended at the top.',
  })
  async setSlabs(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: SetTaxSlabsDto,
  ) {
    return this.tds.setSlabs(
      callerFrom(user, request),
      this.companyOf(user, dto.companyId),
      dto.financialYear,
      dto.regime,
      dto.bands.map((b) => ({
        lowerBound: b.lowerBound,
        upperBound: b.upperBound ?? null,
        ratePercent: b.ratePercent,
      })),
    );
  }

  @Get('declarations/:employeeId')
  @ApiOperation({ summary: 'An employee’s declaration for a financial year' })
  async getDeclaration(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Query('financialYear') financialYear: string,
  ) {
    return this.tds.getDeclaration(
      callerFrom(user, request),
      employeeId,
      financialYear,
    );
  }

  @Post('declarations/:employeeId')
  @ApiOperation({
    summary: 'Record an investment declaration',
    description:
      'Each line is capped at its section ceiling. The declared figure is kept ' +
      'alongside the capped one so the employee can see the cap rather than ' +
      'wondering why their deduction shrank.',
  })
  async declare(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Body() dto: DeclareTaxDto,
  ) {
    return this.tds.declare(
      callerFrom(user, request),
      employeeId,
      dto.financialYear,
      dto.regime,
      dto.lines,
    );
  }

  @Patch('declarations/lines/:lineId/verify')
  @ApiOperation({
    summary: 'Verify one declaration line against its proof',
    description:
      'Past the configured cut-off month, only verified lines reduce taxable ' +
      'income.',
  })
  async verify(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('lineId') lineId: string,
  ) {
    return this.tds.verifyLine(callerFrom(user, request), lineId);
  }

  @Get('quarterly')
  @ApiOperation({
    summary: 'Quarterly TDS return data',
    description:
      'Employees with no PAN are listed separately — the filing needs one, and ' +
      'a penal rate was applied in its absence.',
  })
  async quarterly(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: QuarterlyQueryDto,
  ) {
    return this.tds.quarterlyReturn(
      callerFrom(user, request),
      this.companyOf(user, query.companyId),
      query.financialYear,
      query.quarter,
    );
  }

  @Get('form-16/:employeeId')
  @ApiOperation({ summary: 'Form 16 source data for one employee and year' })
  async formSixteen(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Query('financialYear') financialYear: string,
  ) {
    return this.tds.formSixteenData(
      callerFrom(user, request),
      employeeId,
      financialYear,
    );
  }
}
