import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../caller-context';
import { AttendanceImportService } from './attendance-import.service';
import { AttendanceImportDto } from './dto/import-row.dto';

/**
 * Bulk attendance import (005 US13).
 *
 * Validate and commit are separate calls on purpose: an upload that partially
 * succeeds leaves the operator unable to tell what landed, and re-uploading
 * double-counts.
 */
@ApiTags('HR — Attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/attendance/import')
export class AttendanceImportController {
  constructor(private readonly imports: AttendanceImportService) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    const companyId = user.companyId ?? requested;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  @Get('template')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="attendance-import.csv"')
  @ApiOperation({ summary: 'The CSV template header row' })
  getTemplate(): string {
    return this.imports.getTemplate();
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Check a file without importing anything',
    description:
      'Every row is reported, valid or not, so the whole picture is visible ' +
      'rather than just the first failure.',
  })
  async validate(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: AttendanceImportDto,
  ) {
    return this.imports.validate(
      callerFrom(user, request),
      this.companyOf(user, dto.companyId),
      dto.csv,
    );
  }

  @Post('commit')
  @ApiOperation({
    summary: 'Import a validated file',
    description:
      'Re-validates before writing. Refuses outright if any row is invalid — ' +
      'nothing is imported. Rows rejected by the payroll lock or the ' +
      'mandatory-document gate are reported individually.',
  })
  @ApiResponse({
    status: 400,
    description: 'File still has invalid rows; nothing was imported.',
  })
  async commit(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: AttendanceImportDto,
  ) {
    return this.imports.commit(
      callerFrom(user, request),
      this.companyOf(user, dto.companyId),
      dto.csv,
    );
  }
}
