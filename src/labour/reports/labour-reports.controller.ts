import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { MonthlyWageRollupDto } from './dto/monthly-wage-rollup.dto';
import {
  AttendanceReportDto,
  DeploymentReportDto,
  PaymentRegisterReportDto,
} from './dto/report.dto';
import { LabourReportsService } from './labour-reports.service';
import { MonthlyWageRollupService } from './monthly-wage-rollup.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.REPORTS)
@Controller('labour/reports')
export class LabourReportsController {
  constructor(
    private readonly reports: LabourReportsService,
    private readonly rollup: MonthlyWageRollupService,
  ) {}

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

  @Get('monthly-wage-rollup')
  @RequirePermissions(Permission.PROJECT_FINANCIALS, Permission.REPORTS)
  @ApiOperation({
    summary: 'One project’s labour wages for one calendar month (018 FR-010a)',
    description:
      'Every payment sheet **overlapping** the month, itemised per worker. A sheet covers the wage ' +
      'period its creator named, which under a fortnightly cycle is never a calendar month — so a ' +
      'containment test on `periodFrom` would drop a fortnight beginning on the 28th from the month ' +
      'that paid most of it.\n\n' +
      'A sheet crossing the month boundary is split on **days worked inside the month**, taken from ' +
      'the approved muster behind each line, and the split is stated on the sheet’s row. Pro-rating ' +
      'by elapsed calendar days would invent a figure: a worker who worked four days of a fortnight ' +
      'all in the first week is not half-attributable to each month.\n\n' +
      '**Nothing here is recomputed** (FR-010b). Every figure is read from the sheet as it recorded ' +
      'it, so a sheet corrected later corrects this view and there remains exactly one place a wage ' +
      'is computed.',
  })
  async monthlyWageRollup(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: MonthlyWageRollupDto,
  ) {
    return this.rollup.rollupFor(caller, query);
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
