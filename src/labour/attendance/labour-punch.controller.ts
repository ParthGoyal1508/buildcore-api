import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
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
  LabourDayQueryDto,
  LabourPunchDto,
  LabourRefusalsQueryDto,
} from './dto/labour-punch.dto';
import { LabourPunchService } from './labour-punch.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/attendance')
export class LabourPunchController {
  constructor(private readonly punches: LabourPunchService) {}

  @Get('today')
  @ApiOperation({
    summary: "The site's active labour with today's punch in/out",
  })
  async today(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: LabourDayQueryDto,
  ) {
    return this.punches.today(caller, query.siteId);
  }

  @Get('refusals')
  // HR reviews them too (057): the same pair the group-photo routes accept.
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({ summary: 'Refused labour punches at a site, newest first' })
  async refusals(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: LabourRefusalsQueryDto,
  ) {
    return this.punches.refusals(caller, query.siteId, query.days);
  }

  @Get('refusals/:id/photo')
  @RequirePermissions(
    Permission.DAILY_WORKER_REGISTRY,
    Permission.LABOUR_APPROVE,
  )
  @ApiOperation({
    summary: 'The photo of one refused labour punch (JPEG, 057)',
    description:
      'At a site the caller may see. Kept for the refusal retention period (30 days by default); ' +
      '404 after the sweep deletes it.',
  })
  async refusalPhoto(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const buffer = await this.punches.refusalPhoto(caller, id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  }

  @Post('punch')
  @ApiOperation({
    summary: 'Punch a labour in or out with a face photo and GPS fix',
    description:
      'A face mismatch is refused with 422 LABOUR_PUNCH_REFUSED_FACE. Location follows the ' +
      'employee rule: refused (422) when the company enforces the punch block, otherwise ' +
      'accepted and flagged.',
  })
  async punch(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: LabourPunchDto,
    @Ip() ip: string,
  ) {
    return this.punches.punch(caller, dto, ip);
  }
}
