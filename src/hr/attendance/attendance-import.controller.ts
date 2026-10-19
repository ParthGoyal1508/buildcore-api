import {
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
import { AccessLevel } from '@prisma/client';
import { RequireLevel } from '../../common/decorators/access-level.decorator';
import { resolveCompanyId } from '../../settings/company-scope';

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
    // 036 stream 3b (17-10-2026): `resolveCompanyId`, not `user.companyId ?? requested`. The old
    // order let a Super Admin's *home* company win over the one they asked for, and ignored the
    // company selected in the switcher (which arrives on the RLS context, not on `user`), so a
    // Super Admin working in company B read and wrote company A's rows.
    return resolveCompanyId(user, requested);
  }

  @Get('template')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="attendance-import.csv"')
  @ApiOperation({ summary: 'The CSV template header row' })
  getTemplate(): string {
    return this.imports.getTemplate();
  }

  @Post('validate')
  // 019 T014: a POST that reads. It checks a file and imports nothing, so refusing it to a
  // read-only role would refuse a legitimate read — the one direction the verb→level rule
  // gets wrong.
  @RequireLevel(AccessLevel.read)
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
