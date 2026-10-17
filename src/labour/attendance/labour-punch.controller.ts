import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

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
  @ApiOperation({ summary: 'Refused labour punches at a site, newest first' })
  async refusals(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: LabourRefusalsQueryDto,
  ) {
    return this.punches.refusals(caller, query.siteId, query.days);
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
