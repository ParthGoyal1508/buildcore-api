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
    // Feature 016 composes the approval queue's subject line from these — the spine
    // cannot read the punch to build one itself (research.md §1).
    firstName: 'Rajesh',
    lastName: 'Kulkarni',
    employeeCode: 'CO1-0001',
  };
  const caller: Caller = {
    userId: 'user-1',
    companyId: 'co-1',
    ipAddress: '127.0.0.1',
    roleIds: [],
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
      /**
       * The per-employee location assignment in force (020 FR-011, FR-014).
       *
       * Undefined — the default — means **no assignment**, which is every employee the day this
       * ships and the fallback FR-016 requires. Tests that do not set it therefore keep
       * exercising the site fence.
       */
      assignment?: { siteId: string | null; isMobile: boolean };
      /**
       * Whether the company refuses a failing punch rather than flagging it (020 FR-013).
       *
       * Default false, matching every company's database default, so the existing tests below keep
       * asserting the flagged behaviour they were written for. The refusal tests pass `true`
       * explicitly — a dormant code path is untested in production until the day somebody switches
       * it on, so the flag must never be what decides whether these tests exercise it.
       */
      enforced?: boolean;
    } = {},
  ) => {
    const {
      dayPunches = [],
      enrolled = true,
      enrolmentStatus = FaceEnrolmentStatus.enrolled,
      assignment,
      enforced = false,
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

    const approvals = { submit: jest.fn().mockResolvedValue(undefined) };
    // Held in named consts rather than inlined, because the refusal tests assert on *whether these
    // were called* — FR-013's requirement is about ordering, not about the thrown status.
    const refusals = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { put: jest.fn().mockResolvedValue('punch/ref-1') };
    const service = new PunchService(
      // 020 FR-013c. Phase 2 records would-be refusals while still accepting the punch, so these
      // tests' outcomes are unchanged — the double only needs to absorb the call.
      refusals as never,
      // 020 FR-016. No assignment is the state every employee is in on the day this ships, so
      // the default double returns null and these tests continue to exercise the site fence —
      // which is the fallback, and the case that would break attendance company-wide if it
      // regressed. `assignment` below overrides it for the exemption tests.
      { inForceOn: jest.fn().mockResolvedValue(assignment ?? null) } as never,
      prisma as never,
      { requireByUserId: jest.fn().mockResolvedValue(employee) } as never,
      // Mandatory-document gate (005 US2): satisfied by default here so these
      // tests keep exercising the biometric/geofence paths they were written for.
      // The gate itself is covered in employee-documents.service.spec.ts.
      {
        assertMandatoryDocsComplete: jest.fn().mockResolvedValue(undefined),
      } as never,
      { getGeofence: jest.fn().mockResolvedValue(SITE) } as never,
      {
        getPayrollLockDay: jest.fn().mockResolvedValue(7),
        // 020 FR-012b. 50 is the product default; these tests send no `accuracyMeters`, so the
        // threshold is not reached and their verdicts are unchanged by its arrival.
        getPunchAccuracyMaxMetres: jest.fn().mockResolvedValue(50),
        isPunchBlockEnforced: jest.fn().mockResolvedValue(enforced),
      } as never,
      biometrics,
      { compressPunchPhoto: jest.fn(async (b: Buffer) => b) } as never,
      storage as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      // 016: a flagged punch is submitted into an approval chain. Resolved here so the
      // existing biometric/geofence assertions are unaffected; the submission itself is
      // covered in punch-approval.spec.ts and the e2e suite.
      approvals as never,
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
    return { service, prisma, created, approvals, refusals, storage };
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

    /**
     * 020 Phase 4 — the per-employee assignment (FR-011, FR-014, FR-016).
     *
     * The first of these is the one that matters most on release day: **no** employee carries an
     * assignment when this ships, so if the fallback regressed, every punch in the company would
     * start failing at once.
     */
    describe('per-employee location assignment', () => {
      it('falls back to the site fence when the employee has no assignment', async () => {
        // `build()` with no `assignment` is exactly the state of the database the morning this
        // deploys. The punch is inside the site fence and must read as clean.
        const { service } = build();
        const result = await service.submitPunch(caller, punchDto());

        expect(result.geofenceResult).toBe(GeofenceResult.in_range);
      });

      it('still refuses an out-of-fence punch when there is no assignment', async () => {
        // The other half of the fallback: "no assignment" must mean today's behaviour, not
        // "no validation". A test asserting only the clean case would pass if the fence had
        // been switched off entirely.
        const { service } = build();
        const result = await service.submitPunch(
          caller,
          punchDto({ latitude: SITE.latitude + 0.05 }),
        );

        expect(result.geofenceResult).toBe(GeofenceResult.exception);
      });

      it('does not refuse a mobile employee for being outside the fence', async () => {
        const { service } = build({
          assignment: { siteId: null, isMobile: true },
        });
        const result = await service.submitPunch(
          caller,
          punchDto({ latitude: SITE.latitude + 0.05 }),
        );

        expect(result.geofenceResult).toBe(GeofenceResult.in_range);
      });

      it('refuses a mobile employee for a face mismatch exactly as anyone else', async () => {
        // FR-014 as clarified 2026-09-16. The exemption covers **where** someone works, not
        // **who** they are — and the one-line implementation of "exempt from validation" is the
        // version that gets this wrong, which is the whole reason this test exists.
        const { service } = build({
          assignment: { siteId: null, isMobile: true },
        });
        biometrics.next = Float32Array.from(
          { length: FACE_DESCRIPTOR_LENGTH },
          () => 5,
        );
        const result = await service.submitPunch(caller, punchDto());

        expect(result.geofenceResult).toBe(GeofenceResult.in_range);
        expect(result.faceMatchResult).toBe(FaceMatchResult.exception);
      });
    });

    /**
     * 020 Phase 3 — the inversion (FR-013, FR-013d, FR-015).
     *
     * Every test here passes `enforced: true` rather than relying on a default, because the
     * behaviour under test ships switched off. If the flag were what decided whether these ran,
     * the refusal path would be unexercised until the day a client turned it on.
     */
    describe('the hard refusal, where a company has switched it on', () => {
      const FAR = { latitude: SITE.latitude + 0.05 };

      it('refuses an out-of-fence punch with PUNCH_REFUSED_LOCATION', async () => {
        const { service } = build({ enforced: true });

        await expect(
          service.submitPunch(caller, punchDto(FAR)),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'PUNCH_REFUSED_LOCATION' },
        });
      });

      it('distinguishes an unlocatable punch from one outside the fence', async () => {
        // The distinction FR-013b exists for. Collapsing these two into one code tells a worker
        // standing in exactly the right place to go somewhere else — so this asserts the code, not
        // merely that something was refused.
        const { service } = build({ enforced: true });

        await expect(
          service.submitPunch(caller, punchDto({ accuracyMeters: 500 })),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'PUNCH_REFUSED_UNLOCATABLE' },
        });
      });

      it('refuses a face mismatch and an undetectable face with the same code', async () => {
        // FR-012c. One code, because the advice is identical — retake the photo — and two reasons,
        // because the pattern worth detecting differs. Both halves asserted in one test, since the
        // requirement is precisely that they agree.
        const mismatch = build({ enforced: true });
        biometrics.next = Float32Array.from(
          { length: FACE_DESCRIPTOR_LENGTH },
          () => 5,
        );
        await expect(
          mismatch.service.submitPunch(caller, punchDto()),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'PUNCH_REFUSED_FACE', reason: 'face_mismatch' },
        });

        const undetectable = build({ enforced: true });
        biometrics.next = null;
        await expect(
          undetectable.service.submitPunch(caller, punchDto()),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'PUNCH_REFUSED_FACE', reason: 'no_face_detected' },
        });
      });

      it('writes no attendance row and no photo when it refuses', async () => {
        /**
         * **FR-013d, asserted structurally.** This is what makes the seven-reader audit in T022
         * finite rather than perpetual: payroll, the admin daily and monthly views, the employee's
         * own history, the cost roll-ups, leave accrual, shift compliance and the attendance export
         * all reach attendance through `PunchRecord`, so a day with no row reads as a day with no
         * punch in every one of them — including the reader somebody writes next year without being
         * told refusals exist.
         *
         * The photo matters as much as the row. `storage.put` happens before the day lock, so a
         * refusal thrown one line later would leave a blob whose only referent was the row that was
         * never created — an orphan nothing can collect, because nothing knows it is there.
         */
        const { service, created, storage, prisma } = build({ enforced: true });

        await expect(
          service.submitPunch(caller, punchDto(FAR)),
        ).rejects.toBeDefined();

        expect(created).toHaveLength(0);
        expect(prisma.tx.punchRecord.create).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
      });

      it('logs the refusal before refusing, so the attempt leaves a trace', async () => {
        // The log is not a consolation prize — under FR-013d it is the *only* evidence the attempt
        // happened. A refusal thrown before the log would erase the event entirely, leaving a
        // wrongly-refused worker nothing to appeal to.
        const { service, refusals } = build({ enforced: true });

        await expect(
          service.submitPunch(caller, punchDto(FAR)),
        ).rejects.toBeDefined();

        expect(refusals.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            employeeId: 'emp-1',
            reason: 'outside_geofence',
          }),
        );
      });

      it('submits nothing to the approval chain', async () => {
        // A refused punch is not an exception for anybody to review, because there is nothing to
        // review — the punch does not exist. Submitting one would put an item in a queue that can
        // never be approved into anything.
        const { service, approvals } = build({ enforced: true });

        await expect(
          service.submitPunch(caller, punchDto(FAR)),
        ).rejects.toBeDefined();

        expect(approvals.submit).not.toHaveBeenCalled();
      });

      it('reports the payroll lock, not the refusal, when both apply', async () => {
        // checklists/refusal.md CHK037. The lock is checked first and deliberately stays first:
        // "that period is closed" is permanent and actionable, where a refusal invites a retry that
        // will never succeed. A 423 here rather than a 422.
        const { service, refusals } = build({ enforced: true });
        const lastPeriod = new Date();
        lastPeriod.setUTCMonth(lastPeriod.getUTCMonth() - 2);

        await expect(
          service.submitPunch(
            caller,
            punchDto({ ...FAR, capturedAt: lastPeriod.toISOString() }),
          ),
        ).rejects.toMatchObject({ status: 423 });

        // And no refusal is logged, because no validation ran. The rate must not count punches
        // that were turned away for an unrelated reason.
        expect(refusals.record).not.toHaveBeenCalled();
      });

      it('leaves an unenrolled employee a 400, not a refusal', async () => {
        // checklists/refusal.md CHK036, decided here. A missing enrolment is a prerequisite nobody
        // has met, not a check that failed: the remedy is to enrol, not to retake a photo or move.
        // Logging it as a refusal would also inflate the refusal rate with a setup problem, and
        // that rate is the number the client's decision rests on.
        const { service, refusals } = build({
          enforced: true,
          enrolled: false,
        });

        await expect(
          service.submitPunch(caller, punchDto()),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(refusals.record).not.toHaveBeenCalled();
      });

      it('still accepts the same punch while the company has it switched off', async () => {
        // The flag's other direction, and the reason the default is false: nothing changes for a
        // company that has not been asked. Without this test the whole phase could ship inverted
        // for everybody and every assertion above would still pass.
        const { service, created } = build();

        const result = await service.submitPunch(caller, punchDto(FAR));

        expect(result.geofenceResult).toBe(GeofenceResult.exception);
        expect(created).toHaveLength(1);
      });

      it('records the refusal even while switched off, so the rate is measurable', async () => {
        const { service, refusals } = build();

        await service.submitPunch(caller, punchDto(FAR));

        expect(refusals.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ reason: 'outside_geofence' }),
        );
      });

      it('reports location rather than face when a punch fails both', async () => {
        // checklists/refusal.md CHK032. One reason has to be chosen; location is the one the worker
        // can usually act on from where they stand, since a retaken photo at the wrong site fails
        // again on the fence.
        const { service } = build({ enforced: true });
        biometrics.next = Float32Array.from(
          { length: FACE_DESCRIPTOR_LENGTH },
          () => 5,
        );

        await expect(
          service.submitPunch(caller, punchDto(FAR)),
        ).rejects.toMatchObject({
          response: { code: 'PUNCH_REFUSED_LOCATION' },
        });
      });
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

    // ── 016 FR-012: a flagged punch enters an approval chain ──────────────────

    it('submits a flagged punch into its approval chain, naming what it is about', async () => {
      const { service, approvals, created } = build();
      const result = await service.submitPunch(
        caller,
        punchDto({ latitude: SITE.latitude + 0.05 }),
      );

      expect(result.geofenceResult).toBe(GeofenceResult.exception);
      expect(approvals.submit).toHaveBeenCalledTimes(1);
      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'co-1',
          actionType: 'attendance_exception',
          entityType: 'attendance_exception',
          entityId: created[0].id,
          originatorUserId: 'user-1',
        }),
      );

      // `subject` and `href` are supplied by this module because the spine has no
      // relation to `hr.PunchRecord` and can never read it. A queue row has to say what
      // it is about, and this is where that cost is paid.
      const submitted = approvals.submit.mock.calls[0][0];
      expect(submitted.subject).toContain('Rajesh Kulkarni');
      expect(submitted.subject).toContain('outside the site geofence');
      expect(submitted.href).toContain(created[0].id);
    });

    it('names both reasons when a punch fails the face check and the geofence', async () => {
      const { service, approvals } = build();
      biometrics.next = Float32Array.from(
        { length: FACE_DESCRIPTOR_LENGTH },
        () => 5,
      );
      await service.submitPunch(
        caller,
        punchDto({ latitude: SITE.latitude + 0.05 }),
      );

      const submitted = approvals.submit.mock.calls[0][0];
      expect(submitted.subject).toContain('face did not match');
      expect(submitted.subject).toContain('outside the site geofence');
    });

    it('does not submit a clean punch', async () => {
      const { service, approvals } = build();
      await service.submitPunch(caller, punchDto());
      expect(approvals.submit).not.toHaveBeenCalled();
    });

    it('still records the punch when the chain cannot accept it', async () => {
      // The guarantee this protects is feature 003's FR-007, and it is not negotiable:
      // a punch that fails verification is still recorded. "Unless the approval chain is
      // misconfigured" would be a silent weakening of it, and the person who loses a
      // day's pay would have no idea why.
      const { service, approvals, created } = build();
      approvals.submit = jest.fn(async () => {
        throw new Error('No active approval chain is configured');
      });

      const result = await service.submitPunch(
        caller,
        punchDto({ latitude: SITE.latitude + 0.05 }),
      );

      expect(result.geofenceResult).toBe(GeofenceResult.exception);
      expect(created[0].exceptionResolution).toBe(ExceptionResolution.pending);
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
