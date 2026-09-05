import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExportFormat, Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { buildDashboardContext } from '../context';
import { ExportReportDto } from './dto/export-report.dto';
import { RunReportDto } from './dto/run-report.dto';
import { ExportJobService } from './export/export-job.service';
import type { ReportData } from './report.types';
import { ReportsService } from './reports.service';

/**
 * Reports & export (feature 004, US7). Report runs and metadata sit behind the
 * `REPORTS` permission (spec FR-018, FR-022). An available type returns tabular data;
 * an unavailable one returns the `unavailable` envelope (200, not an error). Exports
 * return the file synchronously under the async threshold, or a job to poll above it.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.REPORTS)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportJobService,
  ) {}

  @Get('types')
  @ApiOperation({ summary: 'Every registered report type, available or not' })
  types() {
    return this.reports.types();
  }

  @Post(':type/run')
  @ApiOperation({ summary: 'Run one report type over a date range' })
  async run(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
    @Param('type') type: string,
    @Body() body: RunReportDto,
  ) {
    return this.reports.run(buildDashboardContext(user, ip), type, {
      fromDate: body.fromDate,
      toDate: body.toDate,
      filters: body.filters,
    });
  }

  @Post(':type/export')
  @ApiOperation({
    summary: 'Export a report to PDF or Excel',
    description:
      'Returns the file directly under the async row threshold, or 202 + an ' +
      'exportJobId to poll above it.',
  })
  async export(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
    @Param('type') type: string,
    @Body() body: ExportReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = buildDashboardContext(user, ip);
    const result = await this.reports.run(ctx, type, {
      fromDate: body.fromDate,
      toDate: body.toDate,
      filters: body.filters,
    });
    if ('unavailable' in result) {
      res.status(200).json(result);
      return;
    }

    const provider = this.reports.find(type);
    const outcome = await this.exports.start(
      user,
      ip,
      type,
      provider.name,
      body.format ?? ExportFormat.pdf,
      (body.filters ?? {}) as Record<string, string>,
      result as ReportData,
    );

    if (outcome.mode === 'async') {
      res
        .status(202)
        .json({ exportJobId: outcome.exportJobId, status: outcome.status });
      return;
    }

    res.setHeader('Content-Type', outcome.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${outcome.filename}"`,
    );
    res.status(200).send(outcome.buffer);
  }

  @Get('exports/:id')
  @ApiOperation({ summary: 'Poll an async export job’s status' })
  async status(@UserEntity() user: AuthenticatedUser, @Param('id') id: string) {
    return this.exports.status(user, id);
  }

  @Get('exports/:id/download')
  @ApiOperation({ summary: 'Download a finished async export' })
  async download(
    @UserEntity() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.exports.download(user, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.status(200).send(file.buffer);
  }
}
