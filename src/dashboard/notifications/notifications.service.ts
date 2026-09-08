import { Inject, Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { ExportJobService } from '../reports/export/export-job.service';
import {
  NOTIFICATION_PROVIDERS,
  type NotificationProvider,
  type NotificationRow,
} from './notification.types';

/**
 * The notifications centre (spec FR-009). Iterates every registered
 * {@link NotificationProvider} in parallel and returns only what is currently active
 * — there is no stored, dismissible notification (research.md §5). Listing (not
 * counting) also marks any "Export Ready" job announced, so it surfaces once.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATION_PROVIDERS)
    private readonly providers: NotificationProvider[],
    private readonly exports: ExportJobService,
  ) {}

  async list(ctx: DashboardContext): Promise<NotificationRow[]> {
    const rows = (
      await Promise.all(this.providers.map((p) => p.checkActive(ctx)))
    ).flat();
    // Announce each ready export exactly once: the row is in `rows` this time, and
    // marking it here removes it from the next fetch (research.md §6).
    const ready = await this.exports.listReadyUnnotified(ctx.user);
    await this.exports.markNotified(
      ctx.user,
      ready.map((job) => job.id),
    );
    return rows;
  }

  async count(ctx: DashboardContext): Promise<{ count: number }> {
    const rows = (
      await Promise.all(this.providers.map((p) => p.checkActive(ctx)))
    ).flat();
    return { count: rows.length };
  }
}
