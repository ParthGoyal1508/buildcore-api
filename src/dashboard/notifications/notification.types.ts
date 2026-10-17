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
  /**
   * Which notification this is, stably across requests (036 D6): the inbox remembers read/unread
   * by it. Defaults to `type` — right for a provider that yields at most one row.
   */
  key?: string;
  /**
   * Changes when there is something new to read under the same `key` (036 D6), which puts a
   * notification the person has read back to unread. Defaults to the title and subtitle, so a
   * count that changes ("3 claims to review" → "4") counts as new.
   */
  fingerprint?: string;
}

/** A notification as the bell shows it (036 D6): the computed row plus its inbox state. */
export interface InboxNotification extends NotificationRow {
  id: string;
  key: string;
  read: boolean;
  readAt: string | null;
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
