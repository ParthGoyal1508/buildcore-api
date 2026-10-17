import { Inject, Injectable } from '@nestjs/common';

import type { DashboardContext } from '../context';
import { ExportJobService } from '../reports/export/export-job.service';
import { NotificationStore } from './notification-store.service';
import {
  NOTIFICATION_PROVIDERS,
  type InboxNotification,
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
    private readonly store: NotificationStore,
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

  async list(ctx: DashboardContext): Promise<InboxNotification[]> {
    const rows = await this.store.sync(ctx.user, await this.active(ctx));
    // Announce each ready export exactly once: the row is in `rows` this time, and
    // marking it here removes it from the next fetch (research.md §6).
    const ready = await this.exports.listReadyUnnotified(ctx.user);
    await this.exports.markNotified(
      ctx.user,
      ready.map((job) => job.id),
    );
    return rows;
  }

  /**
   * The bell badge: **unread** notifications (036 D6). `total` is everything currently active,
   * read or not, for a caller that wants the old number.
   */
  async count(
    ctx: DashboardContext,
  ): Promise<{ count: number; total: number }> {
    const rows = await this.store.sync(ctx.user, await this.active(ctx));
    return { count: rows.filter((r) => !r.read).length, total: rows.length };
  }

  markRead(ctx: DashboardContext, id: string) {
    return this.store.markRead(ctx.user, id);
  }

  markAllRead(ctx: DashboardContext) {
    return this.store.markAllRead(ctx.user);
  }
}
