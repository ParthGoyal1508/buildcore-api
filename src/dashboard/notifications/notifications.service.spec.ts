import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import type { DashboardContext } from '../context';
import type { ExportJobService } from '../reports/export/export-job.service';
import { NotificationsService } from './notifications.service';
import type {
  NotificationProvider,
  NotificationRow,
} from './notification.types';

/**
 * A caller holding exactly `permissions` and nothing else.
 *
 * Only `user.permissions` is read by the filter, but the context is typed through so a
 * provider gaining a different dependency fails to compile rather than at runtime.
 */
function contextFor(permissions: Permission[]): DashboardContext {
  return {
    user: { permissions } as AuthenticatedUser,
  } as DashboardContext;
}

/** A provider that always has something to say, so an empty result can only be the filter. */
function noisy(
  type: string,
  requires?: Permission,
): NotificationProvider & { calls: number } {
  const provider = {
    type,
    requires,
    calls: 0,
    checkActive(): Promise<NotificationRow[]> {
      provider.calls += 1;
      return Promise.resolve([
        {
          type,
          severity: 'yellow',
          title: type,
          subtitle: '2 awaiting your decision',
          actionLink: `/dashboard/${type}`,
          occurredAt: '2026-10-10T00:00:00.000Z',
        } as NotificationRow,
      ]);
    },
  };
  return provider;
}

/** Nothing ready, nothing to mark — the export path is not what these tests are about. */
const exportJobs = {
  listReadyUnnotified: async () => [],
  markNotified: async () => undefined,
} as unknown as ExportJobService;

describe('NotificationsService — who a notification is for (2026-10-10)', () => {
  /**
   * The reported defect: `/notifications` is gated on DASHBOARD, which every employee
   * holds, so a site engineer with no HR access was shown "Pending Leave Approvals — 2
   * applications awaiting your decision" behind a link that answers them 403.
   *
   * Asserting only that the entitled caller sees the row would pass against the defect —
   * they saw it then too. The pair is the test: same provider, same data, two callers.
   */
  it('withholds a notification from a caller without the permission its link needs', async () => {
    const leave = noisy('leave_pending', Permission.ATTENDANCE);
    const service = new NotificationsService([leave], exportJobs);

    const entitled = await service.list(contextFor([Permission.ATTENDANCE]));
    const engineer = await service.list(contextFor([Permission.DASHBOARD]));

    expect(entitled.map((r) => r.type)).toEqual(['leave_pending']);
    expect(engineer).toEqual([]);
  });

  /**
   * The count is a separate code path from the list, and it is the one on screen when the
   * panel is shut. A filter applied to only one of them is this bug with a bell that still
   * says 2 over an empty panel.
   */
  it('counts only what the caller may see', async () => {
    const service = new NotificationsService(
      [
        noisy('leave_pending', Permission.ATTENDANCE),
        noisy('payroll_pending', Permission.EMPLOYEES),
        noisy('export_ready'),
      ],
      exportJobs,
    );

    expect(await service.count(contextFor([Permission.DASHBOARD]))).toEqual({
      count: 1,
    });
    expect(
      await service.count(
        contextFor([Permission.DASHBOARD, Permission.EMPLOYEES]),
      ),
    ).toEqual({ count: 2 });
  });

  /** Not run, not merely discarded: `checkActive` reads other people's leave. */
  it('does not query a queue the caller has no access to', async () => {
    const leave = noisy('leave_pending', Permission.ATTENDANCE);
    const service = new NotificationsService([leave], exportJobs);

    await service.list(contextFor([Permission.DASHBOARD]));
    await service.count(contextFor([Permission.DASHBOARD]));

    expect(leave.calls).toBe(0);
  });

  /** A provider with no `requires` is the caller's own business — `export_ready`. */
  it('keeps an unrestricted notification for everyone', async () => {
    const service = new NotificationsService(
      [noisy('export_ready')],
      exportJobs,
    );

    expect(await service.list(contextFor([]))).toHaveLength(1);
  });
});
