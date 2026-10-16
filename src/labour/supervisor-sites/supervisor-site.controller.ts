import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { SetSupervisorSitesDto } from './dto/supervisor-site.dto';
import { SupervisorSiteService } from './supervisor-site.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('labour')
export class SupervisorSiteController {
  constructor(private readonly supervisorSites: SupervisorSiteService) {}

  @Get('my-sites')
  @RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
  @ApiOperation({
    summary: 'The sites the caller may register labour and mark attendance at',
  })
  async mySites(@UserEntity() caller: AuthenticatedUser) {
    return this.supervisorSites.mySites(caller);
  }

  @Get('supervisor-sites')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary:
      'Every account that can mark labour attendance, with its assigned sites',
  })
  async list(@UserEntity() caller: AuthenticatedUser) {
    return this.supervisorSites.listAssignments(caller);
  }

  @Put('supervisor-sites/:userId')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: "Replace a supervisor's assigned sites" })
  async set(
    @UserEntity() caller: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: SetSupervisorSitesDto,
    @Ip() ip: string,
  ) {
    return this.supervisorSites.setAssignments(caller, userId, dto.siteIds, ip);
  }
}
