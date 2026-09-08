import { Injectable } from '@nestjs/common';

import { ExportJobService } from '../reports/export/export-job.service';
import type { DashboardContext } from '../context';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * "Export Ready" (research.md §6): a finished async export the caller has not been
 * told about yet — one row per ready, un-announced {@link ExportJobService} job. The
 * NotificationsService marks these announced after listing them, so each surfaces
 * exactly once.
 */
@Injectable()
export class ExportReadyProvider implements NotificationProvider {
  readonly type = 'export_ready';

  constructor(private readonly exports: ExportJobService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const ready = await this.exports.listReadyUnnotified(ctx.user);
    return ready.map((job) => ({
      type: this.type,
      severity: 'blue',
      title: 'Export Ready',
      subtitle: `Your ${job.reportType} export is ready to download`,
      actionLink: `/reports/exports/${job.id}/download`,
      occurredAt: (job.completedAt ?? new Date()).toISOString(),
    }));
  }
}
