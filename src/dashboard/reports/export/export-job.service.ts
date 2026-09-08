import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  ExportFormat,
  ExportJobStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../../auth/audit-log.service';
import { AuthenticatedUser } from '../../../auth/authenticated-user';
import type { DashboardConfig } from '../../../common/configs/config.interface';
import {
  rlsContextFor,
  withRlsContext,
} from '../../../common/prisma/rls-context';
import { StorageService } from '../../../common/storage/storage.service';
import type { ReportData } from '../report.types';
import {
  formatMeta,
  renderReportExcel,
  renderReportPdf,
} from './export-renderer';

const STORAGE_NAMESPACE = 'report-exports';

/** A synchronous export — the file itself, ready to return. */
export interface SyncExport {
  mode: 'sync';
  buffer: Buffer;
  contentType: string;
  filename: string;
}

/** An async export — a job the caller polls or is notified about. */
export interface AsyncExport {
  mode: 'async';
  exportJobId: string;
  status: ExportJobStatus;
}

/** The status a poll of `GET /reports/exports/:id` returns. */
export interface ExportJobStatusView {
  status: ExportJobStatus;
  downloadUrl: string | null;
  failureReason: string | null;
}

/**
 * Owns the report-export lifecycle (spec FR-020/FR-021, US7).
 *
 * A render whose row count is at or below `DashboardConfig.asyncExportRowThreshold`
 * returns the file synchronously; a larger one is recorded as an `ExportJob` and
 * rendered off the request path, the caller polling `GET /reports/exports/:id` or
 * receiving the "Export Ready" notification.
 *
 * Deviation from the plan (recorded in plan.md): the off-request render runs
 * in-process rather than on a `@nestjs/bullmq` + Redis queue — the same synchronous-
 * infrastructure posture features 011 and 013 took, avoiding forcing a Redis
 * container on every developer. The `ExportJob` table, the poll contract and the
 * notification are all as specified; only the worker's backing store differs.
 */
@Injectable()
export class ExportJobService {
  private readonly logger = new Logger(ExportJobService.name);
  private readonly threshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.threshold =
      configService.get<DashboardConfig>('dashboard').asyncExportRowThreshold;
  }

  /** Decides sync-vs-async and starts the export (spec FR-020/FR-021). */
  async start(
    user: AuthenticatedUser,
    ipAddress: string,
    reportType: string,
    reportName: string,
    format: ExportFormat,
    filters: Prisma.InputJsonValue,
    report: ReportData,
  ): Promise<SyncExport | AsyncExport> {
    if (report.rows.length <= this.threshold) {
      const buffer = await this.render(reportName, format, report);
      const { contentType, extension } = formatMeta(format);
      await this.audit(user, ipAddress, AuditAction.CREATE, null, {
        reportType,
        format,
        rows: report.rows.length,
        mode: 'sync',
      });
      return {
        mode: 'sync',
        buffer,
        contentType,
        filename: `${reportType}.${extension}`,
      };
    }

    const job = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.create({
        data: {
          reportType,
          format,
          filters,
          status: ExportJobStatus.pending,
          requestedByUserId: user.id,
          companyId: user.companyId ?? '',
        },
        select: { id: true },
      }),
    );
    await this.audit(user, ipAddress, AuditAction.CREATE, job.id, {
      reportType,
      format,
      rows: report.rows.length,
      mode: 'async',
    });

    // In-process render, off the request path. Failures are captured onto the job
    // row, never left as an unhandled rejection.
    void this.process(user, ipAddress, job.id, reportName, format, report);

    return {
      mode: 'async',
      exportJobId: job.id,
      status: ExportJobStatus.pending,
    };
  }

  /** A poll of one job's status, company-scoped (contracts/dashboard-api.md). */
  async status(
    user: AuthenticatedUser,
    id: string,
  ): Promise<ExportJobStatusView> {
    const job = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.findFirst({ where: { id } }),
    );
    if (!job) throw new NotFoundException('Export job not found');
    return {
      status: job.status,
      downloadUrl:
        job.status === ExportJobStatus.ready
          ? `/reports/exports/${job.id}/download`
          : null,
      failureReason: job.failureReason,
    };
  }

  /** Fetches a finished export's file, or throws if it is not ready. */
  async download(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const job = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.findFirst({ where: { id } }),
    );
    if (!job || job.status !== ExportJobStatus.ready || !job.fileRef) {
      throw new NotFoundException('Export not ready');
    }
    const { contentType, extension } = formatMeta(job.format);
    return {
      buffer: await this.storage.get(job.fileRef),
      contentType,
      filename: `${job.reportType}.${extension}`,
    };
  }

  /** Ready jobs the "Export Ready" notification has not announced yet (research.md §6). */
  async listReadyUnnotified(
    user: AuthenticatedUser,
  ): Promise<{ id: string; reportType: string; completedAt: Date | null }[]> {
    return withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.findMany({
        where: { status: ExportJobStatus.ready, notifiedAt: null },
        select: { id: true, reportType: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
      }),
    );
  }

  /** Marks jobs as announced, so the notification surfaces each exactly once. */
  async markNotified(user: AuthenticatedUser, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.updateMany({
        where: { id: { in: ids } },
        data: { notifiedAt: new Date() },
      }),
    );
  }

  private async process(
    user: AuthenticatedUser,
    ipAddress: string,
    jobId: string,
    reportName: string,
    format: ExportFormat,
    report: ReportData,
  ): Promise<void> {
    try {
      await this.setStatus(user, jobId, ExportJobStatus.processing);
      const buffer = await this.render(reportName, format, report);
      const { contentType } = formatMeta(format);
      const fileRef = await this.storage.put(
        STORAGE_NAMESPACE,
        buffer,
        contentType,
      );
      await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
        tx.exportJob.update({
          where: { id: jobId },
          data: {
            status: ExportJobStatus.ready,
            fileRef,
            completedAt: new Date(),
          },
        }),
      );
      await this.audit(user, ipAddress, AuditAction.UPDATE, jobId, {
        status: 'ready',
      });
    } catch (error) {
      this.logger.error(`Export job ${jobId} failed`, error as Error);
      await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
        tx.exportJob.update({
          where: { id: jobId },
          data: {
            status: ExportJobStatus.failed,
            failureReason:
              error instanceof Error ? error.message : 'Render failed',
            completedAt: new Date(),
          },
        }),
      );
    }
  }

  private setStatus(
    user: AuthenticatedUser,
    jobId: string,
    status: ExportJobStatus,
  ): Promise<unknown> {
    return withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.exportJob.update({ where: { id: jobId }, data: { status } }),
    );
  }

  private render(
    reportName: string,
    format: ExportFormat,
    report: ReportData,
  ): Promise<Buffer> {
    return format === ExportFormat.pdf
      ? renderReportPdf(reportName, report)
      : renderReportExcel(reportName, report);
  }

  private audit(
    user: AuthenticatedUser,
    ipAddress: string,
    action: AuditAction,
    entityId: string | null,
    changes: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.auditLog.record({
      entityType: AuditEntityType.REPORT_EXPORT,
      action,
      entityId,
      changes,
      accountId: user.id,
      companyId: user.companyId,
      ipAddress,
    });
  }
}
