import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  FunnelQueryDto,
  NewJoiningsQueryDto,
  ResignationsQueryDto,
} from './dto/recruitment-reports.dto';
import { RecruitmentReportsService } from './recruitment-reports.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.REPORTS)
@Controller('recruitment/reports')
export class RecruitmentReportsController {
  constructor(private readonly reports: RecruitmentReportsService) {}

  @Get('new-joinings')
  @ApiOperation({
    summary: 'New-joinings report for a period',
    description: 'Both `from` and `to` are required, as `YYYY-MM-DD`.',
  })
  @ApiResponse({ status: 400, description: 'Missing or malformed period.' })
  newJoinings(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: NewJoiningsQueryDto,
  ) {
    return this.reports.newJoinings(caller, query);
  }

  @Get('funnel')
  @ApiOperation({
    summary: 'Recruitment funnel: stage counts, conversion, time-to-hire',
  })
  funnel(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: FunnelQueryDto,
  ) {
    return this.reports.funnel(caller, query);
  }

  @Get('resignations')
  @ApiOperation({
    summary: 'Resignation report: tenure, reasons, attrition',
    description: 'Both `from` and `to` are required, as `YYYY-MM-DD`.',
  })
  @ApiResponse({ status: 400, description: 'Missing or malformed period.' })
  resignations(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ResignationsQueryDto,
  ) {
    return this.reports.resignations(caller, query);
  }
}
