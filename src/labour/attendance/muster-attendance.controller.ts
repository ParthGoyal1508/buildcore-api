import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  LabourDayRulesDto,
  LabourDayRulesQueryDto,
  MusterDailyQueryDto,
  MusterMonthlyQueryDto,
  PunchCorrectionDto,
  PunchHistoryQueryDto,
  SitePhotoDto,
  SitePhotoQueryDto,
} from './dto/muster-attendance.dto';
import { MusterAttendanceService } from './muster-attendance.service';

/**
 * Muster attendance from punch times (034): daily and monthly views, corrections with a reason and
 * an edit history, the company's day rules, and reference group photos.
 */
@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('labour/muster-attendance')
export class MusterAttendanceController {
  constructor(private readonly muster: MusterAttendanceService) {}

  @Get('daily')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({
    summary:
      "A day's muster: each labour's punch in and out, hours, status and flag",
  })
  async daily(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: MusterDailyQueryDto,
  ) {
    return this.muster.daily(caller, query);
  }

  @Get('monthly')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({
    summary: "A month's punch times and hours per labour per day",
  })
  async monthly(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: MusterMonthlyQueryDto,
  ) {
    return this.muster.monthly(caller, query);
  }

  @Post('corrections')
  @RequirePermissions(Permission.LABOUR_PUNCH_CORRECT)
  @ApiOperation({
    summary: 'Add a missing punch or correct a wrong one, with a reason',
    description:
      'Times are HH:mm in the company time zone. Refused (409 LABOUR_DAY_ON_PAYMENT_SHEET) for a ' +
      'day a payment sheet already covers, and (400 LABOUR_PUNCH_OUT_BEFORE_IN) when the punch ' +
      'out would not be after the punch in.',
  })
  async correct(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: PunchCorrectionDto,
    @Ip() ip: string,
  ) {
    return this.muster.correct(caller, dto, ip);
  }

  @Get('corrections')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
    Permission.LABOUR_PUNCH_CORRECT,
  )
  @ApiOperation({
    summary: "The edit history of one labour's day, newest first",
  })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: PunchHistoryQueryDto,
  ) {
    return this.muster.history(caller, query.workerId, query.date);
  }

  @Get('rules')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({
    summary: 'The hours that make a full day, a half day and overtime',
  })
  async rules(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: LabourDayRulesQueryDto,
  ) {
    return this.muster.getRules(caller, query.companyId);
  }

  @Put('rules')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Change the day rules',
    description:
      'Every punched day no payment sheet covers yet is re-counted under the new rules; days on ' +
      'a payment sheet were paid as they stood and are left alone.',
  })
  async setRules(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: LabourDayRulesQueryDto,
    @Body() dto: LabourDayRulesDto,
    @Ip() ip: string,
  ) {
    return this.muster.setRules(caller, dto, query.companyId, ip);
  }

  @Post('site-photos')
  @RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
  @ApiOperation({
    summary: 'Keep a group photo of the site for reference',
    description: 'Not attendance: nobody is matched or marked from it.',
  })
  async addPhoto(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: SitePhotoDto,
  ) {
    return this.muster.addSitePhoto(caller, dto);
  }

  @Get('site-photos')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({ summary: "A site's group photos, newest first" })
  async photos(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: SitePhotoQueryDto,
  ) {
    return this.muster.listSitePhotos(caller, query.siteId, query.date);
  }

  @Get('site-photos/:id/image')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({ summary: 'The group photo itself (JPEG)' })
  async photo(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const buffer = await this.muster.sitePhotoImage(caller, id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  }
}
