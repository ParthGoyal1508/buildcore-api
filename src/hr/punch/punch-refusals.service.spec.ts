import { PunchRefusalReason, PunchType } from '@prisma/client';

import { PunchRefusalsService } from './punch-refusals.service';

/**
 * Recording refused punches, and the number Phase 2 exists to produce (020 T013, T016).
 *
 * The property that matters most: **`record` never throws.** In Phase 2 the punch is still accepted,
 * so a failure here must not turn an accepted punch into a 500; in Phase 3 it must not turn a
 * considered refusal into an unexplained server error. The worker's outcome is already decided either
 * way.
 */
describe('PunchRefusalsService', () => {
  const harness = (
    opts: { failWrite?: boolean; counts?: [number, number] } = {},
  ) => {
    const writes: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: async () => 0,
      punchRefusal: {
        create: async (args: { data: Record<string, unknown> }) => {
          if (opts.failWrite) throw new Error('table is gone');
          writes.push(args.data);
          return args.data;
        },
        count: async () => opts.counts?.[0] ?? 0,
        groupBy: async () => [
          { reason: PunchRefusalReason.outside_geofence, _count: { _all: 3 } },
          { reason: PunchRefusalReason.unlocatable, _count: { _all: 1 } },
        ],
      },
      punchRecord: { count: async () => opts.counts?.[1] ?? 0 },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return { service: new PunchRefusalsService(prisma as never), writes };
  };

  const ctx = { isSuperAdmin: true } as never;

  const input = {
    companyId: 'co-1',
    employeeId: 'emp-1',
    type: PunchType.in,
    reason: PunchRefusalReason.outside_geofence,
    latitude: 19.076,
    longitude: 72.8777,
    distanceMeters: 240.5,
    accuracyMeters: 12,
    faceMatchDistance: 0.42,
    capturedAt: new Date('2026-09-30T03:30:00.000Z'),
  };

  it('records the refusal with its evidence', async () => {
    const { service, writes } = harness();
    await service.record(ctx, input);
    expect(writes).toHaveLength(1);
    // The real distance, not one adjusted by the accuracy allowance — this is evidence, and an
    // adjusted figure in an audit trail is a fiction in an audit trail.
    expect(writes[0].distanceMeters).toBe(240.5);
    expect(writes[0].reason).toBe(PunchRefusalReason.outside_geofence);
  });

  it('stores no photo', async () => {
    // Plan D20. A face-mismatch refusal means the system could not establish whose face it is, and
    // retaining an unattributed biometric against a named employee is worse than the record it
    // replaces. The distance is kept because a number is not a biometric.
    const { service, writes } = harness();
    await service.record(ctx, input);
    expect(Object.keys(writes[0])).not.toContain('photo');
    expect(Object.keys(writes[0])).not.toContain('photoRef');
    expect(writes[0].faceMatchDistance).toBe(0.42);
  });

  it('never throws when the write fails', async () => {
    const { service } = harness({ failWrite: true });
    await expect(service.record(ctx, input)).resolves.toBeUndefined();
  });

  it('accepts a refusal with no distance — an unlocatable punch has none', async () => {
    const { service, writes } = harness();
    await service.record(ctx, {
      ...input,
      reason: PunchRefusalReason.unlocatable,
      distanceMeters: null,
    });
    expect(writes[0].distanceMeters).toBeNull();
  });

  it('reports the rate the client needs before the hard block ships', async () => {
    // T016. The client accepted FR-013's cost without knowing how often it would fire, and Phase 3
    // does not begin until they have seen this figure.
    const { service } = harness({ counts: [4, 200] });
    const rate = await service.rateSince(ctx, 'co-1', new Date('2026-09-01'));

    expect(rate.refusals).toBe(4);
    expect(rate.punches).toBe(200);
    expect(rate.ratePercent).toBe(2);
    expect(rate.byReason).toEqual({ outside_geofence: 3, unlocatable: 1 });
  });

  it('reports zero rather than dividing by zero on a quiet window', async () => {
    const { service } = harness({ counts: [0, 0] });
    const rate = await service.rateSince(ctx, 'co-1', new Date('2026-09-01'));
    expect(rate.ratePercent).toBe(0);
  });
});
