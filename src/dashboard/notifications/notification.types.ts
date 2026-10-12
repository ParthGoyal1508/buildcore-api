import type { Permission } from '@prisma/client';

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
  /**
   * The permission a caller must hold for this notification to concern them at all
   * (2026-10-10).
   *
   * The endpoint is gated on `DASHBOARD`, which every employee holds, so until this
   * existed every provider ran for every caller: a site engineer was told the company
   * had two leave applications and three reimbursement claims awaiting *their* decision,
   * behind links that answer them 403. That is both a false instruction and a disclosure
   * — the count itself is information about other people's leave.
   *
   * Declared as the permission the row's `actionLink` is gated on, so the notification
   * and the screen it points at cannot drift apart. Omitted only where the rows are the
   * caller's own (`export_ready`), which needs no permission beyond reaching the endpoint.
   *
   * Checked at the **area** level, the idiom every other service-side permission test in
   * this codebase uses (`rls-context.ts`, `cash-entry.interceptor.ts`): holding an area at
   * any level means being in the audience for its queue.
   */
  readonly requires?: Permission;
  checkActive(ctx: DashboardContext): Promise<NotificationRow[]>;
}

/** Multi-provider injection token every notification registers under. */
export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');
