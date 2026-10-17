import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { AttendanceSheetDto } from './dto/labour-sheets.dto';
import { LabourSheetsService, SheetFile } from './labour-sheets.service';

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 031's Excel downloads. Supervisors get only their assigned sites; the HR office gets all. */
@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY, Permission.LABOUR_APPROVE)
@Controller('labour/sheets')
export class LabourSheetsController {
  constructor(private readonly sheets: LabourSheetsService) {}

  @Get('attendance')
  @ApiOperation({
    summary: 'Month-end consolidated labour attendance sheet (XLSX)',
  })
  async attendance(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: AttendanceSheetDto,
    @Res() response: Response,
  ): Promise<void> {
    send(response, await this.sheets.attendanceSheet(caller, query));
  }

  @Get('payment/:id')
  @ApiOperation({ summary: 'A labour payment sheet as a printable XLSX' })
  async payment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    send(response, await this.sheets.paymentSheet(caller, id));
  }
}

function send(response: Response, file: SheetFile): void {
  response.setHeader('Content-Type', XLSX);
  response.setHeader(
    'Content-Disposition',
    contentDispositionFor(file.filename),
  );
  response.setHeader('Cache-Control', 'no-store');
  response.send(file.buffer);
}
