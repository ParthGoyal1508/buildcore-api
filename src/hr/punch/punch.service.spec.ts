import { BadRequestException, HttpException } from '@nestjs/common';
import {
  ExceptionResolution,
  FaceEnrolmentStatus,
  FaceMatchResult,
  GeofenceResult,
  PunchType,
} from '@prisma/client';
import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  euclideanDistance,
} from '../biometrics/biometrics.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { PunchService } from './punch.service';

const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** The enrolled template every test compares against. */
const ENROLLED = Float32Array.from(
  { length: FACE_DESCRIPTOR_LENGTH },
  () => 0.5,
);

class FakeBiometrics extends BiometricsService {
  /** What the next punch photo will "look like". Set far from ENROLLED to
   * simulate a stranger; set to null to simulate no detectable face. */
  public next: Float32Array | null = ENROLLED;

  async computeDescriptor(): Promise<Float32Array> {
    if (!this.next) {
      throw new Error('no face');
    }
    return this.next;
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

const SITE = {
  siteId: 'site-1',
  latitude: 19.076,
  longitude: 72.8777,
  geofenceRadiusMeters: 200,
};

describe('PunchService', () => {
  const employee = {
    id: 'emp-1',
    companyId: 'co-1',
    siteId: 'site-1',
    shiftId: 'sh-1',
  };
  const caller: Caller = {
    userId: 'user-1',
    companyId: 'co-1',
    ipAddress: '127.0.0.1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
  };

  let biometrics: FakeBiometrics;

  // Several tests below pin the clock so a fixture stays on the side of a gate it
  // is not testing. Restoring here rather than at each call site means a failing
  // expectation cannot leave the next test frozen in 2026.
  afterEach(() => {
    jest.useRealTimers();
  });

  const build = (
    opts: {
      /** Punches already recorded on the punch's own calendar day (FR-008). */
      dayPunches?: { id: string; type: PunchType }[];
      enrolled?: boolean;
      enrolmentStatus?: FaceEnrolmentStatus;
    } = {},
  ) => {
    const {
      dayPunches = [],
      enrolled = true,
      enrolmentStatus = FaceEnrolmentStatus.enrolled,
    } = opts;
    biometrics = new FakeBiometrics();

    const created: Record<string, unknown>[] = [];
    const prisma = createPrismaMock({
      faceEnrolment: {
        findUnique: jest.fn().mockResolvedValue(
          enrolled
            ? {
                id: 'enr-1',
                status: enrolmentStatus,
                descriptor: Buffer.from(
                  ENROLLED.buffer,
                  ENROLLED.byteOffset,
                  ENROLLED.byteLength,
                ),
              }
            : null,
        ),
      },
      punchRecord: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = {
            id: `punch-${created.length + 1}`,
            ...(data as Record<string, unknown>),
          };
          created.push(row);
          return row;
        }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    // The FOR UPDATE lock query returns every punch already recorded on the
    // punch's own calendar day (FR-008) — not just an open one.
    prisma.tx.$queryRaw = jest.fn().mockResolvedValue(dayPunches);

    const service = new PunchService(
      prisma as never,
      { requireByUserId: jest.fn().mockResolvedValue(employee) } as never,
      // Mandatory-document gate (005 US2): satisfied by default here so these
      // tests keep exercising the biometric/geofence paths they were written for.
      // The gate itself is covered in employee-documents.service.spec.ts.
      {
        assertMandatoryDocsComplete: jest.fn().mockResolvedValue(undefined),
      } as never,
      { getGeofence: jest.fn().mockResolvedValue(SITE) } as never,
      { getPayrollLockDay: jest.fn().mockResolvedValue(7) } as never,
      biometrics,
      { compressPunchPhoto: jest.fn(async (b: Buffer) => b) } as never,
      { put: jest.fn().mockResolvedValue('punch/ref-1') } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {
        get: (key: string) =>
          key === 'settings'
            ? { timezone: 'Asia/Kolkata' }
            : {
                faceMatch: { distanceThreshold: 0.6 },
                offlineQueue: {
                  maxAgeHours: 72,
                  clockSkewToleranceMinutes: 5,
                },
                imageProcessing: {
                  punch: { maxDimension: 640, jpegQuality: 72 },
                },
              },
      } as never,
    );
    return { service, prisma, created };
  };

  const punchDto = (overrides: Record<string, unknown> = {}) =>
    ({
      type: PunchType.in,
      photo: JPEG_BASE64,
      latitude: SITE.latitude,
      longitude: SITE.longitude,
      capturedAt: new Date().toISOString(),
      ...overrides,
    } as never);

  describe('one punch-in and one punch-out per day (FR-008)', () => {
    const openIn = { id: 'punch-open', type: PunchType.in };
    const closedOut = { id: 'punch-out', type: PunchType.out };

    it('accepts a punch-in on a day with no punches', async () => {
      const { service } = build({ dayPunches: [] });
      const result = await service.submitPunch(caller, punchDto());
      expect(result.type).toBe(PunchType.in);
    });

    it('rejects a second punch-in while the first is still open', async () => {
      const { service } = build({ dayPunches: [openIn] });
      await expect(
        service.submitPunch(caller, punchDto({ type: PunchType.in })),
      ).rejects.toThrow(/already punched in today/);
    });

    it('rejects a second punch-in even after the day is closed', async () => {
      // The distinction from the old rule: a closed pair used to free the day for
      // another punch-in. One pair is now the whole allowance.
      const { service } = build({ dayPunches: [openIn, closedOut] });
      await expect(
        service.submitPunch(caller, punchDto({ type: PunchType.in })),
      ).rejects.toThrow(/already punched in today/);
    });

    it('rejects a punch-out when the day has no punch-in', async () => {
      const { service } = build({ dayPunches: [] });
      await expect(
        service.submitPunch(caller, punchDto({ type: PunchType.out })),
      ).rejects.toThrow(/not punched in today/);
    });

    it('rejects a second punch-out on the same day', async () => {
      const { service } = build({ dayPunches: [openIn, closedOut] });
      await expect(
        service.submitPunch(caller, punchDto({ type: PunchType.out })),
      ).rejects.toThrow(/already punched out today/);
    });

    it('does not let a punch-in from an earlier day block today (FR-008a)', async () => {
      // The day query is scoped to `punchDate`, so a stale open punch-in simply is
      // not in the result set. Nothing can close it, so blocking on it would lock
      // the employee out for good.
      const { service } = build({ dayPunches: [] });
      const result = await service.submitPunch(caller, punchDto());
      expect(result.type).toBe(PunchType.in);
    });

    it('stamps the calendar day and marks the punch employee-sourced', async () => {
      const { service, created } = build({ dayPunches: [] });
      // The clock is pinned two minutes after the capture. A fixed `capturedAt`
      // against the real clock is a time bomb: the offline-age gate (FR-012)
      // rejects anything over 72 hours old, so this test passed for three days
      // after the date was written and then failed for good.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-31T18:39:00.000Z'));
      await service.submitPunch(
        caller,
        // 00:07 IST on 1 September — 31 August in UTC. The stamped day must be the
        // employee's, not the server's (FR-018a).
        punchDto({ capturedAt: '2026-08-31T18:37:00.000Z' }),
      );
      expect(created[0].punchDate).toEqual(
        new Date('2026-09-01T00:00:00.000Z'),
      );
      expect(created[0].source).toBe('employee');
    });

    it("closes the day's punch-in when punching out", async () => {
      const { service, prisma } = build({ dayPunches: [openIn] });
      await service.submitPunch(caller, punchDto({ type: PunchType.out }));

      expect(prisma.tx.punchRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'punch-open' },
          data: expect.objectContaining({
            closedByPunchId: expect.any(String),
          }),
        }),
      );
    });

    it('takes a row lock before deciding, so concurrent punch-ins serialise', async () => {
      const { service, prisma } = build({ dayPunches: [] });
      await service.submitPunch(caller, punchDto());
      const sql = prisma.tx.$queryRaw.mock.calls[0][0].join('?');
      expect(sql).toMatch(/FOR UPDATE/);
    });

    it('binds the day as a cast date string, not a timestamp', async () => {
      // The regression this exists for: bound as a JS `Date`, Prisma sends
      // `timestamptz` and Postgres widens the `date` column at the session
      // timezone (`Asia/Kolkata` on this deployment) to compare. The row never
      // matched, so the FR-008 guards above were unreachable — a duplicate
      // punch-in surfaced the unique index as a 500 and every punch-out was
      // refused. Only an integration test against a real database can see the
      // mismatch itself, so what is asserted here is the shape that avoids it.
      const { service, prisma } = build({ dayPunches: [] });
      jest.useFakeTimers().setSystemTime(new Date('2026-08-31T18:39:00.000Z'));
      await service.submitPunch(
        caller,
        punchDto({ capturedAt: '2026-08-31T18:37:00.000Z' }),
      );
      const [strings, , day] = prisma.tx.$queryRaw.mock.calls[0];
      expect(strings.join('?')).toMatch(/"punchDate" = \?::date/);
      // 00:07 IST on 1 September: the employee's day, not the server's UTC one.
      expect(day).toBe('2026-09-01');
    });
  });

  describe('verification outcomes', () => {
    it('records a matching, in-geofence punch as clean', async () => {
      const { service, created } = build();
      const result = await service.submitPunch(caller, punchDto());

      expect(result.faceMatchResult).toBe(FaceMatchResult.matched);
      expect(result.geofenceResult).toBe(GeofenceResult.in_range);
      expect(created[0].exceptionResolution).toBeNull();
    });

    it('records a non-matching face as an exception rather than rejecting it', async () => {
      // FR-007: someone physically present must not be absent from payroll
      // because of a bad camera angle.
      const { service, created } = build();
      biometrics.next = Float32Array.from(
        { length: FACE_DESCRIPTOR_LENGTH },
        () => 5,
      );
      const result = await service.submitPunch(caller, punchDto());

      expect(result.faceMatchResult).toBe(FaceMatchResult.exception);
      expect(created[0].exceptionResolution).toBe(ExceptionResolution.pending);
    });

    it('records an out-of-geofence punch as an exception', async () => {
      const { service, created } = build();
      const result = await service.submitPunch(
        caller,
        punchDto({ latitude: SITE.latitude + 0.05 }),
      );

      expect(result.geofenceResult).toBe(GeofenceResult.exception);
      expect(created[0].exceptionResolution).toBe(ExceptionResolution.pending);
    });

    it('records an undetectable face as an exception, not a 400', async () => {
      const { service } = build();
      biometrics.next = null;
      const result = await service.submitPunch(caller, punchDto());
      expect(result.faceMatchResult).toBe(FaceMatchResult.exception);
    });
  });

  describe('gates', () => {
    it('rejects a punch with no enrolled template', async () => {
      const { service } = build({ enrolled: false });
      await expect(
        service.submitPunch(caller, punchDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still accepts a punch while a re-enrolment request is pending', async () => {
      // FR-014 calls the requester an "already-enrolled employee", and FR-016 keeps
      // the old template until a re-enrolment actually completes. Blocking here
      // would lock someone out of attendance for as long as an admin took to
      // respond — and the usual reason to request re-enrolment is that your face has
      // stopped matching well, so it penalised precisely the wrong people.
      const { service } = build({
        enrolmentStatus: FaceEnrolmentStatus.re_enrolment_requested,
      });
      const result = await service.submitPunch(caller, punchDto());
      expect(result.faceMatchResult).toBe(FaceMatchResult.matched);
    });

    it('rejects a punch older than the offline-queue window', async () => {
      const { service } = build();
      // Stale, but still inside the current (unlocked) month, so the offline-age
      // gate is the one that must fire.
      const now = new Date();
      const stale = new Date(now.getTime() - 80 * 3_600_000);
      if (stale.getUTCMonth() !== now.getUTCMonth()) {
        // Near a month boundary this fixture would trip the payroll lock instead;
        // pin "now" to mid-month so the test asserts the gate it means to.
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 7, 20)));
      }
      const capturedAt = new Date(Date.now() - 80 * 3_600_000).toISOString();
      await expect(
        service.submitPunch(caller, punchDto({ capturedAt })),
      ).rejects.toThrow(/offline sync window/);
    });

    it('returns 423 for a punch inside a locked payroll period', async () => {
      const { service } = build();
      // Two months back is locked regardless of the lock day.
      const old = new Date();
      old.setUTCMonth(old.getUTCMonth() - 2);
      const error = await service
        .submitPunch(caller, punchDto({ capturedAt: old.toISOString() }))
        .catch((e) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(423);
    });
  });

  describe('offline sync detection', () => {
    it('does not flag ordinary clock drift as an offline sync', async () => {
      const { service } = build();
      const slightlyStale = new Date(Date.now() - 60_000).toISOString();
      const result = await service.submitPunch(
        caller,
        punchDto({ capturedAt: slightlyStale }),
      );
      expect(result.isOfflineSync).toBe(false);
    });

    it('flags a punch queued well before it arrived', async () => {
      const { service } = build();
      const queued = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const result = await service.submitPunch(
        caller,
        punchDto({ capturedAt: queued }),
      );
      expect(result.isOfflineSync).toBe(true);
    });

    it('does not flag a punch just inside the skew tolerance', async () => {
      // The tolerance is configured at 5 minutes; 4 is ordinary drift, and
      // labelling it an offline sync would mark almost every normal punch.
      const { service } = build();
      const result = await service.submitPunch(
        caller,
        punchDto({
          capturedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        }),
      );
      expect(result.isOfflineSync).toBe(false);
    });

    it('flags a punch just outside the skew tolerance', async () => {
      const { service } = build();
      const result = await service.submitPunch(
        caller,
        punchDto({
          capturedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      expect(result.isOfflineSync).toBe(true);
    });

    it('does not flag a punch whose clock runs ahead of the server', async () => {
      // A client clock a little fast produces a future capturedAt. That is drift
      // in the other direction, not a queued punch, and treating it as offline
      // would misreport a perfectly ordinary punch.
      const { service } = build();
      const result = await service.submitPunch(
        caller,
        punchDto({ capturedAt: new Date(Date.now() + 60_000).toISOString() }),
      );
      expect(result.isOfflineSync).toBe(false);
    });

    it('records the declared capture time and the receipt time separately', async () => {
      // FR-012 requires both: flattening them into one timestamp would hide that
      // the punch was written retroactively.
      const queued = new Date(Date.now() - 2 * 3_600_000);
      const { service, created } = build();
      await service.submitPunch(
        caller,
        punchDto({ capturedAt: queued.toISOString() }),
      );

      const row = created[0] as {
        capturedAt: Date;
        receivedAt: Date;
        isOfflineSync: boolean;
      };
      expect(row.capturedAt.toISOString()).toBe(queued.toISOString());
      expect(row.receivedAt.getTime()).toBeGreaterThan(
        row.capturedAt.getTime(),
      );
      expect(row.isOfflineSync).toBe(true);
    });

    it('validates a synced punch against its declared date, not the arrival time', async () => {
      // The whole point of honouring capturedAt: a punch queued inside a locked
      // period stays locked even though it arrives while the current period is
      // open.
      const { service } = build();
      const lastPeriod = new Date();
      lastPeriod.setUTCMonth(lastPeriod.getUTCMonth() - 2);
      await expect(
        service.submitPunch(
          caller,
          punchDto({ capturedAt: lastPeriod.toISOString() }),
        ),
      ).rejects.toBeInstanceOf(HttpException);
    });
  });
});
