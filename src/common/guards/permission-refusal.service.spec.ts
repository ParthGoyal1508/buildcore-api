import { PermissionRefusalService } from './permission-refusal.service';

/**
 * Recording and pruning refusals (019 FR-003, T038, T040).
 *
 * Two properties matter more than the write itself: that a failure to record **never**
 * propagates — the caller was correctly refused either way, and a 500 instead of a 403 is the
 * difference between a working system and an apparently broken one — and that the sweep
 * deletes beyond the window and nothing inside it.
 */
describe('PermissionRefusalService', () => {
  const serviceWith = (
    behaviour: { failWrite?: boolean } = {},
  ): {
    service: PermissionRefusalService;
    writes: Record<string, unknown>[];
    deletes: Record<string, unknown>[];
  } => {
    const writes: Record<string, unknown>[] = [];
    const deletes: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: async () => 0,
      permissionRefusal: {
        create: async (args: { data: Record<string, unknown> }) => {
          if (behaviour.failWrite) throw new Error('table is gone');
          writes.push(args.data);
          return args.data;
        },
        deleteMany: async (args: Record<string, unknown>) => {
          deletes.push(args);
          return { count: 3 };
        },
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return {
      service: new PermissionRefusalService(prisma as never),
      writes,
      deletes,
    };
  };

  const input = {
    companyId: 'co-1',
    userId: 'u-1',
    method: 'POST',
    path: '/plant/machinery',
    requiredPermission: 'MACHINERY' as never,
    requiredLevel: 'write' as never,
    heldLevel: 'read' as never,
  };

  it('records a refusal with the level actually held', async () => {
    const { service, writes } = serviceWith();
    service.record(input);
    await new Promise((r) => setImmediate(r));
    expect(writes).toHaveLength(1);
    // `heldLevel` is the column that earns the table: read-against-write is a bug report,
    // null is a security signal, and without it they are the same row.
    expect(writes[0].heldLevel).toBe('read');
    expect(writes[0].path).toBe('/plant/machinery');
  });

  it('never throws when the write fails', async () => {
    const { service } = serviceWith({ failWrite: true });
    expect(() => service.record(input)).not.toThrow();
    // And the rejected promise is handled, so it does not surface as an unhandled rejection
    // and take the process down in strict Node configurations.
    await new Promise((r) => setImmediate(r));
  });

  it('drops a refusal from a caller with no company rather than inventing one', async () => {
    // The table is tenant-scoped. A row with a fabricated tenant is worse than no row.
    const { service, writes } = serviceWith();
    service.record({ ...input, companyId: null });
    await new Promise((r) => setImmediate(r));
    expect(writes).toHaveLength(0);
  });

  it('sweeps beyond the retention window and nothing inside it', async () => {
    const { service, deletes } = serviceWith();
    const now = new Date('2026-09-30T00:00:00.000Z');
    const removed = await service.sweep(now);

    expect(removed).toBe(3);
    const where = (deletes[0] as { where: { createdAt: { lt: Date } } }).where;
    const cutoff = where.createdAt.lt;
    const days = (now.getTime() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
    expect(days).toBe(PermissionRefusalService.RETENTION_DAYS);
  });

  it('states a retention window at all', () => {
    // A security log with no stated lifetime is how a small table becomes an incident.
    expect(PermissionRefusalService.RETENTION_DAYS).toBeGreaterThan(0);
  });
});
