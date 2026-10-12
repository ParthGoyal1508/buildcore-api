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
 * {@link NotificationProvider} the caller is entitled to and returns only what is
 * currently active — there is no stored, dismissible notification (research.md §5).
 * Listing (not counting) also marks any "Export Ready" job announced, so it surfaces
 * once.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATION_PROVIDERS)
    private readonly providers: NotificationProvider[],
    private readonly exports: ExportJobService,
  ) {}

  /**
   * The caller's active rows: every provider whose `requires` they hold, run in
   * parallel.
   *
   * One method behind both `list` and `count` — they computed the same thing twice
   * before, and a permission filter applied to only one of them is the version of this
   * bug where the panel is empty and the bell still says 2.
   *
   * The unentitled provider is **not run**, rather than run and filtered: `checkActive`
   * reads other people's leave and claims, and not reading them at all is a stronger
   * statement than discarding the answer.
   */
  private async active(ctx: DashboardContext): Promise<NotificationRow[]> {
    const permitted = this.providers.filter(
      (p) => !p.requires || ctx.user.permissions.includes(p.requires),
    );
    return (await Promise.all(permitted.map((p) => p.checkActive(ctx)))).flat();
  }

  async list(ctx: DashboardContext): Promise<NotificationRow[]> {
    const rows = await this.active(ctx);
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
    return { count: (await this.active(ctx)).length };
  }
}
