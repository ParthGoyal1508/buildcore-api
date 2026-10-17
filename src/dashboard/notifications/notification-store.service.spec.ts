import { NotFoundException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  NotificationStore,
  RESOLVED_RETENTION_DAYS,
} from './notification-store.service';
import type { NotificationRow } from './notification.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** An in-memory `notification` delegate that understands the filters the store uses. */
function fakeTable() {
  let rows: any[] = [];
  let seq = 0;
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([field, cond]: [string, any]) => {
      if (field === 'OR') return cond.some((c: any) => matches(row, c));
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('in' in cond) return cond.in.includes(row[field]);
        if ('lt' in cond) return row[field] !== null && row[field] < cond.lt;
      }
      return row[field] === cond;
    });
  const delegate = {
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    ),
    count: jest.fn(
      async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
    ),
    createMany: jest.fn(async ({ data }: any) => {
      for (const d of data) {
        if (
          rows.some(
            (r) =>
              r.userId === d.userId &&
              r.companyId === d.companyId &&
              r.key === d.key,
          )
        )
          continue;
        rows.push({ id: `n${++seq}`, readAt: null, resolvedAt: null, ...d });
      }
      return { count: data.length };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, where));
      return { count: before - rows.length };
    }),
  };
  return { delegate, all: () => rows };
}

const user = {
  id: 'u1',
  companyId: 'co-1',
  permissions: [Permission.DASHBOARD],
} as never;

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  type: 'approvals_pending',
  severity: 'yellow',
  title: '2 RA bills awaiting your approval',
  subtitle: 'Oldest: RA-03',
  actionLink: '/dashboard/approvals',
  occurredAt: '2026-10-10T09:00:00.000Z',
  key: 'approvals_pending:ra_bill',
  fingerprint: 'f1',
  ...over,
});

function harness() {
  const table = fakeTable();
  const prisma = createPrismaMock({ notification: table.delegate });
  return { store: new NotificationStore(prisma as never), table };
}

describe('NotificationStore (036 D6)', () => {
  it('stores a new notification unread, scoped to the selected company', async () => {
    const { store, table } = harness();
    const [n] = await store.sync(user, [row()]);
    expect(n).toMatchObject({ read: false, key: 'approvals_pending:ra_bill' });
    expect(table.all()[0]).toMatchObject({ userId: 'u1', companyId: 'co-1' });
  });

  it('keeps it read while its fingerprint holds, and writes nothing on an unchanged poll', async () => {
    const { store, table } = harness();
    const [n] = await store.sync(user, [row()]);
    await store.markRead(user, n.id);
    table.delegate.update.mockClear();
    const [again] = await store.sync(user, [row()]);
    expect(again.read).toBe(true);
    expect(table.delegate.update).not.toHaveBeenCalled();
  });

  it('goes back to unread when something new arrives under the same key', async () => {
    const { store } = harness();
    const [n] = await store.sync(user, [row()]);
    await store.markRead(user, n.id);
    const [renewed] = await store.sync(user, [
      row({ fingerprint: 'f2', title: '3 RA bills awaiting your approval' }),
    ]);
    expect(renewed).toMatchObject({
      read: false,
      title: '3 RA bills awaiting your approval',
    });
  });

  it('keeps the read state of a notification that leaves and comes back unchanged', async () => {
    const { store, table } = harness();
    const [n] = await store.sync(user, [row()]);
    await store.markRead(user, n.id);
    await store.sync(user, []);
    expect(table.all()[0].resolvedAt).toBeInstanceOf(Date);
    const [back] = await store.sync(user, [row()]);
    expect(back.read).toBe(true);
    expect(table.all()[0].resolvedAt).toBeNull();
  });

  it('defaults the key to the type and the fingerprint to the text', async () => {
    const { store } = harness();
    const [n] = await store.sync(user, [
      row({ key: undefined, fingerprint: undefined }),
    ]);
    expect(n.key).toBe('approvals_pending');
    const [changed] = await store.sync(user, [
      row({ key: undefined, fingerprint: undefined, subtitle: 'Oldest: RA-04' }),
    ]);
    expect(changed.id).toBe(n.id);
  });

  it('marks all current notifications read, and only the caller’s', async () => {
    const { store, table } = harness();
    await store.sync(user, [row(), row({ key: 'leave_pending' })]);
    const other = { ...(user as object), id: 'u2' } as never;
    await store.sync(other, [row()]);
    await expect(store.markAllRead(user)).resolves.toEqual({ updated: 2 });
    expect(table.all().filter((r) => r.readAt === null)).toHaveLength(1);
  });

  it('answers 404 for a notification that is not the caller’s', async () => {
    const { store } = harness();
    const [n] = await store.sync(user, [row()]);
    const other = { ...(user as object), id: 'u2' } as never;
    await expect(store.markRead(other, n.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('forgets resolved notifications after the retention period', async () => {
    const { store, table } = harness();
    await store.sync(user, [row()]);
    const t0 = new Date('2026-10-01T00:00:00Z');
    await store.sync(user, [], t0);
    await store.sync(
      user,
      [],
      new Date(t0.getTime() + (RESOLVED_RETENTION_DAYS + 1) * 86_400_000),
    );
    expect(table.all()).toHaveLength(0);
  });
});
