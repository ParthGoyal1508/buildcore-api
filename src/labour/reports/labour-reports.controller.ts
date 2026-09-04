import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  AttendanceReportDto,
  DeploymentReportDto,
  PaymentRegisterReportDto,
} from './dto/report.dto';
import { LabourReportsService } from './labour-reports.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.REPORTS)
@Controller('labour/reports')
export class LabourReportsController {
  constructor(private readonly reports: LabourReportsService) {}

  @Get('deployment')
  @ApiOperation({ summary: 'Deployment: headcount and man-days by group' })
  async deployment(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: DeploymentReportDto,
  ) {
    return this.reports.deployment(caller, query);
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Attendance percentage per worker for a site' })
  async attendance(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: AttendanceReportDto,
  ) {
    return this.reports.attendance(caller, query);
  }

  @Get('payment-register')
  @ApiOperation({ summary: 'Payment register: every sheet line for a project' })
  async paymentRegister(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: PaymentRegisterReportDto,
  ) {
    return this.reports.paymentRegister(caller, query);
  }
}
