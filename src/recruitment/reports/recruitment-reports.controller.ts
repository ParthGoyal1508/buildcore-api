import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RecruitmentReportsService } from './recruitment-reports.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.REPORTS)
@Controller('recruitment/reports')
export class RecruitmentReportsController {
  constructor(private readonly reports: RecruitmentReportsService) {}

  @Get('new-joinings')
  @ApiOperation({ summary: 'New-joinings report for a period' })
  newJoinings(
    @UserEntity() caller: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('departmentId') departmentId?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.reports.newJoinings(caller, {
      from,
      to,
      departmentId,
      projectId,
    });
  }

  @Get('funnel')
  @ApiOperation({
    summary: 'Recruitment funnel: stage counts, conversion, time-to-hire',
  })
  funnel(
    @UserEntity() caller: AuthenticatedUser,
    @Query('requisitionId') requisitionId?: string,
  ) {
    return this.reports.funnel(caller, { requisitionId });
  }

  @Get('resignations')
  @ApiOperation({ summary: 'Resignation report: tenure, reasons, attrition' })
  resignations(
    @UserEntity() caller: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('departmentId') departmentId?: string,
    @Query('headcount') headcount?: string,
  ) {
    return this.reports.resignations(caller, {
      from,
      to,
      departmentId,
      headcount: headcount ? Number(headcount) : undefined,
    });
  }
}
