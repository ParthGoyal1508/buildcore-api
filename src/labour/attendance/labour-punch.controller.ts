import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  GroupAccessGuard,
  GroupAccessRefusalMessage,
  REFUSED_PUNCH_LOG_REFUSAL,
} from '../../dashboard/group-access.guard';
import {
  framesFrom,
  LivenessFramesInterceptor,
  livenessMultipartBody,
  UploadedFrame,
} from '../../common/uploads/liveness-frames';
import {
  LabourDayQueryDto,
  LabourPunchDto,
  LabourRefusalsQueryDto,
} from './dto/labour-punch.dto';
import { LabourPunchService } from './labour-punch.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
// 058 US4: the site supervisor's narrow permission reaches today's list and the punch; the
// refusal routes below name their own (wider) audience.
@RequirePermissions(
  Permission.DAILY_WORKER_REGISTRY,
  Permission.LABOUR_ATTENDANCE,
)
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
  // 058 FR-002: and only a Super Admin. The supervisor still sees why a punch was refused at the
  // moment it happens (the 422 from `POST punch`); the log of them is not theirs to browse.
  @UseGuards(GroupAccessGuard)
  @GroupAccessRefusalMessage(REFUSED_PUNCH_LOG_REFUSAL)
  @ApiForbiddenResponse({
    description: 'The caller is not a Super Admin (`SUPER_ADMIN_REQUIRED`).',
  })
  @ApiOperation({
    summary:
      'Refused labour punches at a site, newest first (Super Admin only, 058)',
  })
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
  @UseGuards(GroupAccessGuard)
  @GroupAccessRefusalMessage(REFUSED_PUNCH_LOG_REFUSAL)
  @ApiForbiddenResponse({
    description: 'The caller is not a Super Admin (`SUPER_ADMIN_REQUIRED`).',
  })
  @ApiOperation({
    summary: 'The photo of one refused labour punch (JPEG, 057)',
    description:
      'Super Admin only (058), at a site the caller may see. Kept for the refusal retention period (30 days by default); ' +
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
  @UseInterceptors(LivenessFramesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(
    livenessMultipartBody(
      {
        siteId: { type: 'string' },
        workerId: { type: 'string' },
        type: { type: 'string', enum: ['in', 'out'] },
        challengeId: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        accuracyMeters: { type: 'number' },
      },
      ['siteId', 'workerId', 'type', 'challengeId', 'latitude', 'longitude'],
    ),
  )
  @ApiOperation({
    summary: 'Punch a labour in or out with a liveness capture and GPS fix',
    description:
      'Multipart since 057. A face mismatch is refused with 422 LABOUR_PUNCH_REFUSED_FACE, a ' +
      'capture that is not a live person with LABOUR_PUNCH_REFUSED_LIVENESS. Location follows ' +
      'the employee rule: refused (422) when the company enforces the punch block.',
  })
  async punch(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: LabourPunchDto,
    @UploadedFiles() files: UploadedFrame[],
    @Ip() ip: string,
  ) {
    return this.punches.punch(caller, dto, framesFrom(files), ip);
  }
}
