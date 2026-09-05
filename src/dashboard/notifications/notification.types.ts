import type { DashboardContext } from '../context';

/** Notification urgency, driving the frontend's badge colour (data-model.md). */
export type NotificationSeverity = 'red' | 'yellow' | 'orange' | 'blue';

/** One active notification instance (data-model.md). */
export interface NotificationRow {
  type: string;
  severity: NotificationSeverity;
  title: string;
  subtitle: string;
  actionLink: string;
  occurredAt: string;
}

/**
 * One notification type's registration. Unlike a widget, a notification has no
 * `unavailable` state: a type whose condition never holds simply contributes no rows
 * (research.md §5, contracts "notifications differ from widgets"). `checkActive`
 * runs a live query every request — there is no stored, dismissible notification.
 */
export interface NotificationProvider {
  type: string;
  checkActive(ctx: DashboardContext): Promise<NotificationRow[]>;
}

/** Multi-provider injection token every notification registers under. */
export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');
