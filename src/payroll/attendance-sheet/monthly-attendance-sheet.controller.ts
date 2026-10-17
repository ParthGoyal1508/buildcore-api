import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { callerFrom } from '../../hr/caller-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { MonthlyAttendanceSheetDto } from './monthly-attendance-sheet.dto';
import { MonthlyAttendanceSheetService } from './monthly-attendance-sheet.service';

/**
 * The monthly staff attendance download (2026-10-17), under HR attendance where people look for it.
 * The company is read under the caller's own row-level scope, so nobody downloads a company they
 * cannot open; salary columns are filled only for a caller holding `PAYROLL`.
 */
@ApiTags('HR — Attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/attendance/monthly-sheet')
export class MonthlyAttendanceSheetController {
  constructor(private readonly sheets: MonthlyAttendanceSheetService) {}

  @Get()
  @ApiOperation({
    summary:
      'Attendance_<Company>_<Month>_<Year>.xlsx in the client’s staff attendance format',
  })
  async download(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: MonthlyAttendanceSheetDto,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.sheets.build(
      callerFrom(user, request),
      user,
      { ...query, companyId: resolveCompanyId(user, query.companyId) },
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', contentDispositionFor(filename));
    response.setHeader('Cache-Control', 'no-store');
    response.send(buffer);
  }
}
