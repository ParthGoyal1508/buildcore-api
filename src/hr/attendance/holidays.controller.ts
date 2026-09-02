import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { callerFrom } from '../caller-context';
import { HolidaysService } from '../holidays/holidays.service';
import { CreateHolidayDto, ListHolidaysQueryDto } from './dto/holiday.dto';

/**
 * The company holiday calendar (005 US3).
 *
 * Under `/hr/holidays` rather than `/settings/*` because a holiday is attendance
 * policy, not reference data — it changes what a given day *means* for pay.
 */
@ApiTags('HR — Attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

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
  @ApiOperation({ summary: 'The holiday calendar, filterable by range and site' })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListHolidaysQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.holidays.list(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Declare a holiday',
    description:
      'Company-wide by default; set appliesToAllSites=false and name the sites ' +
      'for a regional holiday.',
  })
  @ApiResponse({
    status: 409,
    description: 'A holiday with that name already exists on that date.',
  })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateHolidayDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.holidays.create(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      dto,
    );
  }
}
