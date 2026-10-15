import { Injectable } from '@nestjs/common';
import { ReminderSeverity } from '@prisma/client';

import type { DashboardContext } from '../context';
import { RemindersService } from '../reminders/reminders.service';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/** How many reminders the panel lists one by one before summing the rest. */
const SHOWN = 5;

/**
 * Reminders that need attention now (2026-10-15): overdue ones, and those inside their rule's
 * warning window. The client wanted reminders in the bell, not only on the Reminders page. Every
 * reminder the caller may see is already filtered by the reminders engine — by permission and by
 * snooze — so this lists what that list holds, most urgent first, and points at the page for the
 * rest. Reminders still far off stay on the page: a bell that rings for everything is ignored.
 */
@Injectable()
export class RemindersDueProvider implements NotificationProvider {
  readonly type = 'reminders_due';

  constructor(private readonly reminders: RemindersService) {}

  async checkActive(ctx: DashboardContext): Promise<NotificationRow[]> {
    const { reminders } = await this.reminders.list(ctx.user, {});
    const urgent = reminders.filter(
      (r) =>
        r.severity === ReminderSeverity.overdue ||
        r.severity === ReminderSeverity.warning,
    );
    const now = new Date().toISOString();
    const rows: NotificationRow[] = urgent.slice(0, SHOWN).map((r) => ({
      type: this.type,
      severity: r.severity === ReminderSeverity.overdue ? 'red' : 'orange',
      title: r.subject,
      subtitle:
        r.daysRemaining < 0
          ? `Overdue by ${-r.daysRemaining} day${
              r.daysRemaining === -1 ? '' : 's'
            } (due ${r.dueDate})`
          : r.daysRemaining === 0
          ? 'Due today'
          : `Due in ${r.daysRemaining} day${
              r.daysRemaining === 1 ? '' : 's'
            } (${r.dueDate})`,
      actionLink: r.actionLink ?? '/dashboard/reminders',
      occurredAt: now,
    }));
    if (urgent.length > SHOWN) {
      const more = urgent.length - SHOWN;
      rows.push({
        type: this.type,
        severity: 'blue',
        title: `${more} more reminder${more === 1 ? '' : 's'} due`,
        subtitle: 'Overdue or due soon — see them all on Reminders',
        actionLink: '/dashboard/reminders',
        occurredAt: now,
      });
    }
    return rows;
  }
}
